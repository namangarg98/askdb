/**
 * Security Layer 5: the audit log, stored in askdb_meta.audit_log.
 *
 * Every question that reaches the agent is recorded with its outcome, the SQL
 * that ran, the steps taken, tokens and estimated cost. Clients are stored as
 * an anonymous keyed hash, never as an IP address. The same table powers the
 * daily spending cap and each client's private history, including a saved
 * snapshot of each result so history can be reopened without calling the model.
 *
 * Each entry records which database it was asked against (`source`, e.g.
 * 127.0.0.1:5434/dvdrental), and history only shows the current database's
 * questions, so "Ask again" never sends a question to a different database.
 */
import type pg from 'pg';
import type { AgentStep } from '../agent/agent.js';
import { emptyUsage, type TokenUsage } from '../llm/usage.js';

/** What is saved of a result so it can be shown again later. */
export interface ResultSnapshot {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly chart: string;
  readonly unverifiedNumbers?: readonly string[];
}

export type AuditStatus = 'answered' | 'no_data' | 'error';

export interface AuditEntry {
  readonly requestId: string;
  readonly clientId: string;
  readonly question: string;
  readonly status: AuditStatus;
  readonly errorCode?: string;
  readonly answer?: string;
  readonly sql?: string;
  readonly rowCount?: number;
  readonly steps?: readonly AgentStep[];
  readonly snapshot?: ResultSnapshot;
  readonly model: string;
  readonly usage?: TokenUsage;
  readonly costUsd?: number;
  readonly durationMs: number;
}

export interface HistoryItem {
  readonly id: string;
  readonly createdAt: string;
  readonly question: string;
  readonly status: AuditStatus;
  /** Why an 'error' entry has no answer, e.g. CANCELLED. */
  readonly errorCode: string | null;
  readonly answer: string | null;
}

/** One past question, as its owner sees it when reopening it from history. */
export interface SavedAnswer {
  readonly id: string;
  readonly createdAt: string;
  readonly question: string;
  readonly status: AuditStatus;
  readonly errorCode: string | null;
  readonly answer: string | null;
  readonly sql: string | null;
  readonly steps: readonly AgentStep[];
  /** Null for errors, or once the retention period has removed the saved rows. */
  readonly snapshot: ResultSnapshot | null;
}

export class AuditLog {
  /** `source` identifies the database this server answers questions about (see schemaSource). */
  constructor(
    private readonly metaPool: pg.Pool,
    private readonly source: string,
  ) {}

  /** Creates the table on first start. Safe to run on every start. */
  async ensureSchema(): Promise<void> {
    await this.metaPool.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id                 bigserial   PRIMARY KEY,
        request_id         uuid        NOT NULL,
        created_at         timestamptz NOT NULL DEFAULT now(),
        client_id          text        NOT NULL,
        question           text        NOT NULL,
        status             text        NOT NULL CHECK (status IN ('answered', 'no_data', 'error')),
        error_code         text,
        answer             text,
        sql                text,
        row_count          integer,
        steps              jsonb       NOT NULL DEFAULT '[]',
        model              text        NOT NULL,
        model_calls        integer     NOT NULL DEFAULT 0,
        input_tokens       integer     NOT NULL DEFAULT 0,
        output_tokens      integer     NOT NULL DEFAULT 0,
        cache_read_tokens  integer     NOT NULL DEFAULT 0,
        cache_write_tokens integer     NOT NULL DEFAULT 0,
        cost_usd           numeric(12, 6),
        duration_ms        integer     NOT NULL
      );
      -- Saved result (columns, rows, chart) for reopening history; cleared after the retention period.
      ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS result jsonb;
      -- The database a question was asked against. Rows from before this column existed stay NULL:
      -- they remain in the audit log but are not shown in any database's history.
      ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS source text;
      DROP INDEX IF EXISTS audit_log_client_created_idx;
      CREATE INDEX IF NOT EXISTS audit_log_client_source_created_idx ON audit_log (client_id, source, created_at DESC);
      CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at);
    `);
  }

  async record(entry: AuditEntry): Promise<void> {
    const usage = entry.usage ?? emptyUsage();
    await this.metaPool.query(
      `INSERT INTO audit_log (request_id, client_id, question, status, error_code, answer, sql, row_count,
         steps, model, model_calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         cost_usd, duration_ms, result, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        entry.requestId, entry.clientId, entry.question, entry.status, entry.errorCode ?? null,
        entry.answer ?? null, entry.sql ?? null, entry.rowCount ?? null, JSON.stringify(entry.steps ?? []),
        entry.model, usage.modelCalls, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens,
        usage.cacheWriteTokens, entry.costUsd ?? null, entry.durationMs,
        entry.snapshot ? JSON.stringify(entry.snapshot) : null, this.source,
      ],
    );
  }

  /** A client's own recent questions about this database, newest first. Never returns other clients' rows. */
  async history(clientId: string, limit: number): Promise<HistoryItem[]> {
    const result = await this.metaPool.query<{
      id: string; created_at: string; question: string; status: AuditStatus; error_code: string | null; answer: string | null;
    }>(
      `SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
              question, status, error_code, answer
       FROM audit_log WHERE client_id = $1 AND source = $3
       ORDER BY created_at DESC LIMIT $2`,
      [clientId, limit, this.source],
    );
    return result.rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      question: row.question,
      status: row.status,
      errorCode: row.error_code,
      answer: row.answer,
    }));
  }

  /**
   * One saved answer, only if it belongs to `clientId` and was asked about this database.
   * Anything else returns undefined, exactly like an id that does not exist.
   */
  async findSaved(clientId: string, id: string): Promise<SavedAnswer | undefined> {
    const result = await this.metaPool.query<{
      id: string; created_at: string; question: string; status: AuditStatus; error_code: string | null;
      answer: string | null; sql: string | null; steps: AgentStep[]; result: ResultSnapshot | null;
    }>(
      `SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
              question, status, error_code, answer, sql, steps, result
       FROM audit_log WHERE id = $1 AND client_id = $2 AND source = $3`,
      [id, clientId, this.source],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.id, createdAt: row.created_at, question: row.question, status: row.status,
      errorCode: row.error_code, answer: row.answer, sql: row.sql, steps: row.steps, snapshot: row.result,
    };
  }

  /**
   * Drops saved result rows older than the retention period. The audit record
   * itself (question, SQL, outcome, cost) is kept; only the bulky data goes.
   */
  async expireSnapshots(retentionDays: number): Promise<number> {
    const result = await this.metaPool.query(
      `UPDATE audit_log SET result = NULL
       WHERE result IS NOT NULL AND created_at < now() - make_interval(days => $1)`,
      [retentionDays],
    );
    return result.rowCount ?? 0;
  }

  /** Estimated Claude spend since midnight UTC, across all clients. */
  async spentTodayUsd(): Promise<number> {
    const result = await this.metaPool.query<{ spent: string | null }>(
      `SELECT sum(cost_usd) AS spent FROM audit_log
       WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    );
    return Number(result.rows[0]?.spent ?? 0);
  }
}
