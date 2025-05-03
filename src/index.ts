import { ethers } from 'ethers';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const INFURA_API_KEY = 'ea0a5cbdb47b4dbfb799f3269d449904';

// Define the ABI including the Sync event
const UNISWAP_V2_POOL_ABI = [
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint112",
        "name": "reserve0",
        "type": "uint112"
      },
      {
        "indexed": false,
        "internalType": "uint112",
        "name": "reserve1",
        "type": "uint112"
      }
    ],
    "name": "Sync",
    "type": "event"
  }
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
  token1_address: string;
  token2_address: string;
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

// Function to subscribe to swap events in batches
function subscribeToPoolsInBatches() {
  const batchSize = 800;

  let i = 0;
  let provider: ethers.WebSocketProvider;
  lpMap.forEach((lpInfo, address) => {
    if (i % batchSize === 0) {
      provider = new ethers.WebSocketProvider(`wss://mainnet.infura.io/ws/v3/${INFURA_API_KEY}`);
    }
    i++;
    const contract = new ethers.Contract(address, UNISWAP_V2_POOL_ABI, provider);
    contract.on('Sync', (...args: any[]) => {
      const [reserve0, reserve1] = args as [ethers.BigNumberish, ethers.BigNumberish];
      const contractAddress = address.toString();
      
      // Log the contract address and check if it exists in lpMap
      const amount0 = BigInt(reserve0.toString());
      const amount1 = BigInt(reserve1.toString());
      const fromSymbol = tokenMap.get(lpInfo.token1_address)?.symbol;
      const toSymbol = tokenMap.get(lpInfo.token2_address)?.symbol;
      console.log(`Sync event detected on pool! ${fromSymbol} ${toSymbol} ${contractAddress} ${amount0} ${amount1}`);
      updateReservesAndCalculateArbitrage(contractAddress, amount0, amount1);
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
        let priceNotReady = false;
        for (const pathItem of routePath.routeInfo) {
          const lpPool = lpMap.get(pathItem.lp);
          if (lpPool) {
            const isToken1Target = pathItem.target === lpPool.token1_address;
            const reserveIn = isToken1Target ? lpPool.reserve2 : lpPool.reserve1;
            const reserveOut = isToken1Target ? lpPool.reserve1 : lpPool.reserve2;

            if (reserveIn === 0n || reserveOut === 0n) {
              priceNotReady = true;
            }

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
          if (!priceNotReady) {
            console.log(`No arbitrage opportunity detected in path ${pathDescription}. Profit: ${ethers.formatEther(profit.toString())} ETH`);
          }
        }
      }
    }));
  }
}

// Helper function to calculate output amount with fee
function getAmountOutWithFee(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeMultiplier: number): bigint {
  if (reserveIn === 0n || reserveOut === 0n) {
    return 0n;
  }
  const amountInWithFee = BigInt(Math.floor(Number(amountIn) * feeMultiplier));
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 1000n + amountInWithFee;

  if (denominator === 0n) {
    //console.error('Error: Division by zero in getAmountOutWithFee');
    return 0n; // or handle the error as needed
  }

  return numerator / denominator;
}

console.log('Listening for Swap events...');

// Call fetchData to initialize maps, log the data, and subscribe to pools in batches
fetchData().then(() => {
  //logDatabaseInfo();
  subscribeToPoolsInBatches();
}).catch(console.error); 

function subscribeToSwapEvents() {
  const provider = new ethers.WebSocketProvider(`wss://mainnet.infura.io/ws/v3/${INFURA_API_KEY}`);
  const contract = new ethers.Contract("0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc", UNISWAP_V2_POOL_ABI, provider);

  contract.on('Swap', (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick) => {
    console.log(`Swap event detected on pool! ${sender} ${recipient} ${amount0} ${amount1} ${sqrtPriceX96} ${liquidity} ${tick}`);
  });
}

//subscribeToSwapEvents();