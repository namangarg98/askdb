/**
 * The AskDB agent: a tool-calling loop around Claude.
 *
 *   question -> Claude -> tool calls (search / describe / run) -> results -> Claude -> ... -> submit_answer
 *
 * The loop is written out by hand (instead of using the SDK's tool runner) so
 * each safety rule is visible here: a cap on model calls and failed queries,
 * at most 20 rows ever shown to the model, and a final answer that must point
 * at a query that actually succeeded.
 */
import Anthropic from '@anthropic-ai/sdk';
import type pg from 'pg';
import type { QueryResult, SafeExecutor } from '../db/executor.js';
import { normalise, validateSql } from '../db/guard.js';
import { AgentError, QueryFailedError, SqlRejectedError } from '../errors.js';
import { emptyUsage, type TokenUsage } from '../llm/usage.js';
import type { Embedder } from '../schema/embeddings.js';
import { findTableStructure, searchSchema } from '../schema/search.js';
import { numbersIn, ungroundedNumbers } from './numbers.js';
import { SYSTEM_PROMPT } from './prompts.js';
import { ToolInputs, isToolName, toolDefinitions, type ChartType } from './tools.js';

const MAX_QUESTION_LENGTH = 500;
const MAX_MODEL_CALLS = 10;
const MAX_FAILED_QUERIES = 3;
const SEARCH_RESULT_COUNT = 6;
/** Privacy (Layer 4): the model sees at most this many rows of any result. */
const ROWS_SHOWN_TO_MODEL = 20;
const MAX_CELL_CHARS = 200;
/** Answers sent back for containing numbers not found in the results, before accepting with a warning. */
const MAX_NUMBER_REJECTIONS = 2;

export interface AgentDependencies {
  readonly claude: Anthropic;
  readonly model: string;
  readonly metaPool: pg.Pool;
  readonly embedder: Embedder;
  /** Which queried database's schema index to search. */
  readonly schemaSource: string;
  readonly executor: SafeExecutor;
  readonly allowedTables: ReadonlySet<string>;
  /** Strict tool schemas; turn off for gateways that block structured outputs. */
  readonly strictTools: boolean;
}

export interface AgentStep {
  readonly tool: string;
  /** The topic, table name or SQL the tool was called with. */
  readonly input: string;
  readonly ok: boolean;
  /** Short outcome, e.g. "8 rows" or "TABLE_NOT_ALLOWED". */
  readonly summary: string;
  readonly durationMs: number;
}

export type AgentUsage = TokenUsage;

export interface AskResult {
  /** answered: backed by a query; no_data: the database cannot answer it. */
  readonly status: 'answered' | 'no_data';
  readonly answer: string;
  readonly sql?: string;
  readonly result?: QueryResult;
  readonly chart: ChartType;
  /** Numbers in the answer text that could not be found in the query results (empty when all are grounded). */
  readonly unverifiedNumbers: readonly string[];
  readonly steps: readonly AgentStep[];
  readonly usage: AgentUsage;
  readonly durationMs: number;
}

/** Everything one question accumulates while the loop runs. */
class RunState {
  readonly steps: AgentStep[] = [];
  readonly successfulQueries = new Map<string, QueryResult>();
  failedQueries = 0;
  numberRejections = 0;
  readonly usage: AgentUsage = emptyUsage();
  private readonly startedAt = performance.now();

  addUsage(usage: Anthropic.Usage): void {
    this.usage.modelCalls += 1;
    this.usage.inputTokens += usage.input_tokens;
    this.usage.outputTokens += usage.output_tokens;
    this.usage.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    this.usage.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
  }

  finish(
    result: Pick<AskResult, 'status' | 'answer' | 'sql' | 'result' | 'chart'> & { unverifiedNumbers?: readonly string[] },
  ): AskResult {
    return {
      unverifiedNumbers: [],
      ...result,
      steps: this.steps,
      usage: this.usage,
      durationMs: Math.round(performance.now() - this.startedAt),
    };
  }
}

type ToolOutcome = { content: string; isError: boolean; summary: string; input: string };

export class AskDbAgent {
  private readonly tools: Anthropic.Tool[];

  constructor(private readonly deps: AgentDependencies) {
    this.tools = toolDefinitions(deps.strictTools);
  }

  /**
   * @param options.signal aborts the run (e.g. the user pressed Cancel and the
   *   browser disconnected): the in-flight Claude request is cancelled and no
   *   further steps run.
   */
  async ask(rawQuestion: string, options: { signal?: AbortSignal } = {}): Promise<AskResult> {
    const question = rawQuestion.trim();
    if (question.length === 0 || question.length > MAX_QUESTION_LENGTH) {
      throw new AgentError('INVALID_QUESTION', `Ask a question between 1 and ${MAX_QUESTION_LENGTH} characters.`);
    }

    const state = new RunState();
    try {
      return await this.runLoop(question, state, options.signal);
    } catch (err) {
      const failure = options.signal?.aborted ? new AgentError('CANCELLED', 'The question was cancelled.', { cause: err }) : err;
      if (failure instanceof AgentError) failure.usage = { ...state.usage };
      throw failure;
    }
  }

  private async runLoop(question: string, state: RunState, signal: AbortSignal | undefined): Promise<AskResult> {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }];

    for (let call = 0; call < MAX_MODEL_CALLS; call++) {
      signal?.throwIfAborted();
      const response = await this.callModel(messages, signal);
      state.addUsage(response.usage);

      if (response.stop_reason === 'refusal') {
        throw new AgentError('MODEL_REFUSED', 'The model declined to answer this question.');
      }
      if (response.stop_reason === 'max_tokens') {
        throw new AgentError('MODEL_ERROR', 'The model response was cut off.');
      }

      // Append the full content (including thinking blocks) unchanged, as the API requires.
      messages.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );
      if (toolUses.length === 0) {
        // Ended with plain text and no submit_answer: treat it as an answer without data.
        const text = textOf(response) || 'I could not find an answer to that question.';
        return state.finish({ status: 'no_data', answer: text, chart: 'none' });
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      let final: AskResult | undefined;

      for (const toolUse of toolUses) {
        if (toolUse.name === 'submit_answer') {
          const submitted = this.trySubmit(toolUse.input, state, question);
          if (typeof submitted !== 'string') {
            final = submitted;
            continue;
          }
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: submitted, is_error: true });
          continue;
        }

        signal?.throwIfAborted();
        const startedAt = performance.now();
        const outcome = await this.runTool(toolUse, state);
        state.steps.push({
          tool: toolUse.name,
          input: outcome.input,
          ok: !outcome.isError,
          summary: outcome.summary,
          durationMs: Math.round(performance.now() - startedAt),
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: outcome.content,
          is_error: outcome.isError,
        });
      }

      if (final) return final;
      // All results go back in ONE user message, so parallel tool calls keep working.
      messages.push({ role: 'user', content: toolResults });
    }

    throw new AgentError('TOO_MANY_STEPS', `No answer after ${MAX_MODEL_CALLS} model calls.`);
  }

  private async callModel(messages: Anthropic.MessageParam[], signal: AbortSignal | undefined): Promise<Anthropic.Message> {
    try {
      return await this.deps.claude.messages.create(
        {
        model: this.deps.model,
        max_tokens: 16_000,
        output_config: { effort: 'medium' },
        system: SYSTEM_PROMPT,
        tools: this.tools,
        messages,
        // Caches the growing prefix (tools, system, earlier turns) between loop iterations.
        cache_control: { type: 'ephemeral' },
        },
        { signal },
      );
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        // The API's error text describes the request problem; it never contains our key.
        const detail = String((err.error as { error?: { message?: unknown } } | undefined)?.error?.message ?? err.message);
        throw new AgentError(
          'MODEL_ERROR',
          `Claude API error (status ${err.status ?? 'none'}): ${detail.replace(/\s+/g, ' ').slice(0, 300)}`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  private async runTool(toolUse: Anthropic.ToolUseBlock, state: RunState): Promise<ToolOutcome> {
    if (!isToolName(toolUse.name)) {
      return failure(toolUse.name, `Unknown tool "${toolUse.name}".`, 'UNKNOWN_TOOL');
    }

    switch (toolUse.name) {
      case 'search_schema': {
        const input = ToolInputs.search_schema.safeParse(toolUse.input);
        if (!input.success) return failure('', 'Invalid input: "topic" must be a non-empty string.', 'INVALID_INPUT');
        const matches = await searchSchema(this.deps.metaPool, this.deps.embedder, this.deps.schemaSource, input.data.topic, SEARCH_RESULT_COUNT);
        return {
          input: input.data.topic,
          isError: false,
          summary: matches.map((m) => m.tableName).join(', '),
          content: JSON.stringify(matches.map((m) => ({ table: m.tableName, description: m.description }))),
        };
      }

      case 'describe_table': {
        const input = ToolInputs.describe_table.safeParse(toolUse.input);
        if (!input.success) return failure('', 'Invalid input: "table_name" is required.', 'INVALID_INPUT');
        const structure = await findTableStructure(this.deps.metaPool, this.deps.schemaSource, input.data.table_name);
        if (!structure) {
          return failure(input.data.table_name, `Unknown table "${input.data.table_name}". Use a name from search_schema.`, 'UNKNOWN_TABLE');
        }
        return { input: input.data.table_name, isError: false, summary: 'described', content: structure };
      }

      case 'run_query':
        return this.runQuery(toolUse.input, state);

      case 'submit_answer':
        // Handled by the loop; listed so the switch covers every tool.
        return failure('', 'submit_answer is handled separately.', 'INTERNAL');
    }
  }

  private async runQuery(rawInput: unknown, state: RunState): Promise<ToolOutcome> {
    const input = ToolInputs.run_query.safeParse(rawInput);
    if (!input.success) return failure('', 'Invalid input: "sql" must be a string.', 'INVALID_INPUT');
    const sql = input.data.sql;

    if (state.failedQueries >= MAX_FAILED_QUERIES) {
      return failure(sql, 'Query attempt limit reached. Call submit_answer now and explain what went wrong.', 'ATTEMPT_LIMIT');
    }

    try {
      const query = validateSql(sql, { allowedTables: this.deps.allowedTables });
      const result = await this.deps.executor.run(query);
      state.successfulQueries.set(query.sql, result);
      return {
        input: query.sql,
        isError: false,
        summary: `${result.rowCount} row${result.rowCount === 1 ? '' : 's'}`,
        content: JSON.stringify(modelView(result)),
      };
    } catch (err) {
      if (err instanceof QueryFailedError && err.code === 'DB_UNAVAILABLE') throw err;
      if (err instanceof SqlRejectedError || err instanceof QueryFailedError) {
        state.failedQueries += 1;
        const source = err instanceof SqlRejectedError ? 'Rejected by the SQL guard' : 'Database error';
        return failure(sql, `${source} (${err.code}): ${err.message}`, err.code);
      }
      throw err;
    }
  }

  /** Returns the final result, or an error message for Claude when the submission is not acceptable. */
  private trySubmit(rawInput: unknown, state: RunState, question: string): AskResult | string {
    const input = ToolInputs.submit_answer.safeParse(rawInput);
    if (!input.success) return 'Invalid submit_answer input: answer, sql and chart are required.';
    const { answer, chart } = input.data;
    const sql = normalise(input.data.sql);

    const result = sql === '' ? undefined : state.successfulQueries.get(sql);
    if (sql !== '' && !result) {
      return 'That SQL has not been run successfully. Submit the exact SQL of a successful run_query call, or run it first.';
    }

    // Every number in the answer must come from a query result (or the question), never mental arithmetic.
    const unverified = ungroundedNumbers(answer, this.groundingNumbers(state, question));
    if (unverified.length > 0 && state.numberRejections < MAX_NUMBER_REJECTIONS) {
      state.numberRejections += 1;
      state.steps.push({ tool: 'submit_answer', input: answer, ok: false, summary: 'UNGROUNDED_NUMBERS', durationMs: 0 });
      return (
        `These numbers are not in your query results: ${unverified.join(', ')}. ` +
        'Do not calculate numbers yourself. Compute them with a SQL query and use its result, or leave them out.'
      );
    }

    if (sql === '') {
      return state.finish({ status: 'no_data', answer, chart: 'none', unverifiedNumbers: unverified });
    }
    return state.finish({ status: 'answered', answer, sql, result, chart, unverifiedNumbers: unverified });
  }

  /** Numbers the answer may use: every value from this run's successful queries, their row counts, and the question. */
  private groundingNumbers(state: RunState, question: string): number[] {
    const numbers = numbersIn([question]);
    for (const result of state.successfulQueries.values()) {
      numbers.push(result.rowCount, ...numbersIn(result.rows.flat()));
    }
    return numbers;
  }
}

function failure(input: string, message: string, summary: string): ToolOutcome {
  return { input, isError: true, summary, content: message };
}

/** What the model sees of a result: column names, counts and the first rows, with long values cut. */
function modelView(result: QueryResult) {
  const rows = result.rows.slice(0, ROWS_SHOWN_TO_MODEL).map((row) =>
    row.map((cell) => {
      if (cell === null || typeof cell === 'number' || typeof cell === 'boolean') return cell;
      const text = cell instanceof Date ? cell.toISOString() : String(cell);
      return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text;
    }),
  );
  return {
    columns: result.columns,
    row_count: result.rowCount,
    rows_shown: rows.length,
    truncated_by_server: result.truncated,
    rows,
  };
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
    .trim();
}
