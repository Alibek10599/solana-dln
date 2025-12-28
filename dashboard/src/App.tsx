import { useDashboard } from './hooks/useDashboard';
import { StatsCards } from './components/StatsCards';
import { VolumeChart } from './components/VolumeChart';
import { TopTokens } from './components/TopTokens';
import { RecentOrdersTable } from './components/RecentOrdersTable';
import { RefreshCw, AlertCircle, Wifi, WifiOff, Activity } from 'lucide-react';

function App() {
  const { 
    data, 
    loading, 
    error, 
    refresh, 
    isConnected, 
    lastUpdate,
    rpcStats,
    parseStats,
  } = useDashboard();

  const formatTime = (date: Date | null) => {
    if (!date) return '';
    return date.toLocaleTimeString();
  };

  // Calculate progress percentage
  const totalOrders = data 
    ? (data.collectionProgress?.created || 0) + (data.collectionProgress?.fulfilled || 0)
    : 0;
  const targetOrders = 50000;
  const progressPercent = Math.min(100, (totalOrders / targetOrders) * 100);

  return (
    <div className="min-h-screen bg-debridge-dark text-white">
      {/* Header */}
      <header className="border-b border-debridge-border bg-debridge-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-debridge-purple to-debridge-blue flex items-center justify-center">
              <span className="text-xl font-bold">D</span>
            </div>
            <div>
              <h1 className="text-xl font-bold">DLN Solana Dashboard</h1>
              <p className="text-sm text-gray-400">Order Events Analytics</p>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            {/* Collection Progress */}
            {data && (
              <div className="flex items-center gap-3">
                <div className="text-sm">
                  <span className="text-green-400">{data.collectionProgress.created.toLocaleString()}</span>
                  {' created / '}
                  <span className="text-blue-400">{data.collectionProgress.fulfilled.toLocaleString()}</span>
                  {' fulfilled'}
                </div>
                
                {/* Progress bar */}
                {progressPercent < 100 && (
                  <div className="w-24 h-2 bg-debridge-border rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-gradient-to-r from-debridge-purple to-debridge-blue transition-all duration-500"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                )}
              </div>
            )}
            
            {/* RPC Stats */}
            {rpcStats && (
              <div className="flex items-center gap-2 px-2 py-1 bg-debridge-card rounded text-xs">
                <Activity className="w-3 h-3 text-green-400" />
                <span className="text-gray-400">
                  {rpcStats.healthyEndpoints}/{rpcStats.totalEndpoints} RPCs
                </span>
              </div>
            )}
            
            {/* Connection Status */}
            <div 
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${
                isConnected 
                  ? 'bg-green-500/20 text-green-400' 
                  : 'bg-red-500/20 text-red-400'
              }`}
              title={isConnected ? 'Real-time updates active' : 'Disconnected - reconnecting...'}
            >
              {isConnected ? (
                <>
                  <Wifi className="w-4 h-4" />
                  <span className="text-sm">LIVE</span>
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                  </span>
                </>
              ) : (
                <>
                  <WifiOff className="w-4 h-4" />
                  <span className="text-sm">OFFLINE</span>
                </>
              )}
            </div>

            {/* Last Update Time */}
            {lastUpdate && (
              <span className="text-xs text-gray-500">
                {formatTime(lastUpdate)}
              </span>
            )}

            {/* Manual Refresh */}
            <button
              onClick={refresh}
              disabled={loading}
              className="p-2 rounded-lg bg-debridge-card hover:bg-debridge-border transition-colors disabled:opacity-50"
              title="Refresh full data"
            >
              <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </header>

      {/* Collection Progress Banner (when actively collecting) */}
      {data && progressPercent < 100 && (
        <div className="bg-debridge-purple/10 border-b border-debridge-purple/20">
          <div className="max-w-7xl mx-auto px-4 py-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-debridge-purple animate-pulse" />
              <span className="text-sm text-debridge-purple">
                Collection in progress: {progressPercent.toFixed(1)}% complete
              </span>
            </div>
            <div className="flex items-center gap-4 text-xs text-gray-400">
              <span>{totalOrders.toLocaleString()} / {targetOrders.toLocaleString()} orders</span>
              {parseStats && (
                <span>
                  Parse: {parseStats.success.toLocaleString()} ✓ / {parseStats.failed.toLocaleString()} ✗
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 py-8">
        {error && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-red-400" />
            <span className="text-red-400">{error}</span>
            <button 
              onClick={refresh}
              className="ml-auto text-sm text-red-400 hover:text-red-300 underline"
            >
              Retry
            </button>
          </div>
        )}

        {loading && !data ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-center">
              <RefreshCw className="w-8 h-8 animate-spin mx-auto mb-4 text-debridge-purple" />
              <p className="text-gray-400">Loading dashboard data...</p>
            </div>
          </div>
        ) : data ? (
          <div className="space-y-8">
            {/* Stats Cards */}
            <StatsCards stats={data.stats} />

            {/* Charts Row */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2">
                <VolumeChart data={data.dailyVolumes} />
              </div>
              <div>
                <TopTokens tokens={data.topTokens} />
              </div>
            </div>

            {/* Recent Orders */}
            <RecentOrdersTable orders={data.recentOrders} />
          </div>
        ) : null}
      </main>

      {/* Footer */}
      <footer className="border-t border-debridge-border mt-auto py-6">
        <div className="max-w-7xl mx-auto px-4 text-center text-sm text-gray-500">
          <p>DLN Solana Dashboard • Built for deBridge Technical Task</p>
          <p className="mt-1">
            Data source: Solana Mainnet • Programs: DlnSource & DlnDestination
          </p>
          {isConnected && (
            <p className="mt-1 text-xs text-green-400/50">
              ● Connected via Server-Sent Events (real-time updates every 2s)
            </p>
          )}
        </div>
      </footer>
    </div>
  );
}

export default App;
