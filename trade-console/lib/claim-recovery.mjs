import {same,ZeroAddress} from './common.mjs';
import {CORLA_MINT} from './corla.mjs';

// No receipt, an unknown dispatch, or a successful receipt never authorizes a
// second claim. The next attempt still rebuilds current quota and official preview.
export function recoverableClaim(order,job){
 const e=order?.steps?.at(-1),p=e?.plan||order?.plan;
 if(order?.status!=='FAILED'||order.intent?.account!==job.account||order.steps?.length!==1||e.status!=='FAILED'||p?.route!=='corla:claim'||!p.requireAssetCredit||!same(p.wallet,job.wallet)||!same(e.step?.to,job.mint)||e.step?.data!==CORLA_MINT.encodeFunctionData('claim')||String(e.step?.value)!=='0'||!job.identity?.fingerprint||!job.protocolIdentities?.[0]?.fingerprint||p.identity?.fingerprint!==job.identity.fingerprint||p.protocolIdentities?.[0]?.fingerprint!==job.protocolIdentities[0].fingerprint||job.policy?.expectedToken&&!same(job.policy.expectedToken,ZeroAddress)&&!same(job.policy.expectedToken,p.outputToken))return false;
 if(e.submissionOutcome?.source==='local-wallet'&&e.submissionOutcome.accepted===false&&!e.txHash&&!e.orderId&&!e.result&&!e.receipt&&!order.txHash&&!order.orderId)return true;
 let reverted=false;try{reverted=BigInt(e.receipt?.status)===0n;}catch{}
 return order.error?.code==='TRANSACTION_REVERTED'&&e.revertVerified===true&&reverted&&/^0x[\da-f]{64}$/i.test(e.txHash||'');
}
