import { ExternalLink, ArrowRightLeft, CheckCircle } from 'lucide-react';
import type { RecentOrder } from '../types';

interface RecentOrdersTableProps {
  orders: RecentOrder[];
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function shortenAddress(address: string | null): string {
  if (!address) return '-';
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function shortenSignature(sig: string): string {
  return `${sig.slice(0, 8)}...${sig.slice(-8)}`;
}

export function RecentOrdersTable({ orders }: RecentOrdersTableProps) {
  return (
    <div className="bg-debridge-card border border-debridge-border rounded-xl overflow-hidden">
      <div className="p-6 border-b border-debridge-border">
        <h2 className="text-lg font-semibold">Recent Orders</h2>
      </div>
      
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-debridge-border">
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                Type
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                Order ID
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                Token
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                Amount (USD)
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                Address
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                Time
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                Tx
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-debridge-border">
            {orders.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-6 py-8 text-center text-gray-500">
                  No orders found
                </td>
              </tr>
            ) : (
              orders.map((order) => (
                <tr
                  key={`${order.signature}-${order.eventType}`}
                  className="hover:bg-debridge-border/30 transition-colors"
                >
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      {order.eventType === 'created' ? (
                        <>
                          <ArrowRightLeft className="w-4 h-4 text-green-400" />
                          <span className="text-green-400 text-sm">Created</span>
                        </>
                      ) : (
                        <>
                          <CheckCircle className="w-4 h-4 text-blue-400" />
                          <span className="text-blue-400 text-sm">Fulfilled</span>
                        </>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <code className="text-xs text-gray-300 bg-debridge-dark px-2 py-1 rounded">
                      {order.orderId.slice(0, 16)}...
                    </code>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className="font-medium">
                      {order.eventType === 'created'
                        ? order.giveTokenSymbol || '-'
                        : order.takeTokenSymbol || '-'}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {order.eventType === 'created' && order.giveAmountUsd
                      ? `$${order.giveAmountUsd.toFixed(2)}`
                      : order.eventType === 'fulfilled' && order.takeAmountUsd
                      ? `$${order.takeAmountUsd.toFixed(2)}`
                      : '-'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <code className="text-xs text-gray-400">
                      {shortenAddress(
                        order.eventType === 'created' ? order.maker : order.taker
                      )}
                    </code>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400">
                    {formatDate(order.blockTime)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <a
                      href={`https://solscan.io/tx/${order.signature}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-debridge-purple hover:text-debridge-purple/80 transition-colors"
                    >
                      {shortenSignature(order.signature)}
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
