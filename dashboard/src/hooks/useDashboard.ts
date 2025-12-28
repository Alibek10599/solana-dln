import { useState, useEffect, useCallback, useRef } from 'react';
import type { DashboardData, ApiResponse } from '../types';

const API_BASE = '/api';

// Refresh intervals
const FAST_REFRESH_MS = 5000;   // 5 seconds during collection
const SLOW_REFRESH_MS = 30000; // 30 seconds when collection is complete

export function useDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isLive, setIsLive] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchData = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      setError(null);
      
      const response = await fetch(`${API_BASE}/dashboard`);
      const result: ApiResponse<DashboardData> = await response.json();
      
      if (result.success) {
        setData(result.data);
        setLastUpdate(new Date());
        
        // Check if collection is complete (25k each = 50k total)
        const totalOrders = 
          (result.data.collectionProgress?.created || 0) + 
          (result.data.collectionProgress?.fulfilled || 0);
        
        // If we have 50k+ orders, slow down refresh
        return totalOrders >= 50000;
      } else {
        setError(result.error || 'Failed to fetch data');
        return false;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
      return false;
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  // Start/stop live updates
  const startLiveUpdates = useCallback((slow = false) => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    
    const refreshMs = slow ? SLOW_REFRESH_MS : FAST_REFRESH_MS;
    intervalRef.current = setInterval(async () => {
      const isComplete = await fetchData(true);
      if (isComplete && !slow) {
        // Switch to slow refresh when collection is done
        startLiveUpdates(true);
      }
    }, refreshMs);
    
    setIsLive(true);
  }, [fetchData]);

  const stopLiveUpdates = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setIsLive(false);
  }, []);

  const toggleLive = useCallback(() => {
    if (isLive) {
      stopLiveUpdates();
    } else {
      startLiveUpdates();
    }
  }, [isLive, startLiveUpdates, stopLiveUpdates]);

  useEffect(() => {
    // Initial fetch
    fetchData().then(isComplete => {
      startLiveUpdates(isComplete);
    });
    
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchData, startLiveUpdates]);

  return { 
    data, 
    loading, 
    error, 
    refresh: () => fetchData(false),
    isLive,
    toggleLive,
    lastUpdate,
  };
}
