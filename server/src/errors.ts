import type { TokenUsage } from './llm/usage.js';

/**
 * Why the SQL Guard (Layer 3) refused a query. Messages are written so they
 * can be fed back to the LLM, letting it correct its own SQL.
 */
export type SqlRejectionCode =
  | 'EMPTY'
  | 'TOO_LONG'
  | 'PARSE_ERROR'
  | 'MULTIPLE_STATEMENTS'
  | 'NOT_SELECT'
  | 'FORBIDDEN_STATEMENT'
  | 'SELECT_INTO'
  | 'FORBIDDEN_FUNCTION'
  | 'TABLE_NOT_ALLOWED';

export class SqlRejectedError extends Error {
  override readonly name = 'SqlRejectedError';

  constructor(
    readonly code: SqlRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

/** A problem found before AskDB answers anything; its message says what to fix. */
export class StartupError extends Error {}

/** A database could not be reached or logged in to at startup. */
export class DatabaseConnectionError extends StartupError {
  override readonly name = 'DatabaseConnectionError';
}

/**
 * The database role AskDB connects as is not read-only (Layer 1 is missing).
 * AskDB refuses to start rather than run AI-generated SQL with that role.
 */
export class UnsafeDatabaseRoleError extends StartupError {
  override readonly name = 'UnsafeDatabaseRoleError';

  constructor(readonly problems: string[]) {
    super(
      'Refusing to start: the database role is not read-only.\n' +
        problems.map((problem) => `  - ${problem}`).join('\n') +
        '\nConnect as a restricted role created with scripts/create-readonly-role.sql, ' +
        'then check it with scripts/verify-db-security.sh.',
    );
  }
}

/** Why the agent could not produce an answer at all. */
export type AgentFailureCode =
  | 'INVALID_QUESTION'
  | 'TOO_MANY_STEPS'
  | 'MODEL_REFUSED'
  | 'MODEL_ERROR'
  | 'CANCELLED';

export class AgentError extends Error {
  override readonly name = 'AgentError';
  /** Tokens already spent before the failure, so failed questions still count toward the budget. */
  usage?: TokenUsage;

  constructor(
    readonly code: AgentFailureCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Why the database refused or failed a query that passed the guard. */
export type QueryFailureCode =
  | 'TIMEOUT'
  | 'PERMISSION_DENIED'
  | 'READ_ONLY_VIOLATION'
  | 'SQL_ERROR'
  | 'DB_UNAVAILABLE';

export class QueryFailedError extends Error {
  override readonly name = 'QueryFailedError';

  constructor(
    readonly code: QueryFailureCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
