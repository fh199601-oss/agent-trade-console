import {Interface,read,ERC20,WBNB,BNB,wallet,same,formatUnits} from './common.mjs';
import {OpeningPools,freshOpeningSnapshot} from './opening-pools.mjs';
import {DEXES,dexFor,matchesCurrency,QUOTES,V2_ROUTER_ABI,V3_LEGACY,V3_MODERN,QUOTER} from './opening-dex.mjs';
import {OpeningPreparation} from './opening-preparation.mjs';
import {sellAmount} from './sell-policy.mjs';
export const ROUTER=V2_ROUTER_ABI;
function saleData(d,pool,token,owner,amount,minimum,receiveNative){
 const deadline=Math.floor(Date.now()/1000)+120;
 if(d.kind==='v2')return ROUTER.encodeFunctionData(receiveNative?'swapExactTokensForETHSupportingFeeOnTransferTokens':'swapExactTokensForTokensSupportingFeeOnTransferTokens',[amount,minimum,[token,pool.quote],owner,deadline]);
 const abi=d.legacy?V3_LEGACY:V3_MODERN,params=[token,pool.quote,pool.fee,receiveNative?d.router:owner,...(d.legacy?[deadline]:[]),amount,minimum,0];
 const calls=[abi.encodeFunctionData('exactInputSingle',[params]),...(receiveNative?[abi.encodeFunctionData('unwrapWETH9',[minimum,owner])]:[])];
 return d.legacy?(calls.length===1?calls[0]:abi.encodeFunctionData('multicall(bytes[])',[calls])):abi.encodeFunctionData('multicall(uint256,bytes[])',[deadline,calls]);
}
export async function refreshOpeningSell(rpc,plan){
 const pool=plan.opening,d=dexFor(pool),amount=BigInt(plan.amountIn);
 if(!d||!plan.requireSellCredit||!same(plan.steps.at(-1)?.to,d.router)||!same(wallet(plan.account).address,plan.wallet))throw Error('开盘卖出刷新缺少可信路线');
 const [[balance],quoted]=await Promise.all([read(rpc,plan.token,ERC20,'balanceOf',[plan.wallet]),d.kind==='v2'?read(rpc,d.router,ROUTER,'getAmountsOut',[amount,[plan.token,pool.quote]]):read(rpc,d.quoter,QUOTER,'quoteExactInputSingle',[[plan.token,pool.quote,amount,pool.fee,0]])]);
 if(String(balance)!==plan.holdingBefore)throw Error('授权期间持仓已变化，请重新预览');
 const output=d.kind==='v2'?quoted[0][1]:quoted[0],minimum=output*BigInt(10000-plan.slippage.bps)/10000n;
 if(minimum<=0n||d.kind==='v2'&&(quoted[0].length!==2||quoted[0][0]!==amount))throw Error('开盘卖出刷新报价无效');
 const step={...plan.steps.at(-1),data:saleData(d,pool,plan.token,plan.wallet,amount,minimum,same(plan.outputToken,BNB))};
 return {...plan,minOutput:String(minimum),quote:{...plan.quote,toCoinAmount:formatUnits(output,18)},quoteRefreshedAt:Date.now(),steps:[...plan.steps.slice(0,-1),step]};
}
export async function openingPlan(rpc,bridge,intent,{scan=(t,o)=>new OpeningPools(rpc).scan(t,o),snapshot,preparation,identityFor,failedPreviews=[]}={}){
 const reused=freshOpeningSnapshot(snapshot,intent.asset);snapshot=reused?snapshot:await scan(intent.asset,{currency:intent.currency});
 const candidates=snapshot.pools.filter(p=>p.liquid&&matchesCurrency(p,intent.currency)&&dexFor(p));
 if(!candidates.length)throw Object.assign(Error('等待可核验的外盘卖出池子；不会提前使用内盘卖出'),{code:'OPENING_WAIT'});
 const w=wallet(intent.account).address,prep=preparation||new OpeningPreparation(rpc,{...(identityFor?{identityFor}:{})});
 const dexes=[...new Map(candidates.map(p=>{const d=dexFor(p);return [d.id,d];})).values()];
 // Warm data never authorizes an amount or approval. Both remain fresh reads.
 const [meta,[balance],allowanceRows]=await Promise.all([prep.token(intent.asset),read(rpc,intent.asset,ERC20,'balanceOf',[w]),Promise.allSettled(dexes.map(d=>read(rpc,intent.asset,ERC20,'allowance',[w,d.router])))]);
 const amount=sellAmount(balance,intent.percent),allowances=new Map(dexes.map((d,n)=>[d.id,allowanceRows[n].status==='fulfilled'?allowanceRows[n].value[0]:null]));
 const failed=p=>failedPreviews.some(f=>same(f.pool,p.pool)&&f.fingerprint===meta.identity?.fingerprint&&f.amountIn===String(amount)&&f.holdingBefore===String(balance));
 candidates.sort((a,b)=>{
  if(failed(a)!==failed(b))return failed(a)?1:-1;
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
 let chosen,lastError;for(const group of [shortlist.filter(p=>!failed(p)&&approved(p)),shortlist.filter(p=>!failed(p)&&!approved(p)),shortlist.filter(p=>failed(p)&&approved(p)),shortlist.filter(p=>failed(p)&&!approved(p))]){
  if(!group.length)continue;
  try{chosen=await Promise.any(group.map(quoteCandidate));break;}catch(e){lastError=e.errors?.at(-1)||e;}
 }
 if(!chosen)throw Object.assign(Error('可用池子尚无有效卖出报价：'+lastError?.message),{code:'OPENING_WAIT'});
 const {pool,d,allowance,venue,output}=chosen,minimum=output*BigInt(10000-intent.slippageBps)/10000n;if(minimum<=0n)throw Error('最低到账为零');
 const receiveNative=same(pool.quote,WBNB)&&intent.currency!=='WBNB',data=saleData(d,pool,intent.asset,w,amount,minimum,receiveNative);
 return {kind:'contract',route:d.id+'-opening',account:intent.account,token:intent.asset,wallet:w,inputToken:intent.asset,outputToken:receiveNative?BNB:pool.quote,amountIn:String(amount),holdingBefore:String(balance),decimals:meta.decimals,minOutput:String(minimum),
  identity:{...meta.identity,learnedAssets:venue.assets},opening:{...pool,detectedAt:snapshot.at,reusedDetection:reused},state:pool,requireSellCredit:true,
  slippage:{mode:'fixed',bps:intent.slippageBps,capBps:intent.slippageBps},quote:{toCoinAmount:formatUnits(output,18)},review:[],steps:[
   ...(allowance<amount?[{kind:'approve',to:intent.asset,value:'0',data:ERC20.encodeFunctionData('approve',[d.router,amount]),spender:d.router,allowance:String(amount)}]:[]),
   {kind:'sell',to:d.router,value:'0',data}
  ]};
}
const SWAP=new Interface(['event Swap(address indexed sender,uint amount0In,uint amount1In,uint amount0Out,uint amount1Out,address indexed to)']);
const V3_SWAP=new Interface(['event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)','event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint128 protocolFeesToken0,uint128 protocolFeesToken1)']);
const TRANSFERS=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)','event Withdrawal(address indexed src,uint256 wad)']);
export function openingSettlement({receipt,token,state,wallet:owner,plan,step}){
 // A fee token can swap its own accrued taxes in the SAME pool/receipt before
 // crediting the user's input. Summing all Swap events attributes that unrelated
 // sale to the wallet. Select the wallet-funded leg and prove its output instead.
 const d=dexFor(state),nativeOut=same(plan?.outputToken,BNB);
 if(!d||!owner||!plan||!same(step?.to,d.router)||!same(plan.inputToken,token)||
  !(same(token,state.token0)||same(token,state.token1))||
  !same(state.quote,same(token,state.token0)?state.token1:state.token0)||
  !(nativeOut?same(state.quote,WBNB):same(plan.outputToken,state.quote)))throw Error('开盘卖出回执缺少可信路线与收款身份');
 const recipient=nativeOut?d.router:owner,transfers=[],swaps=[];
 for(const [index,log]of (receipt.logs||[]).entries()){
  if(same(log.address,token)||same(log.address,state.quote)){
   let e;try{e=TRANSFERS.parseLog(log);}catch{}if(e)transfers.push({index,asset:log.address,...e});
  }
  if(same(log.address,state.pool)){
   let e;try{e=(state.kind==='v3'?V3_SWAP:SWAP).parseLog(log);}catch{}if(e)swaps.push({index,...e});
  }
 }
 const debits=transfers.filter(e=>e.name==='Transfer'&&same(e.asset,token)&&same(e.args.from,owner)&&!same(e.args.to,owner));
 const funding=debits.filter(e=>same(e.args.to,state.pool)&&e.args.value>0n);
 const amountIn=debits.reduce((n,e)=>n+e.args.value,0n),poolCredit=funding.reduce((n,e)=>n+e.args.value,0n);
 if(!funding.length||amountIn<=0n||amountIn>BigInt(plan.amountIn))throw Error('未能核验本钱包实际支出或支出超出本笔金额');
 const anchor=funding.at(-1).index;
 const legs=swaps.filter(e=>e.index>anchor&&same(e.args.sender,d.router)&&same(e.args[state.kind==='v3'?'recipient':'to'],recipient));
 if(legs.length!==1)throw Error('无法唯一归属本钱包的卖出事件');
 const leg=legs[0],zero=same(token,state.token0);
 const poolInput=state.kind==='v3'?leg.args[zero?'amount0':'amount1']:leg.args[zero?'amount0In':'amount1In'];
 const poolOutput=state.kind==='v3'?-leg.args[zero?'amount1':'amount0']:leg.args[zero?'amount1Out':'amount0Out'];
 if(poolInput<=0n||poolOutput<=0n||state.kind==='v2'&&(leg.args[zero?'amount1In':'amount0In']!==0n||leg.args[zero?'amount0Out':'amount1Out']!==0n))throw Error('开盘卖出回执方向不一致');
 if(poolInput!==poolCredit||poolInput>amountIn)throw Error('池子输入与本钱包转入不一致');
 // V3 pays output before collecting input, so use the previous pool swap as
 // the output boundary. For taxed quote tokens count only actual recipient credit.
 const previous=swaps.filter(e=>e.index<leg.index).at(-1)?.index??-1;
 const amountOut=transfers.filter(e=>e.name==='Transfer'&&same(e.asset,state.quote)&&e.index>previous&&e.index<leg.index&&same(e.args.from,state.pool)&&same(e.args.to,recipient)).reduce((n,e)=>n+e.args.value,0n);
 if(amountOut<=0n||amountOut>poolOutput)throw Error('回执未证明本笔卖出的收款到账');
 if(nativeOut){
  const withdrawals=transfers.filter(e=>e.name==='Withdrawal'&&same(e.asset,WBNB)&&e.index>leg.index&&same(e.args.src,d.router));
  if(withdrawals.length!==1||withdrawals[0].args.wad<amountOut)throw Error('回执未证明本笔 BNB 解包到账');
 }
 return {amountOut,amountIn,poolAmountIn:poolInput,attribution:'wallet-funded-swap'};
}
