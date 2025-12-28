import { useState } from 'react';
import { ExternalLink, ArrowRightLeft, CheckCircle, Search, ChevronLeft, ChevronRight, Download } from 'lucide-react';
import type { RecentOrder } from '../types';
import { OrderModal } from './OrderModal';

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

function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) return '-';
  if (value >= 1000000) return `$${(value / 1000000).toFixed(2)}M`;
  if (value >= 1000) return `$${(value / 1000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

// CSV Export function
function exportToCSV(orders: RecentOrder[], filename: string = 'dln-orders.csv') {
  const headers = [
    'Order ID',
    'Type',
    'Give Token',
    'Give Amount USD',
    'Take Token', 
    'Take Amount USD',
    'Maker',
    'Taker',
    'Time',
    'Transaction',
  ];

  const rows = orders.map(order => [
    order.orderId,
    order.eventType,
    order.giveTokenSymbol || '',
    order.giveAmountUsd?.toString() || '',
    order.takeTokenSymbol || '',
    order.takeAmountUsd?.toString() || '',
    order.maker || '',
    order.taker || '',
    order.blockTime,
    order.signature,
  ]);

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function RecentOrdersTable({ orders }: RecentOrdersTableProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'created' | 'fulfilled'>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedOrder, setSelectedOrder] = useState<RecentOrder | null>(null);
  const itemsPerPage = 10;

  // Filter orders
  const filteredOrders = orders.filter(order => {
    const matchesType = filterType === 'all' || order.eventType === filterType;
    const matchesSearch = searchQuery === '' || 
      order.orderId.toLowerCase().includes(searchQuery.toLowerCase()) ||
      order.signature.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (order.maker?.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (order.taker?.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (order.giveTokenSymbol?.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (order.takeTokenSymbol?.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchesType && matchesSearch;
  });

  // Pagination
  const totalPages = Math.ceil(filteredOrders.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const paginatedOrders = filteredOrders.slice(startIndex, startIndex + itemsPerPage);

  const handleFilterChange = (type: 'all' | 'created' | 'fulfilled') => {
    setFilterType(type);
    setCurrentPage(1);
  };

  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    setCurrentPage(1);
  };

  const handleExport = () => {
    const timestamp = new Date().toISOString().split('T')[0];
    exportToCSV(filteredOrders, `dln-orders-${timestamp}.csv`);
  };

  return (
    <>
      <div className="bg-debridge-card border border-debridge-border rounded-xl overflow-hidden">
        {/* Header with search, filters, and export */}
        <div className="p-6 border-b border-debridge-border">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <h2 className="text-lg font-semibold">Recent Orders</h2>
            
            <div className="flex flex-col sm:flex-row gap-3">
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search orders..."
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="pl-10 pr-4 py-2 bg-debridge-dark border border-debridge-border rounded-lg text-sm focus:outline-none focus:border-debridge-purple w-full sm:w-64"
                />
              </div>
              
              {/* Filter buttons */}
              <div className="flex gap-1 bg-debridge-dark rounded-lg p-1">
                <button
                  onClick={() => handleFilterChange('all')}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                    filterType === 'all' 
                      ? 'bg-debridge-purple text-white' 
                      : 'text-gray-400 hover:text-white'
                  }`}
                >
                  All
                </button>
                <button
                  onClick={() => handleFilterChange('created')}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                    filterType === 'created' 
                      ? 'bg-green-500/20 text-green-400' 
                      : 'text-gray-400 hover:text-white'
                  }`}
                >
                  Created
                </button>
                <button
                  onClick={() => handleFilterChange('fulfilled')}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                    filterType === 'fulfilled' 
                      ? 'bg-blue-500/20 text-blue-400' 
                      : 'text-gray-400 hover:text-white'
                  }`}
                >
                  Fulfilled
                </button>
              </div>

              {/* Export button */}
              <button
                onClick={handleExport}
                className="flex items-center gap-2 px-4 py-2 bg-debridge-dark border border-debridge-border rounded-lg text-sm hover:bg-debridge-border transition-colors"
                title="Export to CSV"
              >
                <Download className="w-4 h-4" />
                <span className="hidden sm:inline">Export</span>
              </button>
            </div>
          </div>
          
          {/* Results count */}
          <div className="mt-3 text-sm text-gray-400">
            Showing {paginatedOrders.length} of {filteredOrders.length} orders
            {searchQuery && ` matching "${searchQuery}"`}
          </div>
        </div>
        
        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-debridge-border bg-debridge-dark/50">
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
              {paginatedOrders.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center text-gray-500">
                    {searchQuery ? 'No orders match your search' : 'No orders found'}
                  </td>
                </tr>
              ) : (
                paginatedOrders.map((order, idx) => (
                  <tr
                    key={`${order.signature}-${order.eventType}-${idx}`}
                    className="hover:bg-debridge-border/30 transition-colors cursor-pointer"
                    onClick={() => setSelectedOrder(order)}
                  >
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        {order.eventType === 'created' ? (
                          <>
                            <ArrowRightLeft className="w-4 h-4 text-green-400" />
                            <span className="text-green-400 text-sm font-medium">Created</span>
                          </>
                        ) : (
                          <>
                            <CheckCircle className="w-4 h-4 text-blue-400" />
                            <span className="text-blue-400 text-sm font-medium">Fulfilled</span>
                          </>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <code className="text-xs text-gray-300 bg-debridge-dark px-2 py-1 rounded font-mono">
                        {order.orderId.slice(0, 16)}...
                      </code>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="font-medium text-white">
                        {order.eventType === 'created'
                          ? order.giveTokenSymbol || '-'
                          : order.takeTokenSymbol || order.giveTokenSymbol || '-'}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="text-white font-medium">
                        {order.eventType === 'created'
                          ? formatUsd(order.giveAmountUsd)
                          : formatUsd(order.takeAmountUsd)}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <code className="text-xs text-gray-400 font-mono">
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
                        className="inline-flex items-center gap-1 text-xs text-debridge-purple hover:text-debridge-blue transition-colors"
                        onClick={(e) => e.stopPropagation()}
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
        
        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-6 py-4 border-t border-debridge-border flex items-center justify-between">
            <div className="text-sm text-gray-400">
              Page {currentPage} of {totalPages}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="p-2 rounded-lg bg-debridge-dark border border-debridge-border hover:bg-debridge-border disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              
              {/* Page numbers */}
              <div className="flex gap-1">
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let pageNum;
                  if (totalPages <= 5) {
                    pageNum = i + 1;
                  } else if (currentPage <= 3) {
                    pageNum = i + 1;
                  } else if (currentPage >= totalPages - 2) {
                    pageNum = totalPages - 4 + i;
                  } else {
                    pageNum = currentPage - 2 + i;
                  }
                  
                  return (
                    <button
                      key={pageNum}
                      onClick={() => setCurrentPage(pageNum)}
                      className={`w-8 h-8 rounded-lg text-sm transition-colors ${
                        currentPage === pageNum
                          ? 'bg-debridge-purple text-white'
                          : 'bg-debridge-dark border border-debridge-border hover:bg-debridge-border'
                      }`}
                    >
                      {pageNum}
                    </button>
                  );
                })}
              </div>
              
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="p-2 rounded-lg bg-debridge-dark border border-debridge-border hover:bg-debridge-border disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Order Details Modal */}
      <OrderModal 
        order={selectedOrder} 
        onClose={() => setSelectedOrder(null)} 
      />
    </>
  );
}
