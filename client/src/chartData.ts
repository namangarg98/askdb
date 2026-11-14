/**
 * Decides how a result is shown. The agent suggests a chart type; this checks
 * the data actually fits it, so a bad suggestion degrades to a table, never to
 * a misleading chart.
 */
import { formatCell, isNumericColumn, toNumber } from './format';
import type { Cell, ChartType } from './types';

/** More bars than this stop being readable; the table is the better view. */
const MAX_BARS = 20;
const MAX_LINE_POINTS = 500;

export type View =
  | { kind: 'stat'; label: string; value: number }
  | { kind: 'bar' | 'line'; labelColumn: string; valueColumn: string; points: ChartPoint[]; otherNumericColumns: string[] }
  | { kind: 'table' };

export interface ChartPoint {
  label: string;
  value: number;
}

export function chooseView(columns: string[], rows: Cell[][], suggested: ChartType): View {
  const numeric = columns.map((_, index) => isNumericColumn(rows, index));

  // One number (e.g. "how many orders?") is a stat tile, not a one-bar chart.
  const onlyNumericIndex = numeric.indexOf(true);
  if (rows.length === 1 && onlyNumericIndex >= 0 && numeric.filter(Boolean).length === 1) {
    return { kind: 'stat', label: columns[onlyNumericIndex] ?? '', value: toNumber(rows[0]?.[onlyNumericIndex] ?? null) ?? 0 };
  }

  if ((suggested !== 'bar' && suggested !== 'line') || columns.length < 2 || rows.length < 2) {
    return { kind: 'table' };
  }

  // Label: the first text column, or the first column (e.g. a year). Value: the first numeric column after that.
  const labelIndex = numeric.indexOf(false) >= 0 ? numeric.indexOf(false) : 0;
  const valueIndex = numeric.findIndex((isNumeric, index) => isNumeric && index !== labelIndex);
  if (valueIndex < 0) return { kind: 'table' };
  if (suggested === 'bar' && rows.length > MAX_BARS) return { kind: 'table' };
  if (suggested === 'line' && rows.length > MAX_LINE_POINTS) return { kind: 'table' };

  return {
    kind: suggested,
    labelColumn: columns[labelIndex] ?? '',
    valueColumn: columns[valueIndex] ?? '',
    points: rows.map((row) => ({ label: formatCell(row[labelIndex] ?? null), value: toNumber(row[valueIndex] ?? null) ?? 0 })),
    // Plotted one measure at a time (never two y-axes); the rest stay in the table.
    otherNumericColumns: columns.filter((_, index) => numeric[index] && index !== valueIndex && index !== labelIndex),
  };
}
