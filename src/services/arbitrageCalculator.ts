import { ethers } from 'ethers';
import fs from 'fs';
import { START_AMOUNT, FEE_PERCENT } from '../config/constants';
import { DatabaseManager } from '../database/dbManager';

export class ArbitrageCalculator {
  private dbManager: DatabaseManager;
  private logStream: fs.WriteStream;

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
    this.logStream = fs.createWriteStream('arbitrage.log', { flags: 'a' });
  }

  private logMessage(message: string) {
    console.log(message);
    this.logStream.write(message + '\n');
  }

  updateReservesAndCalculateArbitrage(lpAddress: string, amount0: ethers.BigNumberish, amount1: ethers.BigNumberish) {
    const lpMap = this.dbManager.getLPMap();
    const poolInfo = lpMap.get(lpAddress);
    if (poolInfo) {
      poolInfo.reserve1 = BigInt(amount0.toString());
      poolInfo.reserve2 = BigInt(amount1.toString());
      this.calculateArbitrageOpportunities(poolInfo);
    }
  }

  private async calculateArbitrageOpportunities(poolInfo: any) {
    const startAmount = ethers.parseEther(START_AMOUNT);
    let currentAmount = startAmount;
    const feeMultiplier = 1 - FEE_PERCENT / 100;

    const lp2routeMapping = this.dbManager.getLP2RouteMapping();
    const routeMap = this.dbManager.getRouteMap();
    const tokenMap = this.dbManager.getTokenMap();

    const routePathIds = lp2routeMapping.get(poolInfo.address);
    if (routePathIds) {
      await Promise.all(routePathIds.map(async (pathId) => {
        const routePath = routeMap.get(pathId);
        if (routePath) {
          currentAmount = startAmount;
          let pathDescription = 'WETH';
          let logDescription = `1 WETH`;

          for (const pathItem of routePath.routeInfo) {
            const lpPool = this.dbManager.getLPMap().get(pathItem.lp);
            if (lpPool) {
              const isToken1Target = pathItem.target === lpPool.token1_address;
              const tokenIn = isToken1Target ? lpPool.token2_address.toLowerCase() : lpPool.token1_address.toLowerCase();
              const tokenOut = isToken1Target ? lpPool.token1_address.toLowerCase() : lpPool.token2_address.toLowerCase();
              const reserveIn = isToken1Target ? lpPool.reserve2 : lpPool.reserve1;
              const reserveOut = isToken1Target ? lpPool.reserve1 : lpPool.reserve2;

              const tokenInfoIn = tokenMap.get(tokenIn);
              const tokenInfoOut = tokenMap.get(tokenOut);
              const tokenSymbolIn = tokenInfoIn ? tokenInfoIn.symbol : 'UNKNOWN';
              const tokenSymbolOut = tokenInfoOut ? tokenInfoOut.symbol : 'UNKNOWN';
              const decimalsIn = tokenInfoIn ? tokenInfoIn.decimals : 0;
              const decimalsOut = tokenInfoOut ? tokenInfoOut.decimals : 0;

              pathDescription += ` -> ${tokenSymbolOut}`;

              const amountOut = this.getAmountOutWithFee(
                currentAmount,
                reserveIn,
                reserveOut,
                feeMultiplier,
                decimalsIn,
                decimalsOut
              );

              const adjustedCurrentAmount = Number(currentAmount) / (10 ** decimalsIn);
              const adjustedAmountOut = Number(amountOut) / (10 ** decimalsOut);

              logDescription += ` -> ${adjustedAmountOut.toFixed(decimalsOut)} ${tokenSymbolOut} (${lpPool.address} - ${isToken1Target})\r\n`;
              currentAmount = amountOut;
            }
          }

          const profit = currentAmount - startAmount;
          if (profit > 0n) {
            const adjustedProfit = Number(profit) / (10 ** 18);
            this.logMessage(`Arbitrage opportunity detected! Path: ${pathDescription} Profit: ${adjustedProfit.toFixed(18)} ETH`);
            this.logMessage(`Calculation steps: ${logDescription}`);
          }
        }
      }));
    }
  }

  private getAmountOutWithFee(
    amountIn: bigint,
    reserveIn: bigint,
    reserveOut: bigint,
    feeMultiplier: number,
    decimalsIn: number,
    decimalsOut: number
  ): bigint {
    if (reserveIn === 0n || reserveOut === 0n) {
      return 0n;
    }

    const adjustedAmountIn = amountIn * BigInt(10 ** decimalsOut) / BigInt(10 ** decimalsIn);
    const adjustedReserveIn = reserveIn * BigInt(10 ** decimalsOut) / BigInt(10 ** decimalsIn);
    const adjustedReserveOut = reserveOut;

    const amountInWithFee = BigInt(Math.floor(Number(adjustedAmountIn) * feeMultiplier));
    const numerator = amountInWithFee * adjustedReserveOut;
    const denominator = BigInt(Math.floor(Number(adjustedReserveIn) * feeMultiplier) + Number(adjustedAmountIn));

    if (denominator === 0n) {
      return 0n;
    }

    return numerator / denominator;
  }
} 