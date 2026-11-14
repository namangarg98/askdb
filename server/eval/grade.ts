/**
 * Result-based grading: AskDB's rows are compared with a reference query's
 * rows, never the SQL text, so any correct query passes.
 *
 * - Values are normalised: numbers (including numeric strings) rounded to 2
 *   decimals with a small tolerance; text trimmed, lower-cased, spaces collapsed.
 * - Every reference column must match a distinct AskDB column (extra columns
 *   are allowed, e.g. a revenue column next to the names asked for).
 * - Row counts must be equal; row order is compared only for ordered cases.
 */

type Normalized = string | number | null;

export interface ResultSet {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
}

const NUMBER_TOLERANCE = 0.011;
const NUMERIC_TEXT = /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i;

export function normalizeCell(value: unknown): Normalized {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return round2(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  const text = (typeof value === 'object' ? JSON.stringify(value) : String(value)).trim();
  if (NUMERIC_TEXT.test(text)) return round2(Number(text));
  return text.toLowerCase().replace(/\s+/g, ' ');
}

/**
 * True when `candidate` contains the same answer as `reference`.
 * With `rankingOk`, a longer ranking passes when its first rows equal the reference
 * ("which X is the most?" answered with a top-5 list, best first).
 */
export function resultsMatch(candidate: ResultSet, reference: ResultSet, ordered: boolean, rankingOk = false): boolean {
  if (rankingOk && candidate.rows.length > reference.rows.length && reference.rows.length > 0) {
    return resultsMatch({ columns: candidate.columns, rows: candidate.rows.slice(0, reference.rows.length) }, reference, true);
  }
  if (candidate.rows.length !== reference.rows.length) return false;
  if (candidate.columns.length < reference.columns.length) return false;

  const cand = columnsOf(candidate);
  const ref = columnsOf(reference);

  // For each reference column, the AskDB columns holding the same values.
  const options = ref.map((refColumn) =>
    cand.map((_, index) => index).filter((index) => sameValues(cand[index] ?? [], refColumn, ordered)),
  );
  if (options.some((list) => list.length === 0)) return false;

  // Try column mappings until one also matches row by row (keeps pairs like name + total together).
  const tryMapping = (refIndex: number, used: number[]): boolean => {
    if (refIndex === ref.length) return sameRows(candidate, reference, used, ordered);
    return (options[refIndex] ?? []).some(
      (candIndex) => !used.includes(candIndex) && tryMapping(refIndex + 1, [...used, candIndex]),
    );
  };
  return tryMapping(0, []);
}

function columnsOf(result: ResultSet): Normalized[][] {
  return result.columns.map((_, index) => result.rows.map((row) => normalizeCell(row[index])));
}

function sameValues(a: Normalized[], b: Normalized[], ordered: boolean): boolean {
  const left = ordered ? a : sortValues(a);
  const right = ordered ? b : sortValues(b);
  return left.length === right.length && left.every((value, i) => cellsEqual(value, right[i] ?? null));
}

function sameRows(candidate: ResultSet, reference: ResultSet, mapping: number[], ordered: boolean): boolean {
  const project = (row: readonly unknown[], indexes: number[]) => indexes.map((i) => normalizeCell(row[i]));
  let left = candidate.rows.map((row) => project(row, mapping));
  let right = reference.rows.map((row) => project(row, reference.columns.map((_, i) => i)));
  if (!ordered) {
    left = sortRows(left);
    right = sortRows(right);
  }
  return left.every((row, r) => row.every((value, c) => cellsEqual(value, right[r]?.[c] ?? null)));
}

function cellsEqual(a: Normalized, b: Normalized): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= NUMBER_TOLERANCE + 1e-9 * Math.max(Math.abs(a), Math.abs(b));
  }
  return a === b;
}

const sortKey = (value: Normalized) => (value === null ? '\u0000' : typeof value === 'number' ? `n${value.toFixed(2).padStart(24, '0')}` : `s${value}`);
const sortValues = (values: Normalized[]) => [...values].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
const sortRows = (rows: Normalized[][]) =>
  [...rows].sort((x, y) => x.map(sortKey).join('|').localeCompare(y.map(sortKey).join('|')));

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
