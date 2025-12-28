import { useState, useEffect, useCallback, useRef } from 'react';
import type { DashboardData, ApiResponse } from '../types';

const API_BASE = '/api';

// Real-time update data from SSE
interface RealtimeUpdate {
  stats: {
    totalOrdersCreated: number;
    totalOrdersFulfilled: number;
    totalVolumeCreatedUsd: number;
    totalVolumeFulfilledUsd: number;
  };
  collectionProgress: {
    created: number;
    fulfilled: number;
  };
  recentOrders: any[];
  rpcPool: {
    healthyEndpoints: number;
    totalEndpoints: number;
    totalRequests: number;
  };
  parseStats: {
    total: number;
    success: number;
    failed: number;
    noEvents: number;
  };
  timestamp: string;
}

export function useDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [rpcStats, setRpcStats] = useState<RealtimeUpdate['rpcPool'] | null>(null);
  const [parseStats, setParseStats] = useState<RealtimeUpdate['parseStats'] | null>(null);
  
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch full dashboard data (initial load and manual refresh)
  const fetchFullData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      const response = await fetch(`${API_BASE}/dashboard`);
      const result: ApiResponse<DashboardData> = await response.json();
      
      if (result.success) {
        setData(result.data);
        setLastUpdate(new Date());
      } else {
        setError(result.error || 'Failed to fetch data');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  // Connect to SSE for real-time updates
  const connectSSE = useCallback(() => {
    // Clean up existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    
    const eventSource = new EventSource(`${API_BASE}/events`);
    eventSourceRef.current = eventSource;
    
    eventSource.onopen = () => {
      console.log('SSE connected');
      setIsConnected(true);
      setError(null);
    };
    
    eventSource.addEventListener('connected', (event) => {
      const data = JSON.parse(event.data);
      console.log('SSE connected with client ID:', data.clientId);
    });
    
    eventSource.addEventListener('update', (event) => {
      try {
        const update: RealtimeUpdate = JSON.parse(event.data);
        
        // Update stats and progress in real-time
        setData(prev => {
          if (!prev) return prev;
          return {
            ...prev,
            stats: update.stats,
            collectionProgress: update.collectionProgress,
            // Merge new recent orders with existing
            recentOrders: [
              ...update.recentOrders,
              ...prev.recentOrders.filter(
                o => !update.recentOrders.find((u: any) => u.orderId === o.orderId)
              )
            ].slice(0, 20),
          };
        });
        
        setRpcStats(update.rpcPool);
        setParseStats(update.parseStats);
        setLastUpdate(new Date(update.timestamp));
        setError(null);
      } catch (err) {
        console.error('Failed to parse SSE update:', err);
      }
    });
    
    eventSource.onerror = () => {
      console.error('SSE error');
      setIsConnected(false);
      eventSource.close();
      
      // Reconnect after 3 seconds
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      reconnectTimeoutRef.current = setTimeout(() => {
        console.log('Attempting SSE reconnect...');
        connectSSE();
      }, 3000);
    };
    
    return () => {
      eventSource.close();
    };
  }, []);

  // Initial fetch and SSE connection
  useEffect(() => {
    fetchFullData().then(() => {
      // Connect to SSE after initial data load
      connectSSE();
    });
    
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [fetchFullData, connectSSE]);

  // Manual refresh (refetches full data including charts)
  const refresh = useCallback(async () => {
    await fetchFullData();
  }, [fetchFullData]);

  return { 
    data, 
    loading, 
    error, 
    refresh,
    isConnected,
    lastUpdate,
    rpcStats,
    parseStats,
  };
}
