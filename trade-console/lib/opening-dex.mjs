import {INFINITY} from './infinity.mjs';
import {Interface,WBNB,USDT,same} from './common.mjs';
// Official deployment tables are linked in OPENING_SPEED_20261104.md.
export const USDC='0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
export const USD1='0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d';
export const QUOTES=[WBNB,USDT,USDC,USD1];
export const DEXES=[
 {id:'pancake-v2',kind:'v2',factory:'0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',router:'0x10ED43C718714eb63d5aA57B78B54704E256024E'},
 {id:'uniswap-v2',kind:'v2',factory:'0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',router:'0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24'},
 {id:'pancake-v3',kind:'v3',factory:'0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',router:'0x1b81D678ffb9C0263b24A97847620C99d213eB14',quoter:'0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',fees:[100,500,2500,10000],legacy:true},
 {id:'uniswap-v3',kind:'v3',factory:'0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7',router:'0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2',quoter:'0x78D78E420Da98ad378D7799bE8f4AF69033EB077',fees:[100,500,3000,10000]},
 {id:'biswap-v2',kind:'v2',factory:'0x858E3312ed3A876947EA49d572A7C42DE08af7EE',router:'0x3a6d8ca21d1cf76f653a67577fa0d27453350dd8'},
 {id:'sushi-v2',kind:'v2',factory:'0xc35DADB65012eC5796536bD9864eD8773aBc74C4',router:'0x1b02da8cb0d097eb8d57a175b88c7d8b47997506'},
 {id:'apeswap-v2',kind:'v2',factory:'0x0841BD0B734E4F5853f0dD8d7Ea041c241fb0Da6',router:'0xc0788a3ad43d79aa53b09c2eacc313a787d1d607'}
];
export const V2_ROUTER_ABI=new Interface(['function factory() view returns(address)','function WETH() view returns(address)','function getAmountsOut(uint256,address[]) view returns(uint256[])','function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)','function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)']);
export const V3_IMMUTABLE=new Interface(['function factory() view returns(address)','function factoryV3() view returns(address)','function WETH9() view returns(address)']);
export const QUOTER=new Interface(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
const payment=['function multicall(bytes[]) payable returns(bytes[])','function multicall(uint256,bytes[]) payable returns(bytes[])','function unwrapWETH9(uint256,address) payable'];
export const V3_LEGACY=new Interface([...payment,'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns(uint256)']);
export const V3_MODERN=new Interface([...payment,'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns(uint256)']);
export function dexFor(pool){return [...DEXES,INFINITY].find(d=>same(d.factory,pool.factory)&&d.kind===pool.kind);}
export function matchesCurrency(pool,currency){return currency==='AUTO'||same(pool.quote,currency==='USDT'?USDT:WBNB);}
export function poolRouteKey(pool){return [pool?.factory,pool?.kind,...(pool?.legs||[pool]).map(p=>p?.pool),...(pool?.path||[]),pool?.quote,pool?.fee??''].join(':').toLowerCase();}
