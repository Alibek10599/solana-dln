import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import type { DailyVolume } from '../types';

interface VolumeChartProps {
  data: DailyVolume[];
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatUsd(value: number): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(0)}K`;
  }
  return `$${value.toFixed(0)}`;
}

export function VolumeChart({ data }: VolumeChartProps) {
  const chartData = data.map((d) => ({
    ...d,
    date: formatDate(d.date),
  }));

  return (
    <div className="bg-debridge-card border border-debridge-border rounded-xl p-6">
      <h2 className="text-lg font-semibold mb-4">Daily USD Volumes</h2>
      
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="colorCreated" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="colorFulfilled" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#2D2D44" />
            <XAxis
              dataKey="date"
              tick={{ fill: '#9ca3af', fontSize: 12 }}
              axisLine={{ stroke: '#2D2D44' }}
              tickLine={{ stroke: '#2D2D44' }}
            />
            <YAxis
              tick={{ fill: '#9ca3af', fontSize: 12 }}
              axisLine={{ stroke: '#2D2D44' }}
              tickLine={{ stroke: '#2D2D44' }}
              tickFormatter={formatUsd}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1A1A2E',
                border: '1px solid #2D2D44',
                borderRadius: '8px',
              }}
              labelStyle={{ color: '#fff' }}
              formatter={(value: number, name: string) => [
                formatUsd(value),
                name === 'createdVolumeUsd' ? 'Created Volume' : 'Fulfilled Volume',
              ]}
            />
            <Legend
              formatter={(value) =>
                value === 'createdVolumeUsd' ? 'Created' : 'Fulfilled'
              }
            />
            <Area
              type="monotone"
              dataKey="createdVolumeUsd"
              stroke="#22c55e"
              fillOpacity={1}
              fill="url(#colorCreated)"
              strokeWidth={2}
            />
            <Area
              type="monotone"
              dataKey="fulfilledVolumeUsd"
              stroke="#3b82f6"
              fillOpacity={1}
              fill="url(#colorFulfilled)"
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
