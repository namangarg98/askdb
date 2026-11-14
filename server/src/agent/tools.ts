/**
 * The tools Claude may call. Definitions are fixed and kept in a stable order
 * so the prompt prefix (tools -> system) can be cached between calls.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

export const CHART_TYPES = ['bar', 'line', 'table', 'none'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

/**
 * Tool definitions, with or without `strict` (schema-guaranteed tool input).
 * Strict mode uses the structured-outputs feature, which some gateway routes
 * block (e.g. a Vertex organisation policy), so callers pass `strict: false`
 * there. Input is validated with zod (ToolInputs) either way.
 */
export function toolDefinitions(strict: boolean): Anthropic.Tool[] {
  return strict ? TOOL_DEFINITIONS : TOOL_DEFINITIONS.map(({ strict: _strict, ...tool }) => tool);
}

const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'search_schema',
    description:
      'Find the database tables most relevant to a topic or question. Returns table names with short ' +
      'descriptions, most relevant first. Call this first.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The question or business concept to look up, e.g. "revenue by product".',
        },
      },
      required: ['topic'],
      additionalProperties: false,
    },
  },
  {
    name: 'describe_table',
    description:
      'Get the columns, types, primary key and foreign keys of one table. Use an exact table name ' +
      'returned by search_schema. Call it for every table before using that table in SQL.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        table_name: { type: 'string', description: 'Exact table name, e.g. "order_details".' },
      },
      required: ['table_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_query',
    description:
      'Run one read-only PostgreSQL SELECT statement. Returns the column names, the row count and up ' +
      'to 20 rows. If the query is rejected or fails, the error explains why: fix the query and retry.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single SELECT statement.' },
      },
      required: ['sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_answer',
    description:
      'Finish with the final answer. Call exactly once, as the last step. "sql" must be exactly the ' +
      'SQL of a run_query call that succeeded and supports the answer, or "" if no query applies.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        answer: { type: 'string', description: 'The answer in 1 to 3 plain sentences.' },
        sql: { type: 'string', description: 'SQL of the successful query behind the answer, or "".' },
        chart: {
          type: 'string',
          enum: [...CHART_TYPES],
          description: 'How to visualise the result.',
        },
      },
      required: ['answer', 'sql', 'chart'],
      additionalProperties: false,
    },
  },
];

/**
 * Inputs are validated again on our side: strict mode makes schema-valid input
 * very likely, but tool input is still model output and is never trusted blindly.
 */
export const ToolInputs = {
  search_schema: z.object({ topic: z.string().trim().min(1).max(500) }),
  describe_table: z.object({ table_name: z.string().trim().min(1).max(128) }),
  run_query: z.object({ sql: z.string().max(5_000) }),
  submit_answer: z.object({
    answer: z.string().trim().min(1).max(2_000),
    sql: z.string().max(5_000),
    chart: z.enum(CHART_TYPES),
  }),
} as const;

export type ToolName = keyof typeof ToolInputs;

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(ToolInputs, name);
}
