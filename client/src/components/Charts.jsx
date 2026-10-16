import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, AreaChart, Area,
} from 'recharts';
import { EmptyState } from './ui.jsx';
import { BarChart3 } from 'lucide-react';

// Charts read right-to-left (time flows like Hebrew text), values on the right axis.
const axis = { tick: { fill: 'var(--text-3)', fontSize: 12 }, tickLine: false, axisLine: false };

function TooltipBox({ active, payload, label, labelFormatter, unit = 'שעות' }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{labelFormatter ? labelFormatter(label) : label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex" style={{ gap: 6 }}>
          {payload.length > 1 && <i style={{ width: 10, height: 10, borderRadius: 3, background: p.color, display: 'inline-block' }} />}
          <span className="muted">{payload.length > 1 ? p.name : unit}:</span>
          <strong>{p.value}</strong>
        </div>
      ))}
    </div>
  );
}

function NoData() {
  return <EmptyState icon={BarChart3} title="אין עדיין נתונים להצגה" text="הנתונים יופיעו כאן לאחר שיירשמו משמרות ונוכחות." />;
}

export function HoursBar({ data, xKey, yKey = 'hours', tickFormatter, labelFormatter, height = 260, horizontal = false, unit }) {
  if (!data?.length || data.every((d) => !d[yKey])) return <NoData />;
  if (horizontal) {
    return (
      <div style={{ height: Math.max(height, data.length * 30 + 30) }} dir="ltr">
        <ResponsiveContainer>
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 8, left: 8, bottom: 4 }} barCategoryGap={6}>
            <CartesianGrid horizontal={false} stroke="var(--grid)" />
            <XAxis type="number" reversed {...axis} />
            <YAxis type="category" dataKey={xKey} orientation="right" width={92} {...axis} tick={{ fill: 'var(--text-2)', fontSize: 12 }} />
            <Tooltip cursor={{ fill: 'var(--surface-3)' }} content={<TooltipBox labelFormatter={labelFormatter} unit={unit} />} />
            <Bar dataKey={yKey} fill="var(--series-1)" radius={[4, 0, 0, 4]} maxBarSize={18} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }
  return (
    <div style={{ height }} dir="ltr">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey={xKey} reversed tickFormatter={tickFormatter} {...axis} interval="preserveStartEnd" />
          <YAxis orientation="right" width={36} {...axis} />
          <Tooltip cursor={{ fill: 'var(--surface-3)' }} content={<TooltipBox labelFormatter={labelFormatter} unit={unit} />} />
          <Bar dataKey={yKey} fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={34} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function HoursArea({ data, xKey, yKey = 'hours', tickFormatter, labelFormatter, height = 260 }) {
  if (!data?.length) return <NoData />;
  return (
    <div style={{ height }} dir="ltr">
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.28} />
              <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey={xKey} reversed tickFormatter={tickFormatter} {...axis} />
          <YAxis orientation="right" width={40} {...axis} />
          <Tooltip cursor={{ stroke: 'var(--border-strong)' }} content={<TooltipBox labelFormatter={labelFormatter} />} />
          <Area type="monotone" dataKey={yKey} stroke="var(--series-1)" strokeWidth={2} fill="url(#areaFill)" dot={{ r: 4, fill: 'var(--series-1)', strokeWidth: 2, stroke: 'var(--surface)' }} activeDot={{ r: 6 }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];

export function StackedBar({ data, xKey, keys, height = 260 }) {
  if (!data?.length || data.every((d) => keys.every((k) => !d[k]))) return <NoData />;
  return (
    <>
      <div className="chart-legend" style={{ marginBottom: 8 }}>
        {keys.map((k, i) => <span key={k}><i style={{ background: SERIES[i] }} />{k}</span>)}
      </div>
      <div style={{ height }} dir="ltr">
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey={xKey} reversed {...axis} />
            <YAxis orientation="right" width={30} allowDecimals={false} {...axis} />
            <Tooltip cursor={{ fill: 'var(--surface-3)' }} content={<TooltipBox />} />
            {keys.map((k, i) => (
              <Bar key={k} dataKey={k} name={k} stackId="a" fill={SERIES[i]} stroke="var(--surface)" strokeWidth={2}
                radius={i === keys.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={34} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}
