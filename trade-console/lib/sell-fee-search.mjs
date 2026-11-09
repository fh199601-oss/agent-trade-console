import {BNB,USDT,WBNB,same} from './common.mjs';
import {assessSellFees} from './trade-fees.mjs';
import {poolRouteKey} from './opening-dex.mjs';
import {openingPlan} from './opening-route.mjs';
import {freshOpeningSnapshot} from './opening-pools.mjs';
import {hasPreviewRisks} from './preview-risks.mjs';

export const MAX_FEE_ALTERNATIVES=3;
export const searchableSellPreviewError=e=>e?.code==='SELL_OUTPUT_BELOW_MIN'||e?.code==='OFFICIAL_SIMULATION_FAILED'||String(e?.code)==='351805'&&e.responseReceived===true&&e.details?.officialSimulationFailed===true;

// This function can only read and preview. It cannot submit, approve or retry a
// transaction. An unresolved/attempted sale forbids any alternate construction.
export async function findLowFeeSell(order,{rpc,bridge,scan,preparation,preview,planFn=openingPlan,minimumOutput}={}){
 const prior=order.plan,intent=order.intent;
 if(['PENDING','SUBMITTING','SUBMISSION_UNKNOWN','RECEIPT_REVIEW','CONFIRMED','CONFIRMED_REVIEW','FAILED'].includes(order.status)||intent?.side!=='sell'||!prior?.wallet||!prior.inputToken||!prior.outputToken||!prior.amountIn||!prior.holdingBefore||
  order.orderId||order.txHash||order.steps?.some(e=>e.status!=='CONFIRMED'||e.step?.kind!=='approve'))return null;
 const search=order.feeRouteSearch??={attempts:0,excluded:[],checks:[],status:'searching'};
 if(search.attempts>=MAX_FEE_ALTERNATIVES)return null;
 if(prior.opening&&!search.excluded.includes(poolRouteKey(prior.opening)))search.excluded.push(poolRouteKey(prior.opening));
 const bps=prior.slippage?.bps??intent.slippageBps;
 if(!Number.isInteger(bps)||bps<0||bps>intent.slippageBps)return null;
 const currency=same(prior.outputToken,BNB)?'BNB':same(prior.outputToken,WBNB)?'WBNB':same(prior.outputToken,USDT)?'USDT':'AUTO';
 let snapshot;
 const cachedScan=scan?async(t,options)=>{if(!freshOpeningSnapshot(snapshot,t)||!snapshot.expanded)snapshot=await scan(t,options);return snapshot;}:undefined;
 search.status='searching';
 while(search.attempts<MAX_FEE_ALTERNATIVES){
  search.attempts++;let next,key;
  try{
   next=await planFn(rpc,bridge,{...intent,currency,slippageBps:bps},{...(cachedScan?{scan:cachedScan}:{}),preparation,expand:true,lowFeeOnly:true,excludedRoutes:search.excluded,outputToken:prior.outputToken,minimumOutput});
   key=poolRouteKey(next.opening);
   if(!next.opening||search.excluded.includes(key))throw Error('备用路线重复或未固定池子');
   search.excluded.push(key);
   if(!same(next.wallet,prior.wallet)||!same(next.token,prior.token)||!same(next.inputToken,prior.inputToken)||!same(next.outputToken,prior.outputToken)||next.amountIn!==prior.amountIn||next.holdingBefore!==prior.holdingBefore||
    next.slippage?.bps!==bps||minimumOutput!==undefined&&BigInt(next.minOutput)<BigInt(minimumOutput)||prior.identity?.fingerprint&&next.identity?.fingerprint!==prior.identity.fingerprint)throw Error('备用路线改变了原钱包、资产、数量、滑点、最低到账或代币身份');
   Object.assign(next,{audit:prior.audit,slippage:prior.slippage||next.slippage,project:prior.project,resolved:prior.resolved,...(prior.recovery?{recovery:prior.recovery}:{})});
   const fee=assessSellFees(next);
   if(fee.blocked||fee.required){search.checks.push({route:key,result:'fee',reasons:fee.reasons});continue;}
   const p=await preview(next,intent,0),after=assessSellFees(next,next.steps[0]?.kind==='sell'?p?.review:null);
   if(after.blocked||after.required){search.checks.push({route:key,result:'fee',reasons:after.reasons});continue;}
   if(hasPreviewRisks(p?.raw.risks))throw Error('备用路线出现新的钱包风险提示，未自动采用');
   search.status='selected';search.selected=key;search.checks.push({route:key,result:'selected',poolFeePpm:after.poolFeePpm,additionalLossPpm:after.additionalLossPpm});
   return {plan:next,preview:p};
  }catch(e){
   search.checks.push({...(key?{route:key}:{}),result:'unavailable',code:e.code||'ERROR',message:e.message});
   // Only a proven pre-submit simulation failure can try another pool. A
   // transport/identity/risk error is never evidence of a safely failed trade.
   if(!key||!searchableSellPreviewError(e)){search.status='unavailable';return null;}
  }
 }
 search.status='limit';return null;
}
