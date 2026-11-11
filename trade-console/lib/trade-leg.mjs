import {same,native} from './common.mjs';
// Only server-generated staged Gang plans may change assets between steps.
// User intent never accepts tradeLeg/stagedTrade. Every leg is checked against
// its own input cap and minimum credit, not against a different leg's asset.
export function tradeLegPlan(plan,step){
 if(!step.tradeLeg)return plan;
 const leg=step.tradeLeg;
 if(!plan.stagedTrade||!['gang-modern','gang-pool','gang'].includes(plan.route)||!['gang-modern','gang','trade-conversion'].includes(leg.settlementRoute)||!['buy','sell','conversion'].includes(step.kind)||!/^\d+$/.test(leg.amountIn)||!/^\d+$/.test(leg.minOutput)||BigInt(leg.amountIn)<=0n||BigInt(leg.minOutput)<=0n)throw Error('分步交易资产约束无效');
 for(const a of [leg.inputToken,leg.outputToken])if(!/^0x[\da-f]{40}$/i.test(a))throw Error('分步交易资产无效');
 if(BigInt(step.value)>0n&&(!native(leg.inputToken)||BigInt(step.value)>BigInt(leg.amountIn)))throw Error('分步交易原生币支出超出授权');
 return {...plan,inputToken:leg.inputToken,outputToken:leg.outputToken,amountIn:leg.amountIn,minOutput:leg.minOutput,state:leg.state,route:leg.settlementRoute,token:leg.settlementRoute==='trade-conversion'?leg.inputToken:plan.token,requireTradeCredit:true,requireSellCredit:step.kind==='sell',requireRefundCredit:false};
}
