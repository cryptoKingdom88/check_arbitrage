export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

export interface LPInfo {
  address: string;
  token1_address: string;
  token2_address: string;
  reserve1: bigint;
  reserve2: bigint;
}

export interface RouteItem {
  target: string;
  lp: string;
}

export interface RouteInfo {
  id: string;
  routeInfo: RouteItem[];
} 