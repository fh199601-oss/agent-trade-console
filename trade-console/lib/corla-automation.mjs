import path from 'node:path';
import {hash,load,save,wallet,same,ZeroAddress,publicError} from './common.mjs';
import {corlaClient,CORLA_MINT} from './corla.mjs';
import {DEXES} from './opening-dex.mjs';
import {hasPreviewRisks} from './preview-risks.mjs';
import {localAdmissionDeferred} from './submission-boundary.mjs';
import {recoverableClaim} from './claim-recovery.mjs';

const ACTIVE=new Set(['WAITING_MINT','WATCHING','CLAIMING','SELLING']);
const PENDING=new Set(['PENDING','SUBMITTING','SUBMISSION_UNKNOWN','RECEIPT_REVIEW']);
const SUCCESS=new Set(['CONFIRMED','PARTIAL']);
export class CorlaAutomation{
 constructor({engine,rpc,opening,data,client=corlaClient(rpc),now=Date.now,autoSchedule=true,binding=wallet}){
  Object.assign(this,{engine,rpc,opening,client,now,autoSchedule,binding});this.file=path.join(data,'corla-automation.json');this.jobs=new Map();this.busy=new Set();this.probes=new Map();this.saleWarm=new Map();this.claimWarm=new Map();this.closed=false;
  for(const j of load(this.file,[])){if(ACTIVE.has(j.status)){j.resumeStatus=j.status;j.status='PAUSED';j.pauseReason='restart';j.message='服务重启已暂停；恢复后只跟踪原单，不重复提交。';}this.jobs.set(j.id,j);}
  if(this.jobs.size)this.persist();
 }
 persist(){save(this.file,[...this.jobs.values()]);}
 list(){return [...this.jobs.values()].filter(j=>!j.deletedAt).sort((a,b)=>b.createdAt-a.createdAt);}
 active(){return this.list().some(j=>ACTIVE.has(j.status));}
 allowed(j){return !this.closed&&ACTIVE.has(j.status)&&!j.cancelled&&!j.deletedAt;}
 reconcileSale(j,sale){
  if(!sale||j.cancelled||j.deletedAt||!(j.status==='SELLING'||j.status==='REVIEW'&&j.feeReviewPending))return;
  if(sale.status==='REVIEW'&&sale.rows.some(r=>['SELL_FEE_REVIEW','SELL_FEES_UNVERIFIABLE'].includes(r.error?.code))){
   j.feeReviewPending=true;j.status='REVIEW';j.message=sale.rows.some(r=>r.error?.code==='SELL_FEES_UNVERIFIABLE')?'领取已到账；无法核验卖出路线费用，已拦截，请查看原因':'领取已到账；卖出费用需要单独确认，尚未提交卖出';this.persist();
  }else if(['COMPLETED','CANCELLED','EXPIRED'].includes(sale.status)){
   delete j.feeReviewPending;j.status=sale.rows.every(r=>r.status==='CONFIRMED')?'DONE':'REVIEW';j.message=j.status==='DONE'?'全部领取和联动卖出均已确认':'领取已完成；卖出结果请查看开盘卖出记录';this.persist();
  }
 }
 reconcileOrder(o){
  if(!o?.id)return;
  // Only reflect a manually resolved ORIGINAL sale. This never resumes a
  // paused task, prepares another order, or signs a transaction.
  for(const j of this.jobs.values()){
   const sale=this.opening.jobs.get(j.sellJobId);
   if(sale?.rows.some(r=>r.orderId===o?.id))this.reconcileSale(j,sale);
  }
 }
 enroll(o){
  const p=o.plan,policy=p?.afterMint;if(!policy||p.route!=='corla:mint'||!this.engine.live||o.simulationOnly||!o.authorization)return;
  const id='corla-'+hash(o.id).slice(0,32);if(this.jobs.has(id))return this.jobs.get(id);
  const conflict=this.list().find(j=>this.allowed(j)&&j.account===o.intent.account&&same(j.mint,policy.mint));
  if(conflict){
   if(hash(conflict.policy)!==hash(policy))throw Error('此项目已有不同设置的自动领取任务，请先停止原任务');
   if(conflict.status!=='WAITING_MINT'&&conflict.status!=='WATCHING')throw Error('此项目正在领取或卖出，请等待原任务完成');
   if(!conflict.parents.includes(o.id))conflict.parents.push(o.id);conflict.status='WAITING_MINT';this.persist();return conflict;
  }
  if(!same(this.binding(o.intent.account).address,p.wallet))throw Error('自动领取的钱包绑定已变化');
  const j={id,parents:[o.id],account:o.intent.account,wallet:p.wallet,mint:policy.mint,policy,identity:p.identity,protocolIdentities:p.protocolIdentities,name:p.project?.name||'Corla',createdAt:this.now(),status:'WAITING_MINT',attempts:0,authorization:o.authorization+'；按本次预览约定开盘后领取全部代币'+(policy.sell?'并按 '+policy.sell.percent+'% 当前持仓卖出。':'，不自动卖出。'),message:'等待本次认购回执，尚未提交领取'};
  this.jobs.set(id,j);try{this.persist();}catch(e){this.jobs.delete(id);throw e;}this.schedule();return j;
 }
 schedule(){if(this.closed||!this.autoSchedule||this.timer||!this.active())return;this.timer=setTimeout(()=>{this.timer=null;for(const j of this.list())if(this.allowed(j)&&!this.busy.has(j.id))void this.tick(j.id).catch(()=>{});this.schedule();},250);this.timer.unref?.();}
 close(){this.closed=true;clearTimeout(this.timer);this.timer=null;}
 pause(id){
  const j=this.jobs.get(id);if(!j||j.deletedAt)throw Error('没有该自动领取任务');
  if(!ACTIVE.has(j.status)&&j.status!=='PAUSED')throw Error('此任务已结束或需核对，可删除任务');
  if(j.status!=='PAUSED')j.resumeStatus=j.status;j.status='PAUSED';j.pauseReason='user';j.pausedAt=this.now();j.message='已暂停，保留原任务；点击恢复继续。已提交交易仍保留原单。';this.persist();
  const sale=this.opening.jobs.get(j.sellJobId);if(sale&&['ARMED','FIRING','TRACKING'].includes(sale.status))this.opening.pause(sale.id);return j;
 }
 remove(id){
  const j=this.jobs.get(id);if(!j)throw Error('没有该自动领取任务');
  // Keep a tombstone for stable-ID deduplication. Neither listing nor restart
  // may revive a removed task; transaction journals are independent.
  j.deletedAt??=this.now();j.cancelled=true;j.status='DELETED';j.message='任务已删除；原交易记录保留';this.persist();
  if(j.sellJobId&&this.opening.jobs.has(j.sellJobId))this.opening.remove(j.sellJobId);return j;
 }
 restore(id){
  const j=this.jobs.get(id);if(!j||j.deletedAt)throw Error('任务已删除或不存在，不能恢复');if(j.status==='PAUSED')return j;
  if(j.status!=='STOPPED'||this.busy.has(id))throw Error('仅可找回旧版已停止任务，且原操作须已结束');
  const sale=this.opening.jobs.get(j.sellJobId);if(sale?.status==='CANCELLED')this.opening.restore(sale.id);
  j.resumeStatus=j.sellJobId?'SELLING':j.claimId&&j.commitStartedAt?'CLAIMING':'WAITING_MINT';
  j.status='PAUSED';j.pauseReason='user';delete j.cancelled;j.restoredAt=this.now();j.message='旧版已停止任务已找回；当前暂停，点击恢复后才继续';this.persist();return j;
 }
 stop(id){const j=this.jobs.get(id);if(!j)throw Error('没有该自动领取任务');if(j.sellJobId&&this.opening.jobs.has(j.sellJobId))this.opening.stop(j.sellJobId);j.cancelled=true;j.status='STOPPED';j.message='已停止后续动作；已提交交易请在操作记录核对原单。';this.persist();return j;}
 resume(id){const j=this.jobs.get(id);if(!j||j.status!=='PAUSED'||j.cancelled||this.closed)throw Error('仅暂停且未停止的任务可以恢复');if(!same(this.binding(j.account).address,j.wallet))throw Error('钱包绑定已变化');if(!this.engine.live)throw Error('运行模式已变化，不能恢复实盘任务');
  if(this.busy.has(id))throw Error('正在结束暂停前的操作，请稍后点击恢复');
  if(j.resumeStatus==='CLAIMING'){
   const o=this.engine.get(j.claimId);
   // Cancellation before the dispatch boundary is safe to prepare again;
   // any recorded request/hash must instead follow its original ID.
   if(o?.status==='CANCELLED'&&!o.steps?.length&&!o.orderId&&!o.txHash){j.resumeStatus='WATCHING';delete j.commitStartedAt;}
  }
  if(!ACTIVE.has(j.resumeStatus||'WAITING_MINT'))throw Error('原任务状态不支持恢复，请核对原单');
  if(this.list().some(x=>x.id!==id&&this.allowed(x)&&x.account===j.account&&same(x.mint,j.mint)))throw Error('此钱包已有该项目的自动任务运行，未重复恢复');
  let resumedSale=false;
  if(j.resumeStatus==='SELLING'&&this.opening.jobs.has(j.sellJobId)){const claim=this.engine.get(j.claimId);if(claim?.status!=='CONFIRMED')throw Error('领取原单尚未确认，不能恢复联动卖出');const before=this.opening.jobs.get(j.sellJobId).status;this.opening.resumeAfterClaim(j.sellJobId,claim,j.policy.sell,j.authorization);resumedSale=before==='PAUSED';}
  const previous={status:j.status,resumeStatus:j.resumeStatus,message:j.message};
  j.status=j.resumeStatus||'WAITING_MINT';delete j.resumeStatus;j.message='用户已恢复监测';try{this.persist();}catch(e){Object.assign(j,previous);if(resumedSale)try{this.opening.pause(j.sellJobId);}catch{}throw e;}this.schedule();return j;}
 async probe(mint){const key=mint.toLowerCase(),old=this.probes.get(key);if(old&&(old.pending||this.now()-old.at<250))return old.promise;
  const entry={pending:true,at:this.now(),promise:this.client.get(mint,CORLA_MINT,'getMintState')};this.probes.set(key,entry);
  try{return await entry.promise;}catch(e){if(this.probes.get(key)===entry)this.probes.delete(key);throw e;}finally{entry.pending=false;}}
 warm(j){if(!j.policy.sell||this.now()-(j.warmedAt||0)<45000)return;j.warmedAt=this.now();const prep=this.engine.openingPreparation;if(prep)void Promise.allSettled(DEXES.map(d=>prep.venue(d)));}
 warmClaim(j){
  if(!this.engine.warmCorlaClaim)return;
  const key=j.mint.toLowerCase(),old=this.claimWarm.get(key);if(old&&(old.pending||this.now()-old.at<5000))return;
  const entry={at:this.now(),pending:true};this.claimWarm.set(key,entry);
  // Public registry/code only, shared by every wallet of this project. No
  // claim quantity, official requestId, approval or signature is cached here.
  void Promise.resolve().then(()=>this.engine.warmCorlaClaim(j.mint)).catch(()=>{if(this.claimWarm.get(key)===entry)this.claimWarm.delete(key);}).finally(()=>{entry.pending=false;});
 }
 warmSale(j,token=j.policy.expectedToken){
  if(!j.policy.sell||!this.allowed(j)||!token||same(token,ZeroAddress))return;
  const key=token.toLowerCase()+':'+j.policy.sell.currency,old=this.saleWarm.get(key);
  if(old&&(old.pending||this.now()-old.at<3000))return;
  const entry={at:this.now(),pending:true};this.saleWarm.set(key,entry);j.saleWarmedAt=entry.at;
  // Start public metadata/topology reads BEFORE opening; share them across
  // wallets. Watch scans do not wait for slow historical discovery. No token
  // holding, approval, official requestId or permission to sell is cached.
  void Promise.allSettled([this.engine.openingPreparation?.token(token),this.engine.sellAudit?.(token),this.opening.detector?.scan(token,{currency:j.policy.sell.currency,watch:true,reuseMs:250})]).then(results=>{
   if(results.some(r=>r.status==='rejected')&&this.saleWarm.get(key)===entry)this.saleWarm.delete(key);
  }).finally(()=>{entry.pending=false;for(const [k,v] of this.saleWarm)if(!v.pending&&this.saleWarm.size>128)this.saleWarm.delete(k);});
 }
 review(j,message){j.status='REVIEW';j.message=message;this.persist();}
 rememberError(j,error){j.lastError=publicError(error);j.errorHistory=[...(j.errorHistory||[]),{at:this.now(),status:j.status,claimId:j.claimId,error:j.lastError}].slice(-12);}
 async tick(id){
  const j=this.jobs.get(id);if(!j||!this.allowed(j)||this.busy.has(id))return j;this.busy.add(id);let startedAttempt=false;
  try{
   if(!same(this.binding(j.account).address,j.wallet))return this.review(j,'钱包绑定已变化，停止自动动作');
   if(this.engine.running.has(j.account))return j;
   if(j.status==='WAITING_MINT'){
    let confirmed=false;
    for(const parent of j.parents){let o=this.engine.get(parent);if(!o)return this.review(j,'认购原单缺失，停止自动动作');
     if(PENDING.has(o.status))o=await this.engine.follow(parent);
     if(!this.allowed(j))return j;
     // Resume only the original, already authorized max subscription. Never
     // create a replacement order after an uncertain dispatch.
     if(o.status==='READY_TO_CONTINUE')o=await this.engine.execute(parent,{authorization:o.authorization,acknowledgeReview:o.acknowledgeReview,rejectRisks:true,continueAllowed:()=>this.allowed(j)});
     if(!this.allowed(j))return j;
     if(PENDING.has(o.status)||o.status==='READY_TO_CONTINUE')return j;
     if(o.status==='PREPARED')return this.review(j,'认购尚未提交，自动任务不代替用户确认');
     confirmed ||= o.steps?.some(e=>e.status==='CONFIRMED'&&e.settlement?.kind==='subscription')===true;
     if(!SUCCESS.has(o.status)&&!['FAILED','CANCELLED','BLOCKED','REJECTED'].includes(o.status))return this.review(j,'认购结果需要核对：'+o.status);
    }
    if(!confirmed)return this.review(j,'本次没有已确认的认购份额，未启动领取');
    j.status='WATCHING';j.message='认购已确认，监测开盘；届时领取全部可领代币';this.persist();
   }
   if(!this.allowed(j))return j;
   if(j.status==='WATCHING'){
    this.warm(j);this.warmClaim(j);this.warmSale(j);if(this.now()<(j.retryAt||0))return j;
    const [,phase]=await this.probe(j.mint);if(!this.allowed(j)||j.status!=='WATCHING')return j;j.lastScanAt=this.now();
    if(BigInt(phase)===6n)return this.review(j,'项目已终止；已暂停等待领取，请核对项目状态');
    if(BigInt(phase)===4n)return this.review(j,'项目进入退款阶段；未自动退款，请使用退款入口');
    if(BigInt(phase)===5n){
     const row=await this.client.locate(j.mint,{explicit:true});if(!row)throw Error('无法核验退款阶段的项目登记');
     const [version]=Number(row.root.version)>=5?await this.client.get(j.mint,CORLA_MINT,'refundMintVersion'):[0n];
     if(!this.allowed(j)||j.status!=='WATCHING')return j;
     if(BigInt(version)!==1n)return this.review(j,'认购已结束，项目处于退款阶段；未自动退款');
    }
    if(BigInt(phase)!==3n)return j;
    j.openedAt??=this.now();
    this.warmSale(j);
    if(j.attempts>=30)return this.review(j,'开盘后领取预览仍未通过：'+(j.lastError?.message||'请查看原单原因')+'；没有提交失败交易');
    const claimId=j.id+'-claim-'+(++j.attempts);j.claimId=claimId;startedAttempt=true;this.persist();
    const o=await this.engine.prepare({account:j.account,side:'mint',asset:j.mint,routeId:'corla:claim',quantity:1,scope:'free',maxBnb:'0',maxUsdt:'0',autoClaim:false,referral:'none'},claimId,{instantExecution:this.engine.live});
    if(!this.allowed(j)||j.status!=='WATCHING')return j;
    if(o.status==='BLOCKED'&&!o.steps?.length){
     this.rememberError(j,o.error||{message:'领取预览未通过'});
     if(['CORLA_ALREADY_CLAIMED','CORLA_REFUND_ONLY','CORLA_ENDED'].includes(o.error?.code)||o.error?.code==='NO_QUOTA'&&o.error.details?.reason==='no-allocation')return this.review(j,o.error.message+'；没有重复领取或自动卖出');
     j.message='等待领取预览通过：'+(o.error?.message||'未知原因');j.retryAt=this.now()+1000;this.persist();return j;
    }
    const p=o.plan;
    if(o.status!=='PREPARED'||p?.route!=='corla:claim'||!same(p.wallet,j.wallet)||p.steps?.length!==1||!same(p.steps[0].to,j.mint)||p.steps[0].data!==CORLA_MINT.encodeFunctionData('claim')||BigInt(p.steps[0].value)!==0n||!p.requireAssetCredit||p.identity?.fingerprint!==j.identity?.fingerprint||p.protocolIdentities?.[0]?.fingerprint!==j.protocolIdentities?.[0]?.fingerprint||(!same(j.policy.expectedToken,ZeroAddress)&&!same(p.outputToken,j.policy.expectedToken)))return this.review(j,'领取目标、资产或合约身份与认购时不一致');
    if(hasPreviewRisks(o.preview?.risks))return this.review(j,'领取预览包含新的钱包风险提示，请手动核对');
    this.warmSale(j,p.outputToken);
    // This marker is durable before execute. No later path retries a send.
    j.status='CLAIMING';j.commitStartedAt=this.now();j.message='开盘已检测，提交全部领取';this.persist();
    const result=await this.engine.execute(claimId,{authorization:j.authorization,acknowledgeReview:true,rejectRisks:true,swapReceiptWaitMs:0,continueAllowed:()=>this.allowed(j)});
    if(!this.allowed(j))return j;
    return await this.claimResult(j,result);
   }
   if(j.status==='CLAIMING'){
    this.warmSale(j);
    const o=await this.engine.follow(j.claimId);if(!this.allowed(j))return j;return await this.claimResult(j,o);
   }
   if(j.status==='SELLING'){
    let sale=this.opening.jobs.get(j.sellJobId);
    // Recover the journal boundary after a restart, only after explicit resume.
    // Reuse the exact handoff ID and the already verified original claim.
    if(!sale){const claim=this.engine.get(j.claimId);if(claim?.status!=='CONFIRMED')return this.review(j,'领取原单缺失或未确认，不能恢复卖出');return await this.claimResult(j,claim);}
    if(sale.status==='PAUSED'){j.resumeStatus='SELLING';j.status='PAUSED';j.message='联动卖出已暂停；点击恢复将核验并继续原任务';this.persist();return j;}
    this.reconcileSale(j,sale);
   }
  }catch(e){if(this.allowed(j)){
   this.rememberError(j,e);
   if(startedAttempt&&localAdmissionDeferred(e,this.engine.get(j.claimId))){
    // Neither a busy mutex nor another pending order is a failed claim.
    // Keep the same next attempt ID, and keep reconciling the blocking original.
    j.attempts--;j.busyDeferrals=(j.busyDeferrals||0)+1;delete j.commitStartedAt;j.status='WATCHING';j.retryAt=this.now()+300;
    j.message='等待钱包空闲或原单核对后继续领取；尚未提交本次领取';
   }else{j.message=e.message;if(j.commitStartedAt&&j.status!=='CLAIMING')j.status='REVIEW';}
   this.persist();
  }}
  finally{this.busy.delete(id);}return j;
 }
 async claimResult(j,o){
  if(this.allowed(j)&&(j.claimRecoveries||0)<2&&recoverableClaim(o,j)){
   j.failedClaims=[...(j.failedClaims||[]),{id:o.id,txHash:o.steps.at(-1)?.txHash,error:o.error,at:this.now()}];
   j.claimRecoveries=(j.claimRecoveries||0)+1;delete j.commitStartedAt;
   j.status='WATCHING';j.retryAt=this.now()+250;j.message='领取已确认未成交，重新检查可领额度后重试（'+j.claimRecoveries+'/2）';this.persist();return j;
  }
  if(o.status==='CONFIRMED'){
   if(!same(o.plan.wallet,j.wallet)||o.plan.route!=='corla:claim'||!o.steps?.some(e=>e.status==='CONFIRMED'&&BigInt(e.received||0)>0n))return this.review(j,'领取回执未证明本钱包到账');
   j.claimedAt=this.now();j.claimTx=o.steps.at(-1)?.txHash;
   if(!j.policy.sell){j.status='DONE';j.message='全部可领代币已确认到账';this.persist();return j;}
   j.sellJobId??=j.id+'-sell';j.status='SELLING';j.message='领取已到账，交接开盘自动卖出';this.persist();
   // No await between cancellation check and the idempotent handoff.
   if(this.allowed(j))this.opening.afterClaim(j.sellJobId,o,j.policy.sell,j.authorization);return j;
  }
  if(PENDING.has(o.status)){j.message='领取已提交，仅核对原单；不重复领取';if(['SUBMISSION_UNKNOWN','RECEIPT_REVIEW'].includes(o.status))return this.review(j,'领取提交或回执待核对，请查看原单');this.persist();return j;}
  return this.review(j,'领取未完成：'+(o.error?.message||o.status)+'；未自动重发');
 }
}
