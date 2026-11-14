import { formatCell, humanize, isNumericColumn } from '../format';
import type { Cell } from '../types';

interface Props {
  columns: string[];
  rows: Cell[][];
  truncated: boolean;
}

export function ResultTable({ columns, rows, truncated }: Props) {
  if (rows.length === 0) return <p className="muted">The query returned no rows.</p>;
  const numeric = columns.map((_, index) => isNumericColumn(rows, index));

  return (
    <div className="table-wrap" tabIndex={0} aria-label="Query results">
      <table>
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={index} scope="col" className={numeric[index] ? 'num' : undefined}>
                {humanize(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td key={index} className={numeric[index] ? 'num' : undefined}>
                  {formatCell(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && <p className="muted table-note">Showing the first {rows.length} rows. Ask a narrower question to see fewer.</p>}
    </div>
  );
}
