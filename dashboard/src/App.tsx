import { useDashboard } from './hooks/useDashboard';
import { StatsCards } from './components/StatsCards';
import { VolumeChart } from './components/VolumeChart';
import { TopTokens } from './components/TopTokens';
import { RecentOrdersTable } from './components/RecentOrdersTable';
import { RefreshCw, AlertCircle, Radio, RadioOff } from 'lucide-react';

function App() {
  const { data, loading, error, refresh, isLive, toggleLive, lastUpdate } =
    useDashboard();

  const formatTime = (date: Date | null) => {
    if (!date) return '';
    return date.toLocaleTimeString();
  };

  // Calculate progress percentage
  const totalOrders = data
    ? (data.collectionProgress?.created || 0) +
      (data.collectionProgress?.fulfilled || 0)
    : 0;
  const targetOrders = 50000;
  const progressPercent = Math.min(100, (totalOrders / targetOrders) * 100);

  return (
    <div className='min-h-screen bg-debridge-dark text-white'>
      {/* Header */}
      <header className='border-b border-debridge-border bg-debridge-card/50 backdrop-blur-sm sticky top-0 z-10'>
        <div className='max-w-7xl mx-auto px-4 py-4 flex items-center justify-between'>
          <div className='flex items-center gap-3'>
            <div className='w-10 h-10 rounded-lg bg-gradient-to-br from-debridge-purple to-debridge-blue flex items-center justify-center'>
              <span className='text-xl font-bold'>D</span>
            </div>
            <div>
              <h1 className='text-xl font-bold'>DLN Solana Dashboard</h1>
              <p className='text-sm text-gray-400'>Order Events Analytics</p>
            </div>
          </div>

          <div className='flex items-center gap-4'>
            {/* Collection Progress */}
            {data && (
              <div className='flex items-center gap-3'>
                <div className='text-sm'>
                  <span className='text-green-400'>
                    {data.collectionProgress.created.toLocaleString()}
                  </span>
                  {' created / '}
                  <span className='text-blue-400'>
                    {data.collectionProgress.fulfilled.toLocaleString()}
                  </span>
                  {' fulfilled'}
                </div>

                {/* Progress bar */}
                {progressPercent < 100 && (
                  <div className='w-24 h-2 bg-debridge-border rounded-full overflow-hidden'>
                    <div
                      className='h-full bg-gradient-to-r from-debridge-purple to-debridge-blue transition-all duration-500'
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                )}
              </div>
            )}

            {/* Live Indicator */}
            <button
              onClick={toggleLive}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors ${
                isLive
                  ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                  : 'bg-debridge-card text-gray-400 hover:bg-debridge-border'
              }`}
              title={
                isLive
                  ? 'Live updates ON - Click to pause'
                  : 'Live updates OFF - Click to resume'
              }
            >
              {isLive ? (
                <>
                  <Radio className='w-4 h-4 animate-pulse' />
                  <span className='text-sm'>LIVE</span>
                </>
              ) : (
                <>
                  <RadioOff className='w-4 h-4' />
                  <span className='text-sm'>PAUSED</span>
                </>
              )}
            </button>

            {/* Last Update Time */}
            {lastUpdate && (
              <span className='text-xs text-gray-500'>
                {formatTime(lastUpdate)}
              </span>
            )}

            {/* Manual Refresh */}
            <button
              onClick={refresh}
              disabled={loading}
              className='p-2 rounded-lg bg-debridge-card hover:bg-debridge-border transition-colors disabled:opacity-50'
              title='Refresh now'
            >
              <RefreshCw
                className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`}
              />
            </button>
          </div>
        </div>
      </header>

      {/* Collection Progress Banner (when actively collecting) */}
      {data && progressPercent < 100 && (
        <div className='bg-debridge-purple/10 border-b border-debridge-purple/20'>
          <div className='max-w-7xl mx-auto px-4 py-2 flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <div className='w-2 h-2 rounded-full bg-debridge-purple animate-pulse' />
              <span className='text-sm text-debridge-purple'>
                Collection in progress: {progressPercent.toFixed(1)}% complete
              </span>
            </div>
            <span className='text-xs text-gray-400'>
              {totalOrders.toLocaleString()} / {targetOrders.toLocaleString()}{' '}
              orders
            </span>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className='max-w-7xl mx-auto px-4 py-8'>
        {error && (
          <div className='mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center gap-3'>
            <AlertCircle className='w-5 h-5 text-red-400' />
            <span className='text-red-400'>{error}</span>
          </div>
        )}

        {loading && !data ? (
          <div className='flex items-center justify-center h-64'>
            <div className='text-center'>
              <RefreshCw className='w-8 h-8 animate-spin mx-auto mb-4 text-debridge-purple' />
              <p className='text-gray-400'>Loading dashboard data...</p>
            </div>
          </div>
        ) : data ? (
          <div className='space-y-8'>
            {/* Stats Cards */}
            <StatsCards stats={data.stats} />

            {/* Charts Row */}
            <div className='grid grid-cols-1 lg:grid-cols-3 gap-6'>
              <div className='lg:col-span-2'>
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
      <footer className='border-t border-debridge-border mt-auto py-6'>
        <div className='max-w-7xl mx-auto px-4 text-center text-sm text-gray-500'>
          <p>DLN Solana Dashboard • Built for deBridge Technical Task</p>
          <p className='mt-1'>
            Data source: Solana Mainnet • Programs: DlnSource & DlnDestination
          </p>
          {isLive && (
            <p className='mt-1 text-xs text-green-400/50'>
              Auto-refreshing every 5 seconds
            </p>
          )}
        </div>
      </footer>
    </div>
  );
}

export default App;
