import {describeError} from '../public/error-message.mjs';
import {ERC20,hash,percentOf,read,same,wallet,ZeroAddress} from './common.mjs';
import {DEXES,dexFor,matchesCurrency,poolRouteKey} from './opening-dex.mjs';
import {freshOpeningSnapshot,refreshOpeningPoolProvenance} from './opening-pools.mjs';
import {corlaClient,CORLA_MINT} from './corla.mjs';
import {infinityApprovals,INFINITY,verifyInfinityApproval} from './infinity.mjs';
import {starsPreapprovalVenue} from './stars.mjs';

export const PREAPPROVAL_ROUTE='opening:preapproval';
const pending=new Set(['SUBMITTING','SUBMISSION_UNKNOWN','PENDING','RECEIPT_REVIEW']);
const wait=message=>Object.assign(Error(message),{code:'PREAPPROVAL_WAIT'});

// Only internal task managers can construct this order type. The public intent
// parser does not accept side=approval, calldata, spender or a supplied plan.
export async function openingApprovalPlan(engine,source){
 const {rpc}=engine,w=wallet(source.account),token=source.asset;
 if(!same(w.address,source.wallet))throw wait('钱包绑定已变化，未提前授权');
 let claimable=0n,protocolIdentities=[];
 if(source.claim){
  const client=corlaClient(rpc),row=await client.locate(source.claim.mint,{explicit:true});
  if(!row)throw wait('等待核验领取项目');
  const proof=await client.verify(row),block=await rpc.getBlockNumber();
  if(proof.identity.fingerprint!==source.claim.identity||proof.factoryIdentity.fingerprint!==source.claim.factory||!same(row.record.expectedToken,token))throw wait('领取项目身份或代币已变化，未提前授权');
  const [[participated,quantity,,didClaim,didRefund],[actual],[,phase]]=await Promise.all([
   client.get(source.claim.mint,CORLA_MINT,'getUserInfo',[w.address],block),client.get(source.claim.mint,CORLA_MINT,'token',[],block),client.get(source.claim.mint,CORLA_MINT,'getMintState',[],block)]);
  if(!participated||didClaim||didRefund||quantity<=0n||[4n,6n].includes(BigInt(phase))||!same(actual,ZeroAddress)&&!same(actual,token))throw wait('等待链上提供可核验的待领取数量');
  claimable=BigInt(quantity);protocolIdentities=[proof.identity,proof.factoryIdentity,...(proof.dependencies||[])];
 }
 const [snapshot,meta,[holding]]=await Promise.all([
  engine.openingScan(token,{currency:source.currency||'AUTO',watch:true,reuseMs:250}),engine.openingPreparation.token(token),read(rpc,token,ERC20,'balanceOf',[w.address])]);
 if(!freshOpeningSnapshot(snapshot,token,6000))throw wait('主池查询已过期，等待重新核验');
 const candidates=snapshot.pools.map(p=>refreshOpeningPoolProvenance(snapshot,p)).filter(p=>p.declaredByToken&&dexFor(p)&&matchesCurrency(p,source.currency||'AUTO'));
 // A factory match or the largest third-party pool alone is not primary proof.
 // Never turn speculative discovery into a real approval destination.
 candidates.sort((a,b)=>Number(!!b.liquid)-Number(!!a.liquid));
 let pool=candidates[0];
 if(!pool&&!source.claim){
  const future=await starsPreapprovalVenue(rpc,token,meta.identity),d=future&&DEXES.find(d=>same(d.router,future.router));
  if(d&&matchesCurrency({quote:future.quote},source.currency||'AUTO')){
   pool={kind:d.kind,factory:d.factory,pool:ZeroAddress,quote:future.quote,declaredByToken:true,primaryProof:'stars-pinned-launch',liquid:false};
   protocolIdentities.push(...future.protocolIdentities);
  }
 }
 if(!pool)throw wait('等待核验主池入口；不会向其他池子提前授权');
 const d=dexFor(pool),amount=percentOf(BigInt(holding)+claimable,source.percent);
 if(amount<=0n)throw wait('当前没有可提前授权的计划卖出数量');
 const venue=await engine.openingPreparation.venue(d);
 const steps=d.kind==='infinity-cl'?await infinityApprovals(rpc,token,w.address,amount):await (async()=>{
  const [allowance]=await read(rpc,token,ERC20,'allowance',[w.address,d.router]);
  return allowance>=amount?[]:[{kind:'approve',to:token,value:'0',spender:d.router,allowance:String(amount),data:ERC20.encodeFunctionData('approve',[d.router,amount])}];
 })();
 const plan={kind:'contract',route:PREAPPROVAL_ROUTE,token,wallet:w.address,inputToken:token,amountIn:String(amount),holdingBefore:String(holding),claimable:String(claimable),decimals:meta.decimals,
  identity:{...meta.identity,learnedAssets:[...(meta.identity.learnedAssets||[]),...venue.assets]},protocolIdentities,opening:pool,primaryKey:poolRouteKey(pool),source:{...source},review:[],steps:steps.slice(0,1)};
 if(plan.steps.length)assertOpeningApproval(plan);
 return plan;
}
export function assertOpeningApproval(plan){
 const step=plan?.steps?.[0],d=dexFor(plan?.opening||{});
 if(plan?.route!==PREAPPROVAL_ROUTE||plan.kind!=='contract'||plan.steps?.length!==1||!plan.opening?.declaredByToken||!d||step.kind!=='approve'||BigInt(step.value)!==0n||BigInt(step.allowance)!==BigInt(plan.amountIn)||BigInt(plan.amountIn)<=0n||!same(plan.token,plan.inputToken)||!same(plan.wallet,wallet(plan.source.account).address)||!same(plan.source.asset,plan.token)||!same(plan.source.wallet,plan.wallet))throw Error('提前授权计划不符合主池及数量限制');
 if(BigInt(plan.holdingBefore)<0n||BigInt(plan.claimable)<0n||percentOf(BigInt(plan.holdingBefore)+BigInt(plan.claimable),plan.source.percent)!==BigInt(plan.amountIn))throw Error('提前授权数量不符合计划卖出比例');
 if(step.approvalType){if(d.kind!=='infinity-cl')throw Error('提前授权类型无效');verifyInfinityApproval(step,plan);}
 else{const spender=d.kind==='infinity-cl'?INFINITY.permit2:d.router,v=ERC20.decodeFunctionData('approve',step.data);if(!same(step.to,plan.token)||!same(step.spender,spender)||!same(v[0],spender)||v[1]!==BigInt(plan.amountIn))throw Error('提前授权目标或数量无效');}
 return true;
}
export async function recheckOpeningApproval(engine,plan){
 assertOpeningApproval(plan);
 const fresh=await openingApprovalPlan(engine,plan.source);
 if(!fresh.steps.length)throw wait('链上授权已满足，未重复提交');
 const a=plan.steps[0],b=fresh.steps[0];
 if(fresh.primaryKey!==plan.primaryKey||fresh.amountIn!==plan.amountIn||fresh.holdingBefore!==plan.holdingBefore||fresh.claimable!==plan.claimable||fresh.identity.fingerprint!==plan.identity.fingerprint||!same(a.to,b.to)||!same(a.spender,b.spender)||a.approvalType!==b.approvalType||a.allowance!==b.allowance)throw wait('持仓、待领取数量或主池已变化，重新准备授权');
}

// Per-task, per-wallet durable references. A timeout never creates a new send.
// The manager is background work; opening detection does not await the batch.
export class TaskPreapprovals{
 constructor(engine){this.engine=engine;this.busy=new Set();}
 async run({key,holder,source,allowed,persist}){
  if(this.busy.has(key)||!allowed())return;
  this.busy.add(key);
  try{
   let state=holder.preApproval;
   if(state&&Date.now()-(pending.has(state.status)?state.followAt||0:state.checkedAt||0)<(pending.has(state.status)?500:5000))return;
   if(state?.orderId){
    let o=this.engine.get(state.orderId);
    if(!o)throw wait('提前授权原单缺失，请核对；不会重复提交');
    if(pending.has(o.status)){state.followAt=Date.now();o=await this.engine.follow(o.id);}
    state.status=o.status;state.message=(o.error?describeError(o.error):null)||({PENDING:'提前授权已提交，等待确认',SUBMISSION_UNKNOWN:'提前授权提交待核对，只跟踪原单',CONFIRMED:'提前授权已确认',SIMULATED:'提前授权模拟通过，未提交'}[o.status]||'提前授权尚未完成');persist();
    if(pending.has(o.status))return;
    // Submitted failures are not endlessly retried with gas. Normal sale/claim
    // remains available and will freshly assess the required allowance.
    if(o.steps?.length&&!['CONFIRMED','CANCELLED'].includes(o.status)){state.checkedAt=Date.now();persist();return;}
    if(o.status==='SIMULATED')return;
   }
   if(!allowed()||this.engine.running.has(source.account))return;
   if(Date.now()-(holder.preApproval?.checkedAt||0)<5000)return;
   const checkedAt=Date.now();
   const plan=await openingApprovalPlan(this.engine,source);
   if(!allowed())return;
   if(!plan.steps.length){holder.preApproval={...state,status:'READY',amount:plan.amountIn,decimals:plan.decimals,spender:dexFor(plan.opening).router,checkedAt,message:'主池授权额度已满足'};persist();return;}
   const original=state?.orderId&&this.engine.get(state.orderId);
   if(original?.status==='CONFIRMED'&&hash(original.plan.source)===hash(source)&&same(original.plan.steps[0].to,plan.steps[0].to)&&same(original.plan.steps[0].spender,plan.steps[0].spender)){
    // A growing balance or expired Permit2 allowance is rechecked by the sale.
    // Do not spend gas renewing the same task's allowance throughout the day.
    holder.preApproval={...state,status:'STALE',checkedAt,message:'数量或授权状态已变化；卖出时按最新数量检查，不反复发送提前授权'};persist();return;
   }
   // One submission per task revision / exact amount / actual spender. Permit2
   // expiration does not create an endless stream of renewal transactions.
   const id='preapprove-'+hash([key,source,plan.primaryKey,plan.amountIn,plan.steps[0].to,plan.steps[0].spender,plan.steps[0].approvalType||'erc20']).slice(0,48);
   let o=await this.engine.prepareOpeningApproval(plan,id);
   holder.preApproval={orderId:id,status:o.status,amount:plan.amountIn,decimals:plan.decimals,spender:plan.steps[0].spender,checkedAt,message:'正在准备主池限额授权'};persist();
   if(!allowed())return;
   if(o.status==='PREPARED')o=await this.engine.execute(id,{authorization:'用户启用任务开盘前授权；仅限已核验主池及计划卖出数量。',acknowledgeReview:false,rejectRisks:true,swapReceiptWaitMs:0,continueAllowed:allowed});
   holder.preApproval.status=o.status;holder.preApproval.message=(o.error?describeError(o.error):null)||({CONFIRMED:'提前授权已确认',PENDING:'提前授权已提交，等待确认',SIMULATED:'提前授权模拟通过，未提交',SUBMISSION_UNKNOWN:'提前授权提交待核对，只跟踪原单'}[o.status]||'提前授权未完成，开盘仍会重新检查');persist();
  }catch(e){
   // Preserve the original ID even when following or persistence fails.
   holder.preApproval={...holder.preApproval,checkedAt:Date.now(),message:describeError(e),status:holder.preApproval?.orderId?holder.preApproval.status:'WAITING'};
   persist();
  }finally{this.busy.delete(key);}
 }
}

// Used by the automatic sale too: an early-approved router never becomes a
// reason to choose an unrelated pool after launch, rerouting or a retry.
export async function verifyPrimaryTaskSale(engine,plan){
 const snapshot=await engine.openingScan(plan.token,{currency:'AUTO',watch:true,reuseMs:250});
 if(!freshOpeningSnapshot(snapshot,plan.token,6000)||!snapshot.pools.some(p=>p.liquid&&poolRouteKey(p)===poolRouteKey(plan.opening)&&refreshOpeningPoolProvenance(snapshot,p).declaredByToken))throw wait('卖出主池身份或流动性已变化；未改走其他池子');
}
