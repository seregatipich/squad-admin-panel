'use client';

interface Point {
  timestamp: string;
  value: number;
}

interface Props {
  points: Point[];
  label: string;
  unit: string;
  color: string;
  maxY?: number;
  formatValue?: (v: number) => string;
}

const W = 600;
const H = 160;
const PAD = { top: 10, right: 10, bottom: 20, left: 50 };
const INNER_W = W - PAD.left - PAD.right;
const INNER_H = H - PAD.top - PAD.bottom;

function defaultFormat(v: number): string {
  if (v >= 1_073_741_824) return `${(v / 1_073_741_824).toFixed(1)} GB`;
  if (v >= 1_048_576) return `${(v / 1_048_576).toFixed(0)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${v.toFixed(1)}`;
}

export function MetricsChart({ points, label, unit, color, maxY, formatValue }: Props) {
  const fmt = formatValue ?? defaultFormat;

  if (points.length === 0) {
    return (
      <div className="rounded border border-neutral-800 bg-neutral-950 p-4">
        <span className="text-xs uppercase tracking-widest text-neutral-400">{label}</span>
        <p className="mt-2 text-sm text-neutral-500">Нет данных</p>
      </div>
    );
  }

  const values = points.map((p) => p.value);
  const yMax = maxY ?? (Math.max(...values) * 1.1 || 1);
  const yMin = 0;

  const xScale = (i: number) => PAD.left + (i / (points.length - 1 || 1)) * INNER_W;
  const yScale = (v: number) => PAD.top + INNER_H - ((v - yMin) / (yMax - yMin)) * INNER_H;

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i).toFixed(1)} ${yScale(p.value).toFixed(1)}`)
    .join(' ');

  const currentValue = values[values.length - 1] ?? 0;

  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-xs uppercase tracking-widest text-neutral-400">{label}</span>
        <span className="text-lg font-semibold" style={{ color }}>
          {fmt(currentValue)} {unit}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
      >
        <title>{label}</title>
        <line
          x1={PAD.left}
          y1={PAD.top + INNER_H}
          x2={PAD.left + INNER_W}
          y2={PAD.top + INNER_H}
          stroke="#404040"
          strokeWidth="1"
        />
        {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
          const y = yScale(yMin + frac * (yMax - yMin));
          const val = yMin + frac * (yMax - yMin);
          return (
            <g key={frac}>
              <line
                x1={PAD.left}
                y1={y}
                x2={PAD.left + INNER_W}
                y2={y}
                stroke="#262626"
                strokeWidth="0.5"
              />
              <text x={PAD.left - 4} y={y + 3} textAnchor="end" fill="#737373" fontSize="9">
                {fmt(val)}
              </text>
            </g>
          );
        })}
        <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" />
      </svg>
    </div>
  );
}
