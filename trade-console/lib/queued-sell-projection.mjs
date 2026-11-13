import {same,formatUnits} from './common.mjs';
import {V2_ROUTER_ABI} from './opening-dex.mjs';

// Forecasts only an UNSIGNED preview for a queued direct V2 sale. This is not
// an execution quote. The lane still waits for receipts; reusableQueuedSell
// then requires a fresh real quote, unchanged fees/holdings/code, a minimum
// at least as strict as the new authorized minimum, and an exact eth_call.
// Wrong predictions (including tax, other trades or already-mined predecessors)
// are harmless cache misses. Never apply this to a live plan outside that gate.
export function projectQueuedSale(plan,preceding=[]){
 try{
  const pool=plan.opening,bps=plan.slippage?.bps;
  if(pool?.kind!=='v2'||pool.legs?.length>1||pool.path?.length>2||!Number.isInteger(bps)||bps<=0||bps>5000)return plan;
  const prior=preceding.filter(p=>p&&same(p.token,plan.token)&&same(p.opening?.pool,pool.pool)&&p.wallet!==plan.wallet);
  if(!prior.length||prior.length>8||prior.some(p=>p.opening?.kind!=='v2'||p.opening?.legs?.length>1))return plan;
  const fee=plan.poolFees?.poolFeePpm;
  if(!Number.isInteger(fee)||fee<0||fee>=500000)return plan;
  let ri=BigInt(same(pool.token0,plan.token)?pool.reserve0:pool.reserve1),ro=BigInt(same(pool.token0,plan.token)?pool.reserve1:pool.reserve0);
  if(ri<=0n||ro<=0n)return plan;
  const out=x=>{const net=x*BigInt(1000000-fee);return net*ro/(ri*1000000n+net);};
  for(const p of prior){const x=BigInt(p.amountIn);if(x<=0n)return plan;const y=out(x);if(y<=0n||y>=ro)return plan;ri+=x;ro-=y;}
  const projected=out(BigInt(plan.amountIn));let minimum=projected*BigInt(10000-Math.floor(bps/2))/10000n;
  if(plan.authorizationMinOutput!==undefined&&BigInt(plan.authorizationMinOutput)>minimum)minimum=BigInt(plan.authorizationMinOutput);
  if(minimum<=0n||minimum>projected)return plan;
  const old=plan.steps.at(-1),tx=V2_ROUTER_ABI.parseTransaction(old);
  if(old.kind!=='sell'||!['swapExactTokensForETHSupportingFeeOnTransferTokens','swapExactTokensForTokensSupportingFeeOnTransferTokens'].includes(tx.name)||tx.args[0]!==BigInt(plan.amountIn)||!same(tx.args[3],plan.wallet))return plan;
  const args=[...tx.args];args[1]=minimum;
  return {...plan,quote:{...plan.quote,toCoinAmount:formatUnits(projected,plan.outputDecimals??18)},minOutput:String(minimum),
   queuedProjection:{predecessors:prior.length},steps:[...plan.steps.slice(0,-1),{...old,data:V2_ROUTER_ABI.encodeFunctionData(tx.fragment,args)}]};
 }catch{return plan;}
}
