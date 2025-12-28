import { X, ExternalLink, Copy, Check, ArrowRight } from 'lucide-react';
import { useState } from 'react';
import type { RecentOrder } from '../types';

interface OrderModalProps {
  order: RecentOrder | null;
  onClose: () => void;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) return '-';
  if (value >= 1000000) return `$${(value / 1000000).toFixed(2)}M`;
  if (value >= 1000) return `$${(value / 1000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1 hover:bg-debridge-border rounded transition-colors"
      title="Copy to clipboard"
    >
      {copied ? (
        <Check className="w-4 h-4 text-green-400" />
      ) : (
        <Copy className="w-4 h-4 text-gray-400" />
      )}
    </button>
  );
}

function DetailRow({ label, value, copyable = false, link }: { 
  label: string; 
  value: string | null | undefined;
  copyable?: boolean;
  link?: string;
}) {
  const displayValue = value || '-';
  
  return (
    <div className="flex flex-col sm:flex-row sm:items-center py-3 border-b border-debridge-border last:border-b-0">
      <span className="text-sm text-gray-400 sm:w-40 mb-1 sm:mb-0">{label}</span>
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="text-debridge-purple hover:text-debridge-blue transition-colors flex items-center gap-1 truncate"
          >
            <span className="font-mono text-sm truncate">{displayValue}</span>
            <ExternalLink className="w-4 h-4 flex-shrink-0" />
          </a>
        ) : (
          <span className="font-mono text-sm text-white truncate">{displayValue}</span>
        )}
        {copyable && value && <CopyButton text={value} />}
      </div>
    </div>
  );
}

export function OrderModal({ order, onClose }: OrderModalProps) {
  if (!order) return null;

  const isCreated = order.eventType === 'created';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative bg-debridge-card border border-debridge-border rounded-xl w-full max-w-2xl max-h-[90vh] overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-debridge-border">
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full ${isCreated ? 'bg-green-400' : 'bg-blue-400'}`} />
            <h2 className="text-lg font-semibold">
              Order {isCreated ? 'Created' : 'Fulfilled'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-debridge-border rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[calc(90vh-180px)]">
          {/* Order Info */}
          <div className="mb-6">
            <h3 className="text-sm font-medium text-gray-400 mb-3">Order Information</h3>
            <div className="bg-debridge-dark rounded-lg p-4">
              <DetailRow 
                label="Order ID" 
                value={order.orderId} 
                copyable 
              />
              <DetailRow 
                label="Transaction" 
                value={order.signature}
                copyable
                link={`https://solscan.io/tx/${order.signature}`}
              />
              <DetailRow 
                label="Time" 
                value={formatDate(order.blockTime)} 
              />
              <DetailRow 
                label="Status" 
                value={isCreated ? 'Created' : 'Fulfilled'} 
              />
            </div>
          </div>

          {/* Token Details */}
          {isCreated && (
            <div className="mb-6">
              <h3 className="text-sm font-medium text-gray-400 mb-3">Transfer Details</h3>
              <div className="bg-debridge-dark rounded-lg p-4">
                <div className="flex items-center justify-between py-4">
                  {/* Give Token */}
                  <div className="text-center flex-1">
                    <div className="text-2xl font-bold text-white mb-1">
                      {order.giveTokenSymbol || 'Unknown'}
                    </div>
                    <div className="text-sm text-gray-400">
                      {formatUsd(order.giveAmountUsd)}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">Send</div>
                  </div>
                  
                  {/* Arrow */}
                  <div className="px-4">
                    <ArrowRight className="w-6 h-6 text-debridge-purple" />
                  </div>
                  
                  {/* Take Token */}
                  <div className="text-center flex-1">
                    <div className="text-2xl font-bold text-white mb-1">
                      {order.takeTokenSymbol || 'Unknown'}
                    </div>
                    <div className="text-sm text-gray-400">
                      {formatUsd(order.takeAmountUsd)}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">Receive</div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Addresses */}
          <div>
            <h3 className="text-sm font-medium text-gray-400 mb-3">Addresses</h3>
            <div className="bg-debridge-dark rounded-lg p-4">
              {isCreated ? (
                <DetailRow 
                  label="Maker" 
                  value={order.maker}
                  copyable
                  link={order.maker ? `https://solscan.io/account/${order.maker}` : undefined}
                />
              ) : (
                <DetailRow 
                  label="Taker" 
                  value={order.taker}
                  copyable
                  link={order.taker ? `https://solscan.io/account/${order.taker}` : undefined}
                />
              )}
            </div>
          </div>
        </div>
        
        {/* Footer */}
        <div className="p-6 border-t border-debridge-border bg-debridge-dark/50">
          <div className="flex justify-end gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
            >
              Close
            </button>
            <a
              href={`https://solscan.io/tx/${order.signature}`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 text-sm bg-debridge-purple hover:bg-debridge-purple/80 rounded-lg transition-colors flex items-center gap-2"
            >
              View on Solscan
              <ExternalLink className="w-4 h-4" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
