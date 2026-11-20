import {freshOpeningSnapshot,refreshOpeningPoolProvenance} from './opening-pools.mjs';
import {matchesCurrency} from './opening-dex.mjs';
import path from 'node:path';
import {editableSaleRow} from './task-edit.mjs';
import {randomUUID} from 'node:crypto';
import {address,hash,load,save,wallet,validateIntent,read,ERC20,percentOf,same,publicError} from './common.mjs';
import {recoverableOpeningSale} from './opening-recovery.mjs';
import {localAdmissionDeferred} from './submission-boundary.mjs';
import {parallelWallets} from './parallel-wallets.mjs';
import {saveDurable} from './durable-write.mjs';
const ACTIVE=new Set(['ARMED','FIRING','TRACKING']);
const WATCHING=new Set(['WAITING','PREPARING']);
const resultSaveFailed=r=>{if(r.status==='WAITING'){r.status='REVIEW';r.error={code:'TASK_STATE_WRITE_FAILED',message:'任务恢复记录写入失败，未发起重试；请检查磁盘并核对原单'};}};
const cancelledBeforeSale=o=>o?.status==='CANCELLED'&&!o.orderId&&!o.txHash&&Array.isArray(o.steps)&&o.steps.every(e=>e.status==='CONFIRMED'&&e.step?.kind==='approve');
export function openingConfig(input){
 if(!input||Object.keys(input).some(k=>!['asset','accounts','percent','slippageBps','currency','gasLimit','preApprove'].includes(k)))throw Error('开盘卖出参数无效');
 const asset=address(input.asset);if(/^0x0{40}$/i.test(asset))throw Error('代币地址不能为零');
 if(!Array.isArray(input.accounts)||!input.accounts.length||input.accounts.length>200||new Set(input.accounts).size!==input.accounts.length)throw Error('请选择不重复的已绑定钱包');
 const accounts=[...input.accounts].sort((a,b)=>a-b);accounts.forEach(wallet);
 const percent=String(input.percent??'50'),slippageBps=input.slippageBps??5000,currency=input.currency??'AUTO';
 if(!['AUTO','BNB','WBNB','USDT'].includes(currency))throw Error('开盘卖出到账支持自动、BNB、WBNB、USDT');
 const gas=input.gasLimit===undefined?{}:{gasLimit:input.gasLimit};
 validateIntent({account:accounts[0],asset,side:'sell',percent,slippageBps,currency,slippageMode:'fixed',openingOnly:true,...gas});
 if(input.preApprove!==undefined&&typeof input.preApprove!=='boolean')throw Error('提前授权选项无效');
 return {asset,accounts,percent,slippageBps,currency,...gas,...(input.preApprove===undefined?{}:{preApprove:input.preApprove})};
}
export class OpeningSell{
 constructor({engine,rpc,bridge,detector,data,preparation=null,pollMs=300,now=Date.now,autoSchedule=true}){
  Object.assign(this,{engine,rpc,bridge,detector,preparation,pollMs,now,autoSchedule});this.file=path.join(data,'opening-sell.json');this.jobs=new Map();this.checks=new Map();this.timers=new Map();this.running=new Set();this.closed=false;this.followTimers=new Map();this.retryTimers=new Map();this.followBusy=new Set();this.followRows=new Map();this.rowBusy=new Set();this.warmBusy=new Set();
  for(const job of load(this.file,[])){
   // A process restart never re-arms an old authorization or retries a send.
   if(ACTIVE.has(job.status)){job.status='PAUSED';job.pauseReason='restart';job.message='服务重启，任务已暂停；先核对已有原单，重新启动需再次点击。';}
   this.jobs.set(job.id,job);
  }
  if(this.jobs.size)this.persist();
 }
 persist({asyncWrite=false}={}){
  if(asyncWrite){const revision=this.persistRevision||0;return saveDurable(this.file,[...this.jobs.values()],{publishImmediately:false,canPublish:()=>revision===(this.persistRevision||0)});}
  save(this.file,[...this.jobs.values()]);this.persistRevision=(this.persistRevision||0)+1;
 }
 persistAsync(){
  if(this.persistBatch)return this.persistBatch.promise;
  let resolve,reject;const promise=new Promise((ok,fail)=>{resolve=ok;reject=fail;});
  this.persistBatch={promise,resolve,reject};queueMicrotask(()=>this.drainPersists());return promise;
 }
 async drainPersists(){
  if(this.persistWriting)return;this.persistWriting=true;
  try{while(this.persistBatch){
   const batch=this.persistBatch;this.persistBatch=null;
   // Capture the current complete state, await its fsync, then atomically
   // publish. Requests arriving during IO coalesce into the next snapshot.
   // Each submit still awaits the snapshot containing its own commit marker.
   try{await this.persist({asyncWrite:true});batch.resolve();}catch(e){batch.reject(e);}
  }}finally{this.persistWriting=false;}
 }
 // Receipt results already live durably in their original order files.
 // Coalesce display/tracking snapshots across completed IO callbacks, without
 // delaying the immediate journal barrier used before a submit or retry.
 persistFollowResults(){
  if(this.followWrite)return this.followWrite.promise;
  let resolve,reject;const promise=new Promise((ok,fail)=>{resolve=ok;reject=fail;});
  this.followWrite={promise,resolve,reject};this.followWriteTimer=setTimeout(()=>this.flushFollowResults(),25);return promise;
 }
 flushFollowResults(){
  const pending=this.followWrite;if(!pending)return;
  this.followWrite=null;clearTimeout(this.followWriteTimer);this.followWriteTimer=null;
  try{this.persist();pending.resolve();}catch(e){pending.reject(e);}
 }
 list(){return [...this.jobs.values()].filter(j=>!j.deletedAt).sort((a,b)=>b.createdAt-a.createdAt);}
 settling(j){return this.followBusy.has(j.id)||j.rows.some(r=>this.rowBusy.has(j.id+':'+r.account));}
 finishIfIdle(j){
  if(this.closed||j.deletedAt||j.cancelRequested||!ACTIVE.has(j.status)||this.settling(j)||j.rows.some(r=>WATCHING.has(r.status)||r.status==='TRACKING'))return;
  j.status=j.rows.some(r=>['SELL_FEE_REVIEW','SELL_FEES_UNVERIFIABLE'].includes(r.error?.code))?'REVIEW':'COMPLETED';j.message=j.status==='REVIEW'?'卖出费用检查未通过，尚未提交；请查看原因':'本次开盘任务已结束，请查看各钱包结果';this.persist();
 }
 reconcileOrder(o){
  if(!['CONFIRMED','CONFIRMED_REVIEW','FAILED','REJECTED','CANCELLED'].includes(o?.status))return;
  let changed=false;const retries=[];
  for(const j of this.jobs.values())for(const r of j.rows){
   if(r.orderId!==o.id)continue;
   // A background/manual original-order check can observe a revert before our
   // task poller. Active new tasks must use the SAME idempotent recovery path;
   // otherwise the first observer permanently marks that wallet completed.
   if(ACTIVE.has(j.status)&&j.recoveryVersion===2){this.autoResult(j,r,o,{persist:false});retries.push([j,r]);}
   else this.result(r,o);
   if(j.status==='PAUSED'&&cancelledBeforeSale(o))r.status='PAUSED';changed=true;
   // Reflect a manually reconciled original in the task card without ever
   // re-arming a cancelled/paused task or dispatching a subsequent step.
   if((ACTIVE.has(j.status)||j.status==='REVIEW')&&!this.settling(j)&&j.rows.every(x=>!WATCHING.has(x.status)&&!['TRACKING','PREPARING'].includes(x.status))){j.status=j.rows.some(x=>['SELL_FEE_REVIEW','SELL_FEES_UNVERIFIABLE'].includes(x.error?.code))?'REVIEW':'COMPLETED';j.message=j.status==='REVIEW'?'卖出费用检查未通过，尚未提交；请查看原因':'原单核对完成，请查看各钱包结果';}
  }
  if(changed){try{this.persist();}catch(e){for(const [,r] of retries)resultSaveFailed(r);throw e;}}
  for(const [j,r] of retries)this.scheduleRetry(j,r);
 }
 active(){return this.list().some(j=>ACTIVE.has(j.status));}
 resume(id){
  const j=this.jobs.get(id);if(!j||j.status!=='PAUSED'||j.cancelRequested||this.closed)throw Error('仅暂停且未停止的任务可以恢复');
  if(this.running.has(id)||this.followBusy.has(id)||j.rows.some(r=>this.rowBusy.has(id+':'+r.account)))throw Error('正在结束暂停前的操作，请稍后点击恢复');
  if(j.sourceClaim)throw Error('请从自动领取任务恢复联动卖出');
  if(j.mode!==(this.engine.live?'LIVE':'SIMULATION'))throw Error('运行模式已变化，请重新检查');
  if(j.bindings.some(r=>!same(wallet(r.account).address,r.address)))throw Error('钱包绑定已变化，请重新检查');
  if(this.now()>j.expiresAt&&j.pauseReason!=='user')throw Error('原监测已到期，请重新检查并启动新任务');
  const active=this.list().filter(x=>ACTIVE.has(x.status));
  if(new Set(active.map(x=>x.config.asset.toLowerCase())).size>=4&&!active.some(x=>same(x.config.asset,j.config.asset)))throw Error('最多同时监测 4 个代币');
  if(active.some(x=>same(x.config.asset,j.config.asset)&&x.config.accounts.some(a=>j.config.accounts.includes(a))))throw Error('已有相同钱包和代币的任务运行');
  const previous=structuredClone(j);
  if(this.now()>j.expiresAt)j.expiresAt=this.now()+86400000;
  for(const r of j.rows){
   if(!['PREPARING','TRACKING','WAITING','PAUSED'].includes(r.status))continue;
   const o=r.orderId?this.engine.get(r.orderId):null;
   if(r.status==='PAUSED'&&cancelledBeforeSale(o)){r.status='WAITING';delete r.commitStartedAt;delete r.submittedPercent;if(!r.recovery)delete r.submittedSettings;}
   else if([1,2].includes(j.recoveryVersion)&&r.recovery?.sourceId===o?.id&&!r.commitStartedAt&&r.recoveryAttempts>0&&r.recoveryAttempts<=(j.recoveryVersion===2?3:1)&&recoverableOpeningSale(o))r.status='WAITING';
   else if(o&&['PENDING','READY_TO_CONTINUE'].includes(o.status))r.status='TRACKING';
   else if(o&&['CONFIRMED','CONFIRMED_REVIEW','FAILED','REJECTED','BLOCKED','CANCELLED','SIMULATED'].includes(o.status))this.result(r,o);
   else if(r.commitStartedAt||o&&['SUBMITTING','SUBMISSION_UNKNOWN','RECEIPT_REVIEW'].includes(o.status)){r.status='REVIEW';r.error={message:'原提交结果尚不明确，请核对原单；未重新提交'};}
   else r.status='WAITING';
  }
  j.status=j.rows.some(r=>WATCHING.has(r.status))?'ARMED':j.rows.some(r=>r.status==='TRACKING')?'TRACKING':'COMPLETED';
  j.message='用户已恢复原任务，沿用原比例和截止时间；已提交操作只跟踪原单';
  try{this.persist();}catch(e){for(const k of Object.keys(j))delete j[k];Object.assign(j,previous);throw e;}this.schedule(j,0);this.scheduleFollow(j);return j;
 }
 // Internal handoff only: the engine has already verified the claim receipt.
 // A stable ID makes a crash between the two journals harmless.
 afterClaim(id,claim,policy,authorization){
  if(this.closed||claim.status!=='CONFIRMED'||claim.plan?.route!=='corla:claim'||claim.simulationOnly||!this.engine.live)throw Error('领取尚未确认到账，不能启动联动卖出');
  const config=openingConfig({asset:claim.plan.outputToken,accounts:[claim.intent.account],...policy});
  if(this.fastSaleOwns?.(config.asset,claim.plan.wallet))throw Error('此钱包已有该代币的极速卖出任务');
  if(!same(wallet(claim.intent.account).address,claim.plan.wallet))throw Error('钱包绑定已变化');
  const old=this.jobs.get(id);if(old){if(old.sourceClaim!==claim.id||hash(old.config)!==hash(config)||!same(old.bindings?.[0]?.address,claim.plan.wallet))throw Error('联动卖出 ID 与原领取或策略不一致');return old;}
  if(this.list().some(j=>ACTIVE.has(j.status)&&same(j.config.asset,config.asset)&&j.config.accounts.includes(claim.intent.account)))throw Error('此钱包已有该代币的开盘卖出任务，未重复启动');
  const job={id,config,bindings:[{account:claim.intent.account,address:claim.plan.wallet}],sourceClaim:claim.id,recoveryVersion:2,status:'ARMED',mode:'LIVE',createdAt:this.now(),expiresAt:this.now()+86400000,authorization,rows:[{account:claim.intent.account,status:'WAITING',attempts:0}],message:'领取已确认到账，立即检查开盘卖出路线'};
  this.jobs.set(id,job);try{this.persist();}catch(e){this.jobs.delete(id);throw e;}this.schedule(job,0);this.scheduleFollow(job);return job;
 }
 // Called only by the user's explicit Corla resume action, never startup.
 // Pending sends keep their original order IDs. Uncertain PREPARED sends are
 // reviewed, not re-signed; only a never-dispatched preview may be rebuilt.
 resumeAfterClaim(id,claim,policy,authorization){
  const j=this.afterClaim(id,claim,policy,authorization);if(j.status!=='PAUSED')return j;
  if(this.running.has(id)||this.followBusy.has(id)||j.rows.some(r=>this.rowBusy.has(id+':'+r.account)))throw Error('正在结束暂停前的操作，请稍后点击恢复');
  if(j.cancelRequested||j.mode!=='LIVE')throw Error('原卖出任务已取消或模式不一致，不能恢复');
  if(this.list().some(x=>x.id!==id&&ACTIVE.has(x.status)&&same(x.config.asset,j.config.asset)&&x.config.accounts.some(a=>j.config.accounts.includes(a))))throw Error('已有另一个卖出任务，不能重复恢复');
  const previous=structuredClone(j);
  if(this.now()>j.expiresAt&&j.pauseReason==='user')j.expiresAt=this.now()+86400000;
  for(const r of j.rows){
   if(r.status==='PREPARING'||r.status==='TRACKING'||r.status==='PAUSED'||r.commitStartedAt){
    const o=r.orderId?this.engine.get(r.orderId):null;
    if(r.status==='PAUSED'&&cancelledBeforeSale(o)){r.status='WAITING';delete r.commitStartedAt;delete r.submittedPercent;if(!r.recovery)delete r.submittedSettings;}
    else if([1,2].includes(j.recoveryVersion)&&r.recovery?.sourceId===o?.id&&!r.commitStartedAt&&r.recoveryAttempts>0&&r.recoveryAttempts<=(j.recoveryVersion===2?3:1)&&recoverableOpeningSale(o))r.status='WAITING';
    else if(o&&['PENDING','SUBMITTING','SUBMISSION_UNKNOWN','RECEIPT_REVIEW','READY_TO_CONTINUE'].includes(o.status))r.status='TRACKING';
    else if(o&&['CONFIRMED','CONFIRMED_REVIEW','FAILED','REJECTED','BLOCKED','CANCELLED','SIMULATED'].includes(o.status))this.result(r,o);
    else if(r.commitStartedAt){r.status='REVIEW';r.error={message:'原提交边界未明确，保留原单；不重复卖出'};}
    else r.status='WAITING';
   }
   if(WATCHING.has(r.status)&&this.now()>j.expiresAt)r.status='EXPIRED';
  }
  j.status=j.rows.some(r=>WATCHING.has(r.status))?'ARMED':j.rows.some(r=>r.status==='TRACKING')?'TRACKING':'COMPLETED';
  j.message='用户已恢复领取后的原卖出任务；已提交的操作只核对原单';try{this.persist();}catch(e){for(const k of Object.keys(j))delete j[k];Object.assign(j,previous);throw e;}this.schedule(j,0);this.scheduleFollow(j);return j;
 }
 async check(input){
  const config=openingConfig(input),[snapshot,rows,preflight]=await Promise.all([this.detector.scan(config.asset,{currency:config.currency}),Promise.all(config.accounts.map(async account=>{
   const w=wallet(account);await this.bridge.ready(account,{external:true});
   const [[balance],[decimals]]=await Promise.all([read(this.rpc,config.asset,ERC20,'balanceOf',[w.address]),read(this.rpc,config.asset,ERC20,'decimals')]);
   if(Number(decimals)>36)throw Error('代币精度不支持');return {...w,balance:String(balance),amount:String(percentOf(balance,config.percent)),decimals:Number(decimals)};
  })),this.preparation?.warm(config)]);
  if(rows.every(w=>BigInt(w.amount)===0n))throw Error('所选钱包没有可卖出的代币持仓');
  const c={id:randomUUID(),config,rows,snapshot,preflight,checkedAt:this.now(),mode:this.engine.live?'LIVE':'SIMULATION'};
  this.checks.set(c.id,c);for(const [k,v]of this.checks)if(this.now()-v.checkedAt>60000||this.checks.size>20)this.checks.delete(k);return c;
 }
 arm(id,{confirmed=false,late=null}={}){
  const old=this.jobs.get(id);if(old)return old;
  if(this.closed||confirmed!==true)throw Error('需要点击启动开盘卖出');
  const c=this.checks.get(id);if(!c||this.now()-c.checkedAt>60000)throw Error('开盘卖出检查已过期，请重新检查');
  if(c.mode!==(this.engine.live?'LIVE':'SIMULATION'))throw Error('运行模式已变化，请重新检查');
  for(const r of c.rows)if(!same(wallet(r.account).address,r.address))throw Error('钱包绑定已变化，请重新检查');
  if(c.rows.some(w=>this.fastSaleOwns?.(c.config.asset,w.address)))throw Error('所选钱包已有该代币的极速卖出任务');
  const active=this.list().filter(j=>ACTIVE.has(j.status));if(new Set(active.map(j=>j.config.asset.toLowerCase())).size>=4&&!active.some(j=>same(j.config.asset,c.config.asset)))throw Error('最多同时监测 4 个代币');
  if(active.some(j=>same(j.config.asset,c.config.asset)&&j.config.accounts.some(a=>c.config.accounts.includes(a))))throw Error('这些钱包已有该代币开盘卖出任务，请勿重复启动');
  const job={id,...(late?{lateRequestHash:late.requestHash,name:late.name,sourceMint:late.parent}:{}),config:c.config,bindings:c.rows.map(({account,address})=>({account,address})),recoveryVersion:2,status:'ARMED',mode:c.mode,createdAt:this.now(),expiresAt:this.now()+86400000,
   preflight:c.preflight,authorization:'用户在本地看板点击启动开盘卖出：'+JSON.stringify(c.config)+'；检测到支持的外盘流动性后按实时持仓卖出一次，必要时仅授权本次数量；已核验未成交时最多重试同一主池 3 次，沿用原滑点。',
   rows:c.rows.map(r=>({account:r.account,status:'WAITING',attempts:0})),message:c.snapshot.open?'已检测到流动性，正在检查可卖出路线':c.snapshot.routeIssue||'等待链上加池开盘'};
  this.jobs.set(id,job);try{this.persist();}catch(e){this.jobs.delete(id);throw e;}
  // Use the just-checked state immediately rather than waiting five seconds
  // for maintenance. This only creates read-only approval previews.
  if(!c.snapshot.open&&c.preflight)void this.engine.warmOpeningApprovals?.(job.config,c.preflight,c.snapshot,()=>!this.closed&&job.status==='ARMED'&&!job.cancelRequested&&!(job.revision||0)).catch(()=>{});
  if(!c.snapshot.open)this.prepareApprovals(job);
  this.schedule(job,0);this.scheduleFollow(job);return job;
 }
 schedule(job,ms=this.pollMs){if(!this.autoSchedule||this.closed||!ACTIVE.has(job.status)||this.timers.has(job.id))return;
  const t=setTimeout(()=>{this.timers.delete(job.id);const start=this.now();this.tick(job.id).catch(e=>{job.message=e.message;this.persist();}).finally(()=>this.schedule(job,Math.max(25,this.pollMs-(this.now()-start))));},ms);t.unref?.();this.timers.set(job.id,t);
 }
 pause(id){
  const j=this.jobs.get(id);if(!j||j.deletedAt)throw Error('没有该开盘任务');if(j.status==='PAUSED')return j;
  if(!ACTIVE.has(j.status))throw Error('此任务已结束或需核对，可删除任务');
  j.status='PAUSED';j.pauseReason='user';j.pausedAt=this.now();j.message='已暂停，保留原任务和交易记录，点击恢复继续';
  clearTimeout(this.timers.get(id));this.timers.delete(id);clearTimeout(this.followTimers.get(id));this.followTimers.delete(id);this.persist();return j;
 }
 remove(id){
  const j=this.jobs.get(id);if(!j)throw Error('没有该开盘任务');j.deletedAt??=this.now();j.cancelRequested=true;j.status='DELETED';j.message='任务已删除；原交易记录保留';
  clearTimeout(this.timers.get(id));this.timers.delete(id);clearTimeout(this.followTimers.get(id));this.followTimers.delete(id);this.persist();return j;
 }
 restore(id){
  const j=this.jobs.get(id);if(!j||j.deletedAt)throw Error('任务已删除或不存在，不能恢复');if(j.status==='PAUSED')return j;
  if(j.status!=='CANCELLED'||this.running.has(id)||this.followBusy.has(id))throw Error('仅可找回旧版已停止任务，且原操作须已结束');
  for(const r of j.rows)if(r.status==='CANCELLED')r.status='PAUSED';
  j.status='PAUSED';j.pauseReason='user';delete j.cancelRequested;j.restoredAt=this.now();j.message='旧版任务已找回，点击恢复后才继续';this.persist();return j;
 }
 stop(id){const j=this.jobs.get(id);if(!j)throw Error('没有该开盘任务');j.cancelRequested=true;for(const r of j.rows)if(WATCHING.has(r.status))r.status='CANCELLED';j.status='CANCELLED';j.message='已停止监测；已经提交的原单仍需核对，无法撤回。';clearTimeout(this.timers.get(id));this.timers.delete(id);this.persist();return j;}
 close(){this.closed=true;for(const t of [...this.timers.values(),...this.followTimers.values(),...this.retryTimers.values()])clearTimeout(t);this.timers.clear();this.followTimers.clear();this.retryTimers.clear();this.flushFollowResults();}
 scheduleRetry(j,r){
  if(!this.autoSchedule||this.closed||j.cancelRequested||!ACTIVE.has(j.status)||r.status!=='WAITING'||r.commitStartedAt||this.now()>=j.expiresAt)return;
  const key=j.id+':'+r.account;if(this.retryTimers.has(key))return;
  // Per-wallet retry is independent of the group's Promise.all: a slow
  // preview on wallet 1 must not postpone wallet 100's unsubmitted re-quote.
  const timer=setTimeout(()=>{this.retryTimers.delete(key);void this.fire(j,r).then(()=>this.finishIfIdle(j)).catch(()=>{});},Math.max(25,(r.retryAt||this.now())-this.now()));
  timer.unref?.();this.retryTimers.set(key,timer);
 }
 scheduleFollow(j){if(!this.autoSchedule||this.closed||j.deletedAt||j.status==='PAUSED'||this.followTimers.has(j.id)||!ACTIVE.has(j.status)&&!j.rows.some(r=>r.status==='TRACKING'))return;
  // Schedule the next read independently: one slow original must not hold
  // every other wallet's next receipt check behind a batch Promise.all.
  const timer=setTimeout(()=>{this.followTimers.delete(j.id);void this.followPending(j).catch(e=>{j.followError=e.message;});this.scheduleFollow(j);},500);timer.unref?.();this.followTimers.set(j.id,timer);
 }
 async followPending(j){
  if(this.closed||j.deletedAt||j.status==='PAUSED')return;
  const rows=j.rows.filter(r=>r.status==='TRACKING'&&!this.rowBusy.has(j.id+':'+r.account)&&!this.followRows.has(j.id+':'+r.account)&&this.now()-(r.lastFollowAt||0)>=500);
  if(!rows.length)return;
  for(const r of rows)this.followRows.set(j.id+':'+r.account,r.orderId);
  this.followBusy.add(j.id);
  await parallelWallets(rows,async r=>{
   const key=j.id+':'+r.account,id=this.followRows.get(key);
   try{
    if(this.closed||j.deletedAt||j.status==='PAUSED'||r.orderId!==id)return;
    r.lastFollowAt=this.now();let o=await this.engine.follow(id);
    if(r.orderId!==id)return;
    // Continue only this original's confirmed approval. A separate follower
    // can already have advanced the row; never overwrite a newer attempt.
    if(o.status==='READY_TO_CONTINUE'&&!j.cancelRequested&&!this.closed&&ACTIVE.has(j.status)&&this.now()<=j.expiresAt)o=await this.engine.execute(o.id,{authorization:j.authorization,acknowledgeReview:false,swapReceiptWaitMs:0,continueAllowed:()=>!j.cancelRequested&&!this.closed&&ACTIVE.has(j.status)&&this.now()<=j.expiresAt});
    this.autoResult(j,r,o,{persist:false});
    if(r.orderId===id&&o.status==='READY_TO_CONTINUE'&&(j.cancelRequested||this.closed||!ACTIVE.has(j.status)||this.now()>j.expiresAt)){
     r.status=j.status==='PAUSED'?'TRACKING':'REVIEW';r.error={message:'授权已确认，监测已停止、暂停或到期；卖出未提交，请核对原单'};
    }
   }catch(e){if(r.orderId===id)r.error=publicError(e);}
   finally{
    try{if(r.status==='WAITING')await this.persistAsync();else await this.persistFollowResults();this.scheduleRetry(j,r);}catch(e){resultSaveFailed(r);throw e;}
    finally{this.followRows.delete(key);if(!j.rows.some(x=>this.followRows.has(j.id+':'+x.account))){this.followBusy.delete(j.id);this.finishIfIdle(j);}}
   }
  });
 }
 prepareApprovals(j){
  if(j.config.preApprove!==true||!this.engine.taskPreapprovals)return;
  const revision=j.revision||0;
  for(const row of j.rows){if(!WATCHING.has(row.status))continue;
   const allowed=()=>!this.closed&&!j.deletedAt&&!j.cancelRequested&&j.status==='ARMED'&&!j.detectedAt&&(j.revision||0)===revision&&this.now()<=j.expiresAt&&WATCHING.has(row.status)&&j.config.preApprove===true;
   void this.engine.taskPreapprovals.run({key:j.id+':'+row.account,holder:row,source:{account:row.account,wallet:j.bindings.find(w=>w.account===row.account).address,asset:j.config.asset,percent:j.config.percent,currency:j.config.currency,revision},allowed,persist:()=>this.persist()}).catch(()=>{});
  }
 }
 warm(j,snapshot){if(!this.preparation||this.warmBusy.has(j.id)||this.now()-(j.preflight?.at||0)<5000)return;
  // Read-only fee audit coalesces across wallets while waiting for opening.
  void this.engine.sellAudit?.(j.config.asset).catch(()=>{});
  const revision=j.revision||0;this.warmBusy.add(j.id);void this.preparation.warm(j.config).then(p=>{
   if(j.cancelRequested||this.closed||!ACTIVE.has(j.status)||(j.revision||0)!==revision)return;
   if(j.preflight?.fingerprint&&j.preflight.fingerprint!==p.fingerprint){j.status='PAUSED';j.message='等待期间代币代码已变化，请重新检查';}else{j.preflight=p;delete j.preflightError;
    void this.engine.warmOpeningApprovals?.(j.config,p,snapshot,()=>!this.closed&&j.status==='ARMED'&&!j.cancelRequested&&(j.revision||0)===revision).catch(()=>{});
   }this.persist();
  }).catch(e=>{j.preflightError=e.message;}).finally(()=>this.warmBusy.delete(j.id));
 }
 async tick(id){
  const j=this.jobs.get(id);if(this.closed||!j||!ACTIVE.has(j.status)||this.running.has(id))return j;this.running.add(id);const started=this.now();
  try{
   if(this.now()>j.expiresAt&&j.rows.every(r=>!r.commitStartedAt)){j.status='EXPIRED';j.message='24 小时监测已到期，未自动续订';this.persist();return j;}
   if(j.bindings.some(r=>!same(wallet(r.account).address,r.address))){j.status='PAUSED';j.message='钱包绑定已变化，任务暂停';this.persist();return j;}
   // Receipt polling is independent of opening detection. A slow original
   // order must not hold up other wallets that have not submitted anything.
   const following=this.followPending(j);
   if(j.rows.some(r=>WATCHING.has(r.status)))void following.catch(e=>{j.followError=e.message;this.persist();});
   else await following;
   if(j.cancelRequested||this.closed||!ACTIVE.has(j.status))return j;
   if(this.now()>j.expiresAt)for(const r of j.rows)if(WATCHING.has(r.status))r.status='EXPIRED';
   const waiting=j.rows.filter(r=>WATCHING.has(r.status));
   if(waiting.length){
    let s;try{s=await this.detector.scan(j.config.asset,{currency:j.config.currency,watch:true,reuseMs:250});}catch(e){j.message=e.message;j.lastScanAt=this.now();return j;}
    if(j.cancelRequested||this.closed||!ACTIVE.has(j.status))return j;
    if(this.now()>j.expiresAt){j.status='EXPIRED';j.message='监测已到期';this.persist();return j;}
    j.lastScanAt=this.now();j.lastBlock=s.block;j.scanMs=this.now()-started;j.partial=s.partial;
    const mainOpen=!j.config.preApprove||freshOpeningSnapshot(s,j.config.asset,6000)&&s.pools.some(p=>p.liquid&&matchesCurrency(p,j.config.currency)&&refreshOpeningPoolProvenance(s,p).declaredByToken);
    if(!s.open||!mainOpen){this.prepareApprovals(j);this.warm(j,s);j.message=!mainOpen?'等待已核验主池开盘；不会因其他池子先加池而提前卖出':s.routeIssue||(s.partial?'部分池子查询失败，继续监测':'等待链上加池开盘');return j;}
    j.detectedAt??=this.now();j.detectedBlock??=s.block;j.status='FIRING';j.message='检测到流动性，按当前持仓独立准备各钱包';this.persist();
    await parallelWallets(waiting,r=>this.fire(j,r,s));
   }
   if(!j.cancelRequested&&ACTIVE.has(j.status)){j.status=j.rows.some(r=>WATCHING.has(r.status))?'ARMED':this.settling(j)||j.rows.some(r=>r.status==='TRACKING')?'TRACKING':j.rows.some(r=>['SELL_FEE_REVIEW','SELL_FEES_UNVERIFIABLE'].includes(r.error?.code))?'REVIEW':'COMPLETED';j.message=j.status==='REVIEW'?'卖出费用检查未通过，尚未提交；请查看原因':j.status==='COMPLETED'?'本次开盘任务已结束，请查看各钱包结果':j.status==='TRACKING'?'仅跟踪已提交原单':'池子已出现，等待可执行的卖出预览';}
   this.persist();return j;
  }finally{this.running.delete(id);}
 }
 async fire(j,r,snapshot){
  const key=j.id+':'+r.account;
  if(j.cancelRequested||this.closed||!ACTIVE.has(j.status)||!WATCHING.has(r.status)||this.rowBusy.has(key)||this.now()<(r.retryAt||0))return;
  clearTimeout(this.retryTimers.get(key));this.retryTimers.delete(key);
  if(this.now()>=j.expiresAt){r.status='EXPIRED';this.persist();return;}
  // Independent retries do not pass through tick() again. Preserve its
  // original wallet binding boundary before preparing any new attempt.
  const bound=j.bindings?.find(w=>w.account===r.account);
  if(bound){let matches=false;try{matches=same(wallet(r.account).address,bound.address);}catch{}if(!matches){j.status='PAUSED';j.message='钱包绑定已变化，任务暂停';this.persist();return;}}
  if(r.recovery?(r.recoveryPreviews||0)>=10:r.attempts>=20){r.status='BLOCKED';r.error={message:'开盘后多次预览仍未通过，已停止；请查看原单原因'};this.persist();return;}
  const revision=j.revision||0,config={...j.config,...(r.recovery?r.submittedSettings||{}:{})};if(r.recovery&&r.submittedPercent)config.percent=r.submittedPercent;this.rowBusy.add(key);
  r.attempts++;if(r.recovery)r.recoveryPreviews=(r.recoveryPreviews||0)+1;r.status='PREPARING';r.orderId='opening-'+j.id+'-a'+r.account+'-p'+r.attempts;
  const preparingWrite=this.persistAsync().then(()=>null,error=>error);
  try{
   const intent={account:r.account,side:'sell',asset:config.asset,percent:config.percent,slippageBps:config.slippageBps,slippageMode:'fixed',currency:config.currency,openingOnly:true,...(config.preApprove?{primaryOnly:true}:{}),...(config.gasLimit===undefined?{}:{gasLimit:config.gasLimit})};
   const warmed=j.preflight?.rows?.find(p=>p.account===r.account&&!p.unavailable);
   const openingHoldingHint=warmed?{at:j.preflight.at,token:config.asset,wallet:warmed.address,balance:warmed.balance,fingerprint:j.preflight.fingerprint}:undefined;
   let o=await this.engine.prepare(intent,r.orderId,{instantExecution:this.engine.live,openingSnapshot:snapshot,openingHoldingHint,...(r.recovery?{openingRecovery:r.recovery}:{})});
   const journalError=await preparingWrite;if(journalError)throw journalError;
   if(j.cancelRequested||this.closed||!ACTIVE.has(j.status)||this.now()>j.expiresAt){r.status=j.status==='PAUSED'?'PAUSED':'CANCELLED';return;}
   if((j.revision||0)!==revision&&editableSaleRow(r)){r.status='WAITING';r.retryAt=this.now();r.error={message:'设置已修改，按新比例重新准备'};return;}
   // Unknown fees are a route-policy rejection, not a transient opening state.
   // Do not create twenty more preparations or fall back to another opaque sale.
   if(o.error?.code==='SELL_FEES_UNVERIFIABLE'){this.result(r,o);return;}
   if(o.status==='BLOCKED'&&!o.steps?.length){
    const lowGas=j.config.gasLimit!==undefined&&String(o.error?.code)==='351805'&&/out of gas|gas limit/i.test(o.error?.providerMessage||o.error?.message||'');
    const transientRecovery=r.recovery&&['RPC_UNAVAILABLE','RPC_READ_FAILED','RPC_READ_TIMEOUT','ORIGINAL_READ_UNAVAILABLE','WALLET_BUSY','OFFICIAL_SIMULATION_FAILED','OPENING_QUOTE_UNAVAILABLE'].includes(o.error?.code);
    r.status=lowGas||r.recovery&&!transientRecovery?'BLOCKED':'WAITING';r.retryAt=this.now()+500;r.error=lowGas?{...o.error,message:'本次设置的卖出 Gas 上限 '+j.config.gasLimit+' 不足，已停止；请调整上限后新建任务。'}:o.error;return;
   }
   if(o.status!=='PREPARED'||o.review?.length){this.result(r,o);return;}
   // Durable commit marker BEFORE dispatch. Neither exceptions nor restarts
   // return this wallet to the preflight retry loop after this point.
   r.status='TRACKING';r.submittedPercent=config.percent;
   // Store this wallet's immutable trade terms, not 100 copies of the batch's
   // 100-account list in the shared journal on every state transition.
   r.submittedSettings={percent:config.percent,slippageBps:config.slippageBps,currency:config.currency,preApprove:config.preApprove===true,...(config.gasLimit===undefined?{}:{gasLimit:config.gasLimit})};
   r.commitStartedAt=this.now();r.detectToPrepareMs=this.now()-j.detectedAt;await this.persistAsync();
   o=await this.engine.execute(o.id,{authorization:j.authorization,acknowledgeReview:false,swapReceiptWaitMs:0,continueAllowed:()=>!j.cancelRequested&&!this.closed&&ACTIVE.has(j.status)&&this.now()<=j.expiresAt});this.autoResult(j,r,o,{persist:false});
  }catch(e){
   r.error=publicError(e);
   // A local mutex/original-order guard explicitly rejected this dispatch.
   // Do not strand an opening sale merely because another read/claim occupied
   // the wallet. Reuse the same attempt ID; unknown provider errors never retry.
   const current=this.engine.get?.(r.orderId);
   if(localAdmissionDeferred(e,current)&&!j.cancelRequested&&!this.closed&&ACTIVE.has(j.status)){
    delete r.commitStartedAt;delete r.submittedPercent;if(!r.recovery)delete r.submittedSettings;r.attempts--;if(r.recovery)r.recoveryPreviews--;r.busyDeferrals=(r.busyDeferrals||0)+1;r.status='WAITING';r.retryAt=this.now()+300;
   }else r.status=r.commitStartedAt?'REVIEW':j.status==='PAUSED'?'PAUSED':'BLOCKED';
  }finally{try{await this.persistAsync();}catch(e){resultSaveFailed(r);throw e;}finally{this.rowBusy.delete(key);this.scheduleRetry(j,r);}}
 }
 autoResult(j,r,o,{persist=true}={}){
  if(r.orderId&&o.id&&r.orderId!==o.id)return; // Late response from a previous attempt.
  if(r.recovery?.sourceId===o.id&&!r.commitStartedAt&&r.previousOrders?.some(p=>p.id===o.id))return;
  this.result(r,o);
  if(j.status==='PAUSED'&&cancelledBeforeSale(o)){r.status='PAUSED';return;}
  // Queue/quote/read failures BEFORE the sell was dispatched may retry only
  // under this active task's existing authorization. Approval-only receipts
  // are retained; pending/unknown/reverted sales never enter this branch.
  if(!j.cancelRequested&&!this.closed&&ACTIVE.has(j.status)&&o.status==='BLOCKED'&&!o.txHash&&!o.orderId&&
   ['SELL_POOL_BUSY','RPC_UNAVAILABLE','RPC_READ_FAILED','RPC_READ_TIMEOUT','OPENING_QUOTE_UNAVAILABLE','SELL_OUTPUT_BELOW_MIN'].includes(o.error?.code)&&
   Array.isArray(o.steps)&&o.steps.every(e=>e.step?.kind==='approve'&&e.status==='CONFIRMED')){
   delete r.commitStartedAt;delete r.submittedPercent;if(!r.recovery)delete r.submittedSettings;r.status='WAITING';r.retryAt=this.now()+300;return;
  }
  const limit=j.recoveryVersion===2?3:j.recoveryVersion===1?1:0;
  if(!limit||(r.recoveryAttempts||0)>=limit||j.cancelRequested||this.closed||!ACTIVE.has(j.status)||this.now()>j.expiresAt||!recoverableOpeningSale(o))return;
  // New tasks retry the same verified pool at most three times, each after
  // proof of non-execution. Unknown/successful originals NEVER enter this path.
  // Older tasks keep their original one-attempt recovery policy.
  r.previousOrders=[...(r.previousOrders||[]),{id:o.id,txHash:r.txHash,status:o.status,error:o.error}];
  r.recoveryAttempts=(r.recoveryAttempts||0)+1;r.recovery={sourceId:o.id,...(j.recoveryVersion===2?{samePool:true}:{})};delete r.commitStartedAt;
  r.status='WAITING';r.retryAt=this.now();r.error={code:'OPENING_RECOVERY',message:j.recoveryVersion===2?'原卖出已核验未成交，正在按原滑点重新报价同一主池（重试 '+r.recoveryAttempts+'/3）；已成交及状态未知的钱包不会重复卖出':'原卖出已核验未成交，重新检查一次可用路线；仍须核验池费，沿用原比例、滑点及所选 Gas 设置'};if(persist)this.persist();
 }
 result(r,o){r.orderStatus=o.status;r.error=o.error;r.txHash=o.txHash||o.steps?.at(-1)?.txHash;r.chainOrderId=o.orderId;r.timing=o.timing;
  if(o.needsFeeReview)r.error={code:'SELL_FEE_REVIEW',message:'未自动卖出：'+(o.feeReview?.reasons||[]).join('；')+'。请打开原单确认费用。'};
  r.status=['PENDING','READY_TO_CONTINUE'].includes(o.status)?'TRACKING':['PREPARED','SUBMISSION_UNKNOWN','SUBMITTING','RECEIPT_REVIEW','CONFIRMED_REVIEW'].includes(o.status)?'REVIEW':o.status;
  if(o.error?.code==='SELL_FEES_UNVERIFIABLE')r.status='REVIEW';
 }
}
