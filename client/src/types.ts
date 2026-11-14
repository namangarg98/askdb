/** Shapes returned by the AskDB API (server/src/api/app.ts). */

export type ChartType = 'bar' | 'line' | 'table' | 'none';
export type Cell = string | number | boolean | null;

export interface AgentStep {
  tool: string;
  input: string;
  ok: boolean;
  summary: string;
  durationMs: number;
}

export interface AskResponse {
  requestId: string;
  status: 'answered' | 'no_data';
  answer: string;
  sql: string | null;
  columns: string[];
  rows: Cell[][];
  rowCount: number;
  truncated: boolean;
  chart: ChartType;
  /** Numbers in the answer that could not be found in the query results. */
  unverifiedNumbers: string[];
  steps: AgentStep[];
  usage: {
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estimatedCostUsd: number | null;
  };
  durationMs: number;
}

export interface HistoryItem {
  id: string;
  createdAt: string;
  question: string;
  status: 'answered' | 'no_data' | 'error';
  /** Why an 'error' entry has no answer, e.g. CANCELLED. */
  errorCode: string | null;
  answer: string | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
  requestId: string | null;
}

/** A past question reopened from history (GET /api/history/:id). No model call is made. */
export interface SavedAnswer {
  id: string;
  createdAt: string;
  question: string;
  status: 'answered' | 'no_data' | 'error';
  errorCode: string | null;
  answer: string | null;
  sql: string | null;
  steps: AgentStep[];
  /** Null for errors, or after the retention period removed the saved rows. */
  snapshot: { columns: string[]; rows: Cell[][]; rowCount: number; truncated: boolean; chart: ChartType; unverifiedNumbers?: string[] } | null;
}
