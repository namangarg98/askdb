import type { Cell } from './types';

const fullNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
// Non-whole values (money, averages) always show 2 decimals, so a column reads consistently: 51,097.80 not 51,097.8.
const decimalNumber = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compactNumber = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;

/** PostgreSQL numerics arrive as strings ("110277.31"); treat any finite number-like value as numeric. */
export function toNumber(cell: Cell): number | undefined {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : undefined;
  if (typeof cell === 'string' && cell.trim() !== '' && !ISO_DATE.test(cell)) {
    const value = Number(cell);
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

export function isNumericColumn(rows: Cell[][], index: number): boolean {
  const values = rows.map((row) => row[index] ?? null).filter((cell) => cell !== null);
  return values.length > 0 && values.every((cell) => toNumber(cell) !== undefined);
}

export function formatNumber(value: number): string {
  return Number.isInteger(value) ? fullNumber.format(value) : decimalNumber.format(value);
}

/** Axis ticks: in full under 10,000, compact above (10K, 1.2M). */
export function formatAxisNumber(value: number): string {
  return Math.abs(value) < 10_000 ? fullNumber.format(value) : compactNumber.format(value);
}

/** Display text for any cell. */
export function formatCell(cell: Cell): string {
  if (cell === null) return '—';
  if (typeof cell === 'boolean') return cell ? 'true' : 'false';
  if (typeof cell === 'string' && ISO_DATE.test(cell)) return cell.slice(0, 10);
  const number = toNumber(cell);
  // Years and IDs read better without a thousands separator.
  if (number !== undefined && !(Number.isInteger(number) && Math.abs(number) < 10_000)) return formatNumber(number);
  return String(cell);
}

/** "total_revenue" -> "Total revenue" */
export function humanize(column: string): string {
  const words = column.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
