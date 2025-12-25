import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import type { TokenStat } from '../types';

interface TopTokensProps {
  tokens: TokenStat[];
}

const COLORS = [
  '#7B3FE4', // debridge purple
  '#4F46E5', // indigo
  '#3B82F6', // blue
  '#22C55E', // green
  '#F59E0B', // amber
  '#EF4444', // red
  '#8B5CF6', // violet
  '#EC4899', // pink
  '#06B6D4', // cyan
  '#84CC16', // lime
];

function formatUsd(value: number): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(0)}K`;
  }
  return `$${value.toFixed(0)}`;
}

export function TopTokens({ tokens }: TopTokensProps) {
  return (
    <div className="bg-debridge-card border border-debridge-border rounded-xl p-6 h-full">
      <h2 className="text-lg font-semibold mb-4">Top Tokens by Volume</h2>
      
      {tokens.length === 0 ? (
        <div className="h-64 flex items-center justify-center text-gray-500">
          No token data available
        </div>
      ) : (
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={tokens}
              layout="vertical"
              margin={{ top: 0, right: 0, left: 0, bottom: 0 }}
            >
              <XAxis
                type="number"
                tick={{ fill: '#9ca3af', fontSize: 10 }}
                axisLine={{ stroke: '#2D2D44' }}
                tickLine={{ stroke: '#2D2D44' }}
                tickFormatter={formatUsd}
              />
              <YAxis
                type="category"
                dataKey="symbol"
                tick={{ fill: '#fff', fontSize: 12 }}
                axisLine={{ stroke: '#2D2D44' }}
                tickLine={false}
                width={60}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1A1A2E',
                  border: '1px solid #2D2D44',
                  borderRadius: '8px',
                }}
                formatter={(value: number) => [formatUsd(value), 'Volume']}
              />
              <Bar dataKey="volumeUsd" radius={[0, 4, 4, 0]}>
                {tokens.map((_, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Token list below chart */}
      <div className="mt-4 space-y-2">
        {tokens.slice(0, 5).map((token, index) => (
          <div
            key={token.symbol}
            className="flex items-center justify-between text-sm"
          >
            <div className="flex items-center gap-2">
              <div
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: COLORS[index % COLORS.length] }}
              />
              <span>{token.symbol}</span>
            </div>
            <div className="text-gray-400">
              {token.orderCount.toLocaleString()} orders
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
