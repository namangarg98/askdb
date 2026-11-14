import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ChartPoint } from '../chartData';
import { formatAxisNumber, formatNumber, humanize } from '../format';

interface Props {
  kind: 'bar' | 'line';
  points: ChartPoint[];
  labelColumn: string;
  valueColumn: string;
}

const BAR_THICKNESS = 20; // <= 24px: thin marks, the band's leftover is air
const BAR_ROW_HEIGHT = 34;
const AXIS_TICK = { fill: 'var(--text-muted)', fontSize: 12 };

/** Single-series chart: one colour, no legend (the title names the series). */
export function ResultChart({ kind, points, labelColumn, valueColumn }: Props) {
  const title = `${humanize(valueColumn)} by ${humanize(labelColumn).toLowerCase()}`;

  return (
    <figure className="chart" aria-label={title}>
      <figcaption className="chart-title">{title}</figcaption>
      {kind === 'bar' ? <HorizontalBars points={points} /> : <TrendLine points={points} />}
    </figure>
  );
}

function HorizontalBars({ points }: { points: ChartPoint[] }) {
  const longestLabel = Math.max(...points.map((p) => p.label.length));
  const labelWidth = Math.min(200, Math.max(60, longestLabel * 7.5));

  return (
    <ResponsiveContainer width="100%" height={points.length * BAR_ROW_HEIGHT + 40}>
      <BarChart data={points} layout="vertical" margin={{ top: 4, right: 72, bottom: 4, left: 4 }}>
        <CartesianGrid horizontal={false} stroke="var(--grid)" strokeWidth={1} />
        <XAxis type="number" tickFormatter={formatAxisNumber} tick={AXIS_TICK} axisLine={{ stroke: 'var(--axis)' }} tickLine={false} />
        <YAxis type="category" dataKey="label" width={labelWidth} tick={AXIS_TICK} axisLine={{ stroke: 'var(--axis)' }} tickLine={false} interval={0} />
        <Tooltip cursor={{ fill: 'var(--hover-wash)' }} content={(props) => <ChartTooltip active={props.active} payload={props.payload} />} />
        {/* Rounded data-end, square at the baseline. */}
        <Bar dataKey="value" fill="var(--series-1)" barSize={BAR_THICKNESS} radius={[0, 4, 4, 0]} isAnimationActive={false}>
          <LabelList dataKey="value" position="right" formatter={(v: unknown) => formatNumber(Number(v))} fill="var(--text-secondary)" fontSize={12} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function TrendLine({ points }: { points: ChartPoint[] }) {
  const last = points.length - 1;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={points} margin={{ top: 16, right: 72, bottom: 4, left: 4 }}>
        <CartesianGrid vertical={false} stroke="var(--grid)" strokeWidth={1} />
        <XAxis dataKey="label" tick={AXIS_TICK} axisLine={{ stroke: 'var(--axis)' }} tickLine={false} minTickGap={16} />
        <YAxis tickFormatter={formatAxisNumber} tick={AXIS_TICK} axisLine={false} tickLine={false} width={56} />
        {/* Crosshair: a hairline that snaps to the nearest point. */}
        <Tooltip cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }} content={(props) => <ChartTooltip active={props.active} payload={props.payload} />} />
        <Line
          type="linear"
          dataKey="value"
          stroke="var(--series-1)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          isAnimationActive={false}
          // Only the end point gets a dot (>= 8px with a 2px surface ring) and a value label.
          dot={(props: { cx?: number; cy?: number; index?: number }) =>
            props.index === last && props.cx !== undefined && props.cy !== undefined ? (
              <g key="end">
                <circle cx={props.cx} cy={props.cy} r={5} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
                <text x={props.cx + 10} y={props.cy + 4} fill="var(--text-secondary)" fontSize={12}>
                  {formatNumber(points[last]?.value ?? 0)}
                </text>
              </g>
            ) : (
              <g key={props.index} />
            )
          }
          activeDot={{ r: 5, fill: 'var(--series-1)', stroke: 'var(--surface)', strokeWidth: 2 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Value leads (strong), label follows (secondary). Rendered as React text, never HTML. */
function ChartTooltip({ active, payload }: { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }) {
  const point = payload?.[0]?.payload as ChartPoint | undefined;
  if (!active || !point) return null;
  return (
    <div className="chart-tooltip">
      <span className="chart-tooltip-key" aria-hidden="true" />
      <strong>{formatNumber(point.value)}</strong>
      <span>{point.label}</span>
    </div>
  );
}
