import {BNB,USDT,WBNB,same} from './common.mjs';
import {providerRefusal} from './provider-outcome.mjs';
import {openingPlan} from './opening-route.mjs';
export function rejectedAggregateSale(order,intent){
 return intent.side==='sell'&&!intent.openingOnly&&order?.status==='REJECTED'&&order.intent?.side==='sell'&&
  order.intent.account===intent.account&&same(order.intent.asset,intent.asset)&&order.plan?.kind==='swap'&&
  !order.orderId&&!order.txHash&&!order.result&&!order.receipt&&!order.steps?.length&&
  providerRefusal(order.error)?.kind==='INVALID_PARAMETERS';
}
// Only a NEW explicit user operation may enter this path. The failed order is
// never replayed. The current aggregate quote supplies the user's auto-slippage
// constraint; a verified pool supplies a fresh direct transaction and simulation.
export async function manualDirectSell(rpc,bridge,intent,aggregate,options){
 const currency=same(aggregate.outputToken,BNB)?'BNB':same(aggregate.outputToken,USDT)?'USDT':same(aggregate.outputToken,WBNB)?'WBNB':null;
 if(intent.side!=='sell'||aggregate.kind!=='swap'||!currency||!Number.isInteger(aggregate.slippage?.bps)||aggregate.slippage.bps>intent.slippageBps)throw Error('无法保留本次卖出约束，未切换路线');
 const plan=await openingPlan(rpc,bridge,{...intent,currency,slippageBps:aggregate.slippage.bps},options);
 if(!same(plan.wallet,aggregate.wallet)||!same(plan.inputToken,aggregate.inputToken)||!same(plan.outputToken,aggregate.outputToken)||plan.amountIn!==aggregate.amountIn||plan.holdingBefore!==aggregate.holdingBefore)throw Error('切换卖出路线期间持仓或交易资产已变化，请重新预览');
 return {...plan,slippage:aggregate.slippage,manualRouteRecovery:true};
}
