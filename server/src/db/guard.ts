/**
 * Security Layer 3: the SQL Guard.
 *
 * Every SQL statement the LLM writes is treated as untrusted input. Before it
 * reaches the database it must parse cleanly and be exactly one plain SELECT
 * that only reads allowed tables and calls no dangerous functions.
 *
 * The guard fails closed: anything it cannot parse or recognise is rejected.
 * It is not the last line of defence. A parser can disagree with PostgreSQL
 * on unusual SQL, so Layer 1 (read-only role) and Layer 2 (read-only,
 * time-limited transaction) still stop anything that slips through.
 */
import sqlParser from 'node-sql-parser';
import { SqlRejectedError } from '../errors.js';

const { Parser } = sqlParser;
const parser = new Parser();
const PARSER_OPTIONS = { database: 'PostgreSQL' } as const;

const DEFAULT_MAX_SQL_LENGTH = 5_000;

/** Statement types that must never appear anywhere in the query tree. */
const FORBIDDEN_STATEMENT_TYPES = new Set([
  'insert', 'update', 'delete', 'replace', 'create', 'drop', 'alter',
  'truncate', 'rename', 'grant', 'revoke', 'set', 'lock', 'call', 'exec',
  'transaction', 'use', 'copy',
]);

/** Function families that read server internals, touch files or open connections. */
const FORBIDDEN_FUNCTION_PREFIXES = ['pg_', 'lo_', 'dblink'];

/** Individual functions that change settings, sequences, or run SQL from a string. */
const FORBIDDEN_FUNCTIONS = new Set([
  'set_config', 'nextval', 'setval', 'currval', 'lastval',
  'query_to_xml', 'query_to_xmlschema', 'query_to_xml_and_xmlschema',
  'cursor_to_xml', 'cursor_to_xmlschema',
  'table_to_xml', 'table_to_xmlschema', 'table_to_xml_and_xmlschema',
  'schema_to_xml', 'schema_to_xmlschema', 'schema_to_xml_and_xmlschema',
  'database_to_xml', 'database_to_xmlschema', 'database_to_xml_and_xmlschema',
]);

const ALLOWED_SCHEMAS = new Set(['null', 'public']);

declare const validatedBrand: unique symbol;

/**
 * SQL that has passed the guard. The brand means the executor's type signature
 * only accepts output of `validateSql`, so unchecked SQL cannot reach it by accident.
 */
export interface ValidatedQuery {
  readonly sql: string;
  readonly tables: readonly string[];
  readonly [validatedBrand]: true;
}

export interface GuardOptions {
  /** Lower-case names of tables the query may read (schema `public`). */
  readonly allowedTables: ReadonlySet<string>;
  readonly maxLength?: number;
}

export function validateSql(rawSql: string, options: GuardOptions): ValidatedQuery {
  const sql = normalise(rawSql);
  const maxLength = options.maxLength ?? DEFAULT_MAX_SQL_LENGTH;

  if (sql.length === 0) {
    throw new SqlRejectedError('EMPTY', 'The query is empty.');
  }
  if (sql.length > maxLength) {
    throw new SqlRejectedError('TOO_LONG', `The query is longer than ${maxLength} characters.`);
  }

  const statements = parse(sql);
  if (statements.length !== 1) {
    throw new SqlRejectedError(
      'MULTIPLE_STATEMENTS',
      `Exactly one statement is allowed, but ${statements.length} were found.`,
    );
  }

  const [statement] = statements;
  if (statement?.type !== 'select') {
    throw new SqlRejectedError(
      'NOT_SELECT',
      `Only SELECT queries are allowed, but this is a ${String(statement?.type).toUpperCase()} statement.`,
    );
  }

  const cteNames = inspectTree(statement);
  const tables = checkTables(sql, options.allowedTables, cteNames);

  return { sql, tables } as unknown as ValidatedQuery;
}

/** Trim whitespace and trailing semicolons, which are harmless on a single statement. */
export function normalise(rawSql: string): string {
  return rawSql.trim().replace(/;+\s*$/, '').trim();
}

type AstNode = Record<string, unknown>;

function parse(sql: string): AstNode[] {
  try {
    const ast = parser.astify(sql, PARSER_OPTIONS) as unknown;
    return (Array.isArray(ast) ? ast : [ast]) as AstNode[];
  } catch {
    throw new SqlRejectedError(
      'PARSE_ERROR',
      'The query could not be parsed as a supported PostgreSQL SELECT statement. Use standard SELECT syntax.',
    );
  }
}

/**
 * Walks every node of the parsed query (including subqueries, CTEs and UNION
 * branches) to reject forbidden statements, SELECT INTO and blocked functions.
 * Returns the names defined in WITH clauses, so they are not mistaken for tables.
 */
function inspectTree(root: AstNode): Set<string> {
  const cteNames = new Set<string>();

  walk(root, (node) => {
    const type = typeof node.type === 'string' ? node.type.toLowerCase() : undefined;

    if (type && FORBIDDEN_STATEMENT_TYPES.has(type)) {
      throw new SqlRejectedError(
        'FORBIDDEN_STATEMENT',
        `${type.toUpperCase()} is not allowed anywhere in the query. Only read data with SELECT.`,
      );
    }

    if (isSelectInto(node)) {
      throw new SqlRejectedError('SELECT_INTO', 'SELECT ... INTO creates a table and is not allowed.');
    }

    if (type === 'function') {
      const name = functionName(node);
      if (name && isForbiddenFunction(name)) {
        throw new SqlRejectedError('FORBIDDEN_FUNCTION', `The function ${name}() is not allowed.`);
      }
    }

    if (Array.isArray(node.with)) {
      for (const cte of node.with as AstNode[]) {
        const cteName = identifierValue(cte.name);
        if (cteName) cteNames.add(cteName.toLowerCase());
      }
    }
  });

  return cteNames;
}

function walk(value: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (value !== null && typeof value === 'object') {
    const node = value as AstNode;
    visit(node);
    for (const child of Object.values(node)) walk(child, visit);
  }
}

function isSelectInto(node: AstNode): boolean {
  const into = node.into as AstNode | undefined;
  return node.type === 'select' && into != null && into.expr != null;
}

function functionName(node: AstNode): string | undefined {
  const name = node.name as unknown;
  if (typeof name === 'string') return name.toLowerCase();
  const parts = (name as { name?: unknown } | undefined)?.name;
  if (Array.isArray(parts)) {
    return parts.map((part) => identifierValue(part) ?? '').join('.').toLowerCase();
  }
  return undefined;
}

function identifierValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const inner = (value as { value?: unknown } | undefined)?.value;
  return typeof inner === 'string' ? inner : undefined;
}

function isForbiddenFunction(name: string): boolean {
  const baseName = name.split('.').pop() ?? name;
  return (
    FORBIDDEN_FUNCTIONS.has(baseName) ||
    FORBIDDEN_FUNCTION_PREFIXES.some((prefix) => baseName.startsWith(prefix))
  );
}

/** Every referenced table must be in `public` and on the allow-list (or be a CTE name). */
function checkTables(sql: string, allowedTables: ReadonlySet<string>, cteNames: Set<string>): string[] {
  const referenced = new Set<string>();

  // Entries look like "select::<schema or null>::<table>".
  for (const entry of parser.tableList(sql, PARSER_OPTIONS)) {
    const [, schema = 'null', rawTable = ''] = entry.split('::');
    const table = rawTable.toLowerCase();
    const schemaName = schema.toLowerCase();

    if (!ALLOWED_SCHEMAS.has(schemaName)) {
      throw new SqlRejectedError(
        'TABLE_NOT_ALLOWED',
        `Tables in schema "${schema}" cannot be queried. Only use the provided tables.`,
      );
    }
    if (schemaName === 'null' && cteNames.has(table)) continue;
    if (!allowedTables.has(table)) {
      throw new SqlRejectedError(
        'TABLE_NOT_ALLOWED',
        `The table "${rawTable}" does not exist or is not allowed. Only use the provided tables.`,
      );
    }
    referenced.add(table);
  }

  return [...referenced].sort();
}
