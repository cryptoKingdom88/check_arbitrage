import { ethers } from 'ethers';

const INFURA_API_KEY = 'ea0a5cbdb47b4dbfb799f3269d449904';
const UNISWAP_POOL_ADDRESS = '0xE0554a476A092703abdB3Ef35c80e0D76d32939F';

// ABI for Uniswap V3 Pool
const UNISWAP_POOL_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];

// Define data structures
interface TokenInfo {
  id: string;
  symbol: string;
  decimals: number;
}

interface SwapPoolInfo {
  id: string;
  exchangeType: 'uniswap' | 'sushiswap';
  token1: string;
  token2: string;
  reserve1: bigint;
  reserve2: bigint;
}

interface ArbitragePathItem {
  targetToken: string;
  swapPool: SwapPoolInfo;
}

interface ArbitragePathInfo {
  id: string;
  arbitPathInfo: ArbitragePathItem[];
}

// Maps for storing data
const tokenMap = new Map<string, TokenInfo>();
const swapPoolMap = new Map<string, SwapPoolInfo>();
const arbitragePathMap = new Map<string, ArbitragePathInfo>();
const pairPriceMap = new Map<string, number>();
const arbitragePathMapping = new Map<string, string[]>();

// Function to subscribe to swap events
function subscribeToSwapEvents(poolAddresses: string[], exchangeType: 'uniswap' | 'sushiswap') {
  poolAddresses.forEach((address) => {
    const provider = new ethers.WebSocketProvider(`wss://mainnet.infura.io/ws/v3/${INFURA_API_KEY}`);
    const contract = new ethers.Contract(address, UNISWAP_POOL_ABI, provider);

    contract.on('Swap', (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick) => {
      console.log(`Swap event detected on ${exchangeType} pool!`);
      // Update reserves and calculate arbitrage opportunities
      updateReservesAndCalculateArbitrage(address, amount0, amount1);
    });
  });
}

// Function to update reserves and calculate arbitrage opportunities
function updateReservesAndCalculateArbitrage(poolAddress: string, amount0: ethers.BigNumberish, amount1: ethers.BigNumberish) {
  const poolInfo = swapPoolMap.get(poolAddress);
  if (poolInfo) {
    // Update reserves
    poolInfo.reserve1 = BigInt(amount0.toString());
    poolInfo.reserve2 = BigInt(amount1.toString());

    // Calculate arbitrage opportunities
    calculateArbitrageOpportunities(poolInfo);
  }
}

// Function to calculate arbitrage opportunities
async function calculateArbitrageOpportunities(poolInfo: SwapPoolInfo) {
  const startAmount = ethers.parseEther('1'); // Start with 1 ETH
  let currentAmount = startAmount;
  const feePercent = 0.5; // Fee percentage
  const feeMultiplier = 1 - feePercent / 100;

  // Get all arbitrage paths that include the current pool
  const arbitragePaths = arbitragePathMapping.get(poolInfo.id);
  if (arbitragePaths) {
    // Process each arbitrage path concurrently
    await Promise.all(arbitragePaths.map(async (pathId) => {
      const arbitragePath = arbitragePathMap.get(pathId);
      if (arbitragePath) {
        currentAmount = startAmount;

        // Iterate over each pool in the arbitrage path
        for (const pathItem of arbitragePath.arbitPathInfo) {
          const pool = pathItem.swapPool;
          const isToken1Target = pathItem.targetToken === pool.token1;
          const reserveIn = isToken1Target ? pool.reserve2 : pool.reserve1;
          const reserveOut = isToken1Target ? pool.reserve1 : pool.reserve2;

          // Calculate output amount using the constant product formula with fee
          const amountOut = getAmountOutWithFee(currentAmount, reserveIn, reserveOut, feeMultiplier);
          currentAmount = amountOut;
        }

        // Calculate profit
        const profit = currentAmount - startAmount;
        if (profit > 0n) {
          console.log(`Arbitrage opportunity detected in path ${pathId}! Profit: ${ethers.formatEther(profit.toString())} ETH`);
        } else {
          console.log(`No arbitrage opportunity detected in path ${pathId}.`);
        }
      }
    }));
  }
}

// Helper function to calculate output amount with fee
function getAmountOutWithFee(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeMultiplier: number): bigint {
  const amountInWithFee = BigInt(Math.floor(Number(amountIn) * feeMultiplier));
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 1000n + amountInWithFee;
  return numerator / denominator;
}

// Example usage
const uniswapPools = ['0x4e665157291DBcb25152ebB01061E4012F58aDd2'];
const sushiswapPools = ['0xE0554a476A092703abdB3Ef35c80e0D76d32939F'];
subscribeToSwapEvents(uniswapPools, 'uniswap');
subscribeToSwapEvents(sushiswapPools, 'sushiswap');

console.log('Listening for Swap events...'); 