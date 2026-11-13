import {same,native,parseUnits,WBNB} from './common.mjs';
import {dexFor,V2_ROUTER_ABI} from './opening-dex.mjs';
import {assessSellFees} from './trade-fees.mjs';

// Only a fixed, direct constant-product pool has the reserve model used here.
// This is admission control, never a replacement quote or relaxed minimum.
export function parallelSellCandidate(plan,index=plan?.steps?.length-1){
 try{
  const p=plan.opening,d=dexFor(p),s=plan.steps[index];
  return plan.kind==='contract'&&!plan.stagedTrade&&plan.requireSellCredit===true&&plan.audit?.available===true&&
   p.kind==='v2'&&d?.kind==='v2'&&same(d.router,p.router)&&same(s.to,d.router)&&s.kind==='sell'&&index===plan.steps.length-1&&
   (!p.legs||p.legs.length===1&&same(p.legs[0].pool,p.pool))&&(!p.path||p.path.length===2)&&same(plan.inputToken,plan.token)&&
   same(same(p.token0,plan.token)?p.token1:p.token0,p.quote)&&
   (same(p.token0,plan.token)||same(p.token1,plan.token))&&BigInt(p.reserve0)>0n&&BigInt(p.reserve1)>0n;
 }catch{return false;}
}

function describe(record,now){
 const {plan:p,review,at}=record;
 if(!parallelSellCandidate(p)||!Number.isFinite(at)||now-at<0||now-at>15000)throw Error('stale or unsupported');
 // A bound but uncertain submission counts as its FULL possible sale. This
 // never retries that wallet; it can still admit a different wallet if BOTH
 // outcomes (original executes / original never executes) fit all minimums.
 if(record.status&&!['SUBMITTING','SUBMISSION_UNKNOWN','PENDING','CONFIRMED','CONFIRMED_REVIEW'].includes(record.status))throw Error('unverified original');
 const fees=assessSellFees(p,review,{beforeSell:true});if(fees.blocked||fees.required)throw Error('unverified fees');
 if(p.poolFees?.source!=='same-block-reserves-and-quote'||p.poolFees.block!==p.opening.block||p.poolFees.pools?.length!==1||!same(p.poolFees.pools[0].address,p.opening.pool))throw Error('unbound fee proof');
 const x=BigInt(p.amountIn),minimum=BigInt(p.minOutput),pool=p.opening,fee=BigInt(fees.poolFeePpm);
 const ri=BigInt(same(pool.token0,p.token)?pool.reserve0:pool.reserve1),ro=BigInt(same(pool.token0,p.token)?pool.reserve1:pool.reserve0);
 const tx=V2_ROUTER_ABI.parseTransaction(p.steps.at(-1));
 if(!['swapExactTokensForETHSupportingFeeOnTransferTokens','swapExactTokensForTokensSupportingFeeOnTransferTokens'].includes(tx.name)||
  tx.args[0]!==x||tx.args[1]!==minimum||tx.args[2].length!==2||!same(tx.args[2][0],p.token)||!same(tx.args[2][1],pool.quote)||
  !same(tx.args[3],p.wallet)||tx.args[4]<=BigInt(Math.floor(now/1000)+5)||BigInt(p.steps.at(-1).value)!==0n||
  (tx.name==='swapExactTokensForETHSupportingFeeOnTransferTokens'?!(native(p.outputToken)&&same(pool.quote,WBNB)):!same(p.outputToken,pool.quote)))throw Error('unbound calldata');
 let credit=0n;
 for(const c of review?.balanceChanges||[]){
  if(!same(c.owner,p.wallet)||!(same(c.contractAddress,p.outputToken)||native(c.contractAddress)&&native(p.outputToken)))continue;
  if(c.amountApproximate||typeof c.change==='number'&&!Number.isSafeInteger(c.change)||!/^\d+$/.test(String(c.change)))throw Error('inexact credit');
  credit+=BigInt(c.change);
 }
 const gross=parseUnits(String(p.quote.toCoinAmount),p.outputDecimals??18);
 if(x<=0n||minimum<=0n||credit<minimum||gross<=0n||fee<0n||fee>=500000n)throw Error('invalid amounts');
 return {record,p,x,minimum,ri,ro,fee,credit,gross};
}

export function parallelSellProof(records,now=Date.now()){
 try{
  if(!records.length||records.length>8)return null;
  const rows=records.map(r=>describe(r,now)),base=rows[0];
  if(new Set(rows.map(r=>r.p.wallet.toLowerCase())).size!==rows.length)return null;
  if(rows.some(r=>!same(r.p.opening.pool,base.p.opening.pool)||!same(r.p.opening.factory,base.p.opening.factory)||
   !same(r.p.opening.router,base.p.opening.router)||!same(r.p.token,base.p.token)||!same(r.p.opening.quote,base.p.opening.quote)))return null;
  // Alone there is no cross-wallet price impact. Future joiners must pass the
  // full group test, including this first wallet's unchanged original minimum.
  if(rows.length===1)return {version:1,wallets:1,maxIncrementalImpactPpm:0,extraCushionPpm:0};
  // Different snapshots: take the least favourable reserves. Counting already
  // mined peers again is conservative. It may queue a trade, never improve it.
  const ri=rows.reduce((n,r)=>r.ri>n?r.ri:n,0n),ro=rows.reduce((n,r)=>r.ro<n?r.ro:n,base.ro);
  const total=rows.reduce((n,r)=>n+r.x,0n),out=(x,i,o,f)=>x*(1000000n-f)*o/(i*1000000n+x*(1000000n-f));
  for(const r of rows){
   const others=total-r.x,afterIn=ri+others,afterOut=ro*ri/afterIn;
   const before=out(r.x,ri,ro,r.fee),worst=out(r.x,afterIn,afterOut,r.fee);
   // Keep concurrency to genuinely low-impact batches (<= 0.1% incremental
   // impact), with an additional 0.25% output cushion. Do not infer token tax
   // from audit display units: use this wallet's verified NET simulation.
   if(before<=0n||(before-worst)*1000000n>before*1000n)return null;
   const denominator=r.gross>before?r.gross:before,net=worst*(r.credit<denominator?r.credit:denominator)/denominator;
   if(net<r.minimum+(r.gross*2500n+999999n)/1000000n)return null;
  }
  return {version:1,wallets:rows.length,maxIncrementalImpactPpm:1000,extraCushionPpm:2500};
 }catch{return null;}
}
