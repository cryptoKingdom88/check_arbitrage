import { ethers } from 'ethers';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const INFURA_API_KEY = 'ea0a5cbdb47b4dbfb799f3269d449904';

// ABI for Uniswap V3 Pool
const UNISWAP_POOL_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];

// ABI for Sushiswap Pool
const SUSHISWAP_POOL_ABI = [
  "event Swap(address indexed sender, address indexed to, int256 amount0In, int256 amount1In, int256 amount0Out, int256 amount1Out)"
];

// Define data structures
interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

interface LPInfo {
  address: string;
  source: 'uniswap' | 'sushiswap';
  token1: string;
  token2: string;
  reserve1: bigint;
  reserve2: bigint;
}

interface RouteItem {
  target: string;
  lp: string;
}

interface RouteInfo {
  id: string;
  routeInfo: RouteItem[];
}

// Maps for storing data
const tokenMap = new Map<string, TokenInfo>();
const lpMap = new Map<string, LPInfo>();
const routeMap = new Map<string, RouteInfo>();
const lp2routeMapping = new Map<string, string[]>();

// Open the SQLite database
async function openDatabase() {
  return open({
    filename: 'defi.db',
    driver: sqlite3.Database
  });
}

// Fetch data from the database and populate maps
async function fetchData() {
  const db = await openDatabase();

  // Fetch TokenInfo
  const tokens = await db.all<TokenInfo[]>('SELECT * FROM TokenInfo');
  tokens.forEach((token: TokenInfo) => {
    tokenMap.set(token.address, token);
  });

  // Fetch LPInfo
  const lps = await db.all<LPInfo[]>('SELECT * FROM LPInfo');
  lps.forEach((lp: LPInfo) => {
    lpMap.set(lp.address, { ...lp, reserve1: 0n, reserve2: 0n });
  });

  // Fetch RouteInfo
  const routes = await db.all<{ id: string, path: string }[]>('SELECT id, path FROM Route');
  routes.forEach((route: { id: string, path: string }) => {
    const pathArray: [string, [string]][] = JSON.parse(route.path);
    const routeInfo: RouteItem[] = pathArray.map(([target, [lp]]: [string, [string]]) => ({ target, lp }));
    routeMap.set(route.id, { id: route.id, routeInfo });

    // Update lp2routeMapping for each LP pool in the route
    routeInfo.forEach(({ lp }) => {
      if (!lp2routeMapping.has(lp)) {
        lp2routeMapping.set(lp, []);
      }
      lp2routeMapping.get(lp)!.push(route.id);
    });
  });

  await db.close();
}

// Log the loaded database information
function logDatabaseInfo() {
  console.log('TokenMap:', Array.from(tokenMap.entries()));
  console.log('LPMap:', Array.from(lpMap.entries()));
  console.log('RouteMap:', Array.from(routeMap.entries()));
  console.log('LP to Route Mapping:', Array.from(lp2routeMapping.entries()));
}

// Single global provider for both Uniswap and Sushiswap
const provider = new ethers.WebSocketProvider(`wss://mainnet.infura.io/ws/v3/${INFURA_API_KEY}`);

// Function to subscribe to swap events for all pools in lpMap
function subscribeToAllPools() {
  lpMap.forEach((lpInfo, address) => {
    const abi = lpInfo.source === 'uniswap' ? UNISWAP_POOL_ABI : SUSHISWAP_POOL_ABI;
    console.log(address + " " + lpInfo.source);
    const contract = new ethers.Contract(address, abi, provider);
    contract.on('Swap', (...args: any[]) => {
      console.log(`Swap event detected on ${lpInfo.source} pool!`);
      const contractAddress = contract.address.toString();
      if (lpInfo.source === 'uniswap') {
        const [sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick] = args as [string, string, ethers.BigNumberish, ethers.BigNumberish, ethers.BigNumberish, ethers.BigNumberish, number];
        updateReservesAndCalculateArbitrage(contractAddress, amount0, amount1);
      } else if (lpInfo.source === 'sushiswap') {
        const [sender, to, amount0In, amount1In, amount0Out, amount1Out] = args as [string, string, ethers.BigNumberish, ethers.BigNumberish, ethers.BigNumberish, ethers.BigNumberish];
        const amount0 = BigInt(amount0Out.toString()) - BigInt(amount0In.toString());
        const amount1 = BigInt(amount1Out.toString()) - BigInt(amount1In.toString());
        updateReservesAndCalculateArbitrage(contractAddress, amount0, amount1);
      }
    });
  });
}

// Function to update reserves and calculate arbitrage opportunities
function updateReservesAndCalculateArbitrage(lpAddress: string, amount0: ethers.BigNumberish, amount1: ethers.BigNumberish) {
  const poolInfo = lpMap.get(lpAddress);
  if (poolInfo) {
    // Update reserves
    poolInfo.reserve1 = BigInt(amount0.toString());
    poolInfo.reserve2 = BigInt(amount1.toString());

    // Calculate arbitrage opportunities
    calculateArbitrageOpportunities(poolInfo);
  }
}

// Function to calculate arbitrage opportunities
async function calculateArbitrageOpportunities(poolInfo: LPInfo) {
  const startAmount = ethers.parseEther('1'); // Start with 1 ETH
  let currentAmount = startAmount;
  const feePercent = 0.5; // Fee percentage
  const feeMultiplier = 1 - feePercent / 100;

  // Get all arbitrage paths that include the current pool
  const routePathIds = lp2routeMapping.get(poolInfo.address);
  if (routePathIds) {
    // Process each arbitrage path concurrently
    await Promise.all(routePathIds.map(async (pathId) => {
      const routePath = routeMap.get(pathId);
      if (routePath) {
        currentAmount = startAmount;
        let pathDescription = 'WETH';

        // Iterate over each pool in the arbitrage path
        for (const pathItem of routePath.routeInfo) {
          const lpPool = lpMap.get(pathItem.lp);
          if (lpPool) {
            const isToken1Target = pathItem.target === lpPool.token1;
            const reserveIn = isToken1Target ? lpPool.reserve2 : lpPool.reserve1;
            const reserveOut = isToken1Target ? lpPool.reserve1 : lpPool.reserve2;

            // Retrieve the token symbol from the tokenMap
            const tokenInfo = tokenMap.get(pathItem.target);
            const tokenSymbol = tokenInfo ? tokenInfo.symbol : 'UNKNOWN';

            // Append the target token symbol to the path description
            pathDescription += `->${tokenSymbol}`;

            // Calculate output amount using the constant product formula with fee
            const amountOut = getAmountOutWithFee(currentAmount, reserveIn, reserveOut, feeMultiplier);
            currentAmount = amountOut;
          }
        }

        // Calculate profit
        const profit = currentAmount - startAmount;
        if (profit > 0n) {
          console.log(`Arbitrage opportunity detected! Path: ${pathDescription} Profit: ${ethers.formatEther(profit.toString())} ETH`);
        } else {
          console.log(`No arbitrage opportunity detected in path ${pathDescription}.`);
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

console.log('Listening for Swap events...');

// Call fetchData to initialize maps, log the data, and subscribe to all pools
fetchData().then(() => {
  //logDatabaseInfo();
  subscribeToAllPools();
}).catch(console.error); 