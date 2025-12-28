import { useState, useEffect } from 'react';
import { 
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, Legend
} from 'recharts';
import { Globe, TrendingUp, Users, ArrowRightLeft, Clock, ExternalLink } from 'lucide-react';

interface ChainStats {
  chain_id: number;
  chain_name: string;
  order_count: number;
  volume_usd: number;
}

interface TimeFilteredStats {
  period: string;
  total_created: number;
  total_fulfilled: number;
  total_volume_usd: number;
  fill_rate: number;
  avg_order_size: number;
  median_order_size: number;
}

interface AddressStats {
  address: string;
  orderCount: number;
  volumeUsd: number;
}

interface TokenPair {
  giveToken: string;
  takeToken: string;
  orderCount: number;
  volumeUsd: number;
}

interface OrderLifecycle {
  order_id: string;
  created_at: string | null;
  fulfilled_at: string | null;
  maker: string | null;
  taker: string | null;
  give_token: string | null;
  take_token: string | null;
  amount_usd: number | null;
  time_to_fill_seconds: number | null;
}

const CHAIN_COLORS: Record<string, string> = {
  'Solana': '#9945FF',
  'Ethereum': '#627EEA',
  'Arbitrum': '#28A0F0',
  'Base': '#0052FF',
  'Optimism': '#FF0420',
  'Polygon': '#8247E5',
  'BSC': '#F3BA2F',
  'Avalanche': '#E84142',
};

function formatUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '-';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function shortenAddress(address: string | null): string {
  if (!address) return '-';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function AnalyticsPage() {
  const [period, setPeriod] = useState('24h');
  const [stats, setStats] = useState<TimeFilteredStats | null>(null);
  const [chains, setChains] = useState<{ source: ChainStats[]; destination: ChainStats[] }>({ source: [], destination: [] });
  const [topMakers, setTopMakers] = useState<AddressStats[]>([]);
  const [topTakers, setTopTakers] = useState<AddressStats[]>([]);
  const [tokenPairs, setTokenPairs] = useState<TokenPair[]>([]);
  const [recentFills, setRecentFills] = useState<OrderLifecycle[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const [statsRes, chainsRes, makersRes, takersRes, pairsRes, fillsRes] = await Promise.all([
          fetch(`/api/analytics/stats?period=${period}`),
          fetch('/api/analytics/chains'),
          fetch('/api/analytics/top-makers?limit=10'),
          fetch('/api/analytics/top-takers?limit=10'),
          fetch('/api/analytics/token-pairs?limit=15'),
          fetch('/api/analytics/recent-fills?limit=10'),
        ]);

        const [statsData, chainsData, makersData, takersData, pairsData, fillsData] = await Promise.all([
          statsRes.json(),
          chainsRes.json(),
          makersRes.json(),
          takersRes.json(),
          pairsRes.json(),
          fillsRes.json(),
        ]);

        if (statsData.success) setStats(statsData.data);
        if (chainsData.success) setChains(chainsData.data);
        if (makersData.success) setTopMakers(makersData.data);
        if (takersData.success) setTopTakers(takersData.data);
        if (pairsData.success) setTokenPairs(pairsData.data);
        if (fillsData.success) setRecentFills(fillsData.data);
      } catch (error) {
        console.error('Failed to fetch analytics:', error);
      }
      setLoading(false);
    };

    fetchData();
  }, [period]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-debridge-purple"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Time Period Selector */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">Advanced Analytics</h2>
        <div className="flex gap-1 bg-debridge-dark rounded-lg p-1">
          {['1h', '24h', '7d', '30d', 'all'].map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-4 py-2 text-sm rounded-md transition-colors ${
                period === p
                  ? 'bg-debridge-purple text-white'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              {p === 'all' ? 'All Time' : p.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Key Metrics */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricCard
            icon={<TrendingUp className="w-5 h-5" />}
            label="Fill Rate"
            value={`${stats.fill_rate.toFixed(1)}%`}
            subtext={`${stats.total_fulfilled} of ${stats.total_created} orders`}
          />
          <MetricCard
            icon={<ArrowRightLeft className="w-5 h-5" />}
            label="Avg Order Size"
            value={formatUsd(stats.avg_order_size)}
            subtext={`Median: ${formatUsd(stats.median_order_size)}`}
          />
          <MetricCard
            icon={<Globe className="w-5 h-5" />}
            label="Volume"
            value={formatUsd(stats.total_volume_usd)}
            subtext={`${period === 'all' ? 'All time' : `Last ${period}`}`}
          />
          <MetricCard
            icon={<Users className="w-5 h-5" />}
            label="Orders"
            value={stats.total_created.toLocaleString()}
            subtext="Created orders"
          />
        </div>
      )}

      {/* Chain Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChainBreakdownChart title="Source Chains" data={chains.source} />
        <ChainBreakdownChart title="Destination Chains" data={chains.destination} />
      </div>

      {/* Token Pairs Heatmap */}
      <div className="bg-debridge-card border border-debridge-border rounded-xl p-6">
        <h3 className="text-lg font-semibold mb-4">Popular Token Pairs</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {tokenPairs.slice(0, 10).map((pair, idx) => (
            <div
              key={`${pair.giveToken}-${pair.takeToken}`}
              className="bg-debridge-dark rounded-lg p-3 text-center"
              style={{
                opacity: 1 - (idx * 0.08),
              }}
            >
              <div className="text-sm font-medium text-white">
                {pair.giveToken} → {pair.takeToken}
              </div>
              <div className="text-xs text-gray-400 mt-1">
                {pair.orderCount.toLocaleString()} orders
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Leaderboards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <LeaderboardCard title="Top Makers" icon={<Users />} data={topMakers} />
        <LeaderboardCard title="Top Takers" icon={<Users />} data={topTakers} />
      </div>

      {/* Recent Fills with Time */}
      <div className="bg-debridge-card border border-debridge-border rounded-xl p-6">
        <div className="flex items-center gap-2 mb-4">
          <Clock className="w-5 h-5 text-debridge-purple" />
          <h3 className="text-lg font-semibold">Recent Fills</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-left text-xs text-gray-400 border-b border-debridge-border">
                <th className="pb-2">Order</th>
                <th className="pb-2">Pair</th>
                <th className="pb-2">Amount</th>
                <th className="pb-2">Fill Time</th>
                <th className="pb-2">Taker</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {recentFills.map((fill) => (
                <tr key={fill.order_id} className="border-b border-debridge-border/50">
                  <td className="py-3">
                    <code className="text-xs bg-debridge-dark px-2 py-1 rounded">
                      {fill.order_id.slice(0, 12)}...
                    </code>
                  </td>
                  <td className="py-3">
                    {fill.give_token && fill.take_token ? (
                      <span>{fill.give_token} → {fill.take_token}</span>
                    ) : '-'}
                  </td>
                  <td className="py-3 font-medium">
                    {fill.amount_usd ? formatUsd(fill.amount_usd) : '-'}
                  </td>
                  <td className="py-3">
                    <span className={`${
                      fill.time_to_fill_seconds !== null && fill.time_to_fill_seconds < 60
                        ? 'text-green-400'
                        : fill.time_to_fill_seconds !== null && fill.time_to_fill_seconds < 300
                        ? 'text-yellow-400'
                        : 'text-gray-400'
                    }`}>
                      {formatDuration(fill.time_to_fill_seconds)}
                    </span>
                  </td>
                  <td className="py-3">
                    {fill.taker && (
                      <a
                        href={`https://solscan.io/account/${fill.taker}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-debridge-purple hover:text-debridge-blue flex items-center gap-1"
                      >
                        {shortenAddress(fill.taker)}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function MetricCard({ icon, label, value, subtext }: { 
  icon: React.ReactNode;
  label: string;
  value: string;
  subtext: string;
}) {
  return (
    <div className="bg-debridge-card border border-debridge-border rounded-xl p-4">
      <div className="flex items-center gap-2 text-gray-400 mb-2">
        {icon}
        <span className="text-sm">{label}</span>
      </div>
      <div className="text-2xl font-bold text-white">{value}</div>
      <div className="text-xs text-gray-500 mt-1">{subtext}</div>
    </div>
  );
}

function ChainBreakdownChart({ title, data }: { title: string; data: ChainStats[] }) {
  return (
    <div className="bg-debridge-card border border-debridge-border rounded-xl p-6">
      <h3 className="text-lg font-semibold mb-4">{title}</h3>
      {data.length === 0 ? (
        <div className="h-64 flex items-center justify-center text-gray-500">
          No data available
        </div>
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="order_count"
                nameKey="chain_name"
                cx="50%"
                cy="50%"
                outerRadius={80}
                label={({ chain_name, percent }) => 
                  `${chain_name} ${(percent * 100).toFixed(0)}%`
                }
                labelLine={false}
              >
                {data.map((entry) => (
                  <Cell 
                    key={entry.chain_id} 
                    fill={CHAIN_COLORS[entry.chain_name] || '#6366f1'} 
                  />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1A1A2E',
                  border: '1px solid #2D2D44',
                  borderRadius: '8px',
                }}
                formatter={(value: number) => [value.toLocaleString(), 'Orders']}
              />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function LeaderboardCard({ title, icon, data }: { 
  title: string;
  icon: React.ReactNode;
  data: AddressStats[];
}) {
  return (
    <div className="bg-debridge-card border border-debridge-border rounded-xl p-6">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-debridge-purple">{icon}</span>
        <h3 className="text-lg font-semibold">{title}</h3>
      </div>
      <div className="space-y-3">
        {data.length === 0 ? (
          <div className="text-center text-gray-500 py-8">No data available</div>
        ) : (
          data.map((item, idx) => (
            <div key={item.address} className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                  idx === 0 ? 'bg-yellow-500/20 text-yellow-400' :
                  idx === 1 ? 'bg-gray-400/20 text-gray-300' :
                  idx === 2 ? 'bg-orange-500/20 text-orange-400' :
                  'bg-debridge-dark text-gray-400'
                }`}>
                  {idx + 1}
                </span>
                <a
                  href={`https://solscan.io/account/${item.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-debridge-purple hover:text-debridge-blue"
                >
                  {shortenAddress(item.address)}
                </a>
              </div>
              <div className="text-right">
                <div className="text-sm font-medium">{item.orderCount.toLocaleString()} orders</div>
                <div className="text-xs text-gray-400">{formatUsd(item.volumeUsd)}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
