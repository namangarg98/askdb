/**
 * Agent loop tests with a scripted fake Claude: free, fast and deterministic.
 * The guard, executor and database are real (needs the Podman DB), so these
 * prove the loop's rules end to end without calling the model.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type pg from 'pg';
import { AskDbAgent } from '../src/agent/agent.js';
import { loadConfig } from '../src/config.js';
import { SafeExecutor, loadAllowedTables } from '../src/db/executor.js';
import { createMetaPool, createReadOnlyPool } from '../src/db/pool.js';
import { AgentError } from '../src/errors.js';
import type { Embedder } from '../src/schema/embeddings.js';
import { ensureSchemaStore } from '../src/schema/store.js';

const hasDatabase = Boolean(process.env.ASKDB_READONLY_PASSWORD && process.env.ASKDB_APP_PASSWORD);

type ToolCall = { name: string; input: Record<string, unknown> };

/** A fake Claude that replies with a fixed script of tool calls, and records what it was sent. */
function scriptedClaude(script: (ToolCall[] | string)[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let turn = 0;
  const create = async (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
    requests.push(structuredClone(params));
    const step = script[Math.min(turn++, script.length - 1)] ?? 'done';
    const content =
      typeof step === 'string'
        ? [{ type: 'text', text: step }]
        : step.map((call, i) => ({ type: 'tool_use', id: `tool_${turn}_${i}`, name: call.name, input: call.input }));
    return {
      id: `msg_${turn}`,
      type: 'message',
      role: 'assistant',
      model: 'fake',
      content,
      stop_reason: typeof step === 'string' ? 'end_turn' : 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as unknown as Anthropic.Message;
  };
  return { claude: { messages: { create } } as unknown as Anthropic, requests };
}

/** The tool_result blocks the agent sent back in the last request. */
function lastToolResults(requests: Anthropic.MessageCreateParamsNonStreaming[]): Anthropic.ToolResultBlockParam[] {
  const last = requests.at(-1)?.messages.at(-1);
  return (Array.isArray(last?.content) ? last.content : []) as Anthropic.ToolResultBlockParam[];
}

const unusedEmbedder: Embedder = { id: 'none', embed: async () => [] };
const COUNT_SQL = 'SELECT count(*) AS order_count FROM orders';

describe.skipIf(!hasDatabase)('AskDB agent loop', () => {
  let readOnlyPool: pg.Pool;
  let metaPool: pg.Pool;
  let makeAgent: (claude: Anthropic) => AskDbAgent;

  beforeAll(async () => {
    const config = loadConfig();
    readOnlyPool = createReadOnlyPool(config);
    metaPool = createMetaPool(config);
    // On a fresh database (e.g. CI) the index table does not exist yet; the server creates it at startup.
    await ensureSchemaStore(metaPool);
    const executor = new SafeExecutor(readOnlyPool, { timeoutMs: 2_000, maxRows: 500 });
    const allowedTables = await loadAllowedTables(readOnlyPool);
    makeAgent = (claude) =>
      new AskDbAgent({ claude, model: 'fake', metaPool, embedder: unusedEmbedder, schemaSource: 'test', executor, allowedTables, strictTools: true });
  });

  afterAll(async () => {
    await Promise.all([readOnlyPool?.end(), metaPool?.end()]);
  });

  it('answers with the result of a query that succeeded', async () => {
    const { claude } = scriptedClaude([
      [{ name: 'run_query', input: { sql: COUNT_SQL } }],
      [{ name: 'submit_answer', input: { answer: 'There are 830 orders.', sql: `${COUNT_SQL};`, chart: 'none' } }],
    ]);

    const result = await makeAgent(claude).ask('How many orders are there?');

    expect(result.status).toBe('answered');
    expect(result.sql).toBe(COUNT_SQL);
    expect(result.result?.rows).toEqual([['830']]);
    expect(result.steps).toHaveLength(1);
    expect(result.usage.modelCalls).toBe(2);
  });

  it('feeds guard rejections back to Claude as errors so it can correct itself', async () => {
    const { claude, requests } = scriptedClaude([
      [{ name: 'run_query', input: { sql: 'DELETE FROM orders' } }],
      [{ name: 'run_query', input: { sql: COUNT_SQL } }],
      [{ name: 'submit_answer', input: { answer: '830 orders.', sql: COUNT_SQL, chart: 'none' } }],
    ]);

    const result = await makeAgent(claude).ask('Delete orders and count them');

    const firstFeedback = requests[1]?.messages.at(-1)?.content as Anthropic.ToolResultBlockParam[];
    expect(firstFeedback[0]?.is_error).toBe(true);
    expect(String(firstFeedback[0]?.content)).toContain('NOT_SELECT');
    expect(result.steps.map((s) => s.ok)).toEqual([false, true]);
    expect(result.status).toBe('answered');
  });

  it('refuses a final answer whose SQL never ran (no invented numbers)', async () => {
    const { claude, requests } = scriptedClaude([
      [{ name: 'submit_answer', input: { answer: 'There are 1,000,000 orders.', sql: COUNT_SQL, chart: 'none' } }],
      [{ name: 'run_query', input: { sql: COUNT_SQL } }],
      [{ name: 'submit_answer', input: { answer: 'There are 830 orders.', sql: COUNT_SQL, chart: 'none' } }],
    ]);

    const result = await makeAgent(claude).ask('How many orders are there?');

    expect(String(lastToolResults(requests.slice(0, 2))[0]?.content)).toContain('has not been run successfully');
    expect(result.answer).toBe('There are 830 orders.');
  });

  it('sends back an answer containing a number the model calculated itself', async () => {
    const { claude, requests } = scriptedClaude([
      [{ name: 'run_query', input: { sql: COUNT_SQL } }],
      [{ name: 'submit_answer', input: { answer: 'There are 830 orders, worth about 597,094.42.', sql: COUNT_SQL, chart: 'none' } }],
      [{ name: 'submit_answer', input: { answer: 'There are 830 orders.', sql: COUNT_SQL, chart: 'none' } }],
    ]);

    const result = await makeAgent(claude).ask('How many orders are there?');

    expect(String(lastToolResults(requests)[0]?.content)).toContain('597,094.42');
    expect(result.answer).toBe('There are 830 orders.');
    expect(result.unverifiedNumbers).toEqual([]);
    expect(result.steps.some((s) => s.summary === 'UNGROUNDED_NUMBERS')).toBe(true);
  });

  it('accepts after 2 send-backs but flags the unverified numbers', async () => {
    const wrong = { name: 'submit_answer', input: { answer: 'There are 999,999 orders.', sql: COUNT_SQL, chart: 'none' } };
    const { claude } = scriptedClaude([[{ name: 'run_query', input: { sql: COUNT_SQL } }], [wrong], [wrong], [wrong]]);

    const result = await makeAgent(claude).ask('How many orders are there?');

    expect(result.status).toBe('answered');
    expect(result.unverifiedNumbers).toEqual(['999,999']);
  });

  it('shows Claude at most 20 rows, while the user gets the full result', async () => {
    const sql = 'SELECT order_id FROM orders ORDER BY order_id';
    const { claude, requests } = scriptedClaude([
      [{ name: 'run_query', input: { sql } }],
      [{ name: 'submit_answer', input: { answer: 'All orders.', sql, chart: 'table' } }],
    ]);

    const result = await makeAgent(claude).ask('List all order ids');

    const seenByModel = JSON.parse(String(lastToolResults(requests)[0]?.content));
    expect(seenByModel.rows).toHaveLength(20);
    expect(seenByModel.row_count).toBe(500);
    expect(result.result?.rowCount).toBe(500);
  });

  it('stops retrying after 3 failed queries', async () => {
    const { claude, requests } = scriptedClaude([
      ...Array.from({ length: 4 }, () => [{ name: 'run_query', input: { sql: 'SELECT nope FROM orders' } }]),
      [{ name: 'submit_answer', input: { answer: 'I could not query that.', sql: '', chart: 'none' } }],
    ]);

    const result = await makeAgent(claude).ask('Something impossible');

    expect(String(lastToolResults(requests.slice(0, 5))[0]?.content)).toContain('attempt limit');
    expect(result.status).toBe('no_data');
  });

  it('gives up after 10 model calls', async () => {
    const { claude } = scriptedClaude([[{ name: 'describe_table', input: { table_name: 'orders' } }]]);
    await expect(makeAgent(claude).ask('Loop forever')).rejects.toMatchObject({ code: 'TOO_MANY_STEPS' });
  });

  it('stops immediately when cancelled mid-run, keeping the tokens already spent', async () => {
    const controller = new AbortController();
    const { claude, requests } = scriptedClaude([
      [{ name: 'describe_table', input: { table_name: 'orders' } }],
      [{ name: 'describe_table', input: { table_name: 'customers' } }],
      [{ name: 'submit_answer', input: { answer: 'never reached', sql: '', chart: 'none' } }],
    ]);
    // The user presses Cancel while the first model call is in flight.
    const originalCreate = claude.messages.create.bind(claude.messages);
    (claude.messages as { create: unknown }).create = async (...args: Parameters<typeof originalCreate>) => {
      const reply = await originalCreate(...args);
      controller.abort();
      return reply;
    };

    const error = await makeAgent(claude).ask('Cancel me', { signal: controller.signal }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'CANCELLED' });
    expect((error as AgentError).usage?.modelCalls).toBe(1);
    expect(requests).toHaveLength(1); // no further model calls after Cancel
  });

  it('rejects empty and oversized questions before calling the model', async () => {
    const { claude, requests } = scriptedClaude(['unused']);
    await expect(makeAgent(claude).ask('   ')).rejects.toBeInstanceOf(AgentError);
    await expect(makeAgent(claude).ask('x'.repeat(501))).rejects.toMatchObject({ code: 'INVALID_QUESTION' });
    expect(requests).toHaveLength(0);
  });
});
