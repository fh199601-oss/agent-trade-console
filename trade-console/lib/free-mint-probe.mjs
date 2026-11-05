// Bounded, read-only quantity discovery. A successful batch is evidence of a
// callable zero-payment quantity, never proof of the wallet's total allowance.
const terminal=new Set(['MINT_INELIGIBLE','MINT_NOT_OPEN','MINT_ENDED','MINT_PAUSED','SITE_PROOF_REQUIRED','REFERRAL_NOT_VERIFIED','MINT_ASSET_UNKNOWN','MINT_ADAPTER_INCOMPLETE']);
export async function probeFreeBatch({quote,cap=10,seed=null}){
 const upper=Math.max(0,Math.min(10,Number(cap))),attempted=[];let lastError;
 if(!Number.isInteger(upper))throw Error('免费模拟的数量边界无效');
 if(upper===0)throw Object.assign(Error('当前可核验库存或单笔额度为 0'),{code:'NO_QUOTA'});
 for(let n=upper;n>=1;n--){
  attempted.push(n);let q;
  try{q=seed?.quantity===n?seed:await quote(n);}
  catch(e){
   if(terminal.has(e.code)||!(e.executionError||['MINT_REVERT','NO_QUOTA','NO_FREE_MINT','FREE_PROBE_REJECTED'].includes(e.code)||/execution reverted/i.test(e.message||'')))throw e;
   lastError={code:e.code||'MINT_REVERT',message:e.message};continue;
  }
  if(q?.quantity!==n)throw Error('免费模拟返回的份数与本次请求不一致');
  if(q.available===false||q.simulated===false||BigInt(q.total?.raw??q.cost??-1)!==0n||BigInt(q.call?.value??q.step?.value??-1)!==0n||q.paidUnits>0)continue;
  return {quote:q,probe:{kind:'descending-free-simulation',upper,attempted,quantity:n,quotaKnown:false,zeroPayment:true}};
 }
 throw Object.assign(Error('当前 1～'+upper+' 份零付款模拟均未通过，未提交交易'),{code:'NO_FREE_MINT',details:{probe:{upper,attempted},lastError}});
}
