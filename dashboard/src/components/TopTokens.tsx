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
    return `$${(value / 1_000).toFixed(1)}K`;
  }
  if (value >= 1) {
    return `$${value.toFixed(0)}`;
  }
  return `$${value.toFixed(2)}`;
}

export function TopTokens({ tokens }: TopTokensProps) {
  // Filter out tokens with 0 volume for the chart
  const tokensWithVolume = tokens.filter(t => t.volumeUsd > 0);
  
  return (
    <div className="bg-debridge-card border border-debridge-border rounded-xl p-6 h-full">
      <h2 className="text-lg font-semibold mb-4 text-white">Top Tokens by Volume</h2>
      
      {tokens.length === 0 ? (
        <div className="h-64 flex items-center justify-center text-gray-500">
          No token data available
        </div>
      ) : tokensWithVolume.length === 0 ? (
        // Show tokens by order count if no USD volumes
        <div className="space-y-3">
          <p className="text-sm text-gray-400 mb-4">By Order Count</p>
          {tokens.slice(0, 8).map((token, index) => (
            <div key={token.symbol} className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: COLORS[index % COLORS.length] }}
                />
                <span className="font-medium text-white">{token.symbol}</span>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-32 h-2 bg-debridge-dark rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${(token.orderCount / tokens[0].orderCount) * 100}%`,
                      backgroundColor: COLORS[index % COLORS.length],
                    }}
                  />
                </div>
                <span className="text-sm text-gray-400 w-20 text-right">
                  {token.orderCount.toLocaleString()} orders
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={tokensWithVolume.slice(0, 6)}
                layout="vertical"
                margin={{ top: 0, right: 10, left: 10, bottom: 0 }}
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
                  tick={{ fill: '#ffffff', fontSize: 12, fontWeight: 500 }}
                  axisLine={{ stroke: '#2D2D44' }}
                  tickLine={false}
                  width={50}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1A1A2E',
                    border: '1px solid #2D2D44',
                    borderRadius: '8px',
                    color: '#ffffff',
                  }}
                  labelStyle={{ color: '#ffffff' }}
                  formatter={(value: number) => [formatUsd(value), 'Volume']}
                />
                <Bar dataKey="volumeUsd" radius={[0, 4, 4, 0]}>
                  {tokensWithVolume.slice(0, 6).map((_, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Token list below chart */}
          <div className="mt-4 space-y-2 border-t border-debridge-border pt-4">
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
                  <span className="text-white font-medium">{token.symbol}</span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-gray-400">
                    {token.orderCount.toLocaleString()} orders
                  </span>
                  {token.volumeUsd > 0 && (
                    <span className="text-white font-medium">
                      {formatUsd(token.volumeUsd)}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
