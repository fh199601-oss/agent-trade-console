import {hash,parseUnits} from './common.mjs';
import {assessSellFees} from './trade-fees.mjs';
import {previewUsable} from './preview-cache.mjs';

// A queued wallet may simulate its own sale while another wallet is settling.
// It does NOT bypass the pool lane. At its turn a fresh on-chain quote must
// still leave at least half the original price cushion, with the exact same
// amount/recipient/venue/fees. Keep the original calldata and minimum; never
// rewrite a requestId's transaction or relax its minimum to reuse a preview.
export function queuedSellEligible(plan,index){
 return plan?.kind==='contract'&&!plan.stagedTrade&&plan.requireSellCredit===true&&
  ['v2','v3'].includes(plan.opening?.kind)&&index===plan.steps.length-1&&plan.steps[index].kind==='sell';
}
function binding(p){
 const o=p.opening;
 return hash({account:p.account,wallet:p.wallet,token:p.token,input:p.inputToken,output:p.outputToken,
  amount:p.amountIn,balance:p.holdingBefore,decimals:p.outputDecimals,route:p.route,slippage:p.slippage,
  identity:p.identity,protocolIdentities:p.protocolIdentities,authorizationMinOutput:p.authorizationMinOutput,
  audit:{available:p.audit?.available,tax:p.audit?.taxes?.sellTax,unusual:p.audit?.taxes?.unusualSellTax,flagged:p.audit?.taxes?.isFlaggedByVendor},
  pool:o.pool,kind:o.kind,id:o.id,router:o.router,factory:o.factory,quote:o.quote,fee:o.fee,
  path:o.path,legs:o.legs?.map(l=>({pool:l.pool,kind:l.kind,router:l.router,factory:l.factory,token0:l.token0,token1:l.token1})),
  fees:{poolFeePpm:p.poolFees?.poolFeePpm,quoteLossPpm:p.poolFees?.quoteLossPpm,pools:p.poolFees?.pools},
  prefix:p.steps.slice(0,-1),target:p.steps.at(-1).to,value:p.steps.at(-1).value});
}
export function reusableQueuedSell(fresh,warmed,now=Date.now()){
 try{
  const old=warmed?.plan,p=warmed?.preview,index=fresh.steps.length-1,age=now-p?.at;
  if(!queuedSellEligible(fresh,index)||!queuedSellEligible(old,index)||!previewUsable(p,now,10000)||binding(old)!==binding(fresh))return null;
  const quoted=parseUnits(String(old.quote.toCoinAmount),old.outputDecimals??18),latest=parseUnits(String(fresh.quote.toCoinAmount),fresh.outputDecimals??18);
  const minimum=BigInt(old.minOutput),cushion=quoted-minimum;
  if(quoted<=0n||minimum<=0n||cushion<0n||minimum<BigInt(fresh.minOutput)||latest<quoted-cushion/2n)return null;
  // Preserve the old quote for conservative simulated shortfall accounting.
  // Latest reserves and independently rechecked fee proof still govern the sale.
  const plan={...fresh,quote:old.quote,latestQuote:fresh.quote,minOutput:old.minOutput,steps:[...fresh.steps.slice(0,-1),old.steps.at(-1)]};
  if([assessSellFees(old,p.review,{beforeSell:true}),assessSellFees(plan,p.review,{beforeSell:true})].some(f=>f.blocked||f.required))return null;
  return {plan,preview:p,ageMs:age};
 }catch{return null;}
}
