export const INFURA_API_KEY = 'ea0a5cbdb47b4dbfb799f3269d449904';

export const UNISWAP_VIEW_ABI = [
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

export const UNISWAP_V2_POOL_ABI = [
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

export const BATCH_SIZE = 800;
export const START_AMOUNT = '1';
export const FEE_PERCENT = 0.5; 