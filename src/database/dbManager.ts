import { open, Database } from 'sqlite';
import sqlite3 from 'sqlite3';
import { TokenInfo, LPInfo, RouteInfo } from '../types/interfaces';

export class DatabaseManager {
  private tokenMap = new Map<string, TokenInfo>();
  private lpMap = new Map<string, LPInfo>();
  private routeMap = new Map<string, RouteInfo>();
  private lp2routeMapping = new Map<string, string[]>();

  async initialize() {
    const db = await this.openDatabase();
    await this.fetchData(db);
    await db.close();
  }

  private async openDatabase(): Promise<Database> {
    return open({
      filename: 'defi.db',
      driver: sqlite3.Database
    });
  }

  private async fetchData(db: Database) {
    // Fetch TokenInfo
    const tokens = await db.all('SELECT * FROM TokenInfo') as TokenInfo[];
    tokens.forEach((token: TokenInfo) => {
      this.tokenMap.set(token.address, token);
    });

    // Fetch LPInfo
    const lps = await db.all('SELECT * FROM LPInfo') as LPInfo[];
    lps.forEach((lp: LPInfo) => {
      this.lpMap.set(lp.address, { ...lp, reserve1: 0n, reserve2: 0n });
    });

    // Fetch RouteInfo
    const routes = await db.all('SELECT id, path FROM Route') as { id: string, path: string }[];
    routes.forEach((route: { id: string, path: string }) => {
      const pathArray: [string, [string]][] = JSON.parse(route.path);
      const routeInfo = pathArray.map(([target, [lp]]: [string, [string]]) => ({ target, lp }));
      this.routeMap.set(route.id, { id: route.id, routeInfo });

      // Update lp2routeMapping for each LP pool in the route
      routeInfo.forEach(({ lp }) => {
        if (!this.lp2routeMapping.has(lp)) {
          this.lp2routeMapping.set(lp, []);
        }
        this.lp2routeMapping.get(lp)!.push(route.id);
      });
    });
  }

  getTokenMap() {
    return this.tokenMap;
  }

  getLPMap() {
    return this.lpMap;
  }

  getRouteMap() {
    return this.routeMap;
  }

  getLP2RouteMapping() {
    return this.lp2routeMapping;
  }
} 