import {Interface,read,ERC20,WBNB,BNB,wallet,same,formatUnits} from './common.mjs';
import {OpeningPools,freshOpeningSnapshot} from './opening-pools.mjs';
import {DEXES,dexFor,matchesCurrency,QUOTES,V2_ROUTER_ABI,V3_LEGACY,V3_MODERN,QUOTER} from './opening-dex.mjs';
import {OpeningPreparation} from './opening-preparation.mjs';
import {sellAmount} from './sell-policy.mjs';
export const ROUTER=V2_ROUTER_ABI;
export async function openingPlan(rpc,bridge,intent,{scan=(t,o)=>new OpeningPools(rpc).scan(t,o),snapshot,preparation,identityFor}={}){
 const reused=freshOpeningSnapshot(snapshot,intent.asset);snapshot=reused?snapshot:await scan(intent.asset,{currency:intent.currency});
 const candidates=snapshot.pools.filter(p=>p.liquid&&matchesCurrency(p,intent.currency)&&dexFor(p));
 if(!candidates.length)throw Object.assign(Error('等待可核验的外盘卖出池子；不会提前使用内盘卖出'),{code:'OPENING_WAIT'});
 const w=wallet(intent.account).address,prep=preparation||new OpeningPreparation(rpc,{...(identityFor?{identityFor}:{})});
 const dexes=[...new Map(candidates.map(p=>{const d=dexFor(p);return [d.id,d];})).values()];
 // Warm data never authorizes an amount or approval. Both remain fresh reads.
 const [meta,[balance],allowanceRows]=await Promise.all([prep.token(intent.asset),read(rpc,intent.asset,ERC20,'balanceOf',[w]),Promise.allSettled(dexes.map(d=>read(rpc,intent.asset,ERC20,'allowance',[w,d.router])))]);
 const amount=sellAmount(balance,intent.percent),allowances=new Map(dexes.map((d,n)=>[d.id,allowanceRows[n].status==='fulfilled'?allowanceRows[n].value[0]:null]));
 candidates.sort((a,b)=>{
  const approved=p=>allowances.get(dexFor(p).id)!==null&&allowances.get(dexFor(p).id)>=amount;
  const score=p=>(approved(p)?100:0)+(p.kind==='v2'?10:0)+(QUOTES.length-QUOTES.findIndex(q=>same(q,p.quote)));
  const diff=score(b)-score(a);if(diff)return diff;
  const depth=p=>BigInt(p.kind==='v2'?(same(p.token0,intent.asset)?p.reserve1:p.reserve0)||'0':p.liquidity||'0');return depth(b)>depth(a)?1:depth(b)<depth(a)?-1:0;
 });
 // Try independent candidates only before any preview or submission. A broken
 // thin pool must not hide another verified pool; at most four quotes per plan.
 const quoteCandidate=async pool=>{const d=dexFor(pool);
  const allowance=allowances.get(d.id);if(allowance===null)throw Error('无法读取当前授权额度');
  const [venue,quoted]=await Promise.all([prep.venue(d),d.kind==='v2'?read(rpc,d.router,ROUTER,'getAmountsOut',[amount,[intent.asset,pool.quote]]):read(rpc,d.quoter,QUOTER,'quoteExactInputSingle',[[intent.asset,pool.quote,amount,pool.fee,0]])]);
  const output=d.kind==='v2'?quoted[0][1]:quoted[0];if(output<=0n||d.kind==='v2'&&(quoted[0].length!==2||quoted[0][0]!==amount))throw Error('开盘卖出报价无效');
  return {pool,d,allowance,venue,output};
 };
 // A slow/reverting pool must not delay a healthy independent venue. Race only
 // within the same approval tier so a fast quote cannot add an avoidable approval.
 const shortlist=candidates.slice(0,4),approved=p=>allowances.get(dexFor(p).id)!==null&&allowances.get(dexFor(p).id)>=amount;
 let chosen,lastError;for(const group of [shortlist.filter(approved),shortlist.filter(p=>!approved(p))]){
  if(!group.length)continue;
  try{chosen=await Promise.any(group.map(quoteCandidate));break;}catch(e){lastError=e.errors?.at(-1)||e;}
 }
 if(!chosen)throw Object.assign(Error('可用池子尚无有效卖出报价：'+lastError?.message),{code:'OPENING_WAIT'});
 const {pool,d,allowance,venue,output}=chosen,minimum=output*BigInt(10000-intent.slippageBps)/10000n;if(minimum<=0n)throw Error('最低到账为零');
 const receiveNative=same(pool.quote,WBNB)&&intent.currency!=='WBNB',deadline=Math.floor(Date.now()/1000)+120;let data;
 if(d.kind==='v2')data=ROUTER.encodeFunctionData(receiveNative?'swapExactTokensForETHSupportingFeeOnTransferTokens':'swapExactTokensForTokensSupportingFeeOnTransferTokens',[amount,minimum,[intent.asset,pool.quote],w,deadline]);
 else{
  const abi=d.legacy?V3_LEGACY:V3_MODERN,params=[intent.asset,pool.quote,pool.fee,receiveNative?d.router:w,...(d.legacy?[deadline]:[]),amount,minimum,0];
  const calls=[abi.encodeFunctionData('exactInputSingle',[params]),...(receiveNative?[abi.encodeFunctionData('unwrapWETH9',[minimum,w])]:[])];
  data=d.legacy?(calls.length===1?calls[0]:abi.encodeFunctionData('multicall(bytes[])',[calls])):abi.encodeFunctionData('multicall(uint256,bytes[])',[deadline,calls]);
 }
 return {kind:'contract',route:d.id+'-opening',token:intent.asset,wallet:w,inputToken:intent.asset,outputToken:receiveNative?BNB:pool.quote,amountIn:String(amount),holdingBefore:String(balance),decimals:meta.decimals,minOutput:String(minimum),
  identity:{...meta.identity,learnedAssets:venue.assets},opening:{...pool,detectedAt:snapshot.at,reusedDetection:reused},state:pool,requireSellCredit:true,
  slippage:{mode:'fixed',bps:intent.slippageBps,capBps:intent.slippageBps},quote:{toCoinAmount:formatUnits(output,18)},review:[],steps:[
   ...(allowance<amount?[{kind:'approve',to:intent.asset,value:'0',data:ERC20.encodeFunctionData('approve',[d.router,amount]),spender:d.router,allowance:String(amount)}]:[]),
   {kind:'sell',to:d.router,value:'0',data}
  ]};
}
const SWAP=new Interface(['event Swap(address indexed sender,uint amount0In,uint amount1In,uint amount0Out,uint amount1Out,address indexed to)']);
const V3_SWAP=new Interface(['event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)','event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint128 protocolFeesToken0,uint128 protocolFeesToken1)']);
export function openingSettlement({receipt,token,state}){
 let amountOut=0n,amountIn=0n;
 for(const log of receipt.logs||[]){if(!same(log.address,state.pool))continue;let e;try{e=(state.kind==='v3'?V3_SWAP:SWAP).parseLog(log);}catch{}if(!e)continue;
  const zero=same(token,state.token0);if(state.kind==='v3'){const input=e.args[zero?'amount0':'amount1'],output=e.args[zero?'amount1':'amount0'];if(input<0n||output>0n)throw Error('开盘卖出回执方向不一致');amountIn+=input;amountOut-=output;}
  else{amountOut+=e.args[zero?'amount1Out':'amount0Out'];amountIn+=e.args[zero?'amount0In':'amount1In'];}
 }
 return {amountOut,amountIn};
}
