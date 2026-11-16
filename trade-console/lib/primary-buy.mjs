import {infinityBuyPool,INFINITY_BUY} from './infinity-buy.mjs';
import {WBNB,same,native,formatUnits} from './common.mjs';
import {OpeningPools,refreshOpeningPoolProvenance} from './opening-pools.mjs';
import {conversions} from './trade-conversion.mjs';
import {starsBuyTax} from './stars.mjs';

// Reuse authenticated pool discovery in both directions. A sell-side bridge
// token -> USDT -> WBNB becomes WBNB -> USDT -> token; all legs stay pinned.
export function reverseBuyPool(p,token){
 const input=p.quote,legs=p.legs?[...p.legs].reverse():null;
 if(p.kind==='infinity-cl')p=infinityBuyPool(p,token);
 return {...p,...(legs?legs[0]:{}),token:input,quote:token,
  declaredByToken:!!p.declaredByToken,primaryPool:p.pool,
  ...(legs?{path:[...p.path].reverse(),legs}:{}),buySource:p};
}
export async function primaryBuyPlan(rpc,intent,seed,{scan=(t,o)=>new OpeningPools(rpc).scan(t,o),converter=conversions(rpc),slippagePromise}={}){
 // Box an independently requested policy so a scan error cannot orphan it.
 const policy=Promise.resolve(slippagePromise||seed.slippage).then(value=>({value}),error=>({error}));
 const [snapshot,asset]=await Promise.all([scan(seed.token,{currency:intent.currency}),converter.prep?.token(seed.token)]);
 const payment=native(seed.inputToken)?WBNB:seed.inputToken;
 const pools=snapshot.pools.filter(p=>p.liquid&&same(p.quote,payment)&&['v2','v3','infinity-cl'].includes(p.kind));
 if(!pools.length)throw Object.assign(Error(snapshot.routeIssue||'未找到付款币对应的可核验买入池；不会交给聚合器改走未知池子，未提交交易'),{code:'BUY_ROUTE_UNAVAILABLE'});
 const r=await policy;if(r.error)throw r.error;const slippage=r.value;
 if(!Number.isInteger(slippage?.bps)||slippage.bps<0||slippage.bps>intent.slippageBps)throw Error('买入滑点超出本次上限');
 const trade=await converter.plan({inputToken:seed.inputToken,outputToken:seed.token,amount:BigInt(seed.amountIn),owner:seed.wallet,slippageBps:slippage.bps,maxHops:1,
  quotedOutput:starsBuyTax(asset?.identity),
  routeCandidates:pools.map(p=>reverseBuyPool(refreshOpeningPoolProvenance(snapshot,p),seed.token)),
  refreshProvenance:p=>({...p,declaredByToken:!!refreshOpeningPoolProvenance(snapshot,p.buySource).declaredByToken})});
 trade.steps.at(-1).kind='buy';
 return {kind:'contract',route:trade.selectedPool?.kind==='infinity-cl'?INFINITY_BUY:'primary-pool',account:intent.account,wallet:seed.wallet,token:seed.token,inputToken:seed.inputToken,outputToken:seed.token,
  amountIn:seed.amountIn,holdingBefore:seed.holdingBefore,decimals:seed.decimals,outputDecimals:trade.outputDecimals,minOutput:trade.minOutput,
  stagedTrade:trade.selectedPool?.kind!=='infinity-cl',state:trade.selectedPool,requireTradeCredit:true,protocolIdentities:trade.identities,poolFees:trade.fees,
  primaryPool:trade.selectedPool?.primaryPool||trade.selectedPool?.pool,primarySelected:trade.primarySelected,slippage,
  quote:{fromCoinAmount:formatUnits(seed.amountIn,18),toCoinAmount:formatUnits(trade.amountOut,trade.outputDecimals)},review:[],steps:trade.steps};
}
