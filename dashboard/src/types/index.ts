export interface DashboardStats {
  totalOrdersCreated: number;
  totalOrdersFulfilled: number;
  totalVolumeCreatedUsd: number;
  totalVolumeFulfilledUsd: number;
}

export interface DailyVolume {
  date: string;
  createdCount: number;
  createdVolumeUsd: number;
  fulfilledCount: number;
  fulfilledVolumeUsd: number;
}

export interface TokenStat {
  symbol: string;
  orderCount: number;
  volumeUsd: number;
}

export interface RecentOrder {
  orderId: string;
  eventType: 'created' | 'fulfilled';
  signature: string;
  blockTime: string;
  giveTokenSymbol: string | null;
  giveAmountUsd: number | null;
  takeTokenSymbol: string | null;
  takeAmountUsd: number | null;
  maker: string | null;
  taker: string | null;
}

export interface CollectionProgress {
  created: number;
  fulfilled: number;
}

export interface DashboardData {
  stats: DashboardStats;
  dailyVolumes: DailyVolume[];
  topTokens: TokenStat[];
  recentOrders: RecentOrder[];
  collectionProgress: CollectionProgress;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}
