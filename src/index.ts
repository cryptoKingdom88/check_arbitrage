import { ethers } from 'ethers';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fs from 'fs';

const INFURA_API_KEY = 'ea0a5cbdb47b4dbfb799f3269d449904';

const UNISWAP_VIEW_ABI = [
	{
		"inputs": [
			{
				"internalType": "address[]",
				"name": "_pair",
				"type": "address[]"
			}
		],
		"name": "viewPair",
		"outputs": [
			{
				"internalType": "uint112[]",
				"name": "",
				"type": "uint112[]"
			}
		],
		"stateMutability": "view",
		"type": "function"
	}
];

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

// Create a write stream for logging
const logStream = fs.createWriteStream('arbitrage.log', { flags: 'a' });

// Helper function to log messages to both console and file
function logMessage(message: string) {
  console.log(message);
  logStream.write(message + '\n');
}

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
      logMessage(`Pool updated! ${fromSymbol} ${toSymbol} ${contractAddress} ${amount0} ${amount1}`);
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
        let logDescription = `1 WETH`;

        // Iterate over each pool in the arbitrage path
        for (const pathItem of routePath.routeInfo) {
          const lpPool = lpMap.get(pathItem.lp);
          if (lpPool) {
            const isToken1Target = pathItem.target === lpPool.token1_address;
            const tokenIn = isToken1Target ? lpPool.token2_address.toLowerCase() : lpPool.token1_address.toLowerCase();
            const tokenOut = isToken1Target ? lpPool.token1_address.toLowerCase() : lpPool.token2_address.toLowerCase();
            const reserveIn = isToken1Target ? lpPool.reserve2 : lpPool.reserve1;
            const reserveOut = isToken1Target ? lpPool.reserve1 : lpPool.reserve2;

            // Retrieve the token symbol and decimals from the tokenMap
            const tokenInfoIn = tokenMap.get(tokenIn);
            const tokenInfoOut = tokenMap.get(tokenOut);
            const tokenSymbolIn = tokenInfoIn ? tokenInfoIn.symbol : 'UNKNOWN';
            const tokenSymbolOut = tokenInfoOut ? tokenInfoOut.symbol : 'UNKNOWN';
            const decimalsIn = tokenInfoIn ? tokenInfoIn.decimals : 0;
            const decimalsOut = tokenInfoOut ? tokenInfoOut.decimals : 0;

            // Append the target token symbol to the path description
            pathDescription += ` -> ${tokenSymbolOut}`;

            // Calculate output amount using the constant product formula with fee
            const amountOut = getAmountOutWithFee(currentAmount, reserveIn, reserveOut, feeMultiplier, decimalsIn, decimalsOut);

            // Adjust amounts for logging
            const adjustedCurrentAmount = Number(currentAmount) / (10 ** decimalsIn);
            const adjustedAmountOut = Number(amountOut) / (10 ** decimalsOut);

            logDescription += ` -> ${adjustedAmountOut.toFixed(decimalsOut)} ${tokenSymbolOut} (${lpPool.address} - ${isToken1Target})\r\n`;
            currentAmount = amountOut;
          }
        }

        // Calculate profit
        const profit = currentAmount - startAmount;
        if (profit > 0n) {
          const adjustedProfit = Number(profit) / (10 ** 18); // Assuming profit is in ETH
          logMessage(`Arbitrage opportunity detected! Path: ${pathDescription} Profit: ${adjustedProfit.toFixed(18)} ETH`);
          logMessage(`Calculation steps: ${logDescription}`);
        } else {
          //console.log(`No arbitrage opportunity detected in path ${pathDescription}.`);
        }
      }
    }));
  }
}

// Helper function to calculate output amount with fee
function getAmountOutWithFee(
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

  // Adjust the amountIn and reserves based on token decimals
  const adjustedAmountIn = amountIn * BigInt(10 ** decimalsOut) / BigInt(10 ** decimalsIn);
  const adjustedReserveIn = reserveIn * BigInt(10 ** decimalsOut) / BigInt(10 ** decimalsIn);
  const adjustedReserveOut = reserveOut;

  // Formula for calculating the output amount with fee
  const amountInWithFee = BigInt(Math.floor(Number(adjustedAmountIn) * feeMultiplier));
  const numerator = amountInWithFee * adjustedReserveOut;
  const denominator = BigInt(Math.floor(Number(adjustedReserveIn) * feeMultiplier) + Number(adjustedAmountIn));

  if (denominator === 0n) {
    return 0n; // or handle the error as needed
  }

  return numerator / denominator;
}

// Function to fetch initial pool reserves
async function fetchInitialPoolReserves() {
  const batchSize = 800;
  const poolAddresses = Array.from(lpMap.keys());
  const provider = new ethers.JsonRpcProvider(`https://mainnet.infura.io/v3/${INFURA_API_KEY}`);
  const viewContract = new ethers.Contract("0x416355755f32b2710ce38725ed0fa102ce7d07e6", UNISWAP_VIEW_ABI, provider);

  for (let i = 0; i < poolAddresses.length; i += batchSize) {
    const batch = poolAddresses.slice(i, i + batchSize);
    try {
      // call getReserves function with multiple addresses at once
      const reservesArray = await viewContract.viewPair(batch);
      
      // update the reserves of each pool
      for (let j = 0; j < batch.length; j++) {
        const address = batch[j];
        const reserve0 = reservesArray[j * 2];
        const reserve1 = reservesArray[j * 2 + 1];
        const lpInfo = lpMap.get(address);
        if (lpInfo) {
          lpInfo.reserve1 = BigInt(reserve0.toString());
          lpInfo.reserve2 = BigInt(reserve1.toString());
          logMessage(`Initial reserves for ${address}: ${reserve0.toString()}, ${reserve1.toString()}`);
        }
      }
    } catch (error) {
      console.error(`Error fetching reserves for batch starting at index ${i}:`, error);
    }
  }
}

console.log('Listening for Swap events...');
logStream.write('Listening for Swap events...\n');

// Call fetchData to initialize maps, fetch initial reserves, and subscribe to pools in batches
fetchData().then(() => {
  fetchInitialPoolReserves().then(() => {
    subscribeToPoolsInBatches();
  });
}).catch(console.error); 
