import {same,formatUnits} from './common.mjs';
import {recoverableOpeningSale} from './opening-recovery.mjs';
import {providerRefusal} from './provider-outcome.mjs';

// A quote can exist for a pool whose actual transfer currently fails. Prefer
// another verified venue before sending anything; every venue still simulates.
export function recentOpeningPreviewFailures(orders,intent,now=Date.now()){
 if(!intent.openingOnly||intent.side!=='sell')return [];
 return orders.filter(o=>o.status==='BLOCKED'&&!o.steps?.length&&!o.orderId&&!o.txHash&&
  (o.error?.code==='OFFICIAL_SIMULATION_FAILED'||String(o.error?.code)==='351805'&&o.error.details?.officialSimulationFailed===true)&&o.createdAt<=now&&o.createdAt>=now-10000&&
  o.intent?.account===intent.account&&same(o.intent.asset,intent.asset)&&o.intent.currency===intent.currency&&o.intent.slippageBps===intent.slippageBps&&o.intent.gasLimit===intent.gasLimit&&
  o.plan?.requireSellCredit&&o.plan.steps?.length===1&&o.plan.steps[0].kind==='sell'&&o.plan.identity?.fingerprint&&o.plan.opening?.pool)
 .map(o=>({pool:o.plan.opening.pool,fingerprint:o.plan.identity.fingerprint,amountIn:o.plan.amountIn,holdingBefore:o.plan.holdingBefore}));
}

// Evidence only changes route preference, never amount, slippage, gas policy,
// or authorization. Scope it to this token/code and recent confirmed outcomes.
export function provenAggregateRoute(orders,intent,plan,now=Date.now()){
 if(!intent.openingOnly||intent.side!=='sell'||intent.gasLimit!==undefined||!plan.opening||!plan.identity?.fingerprint)return null;
 const recent=orders.filter(o=>o.simulationOnly===false&&o.intent?.side==='sell'&&same(o.intent.asset,intent.asset)&&
  same(o.plan?.outputToken,plan.outputToken)&&o.createdAt<=now&&o.createdAt>=now-3600000).sort((a,b)=>b.createdAt-a.createdAt);
 const aggregate=recent.find(o=>o.plan?.kind==='swap'&&(o.status==='CONFIRMED'||o.status==='FAILED'||o.status==='REJECTED'));
 if(aggregate?.status!=='CONFIRMED'||aggregate.receipt?.status!=='FINISHED'||!aggregate.orderId||!/^0x[\da-f]{64}$/i.test(aggregate.txHash||'')||aggregate.refund?.length)return null;
 const failed=recent.find(o=>o.createdAt<aggregate.createdAt&&recoverableOpeningSale(o)&&o.plan.identity?.fingerprint===plan.identity.fingerprint);
 return failed?{failedId:failed.id,successfulId:aggregate.id,reason:'verified-direct-revert-then-aggregate-success'}:null;
}
export async function preferProvenOpeningRoute(bridge,intent,plan,orders){
 const hint=provenAggregateRoute(orders,intent,plan);if(!hint)return plan;
 const args=['--binanceChainId','56','--fromToken',plan.inputToken,'--toToken',plan.outputToken,'--fromTokenQty',formatUnits(BigInt(plan.amountIn),plan.decimals),'--slippage',String(intent.slippageBps/100)];
 let quote;try{quote=await bridge.call(intent.account,['market-order','quote',...args]);}
 catch(e){if(providerRefusal(e)?.kind==='APP_RISK_REVIEW')throw e;return {...plan,routePreference:{...hint,available:false}};}
 if(!Number.isFinite(Number(quote.toCoinAmount))||Number(quote.toCoinAmount)<=0)return {...plan,routePreference:{...hint,available:false}};
 return {kind:'swap',route:'binance-aggregate',wallet:plan.wallet,token:plan.token,inputToken:plan.inputToken,outputToken:plan.outputToken,
  amountIn:plan.amountIn,holdingBefore:plan.holdingBefore,decimals:plan.decimals,identity:plan.identity,quote,
  slippage:plan.slippage,args,review:[],steps:[],opening:plan.opening,routePreference:{...hint,available:true}};
}
