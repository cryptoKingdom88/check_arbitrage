import { ethers } from 'ethers';
import { UNISWAP_V2_POOL_ABI, UNISWAP_VIEW_ABI, INFURA_API_KEY, BATCH_SIZE } from '../config/constants';
import { LPInfo } from '../types/interfaces';
import { DatabaseManager } from '../database/dbManager';
import { ArbitrageCalculator } from './arbitrageCalculator';

export class EventSubscriber {
  private dbManager: DatabaseManager;
  private arbitrageCalculator: ArbitrageCalculator;

  constructor(dbManager: DatabaseManager, arbitrageCalculator: ArbitrageCalculator) {
    this.dbManager = dbManager;
    this.arbitrageCalculator = arbitrageCalculator;
  }

  async subscribeToPoolsInBatches() {
    const lpMap = this.dbManager.getLPMap();
    let i = 0;
    let provider: ethers.WebSocketProvider;

    lpMap.forEach((lpInfo, address) => {
      if (i % BATCH_SIZE === 0) {
        provider = new ethers.WebSocketProvider(`wss://mainnet.infura.io/ws/v3/${INFURA_API_KEY}`);
      }
      i++;
      const contract = new ethers.Contract(address, UNISWAP_V2_POOL_ABI, provider);
      contract.on('Sync', (...args: any[]) => {
        const [reserve0, reserve1] = args as [ethers.BigNumberish, ethers.BigNumberish];
        const contractAddress = address.toString();
        
        const amount0 = BigInt(reserve0.toString());
        const amount1 = BigInt(reserve1.toString());
        this.arbitrageCalculator.updateReservesAndCalculateArbitrage(contractAddress, amount0, amount1);
      });
    });
  }

  async fetchInitialPoolReserves() {
    const lpMap = this.dbManager.getLPMap();
    const poolAddresses = Array.from(lpMap.keys());
    const provider = new ethers.JsonRpcProvider(`https://mainnet.infura.io/v3/${INFURA_API_KEY}`);
    const viewContract = new ethers.Contract("0x416355755f32b2710ce38725ed0fa102ce7d07e6", UNISWAP_VIEW_ABI, provider);

    for (let i = 0; i < poolAddresses.length; i += BATCH_SIZE) {
      const batch = poolAddresses.slice(i, i + BATCH_SIZE);
      try {
        const reservesArray = await viewContract.viewPair(batch);
        
        for (let j = 0; j < batch.length; j++) {
          const address = batch[j];
          const reserve0 = reservesArray[j * 2];
          const reserve1 = reservesArray[j * 2 + 1];
          const lpInfo = lpMap.get(address);
          if (lpInfo) {
            lpInfo.reserve1 = BigInt(reserve0.toString());
            lpInfo.reserve2 = BigInt(reserve1.toString());
          }
        }
      } catch (error) {
        console.error(`Error fetching reserves for batch starting at index ${i}:`, error);
      }
    }
  }
} 