import path from 'node:path';
import {editableSaleRow} from './task-edit.mjs';
import {randomUUID} from 'node:crypto';
import {address,hash,load,save,wallet,validateIntent,read,ERC20,percentOf,same,publicError} from './common.mjs';
import {recoverableOpeningSale} from './opening-recovery.mjs';
import {localAdmissionDeferred} from './submission-boundary.mjs';
const ACTIVE=new Set(['ARMED','FIRING','TRACKING']);
const WATCHING=new Set(['WAITING','PREPARING']);
const cancelledBeforeSale=o=>o?.status==='CANCELLED'&&!o.orderId&&!o.txHash&&Array.isArray(o.steps)&&o.steps.every(e=>e.status==='CONFIRMED'&&e.step?.kind==='approve');
export function openingConfig(input){
 if(!input||Object.keys(input).some(k=>!['asset','accounts','percent','slippageBps','currency','gasLimit'].includes(k)))throw Error('开盘卖出参数无效');
 const asset=address(input.asset);if(/^0x0{40}$/i.test(asset))throw Error('代币地址不能为零');
 if(!Array.isArray(input.accounts)||!input.accounts.length||input.accounts.length>200||new Set(input.accounts).size!==input.accounts.length)throw Error('请选择不重复的已绑定钱包');
 const accounts=[...input.accounts].sort((a,b)=>a-b);accounts.forEach(wallet);
 const percent=String(input.percent??'50'),slippageBps=input.slippageBps??5000,currency=input.currency??'AUTO';
 if(!['AUTO','BNB','WBNB','USDT'].includes(currency))throw Error('开盘卖出到账支持自动、BNB、WBNB、USDT');
 const gas=input.gasLimit===undefined?{}:{gasLimit:input.gasLimit};
 validateIntent({account:accounts[0],asset,side:'sell',percent,slippageBps,currency,slippageMode:'fixed',openingOnly:true,...gas});
 return {asset,accounts,percent,slippageBps,currency,...gas};
}
export class OpeningSell{
 constructor({engine,rpc,bridge,detector,data,preparation=null,pollMs=300,now=Date.now,autoSchedule=true}){
  Object.assign(this,{engine,rpc,bridge,detector,preparation,pollMs,now,autoSchedule});this.file=path.join(data,'opening-sell.json');this.jobs=new Map();this.checks=new Map();this.timers=new Map();this.running=new Set();this.closed=false;this.followTimers=new Map();this.followBusy=new Set();this.rowBusy=new Set();this.warmBusy=new Set();
  for(const job of load(this.file,[])){
   // A process restart never re-arms an old authorization or retries a send.
   if(ACTIVE.has(job.status)){job.status='PAUSED';job.pauseReason='restart';job.message='服务重启，任务已暂停；先核对已有原单，重新启动需再次点击。';}
   this.jobs.set(job.id,job);
  }
  if(this.jobs.size)this.persist();
 }
 persist(){save(this.file,[...this.jobs.values()]);}
 list(){return [...this.jobs.values()].filter(j=>!j.deletedAt).sort((a,b)=>b.createdAt-a.createdAt);}
 reconcileOrder(o){
  if(!['CONFIRMED','CONFIRMED_REVIEW','FAILED','REJECTED','CANCELLED'].includes(o?.status))return;
  let changed=false;
  for(const j of this.jobs.values())for(const r of j.rows){
   if(r.orderId!==o.id)continue;this.result(r,o);if(j.status==='PAUSED'&&cancelledBeforeSale(o))r.status='PAUSED';changed=true;
   // Reflect a manually reconciled original in the task card without ever
   // re-arming a cancelled/paused task or dispatching a subsequent step.
   if((ACTIVE.has(j.status)||j.status==='REVIEW')&&j.rows.every(x=>!WATCHING.has(x.status)&&!['TRACKING','PREPARING'].includes(x.status))){j.status=j.rows.some(x=>['SELL_FEE_REVIEW','SELL_FEES_UNVERIFIABLE'].includes(x.error?.code))?'REVIEW':'COMPLETED';j.message=j.status==='REVIEW'?'卖出费用检查未通过，尚未提交；请查看原因':'原单核对完成，请查看各钱包结果';}
  }
  if(changed)this.persist();
 }
 active(){return this.list().some(j=>ACTIVE.has(j.status));}
 resume(id){
  const j=this.jobs.get(id);if(!j||j.status!=='PAUSED'||j.cancelRequested||this.closed)throw Error('仅暂停且未停止的任务可以恢复');
  if(this.running.has(id)||this.followBusy.has(id))throw Error('正在结束暂停前的操作，请稍后点击恢复');
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
   if(r.status==='PAUSED'&&cancelledBeforeSale(o)){r.status='WAITING';delete r.commitStartedAt;delete r.submittedPercent;}
   else if(j.recoveryVersion===1&&r.recovery?.sourceId===o?.id&&!r.commitStartedAt&&r.recoveryAttempts===1&&recoverableOpeningSale(o))r.status='WAITING';
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
  if(!same(wallet(claim.intent.account).address,claim.plan.wallet))throw Error('钱包绑定已变化');
  const old=this.jobs.get(id);if(old){if(old.sourceClaim!==claim.id||hash(old.config)!==hash(config)||!same(old.bindings?.[0]?.address,claim.plan.wallet))throw Error('联动卖出 ID 与原领取或策略不一致');return old;}
  if(this.list().some(j=>ACTIVE.has(j.status)&&same(j.config.asset,config.asset)&&j.config.accounts.includes(claim.intent.account)))throw Error('此钱包已有该代币的开盘卖出任务，未重复启动');
  const job={id,config,bindings:[{account:claim.intent.account,address:claim.plan.wallet}],sourceClaim:claim.id,recoveryVersion:1,status:'ARMED',mode:'LIVE',createdAt:this.now(),expiresAt:this.now()+86400000,authorization,rows:[{account:claim.intent.account,status:'WAITING',attempts:0}],message:'领取已确认到账，立即检查开盘卖出路线'};
  this.jobs.set(id,job);try{this.persist();}catch(e){this.jobs.delete(id);throw e;}this.schedule(job,0);this.scheduleFollow(job);return job;
 }
 // Called only by the user's explicit Corla resume action, never startup.
 // Pending sends keep their original order IDs. Uncertain PREPARED sends are
 // reviewed, not re-signed; only a never-dispatched preview may be rebuilt.
 resumeAfterClaim(id,claim,policy,authorization){
  const j=this.afterClaim(id,claim,policy,authorization);if(j.status!=='PAUSED')return j;
  if(this.running.has(id)||this.followBusy.has(id))throw Error('正在结束暂停前的操作，请稍后点击恢复');
  if(j.cancelRequested||j.mode!=='LIVE')throw Error('原卖出任务已取消或模式不一致，不能恢复');
  if(this.list().some(x=>x.id!==id&&ACTIVE.has(x.status)&&same(x.config.asset,j.config.asset)&&x.config.accounts.some(a=>j.config.accounts.includes(a))))throw Error('已有另一个卖出任务，不能重复恢复');
  const previous=structuredClone(j);
  if(this.now()>j.expiresAt&&j.pauseReason==='user')j.expiresAt=this.now()+86400000;
  for(const r of j.rows){
   if(r.status==='PREPARING'||r.status==='TRACKING'||r.status==='PAUSED'||r.commitStartedAt){
    const o=r.orderId?this.engine.get(r.orderId):null;
    if(r.status==='PAUSED'&&cancelledBeforeSale(o)){r.status='WAITING';delete r.commitStartedAt;delete r.submittedPercent;}
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
  const active=this.list().filter(j=>ACTIVE.has(j.status));if(new Set(active.map(j=>j.config.asset.toLowerCase())).size>=4&&!active.some(j=>same(j.config.asset,c.config.asset)))throw Error('最多同时监测 4 个代币');
  if(active.some(j=>same(j.config.asset,c.config.asset)&&j.config.accounts.some(a=>c.config.accounts.includes(a))))throw Error('这些钱包已有该代币开盘卖出任务，请勿重复启动');
  const job={id,...(late?{lateRequestHash:late.requestHash,name:late.name,sourceMint:late.parent}:{}),config:c.config,bindings:c.rows.map(({account,address})=>({account,address})),recoveryVersion:1,status:'ARMED',mode:c.mode,createdAt:this.now(),expiresAt:this.now()+86400000,
   preflight:c.preflight,authorization:'用户在本地看板点击启动开盘卖出：'+JSON.stringify(c.config)+'；检测到支持的外盘流动性后按实时持仓卖出一次，必要时仅授权本次数量。',
   rows:c.rows.map(r=>({account:r.account,status:'WAITING',attempts:0})),message:c.snapshot.open?'已检测到流动性，正在检查可卖出路线':c.snapshot.routeIssue||'等待链上加池开盘'};
  this.jobs.set(id,job);try{this.persist();}catch(e){this.jobs.delete(id);throw e;}this.schedule(job,0);this.scheduleFollow(job);return job;
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
 close(){this.closed=true;for(const t of [...this.timers.values(),...this.followTimers.values()])clearTimeout(t);this.timers.clear();this.followTimers.clear();}
 scheduleFollow(j){if(!this.autoSchedule||this.closed||j.deletedAt||j.status==='PAUSED'||this.followTimers.has(j.id)||!ACTIVE.has(j.status)&&!j.rows.some(r=>r.status==='TRACKING'))return;
  const timer=setTimeout(()=>{this.followTimers.delete(j.id);this.followPending(j).catch(e=>{j.followError=e.message;}).finally(()=>this.scheduleFollow(j));},500);timer.unref?.();this.followTimers.set(j.id,timer);
 }
 async followPending(j){if(this.closed||j.deletedAt||j.status==='PAUSED'||this.followBusy.has(j.id)||!j.rows.some(r=>r.status==='TRACKING'&&!this.rowBusy.has(j.id+':'+r.account)&&this.now()-(r.lastFollowAt||0)>=500))return;this.followBusy.add(j.id);try{
   await Promise.all(j.rows.filter(r=>r.status==='TRACKING'&&!this.rowBusy.has(j.id+':'+r.account)&&this.now()-(r.lastFollowAt||0)>=500).map(async r=>{
    r.lastFollowAt=this.now();try{let o=await this.engine.follow(r.orderId);
     // Continue only the same order's confirmed approval, never a second sale.
     if(o.status==='READY_TO_CONTINUE'&&!j.cancelRequested&&!this.closed&&ACTIVE.has(j.status)&&this.now()<=j.expiresAt)o=await this.engine.execute(o.id,{authorization:j.authorization,acknowledgeReview:false,swapReceiptWaitMs:0,continueAllowed:()=>!j.cancelRequested&&!this.closed&&ACTIVE.has(j.status)&&this.now()<=j.expiresAt});
     this.autoResult(j,r,o);
     if(o.status==='READY_TO_CONTINUE'&&(j.cancelRequested||this.closed||!ACTIVE.has(j.status)||this.now()>j.expiresAt)){
      r.status=j.status==='PAUSED'?'TRACKING':'REVIEW';r.error={message:'授权已确认，监测已停止、暂停或到期；卖出未提交，请核对原单'};
     }
    }catch(e){r.error=publicError(e);}
   }));
   this.persist();
  }finally{this.followBusy.delete(j.id);}
 }
 warm(j){if(!this.preparation||this.warmBusy.has(j.id)||this.now()-(j.preflight?.at||0)<5000)return;
  // Read-only fee audit coalesces across wallets while waiting for opening.
  void this.engine.sellAudit?.(j.config.asset).catch(()=>{});
  const revision=j.revision||0;this.warmBusy.add(j.id);void this.preparation.warm(j.config).then(p=>{
   if(j.cancelRequested||this.closed||!ACTIVE.has(j.status)||(j.revision||0)!==revision)return;
   if(j.preflight?.fingerprint&&j.preflight.fingerprint!==p.fingerprint){j.status='PAUSED';j.message='等待期间代币代码已变化，请重新检查';}else{j.preflight=p;delete j.preflightError;}this.persist();
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
    let s;try{s=await this.detector.scan(j.config.asset,{currency:j.config.currency});}catch(e){j.message=e.message;j.lastScanAt=this.now();return j;}
    if(j.cancelRequested||this.closed||!ACTIVE.has(j.status))return j;
    if(this.now()>j.expiresAt){j.status='EXPIRED';j.message='监测已到期';this.persist();return j;}
    j.lastScanAt=this.now();j.lastBlock=s.block;j.scanMs=this.now()-started;j.partial=s.partial;
    if(!s.open){this.warm(j);j.message=s.routeIssue||(s.partial?'部分池子查询失败，继续监测':'等待链上加池开盘');return j;}
    j.detectedAt??=this.now();j.detectedBlock??=s.block;j.status='FIRING';j.message='检测到流动性，按当前持仓独立准备各钱包';this.persist();
    await Promise.all(waiting.map(r=>this.fire(j,r,s)));
   }
   if(!j.cancelRequested&&ACTIVE.has(j.status)){j.status=j.rows.some(r=>WATCHING.has(r.status))?'ARMED':j.rows.some(r=>r.status==='TRACKING')?'TRACKING':j.rows.some(r=>['SELL_FEE_REVIEW','SELL_FEES_UNVERIFIABLE'].includes(r.error?.code))?'REVIEW':'COMPLETED';j.message=j.status==='REVIEW'?'卖出费用检查未通过，尚未提交；请查看原因':j.status==='COMPLETED'?'本次开盘任务已结束，请查看各钱包结果':j.status==='TRACKING'?'仅跟踪已提交原单':'池子已出现，等待可执行的卖出预览';}
   this.persist();return j;
  }finally{this.running.delete(id);}
 }
 async fire(j,r,snapshot){
  if(j.cancelRequested||this.closed||!ACTIVE.has(j.status)||this.now()<(r.retryAt||0))return;
  if(r.recovery?(r.recoveryPreviews||0)>=10:r.attempts>=20){r.status='BLOCKED';r.error={message:'开盘后多次预览仍未通过，已停止；请查看原单原因'};return;}
  const key=j.id+':'+r.account,revision=j.revision||0,config={...j.config};if(r.recovery&&r.submittedPercent)config.percent=r.submittedPercent;this.rowBusy.add(key);
  r.attempts++;if(r.recovery)r.recoveryPreviews=(r.recoveryPreviews||0)+1;r.status='PREPARING';r.orderId='opening-'+j.id+'-a'+r.account+'-p'+r.attempts;this.persist();
  try{
   const intent={account:r.account,side:'sell',asset:config.asset,percent:config.percent,slippageBps:config.slippageBps,slippageMode:'fixed',currency:config.currency,openingOnly:true,...(config.gasLimit===undefined?{}:{gasLimit:config.gasLimit})};
   let o=await this.engine.prepare(intent,r.orderId,{openingSnapshot:snapshot,...(r.recovery?{openingRecovery:r.recovery}:{})});
   if(j.cancelRequested||this.closed||!ACTIVE.has(j.status)||this.now()>j.expiresAt){r.status=j.status==='PAUSED'?'PAUSED':'CANCELLED';return;}
   if((j.revision||0)!==revision&&editableSaleRow(r)){r.status='WAITING';r.retryAt=this.now();r.error={message:'设置已修改，按新比例重新准备'};return;}
   // Unknown fees are a route-policy rejection, not a transient opening state.
   // Do not create twenty more preparations or fall back to another opaque sale.
   if(o.error?.code==='SELL_FEES_UNVERIFIABLE'){this.result(r,o);return;}
   if(o.status==='BLOCKED'&&!o.steps?.length){
    const lowGas=j.config.gasLimit!==undefined&&String(o.error?.code)==='351805'&&/out of gas|gas limit/i.test(o.error?.providerMessage||o.error?.message||'');
    const transientRecovery=r.recovery&&['RPC_UNAVAILABLE','ORIGINAL_READ_UNAVAILABLE','WALLET_BUSY','OFFICIAL_SIMULATION_FAILED','OPENING_QUOTE_UNAVAILABLE'].includes(o.error?.code);
    r.status=lowGas||r.recovery&&!transientRecovery?'BLOCKED':'WAITING';r.retryAt=this.now()+500;r.error=lowGas?{...o.error,message:'本次设置的卖出 Gas 上限 '+j.config.gasLimit+' 不足，已停止；请调整上限后新建任务。'}:o.error;return;
   }
   if(o.status!=='PREPARED'||o.review?.length){this.result(r,o);return;}
   // Durable commit marker BEFORE dispatch. Neither exceptions nor restarts
   // return this wallet to the preflight retry loop after this point.
   r.status='TRACKING';r.submittedPercent=config.percent;r.commitStartedAt=this.now();r.detectToPrepareMs=this.now()-j.detectedAt;this.persist();
   o=await this.engine.execute(o.id,{authorization:j.authorization,acknowledgeReview:false,swapReceiptWaitMs:0,continueAllowed:()=>!j.cancelRequested&&!this.closed&&ACTIVE.has(j.status)&&this.now()<=j.expiresAt});this.autoResult(j,r,o);
  }catch(e){
   r.error=publicError(e);
   // A local mutex/original-order guard explicitly rejected this dispatch.
   // Do not strand an opening sale merely because another read/claim occupied
   // the wallet. Reuse the same attempt ID; unknown provider errors never retry.
   const current=this.engine.get?.(r.orderId);
   if(localAdmissionDeferred(e,current)&&!j.cancelRequested&&!this.closed&&ACTIVE.has(j.status)){
    delete r.commitStartedAt;delete r.submittedPercent;r.attempts--;if(r.recovery)r.recoveryPreviews--;r.busyDeferrals=(r.busyDeferrals||0)+1;r.status='WAITING';r.retryAt=this.now()+300;
   }else r.status=r.commitStartedAt?'REVIEW':j.status==='PAUSED'?'PAUSED':'BLOCKED';
  }finally{this.rowBusy.delete(key);}
 }
 autoResult(j,r,o){
  this.result(r,o);
  if(j.status==='PAUSED'&&cancelledBeforeSale(o)){r.status='PAUSED';return;}
  if(j.recoveryVersion!==1||r.recoveryAttempts||j.cancelRequested||this.closed||!ACTIVE.has(j.status)||this.now()>j.expiresAt||!recoverableOpeningSale(o))return;
  // Exactly one alternate route after a proven on-chain revert. Persist the
  // boundary first; pending/unknown/successful originals NEVER enter this path.
  r.previousOrders=[...(r.previousOrders||[]),{id:o.id,txHash:r.txHash,status:o.status,error:o.error}];
  r.recoveryAttempts=1;r.recovery={sourceId:o.id};delete r.commitStartedAt;
  r.status='WAITING';r.retryAt=this.now();r.error={code:'OPENING_RECOVERY',message:'原卖出已核验未成交，重新检查一次可用路线；仍须核验池费，沿用原比例、滑点及所选 Gas 设置'};this.persist();
 }
 result(r,o){r.orderStatus=o.status;r.error=o.error;r.txHash=o.txHash||o.steps?.at(-1)?.txHash;r.chainOrderId=o.orderId;r.timing=o.timing;
  if(o.needsFeeReview)r.error={code:'SELL_FEE_REVIEW',message:'未自动卖出：'+(o.feeReview?.reasons||[]).join('；')+'。请打开原单确认费用。'};
  r.status=['PENDING','READY_TO_CONTINUE'].includes(o.status)?'TRACKING':['PREPARED','SUBMISSION_UNKNOWN','SUBMITTING','RECEIPT_REVIEW','CONFIRMED_REVIEW'].includes(o.status)?'REVIEW':o.status;
  if(o.error?.code==='SELL_FEES_UNVERIFIABLE')r.status='REVIEW';
 }
}
