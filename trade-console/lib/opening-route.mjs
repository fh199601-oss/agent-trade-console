import {InfinityPools,infinityQuote,infinitySaleData,infinityApprovals,infinitySettlement} from './infinity.mjs';
import {Interface,read,ERC20,WBNB,BNB,wallet,same,formatUnits} from './common.mjs';
import {OpeningPools,freshOpeningSnapshot} from './opening-pools.mjs';
import {DEXES,dexFor,matchesCurrency,poolRouteKey,QUOTES,V2_ROUTER_ABI,V3_LEGACY,V3_MODERN,QUOTER} from './opening-dex.mjs';
import {OpeningPreparation} from './opening-preparation.mjs';
import {sellAmount} from './sell-policy.mjs';
import {multiHopSettlement} from './opening-multihop.mjs';
import {poolFeeProof,compareFeeRoutes,HIGH_FEE_PPM,feePercent} from './trade-fees.mjs';
import {openingReads} from './opening-read.mjs';
import {POOL} from './opening-pools.mjs';
export const ROUTER=V2_ROUTER_ABI;
function saleData(d,pool,token,owner,amount,minimum,receiveNative){
 if(d.kind==='infinity-cl')return infinitySaleData(pool,token,owner,amount,minimum,receiveNative);
 const deadline=Math.floor(Date.now()/1000)+120;
 if(d.kind==='v2')return ROUTER.encodeFunctionData(receiveNative?'swapExactTokensForETHSupportingFeeOnTransferTokens':'swapExactTokensForTokensSupportingFeeOnTransferTokens',[amount,minimum,pool.path||[token,pool.quote],owner,deadline]);
 const abi=d.legacy?V3_LEGACY:V3_MODERN,params=[token,pool.quote,pool.fee,receiveNative?d.router:owner,...(d.legacy?[deadline]:[]),amount,minimum,0];
 const calls=[abi.encodeFunctionData('exactInputSingle',[params]),...(receiveNative?[abi.encodeFunctionData('unwrapWETH9',[minimum,owner])]:[])];
 return d.legacy?(calls.length===1?calls[0]:abi.encodeFunctionData('multicall(bytes[])',[calls])):abi.encodeFunctionData('multicall(uint256,bytes[])',[deadline,calls]);
}
export async function refreshOpeningSell(rpc,plan){
 const pool=plan.opening,d=dexFor(pool),amount=BigInt(plan.amountIn);
 if(!d||!plan.requireSellCredit||!same(plan.steps.at(-1)?.to,d.router)||!same(wallet(plan.account).address,plan.wallet))throw Error('开盘卖出刷新缺少可信路线');
 if(d.kind==='infinity-cl'){
  const [[balance],freshPool]=await Promise.all([read(rpc,plan.token,ERC20,'balanceOf',[plan.wallet]),new InfinityPools(rpc).state(plan.token,pool.pool)]);
  if(!freshPool||String(balance)!==plan.holdingBefore)throw Error('授权期间持仓或 Infinity 池身份已变化，请重新预览');
  const {output,fees}=await infinityQuote(rpc,freshPool,plan.token,amount);let minimum=output*BigInt(10000-plan.slippage.bps)/10000n;
  if(plan.authorizationMinOutput!==undefined&&BigInt(plan.authorizationMinOutput)>minimum)minimum=BigInt(plan.authorizationMinOutput);
  if(minimum<=0n||output<minimum)throw Error('Infinity 最新报价不足原最低到账');
  const step={...plan.steps.at(-1),data:saleData(d,freshPool,plan.token,plan.wallet,amount,minimum,same(plan.outputToken,BNB))};
  return {...plan,opening:freshPool,state:freshPool,poolFees:fees,minOutput:String(minimum),quote:{...plan.quote,toCoinAmount:formatUnits(output,plan.outputDecimals??18)},quoteRefreshedAt:Date.now(),steps:[...plan.steps.slice(0,-1),step]};
 }
 const requests=d.kind==='v2'?[...(pool.legs||[pool]).map(p=>({to:p.pool,abi:POOL,method:'getReserves'})),{to:d.router,abi:ROUTER,method:'getAmountsOut',args:[amount,pool.path||[plan.token,pool.quote]]}]:[{to:d.quoter,abi:QUOTER,method:'quoteExactInputSingle',args:[[plan.token,pool.quote,amount,pool.fee,0]]}];
 const [[balance],batch]=await Promise.all([read(rpc,plan.token,ERC20,'balanceOf',[plan.wallet]),openingReads(rpc,requests)]);
 if(batch.results.some(r=>r.status!=='fulfilled'))throw Error('最新池费与报价查询未完成，未提交');
 const quoted=batch.results.at(-1).value,legs=d.kind==='v2'?(pool.legs||[pool]).map((p,i)=>({...p,block:batch.block,reserve0:String(batch.results[i].value[0]),reserve1:String(batch.results[i].value[1])})):null;
 const freshPool=legs?{...pool,...legs[0],...(pool.legs?{quote:pool.quote,path:pool.path,legs}:{})}:pool;
 if(String(balance)!==plan.holdingBefore)throw Error('授权期间持仓已变化，请重新预览');
 const output=d.kind==='v2'?quoted[0].at(-1):quoted[0];let minimum=output*BigInt(10000-plan.slippage.bps)/10000n;
 if(plan.authorizationMinOutput!==undefined&&BigInt(plan.authorizationMinOutput)>minimum)minimum=BigInt(plan.authorizationMinOutput);
 if(output<minimum)throw Error('备用路线刷新报价不足原最低到账');
 if(minimum<=0n||d.kind==='v2'&&(quoted[0].length!==(pool.path?.length||2)||quoted[0][0]!==amount))throw Error('开盘卖出刷新报价无效');
 const step={...plan.steps.at(-1),data:saleData(d,pool,plan.token,plan.wallet,amount,minimum,same(plan.outputToken,BNB))};
 return {...plan,opening:freshPool,state:freshPool,poolFees:poolFeeProof(freshPool,d.kind==='v2'?quoted[0]:null,plan.token,batch.block),minOutput:String(minimum),quote:{...plan.quote,toCoinAmount:formatUnits(output,plan.outputDecimals??18)},quoteRefreshedAt:Date.now(),steps:[...plan.steps.slice(0,-1),step]};
}
export async function openingPlan(rpc,bridge,intent,{scan=(t,o)=>new OpeningPools(rpc).scan(t,o),snapshot,preparation,identityFor,holdingHint,failedPreviews=[],excludedRoutes=[],lowFeeOnly=false,expand=false,outputToken,minimumOutput,slippagePromise}={}){
 // Pool discovery and token/holding reads are independent. Only metadata is
 // cached: the balance and every allowance are read afresh for this operation.
 // Box a concurrently requested policy now, including on an early scan error.
 const policy=slippagePromise?Promise.resolve(slippagePromise).then(value=>({value}),error=>({error})):null;
 const w=wallet(intent.account).address,prep=preparation||new OpeningPreparation(rpc,{...(identityFor?{identityFor}:{})});
 const reused=freshOpeningSnapshot(snapshot,intent.asset)&&(!expand||snapshot.expanded);
 // An opening/claim-linked task may receive its tokens during detection. Keep
 // that holding read AFTER detection so pre-opening zero cannot skip a sale.
 const tokenReads=Promise.all([prep.token(intent.asset),...(intent.openingOnly?[]:[read(rpc,intent.asset,ERC20,'balanceOf',[w])])]).then(value=>({value}),error=>({error}));
 snapshot=reused?snapshot:await scan(intent.asset,{currency:intent.currency,expand});
 const candidates=snapshot.pools.filter(p=>p.liquid&&matchesCurrency(p,intent.currency)&&dexFor(p)&&!excludedRoutes.includes(poolRouteKey(p))&&(!outputToken||same(p.quote,same(outputToken,BNB)?WBNB:outputToken)));
 if(!candidates.length)throw Object.assign(Error(snapshot.routeIssue||(excludedRoutes.length?'本轮已核验的池子中，没有符合原到账币种的其他路线':intent.openingOnly?'等待可核验的外盘卖出池子；不会提前使用内盘卖出':'当前未找到可成交的卖出池：可能流动性尚未开放、已移除，或池型尚未支持；未提交，钱包可继续操作')),{code:intent.openingOnly?'OPENING_WAIT':'SELL_ROUTE_UNAVAILABLE'});
 const dexes=[...new Map(candidates.map(p=>{const d=dexFor(p);return [d.id,d];})).values()];
 const poolQuote=(pool,amount)=>{const d=dexFor(pool);return d.kind==='infinity-cl'?infinityQuote(rpc,pool,intent.asset,amount):d.kind==='v2'?read(rpc,d.router,ROUTER,'getAmountsOut',[amount,pool.path||[intent.asset,pool.quote]],pool.block??'latest'):read(rpc,d.quoter,QUOTER,'quoteExactInputSingle',[[intent.asset,pool.quote,amount,pool.fee,0]],pool.block??'latest');};
 // After a verified opening, a recent warm holding may predict a READ-ONLY
 // quote amount so balance + allowance + quote share one RPC round-trip.
 // It never sets the sell amount: consume only after a fresh balance and
 // identity match. Any mismatch discards it and quotes the fresh amount.
 const predicted=new Map(),age=Date.now()-holdingHint?.at;
 if(intent.openingOnly&&age>=0&&age<=6000&&same(holdingHint?.token,intent.asset)&&same(holdingHint?.wallet,w)&&holdingHint?.fingerprint&&/^\d{1,78}$/.test(holdingHint.balance)&&BigInt(holdingHint.balance)>0n&&BigInt(holdingHint.balance)<2n**256n){
  let amount;try{amount=sellAmount(BigInt(holdingHint.balance),intent.percent);}catch{/* Dust in an old hint is not the live holding. */}
  if(amount)for(const p of candidates.slice(0,8))if(p.kind!=='infinity-cl')predicted.set(p,poolQuote(p,amount).then(value=>({value}),error=>({error})));
 }
 // Warm data never authorizes an amount or approval. Both remain fresh reads.
 // Don't make every venue wait for the slowest allowance endpoint. Each
 // bounded candidate waits for its own fresh allowance alongside its quote.
 // Box failures immediately, including when a zero holding ends planning.
 const allowances=new Map(dexes.map(d=>[d.id,(d.kind==='infinity-cl'?Promise.resolve([0n]):read(rpc,intent.asset,ERC20,'allowance',[w,d.router])).then(value=>({value:value[0]}),error=>({error}))]));
 const [tokenResult,openingBalance]=await Promise.all([tokenReads,intent.openingOnly?read(rpc,intent.asset,ERC20,'balanceOf',[w]):null]);if(tokenResult.error)throw tokenResult.error;const [meta,earlyBalance]=tokenResult.value,[balance]=openingBalance||earlyBalance;
 const amount=sellAmount(balance,intent.percent);
 const failed=p=>failedPreviews.some(f=>same(f.pool,p.pool)&&f.fingerprint===meta.identity?.fingerprint&&f.amountIn===String(amount)&&f.holdingBefore===String(balance));
 candidates.sort((a,b)=>{
  const high=p=>['v3','infinity-cl'].includes(p.kind)&&p.fee>=HIGH_FEE_PPM;
  if(high(a)!==high(b))return high(a)?1:-1;
  if(failed(a)!==failed(b))return failed(a)?1:-1;
  const score=p=>{const index=QUOTES.findIndex(q=>same(q,p.quote));return (p.declaredByToken?50:0)+(p.kind==='v2'?10:0)+(index<0?0:QUOTES.length-index);};
  const diff=score(b)-score(a);if(diff)return diff;
  const depth=p=>BigInt(p.kind==='v2'?(same(p.token0,intent.asset)?p.reserve1:p.reserve0)||'0':p.liquidity||'0');return depth(b)>depth(a)?1:depth(b)<depth(a)?-1:0;
 });
 // Try independent candidates only before any preview or submission. Keep the
 // fast first batch, but do not hide a low-fee route behind eight bad quotes.
 const quoteCandidate=async pool=>{const d=dexFor(pool);
  const hinted=predicted.get(pool)&&holdingHint.balance===String(balance)&&holdingHint.fingerprint===meta.identity?.fingerprint?predicted.get(pool).then(r=>{if(r.error)throw r.error;return r.value;}):null;
  const [venue,quoted,outputMeta,approval]=await Promise.all([prep.venue(d),hinted||poolQuote(pool,amount),QUOTES.some(q=>same(q,pool.quote))?{decimals:18}:prep.quote(pool.quote),allowances.get(d.id)]);
  if(approval.error)throw Error('无法读取当前授权额度');const allowance=approval.value;
  const output=d.kind==='infinity-cl'?quoted.output:d.kind==='v2'?quoted[0].at(-1):quoted[0];if(output<=0n||d.kind==='v2'&&(quoted[0].length!==(pool.path?.length||2)||quoted[0][0]!==amount))throw Error('开盘卖出报价无效');
  if(minimumOutput!==undefined&&output<BigInt(minimumOutput))throw Error('备用路线报价不足原最低到账');
  return {pool,d,allowance,venue,output,failed:failed(pool),outputDecimals:outputMeta.decimals,fees:d.kind==='infinity-cl'?quoted.fees:poolFeeProof(pool,d.kind==='v2'?quoted[0]:null,intent.asset,pool.block)};
 };
 // Compare bounded parallel quotes. Fast/previously approved is not evidence
 // of cheap. A hung quote cannot indefinitely block the remaining candidates.
 const bounded=async pool=>{let timer;try{return await Promise.race([quoteCandidate(pool),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('报价超时')),pool.kind==='infinity-cl'?4000:1200))]);}finally{clearTimeout(timer);}};
 const results=[];let usable=[];
 for(let start=0;start<Math.min(candidates.length,32);start+=8){
  results.push(...await Promise.allSettled(candidates.slice(start,start+8).map(bounded)));
  usable=results.filter(r=>r.status==='fulfilled').map(r=>r.value);
  if(usable.some(r=>r.fees.poolFeePpm!==null&&Math.max(r.fees.poolFeePpm,r.fees.quoteLossPpm||0)<HIGH_FEE_PPM&&!r.failed))break;
 }
 if(lowFeeOnly)usable=usable.filter(r=>r.fees.poolFeePpm!==null&&Math.max(r.fees.poolFeePpm,r.fees.quoteLossPpm||0)<HIGH_FEE_PPM);
 usable.sort(compareFeeRoutes);
 const chosen=usable[0],lastError=results.find(r=>r.status==='rejected')?.reason;
 // A quote failure can be a thin/closed pool, not the absence of all pools.
 // Expand once BEFORE any authorization/submission; fixed output stays fixed.
 if(!chosen&&!expand&&!intent.openingOnly)return openingPlan(rpc,bridge,intent,{scan,preparation:prep,failedPreviews,excludedRoutes,lowFeeOnly,expand:true,outputToken,minimumOutput,slippagePromise});
 if(!chosen)throw Object.assign(Error(lowFeeOnly?'本轮未找到池费低于 '+feePercent(HIGH_FEE_PPM)+' 且满足原到账约束的可核验路线':'可用池子尚无有效卖出报价：'+(lastError?.message||'没有可用报价')),{code:intent.openingOnly?'OPENING_WAIT':'SELL_QUOTE_UNAVAILABLE'});
 const resolvedPolicy=policy?await policy:{value:{mode:'fixed',bps:intent.slippageBps,capBps:intent.slippageBps}};if(resolvedPolicy.error)throw resolvedPolicy.error;
 const slippage=resolvedPolicy.value;if(!Number.isInteger(slippage?.bps)||slippage.bps<0||slippage.bps>intent.slippageBps)throw Error('卖出滑点超出本次上限');
 const {pool,d,allowance,venue,output,outputDecimals}=chosen;let minimum=output*BigInt(10000-slippage.bps)/10000n;if(minimumOutput!==undefined&&BigInt(minimumOutput)>minimum)minimum=BigInt(minimumOutput);if(minimum<=0n)throw Error('最低到账为零');
 const approvalSteps=d.kind==='infinity-cl'?await infinityApprovals(rpc,intent.asset,w,amount):allowance<amount?[{kind:'approve',to:intent.asset,value:'0',data:ERC20.encodeFunctionData('approve',[d.router,amount]),spender:d.router,allowance:String(amount)}]:[];
 const receiveNative=same(pool.quote,WBNB)&&(outputToken?same(outputToken,BNB):intent.currency!=='WBNB'),data=saleData(d,pool,intent.asset,w,amount,minimum,receiveNative);
 return {kind:'contract',route:d.id+'-opening',account:intent.account,token:intent.asset,wallet:w,inputToken:intent.asset,outputToken:receiveNative?BNB:pool.quote,amountIn:String(amount),holdingBefore:String(balance),decimals:meta.decimals,outputDecimals,minOutput:String(minimum),
  identity:{...meta.identity,learnedAssets:venue.assets},opening:{...pool,detectedAt:snapshot.at,reusedDetection:reused},state:pool,requireSellCredit:true,
  poolFees:chosen.fees,...(minimumOutput!==undefined?{authorizationMinOutput:String(minimumOutput)}:{}),routeSearch:{quoted:results.length,candidates:candidates.length,limited:results.length<candidates.length,expanded:!!snapshot.expanded},slippage,quote:{toCoinAmount:formatUnits(output,outputDecimals)},review:[],steps:[
   ...approvalSteps,
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
 if(state?.kind==='infinity-cl')return infinitySettlement({receipt,token,state,wallet:owner,plan,step});
 if(state?.legs)return multiHopSettlement({receipt,token,state,wallet:owner,plan,step});
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
