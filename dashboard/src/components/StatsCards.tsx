import { TrendingUp, ArrowRightLeft, DollarSign, CheckCircle } from 'lucide-react';
import type { DashboardStats } from '../types';

interface StatsCardsProps {
  stats: DashboardStats;
}

function formatNumber(num: number): string {
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(2)}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K`;
  }
  return num.toLocaleString();
}

function formatUsd(amount: number): string {
  if (amount >= 1_000_000) {
    return `$${(amount / 1_000_000).toFixed(2)}M`;
  }
  if (amount >= 1_000) {
    return `$${(amount / 1_000).toFixed(1)}K`;
  }
  return `$${amount.toFixed(2)}`;
}

export function StatsCards({ stats }: StatsCardsProps) {
  const cards = [
    {
      title: 'Orders Created',
      value: formatNumber(stats.totalOrdersCreated),
      icon: ArrowRightLeft,
      color: 'from-green-500 to-emerald-600',
      subtitle: 'Total on Solana',
    },
    {
      title: 'Orders Fulfilled',
      value: formatNumber(stats.totalOrdersFulfilled),
      icon: CheckCircle,
      color: 'from-blue-500 to-indigo-600',
      subtitle: 'Total on Solana',
    },
    {
      title: 'Created Volume',
      value: formatUsd(stats.totalVolumeCreatedUsd),
      icon: DollarSign,
      color: 'from-purple-500 to-debridge-purple',
      subtitle: 'USD equivalent',
    },
    {
      title: 'Fulfilled Volume',
      value: formatUsd(stats.totalVolumeFulfilledUsd),
      icon: TrendingUp,
      color: 'from-orange-500 to-red-500',
      subtitle: 'USD equivalent',
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card) => (
        <div
          key={card.title}
          className="bg-debridge-card border border-debridge-border rounded-xl p-6 hover:border-debridge-purple/50 transition-colors"
        >
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-gray-400">{card.title}</p>
              <p className="text-2xl font-bold mt-1">{card.value}</p>
              <p className="text-xs text-gray-500 mt-1">{card.subtitle}</p>
            </div>
            <div className={`p-3 rounded-lg bg-gradient-to-br ${card.color}`}>
              <card.icon className="w-5 h-5 text-white" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
