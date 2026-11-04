import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {address,hash,load,save,wallet,validateIntent,read,ERC20,percentOf,same,publicError} from './common.mjs';
const ACTIVE=new Set(['ARMED','FIRING','TRACKING']);
const WATCHING=new Set(['WAITING','PREPARING']);
export function openingConfig(input){
 if(!input||Object.keys(input).some(k=>!['asset','accounts','percent','slippageBps','currency'].includes(k)))throw Error('开盘卖出参数无效');
 const asset=address(input.asset);if(/^0x0{40}$/i.test(asset))throw Error('代币地址不能为零');
 if(!Array.isArray(input.accounts)||!input.accounts.length||input.accounts.length>5||new Set(input.accounts).size!==input.accounts.length)throw Error('请选择不重复的已绑定钱包');
 const accounts=[...input.accounts].sort((a,b)=>a-b);accounts.forEach(wallet);
 const percent=String(input.percent??'100'),slippageBps=input.slippageBps??5000,currency=input.currency??'AUTO';
 if(!['AUTO','BNB','WBNB','USDT'].includes(currency))throw Error('开盘卖出到账支持自动、BNB、WBNB、USDT');
 validateIntent({account:accounts[0],asset,side:'sell',percent,slippageBps,currency,slippageMode:'fixed'});
 return {asset,accounts,percent,slippageBps,currency};
}
export class OpeningSell{
 constructor({engine,rpc,bridge,detector,data,preparation=null,pollMs=300,now=Date.now,autoSchedule=true}){
  Object.assign(this,{engine,rpc,bridge,detector,preparation,pollMs,now,autoSchedule});this.file=path.join(data,'opening-sell.json');this.jobs=new Map();this.checks=new Map();this.timers=new Map();this.running=new Set();this.closed=false;this.followTimers=new Map();this.followBusy=new Set();this.rowBusy=new Set();this.warmBusy=new Set();
  for(const job of load(this.file,[])){
   // A process restart never re-arms an old authorization or retries a send.
   if(ACTIVE.has(job.status)){job.status='PAUSED';job.message='服务重启，任务已暂停；先核对已有原单，重新启动需再次点击。';}
   this.jobs.set(job.id,job);
  }
  if(this.jobs.size)this.persist();
 }
 persist(){save(this.file,[...this.jobs.values()]);}
 list(){return [...this.jobs.values()].sort((a,b)=>b.createdAt-a.createdAt);}
 active(){return this.list().some(j=>ACTIVE.has(j.status));}
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
 arm(id,{confirmed=false}={}){
  const old=this.jobs.get(id);if(old)return old;
  if(this.closed||confirmed!==true)throw Error('需要点击启动开盘卖出');
  const c=this.checks.get(id);if(!c||this.now()-c.checkedAt>60000)throw Error('开盘卖出检查已过期，请重新检查');
  if(c.mode!==(this.engine.live?'LIVE':'SIMULATION'))throw Error('运行模式已变化，请重新检查');
  for(const r of c.rows)if(!same(wallet(r.account).address,r.address))throw Error('钱包绑定已变化，请重新检查');
  const active=this.list().filter(j=>ACTIVE.has(j.status));if(active.length>=4)throw Error('最多同时监测 4 个代币');
  if(active.some(j=>same(j.config.asset,c.config.asset)&&j.config.accounts.some(a=>c.config.accounts.includes(a))))throw Error('这些钱包已有该代币开盘卖出任务，请勿重复启动');
  const job={id,config:c.config,bindings:c.rows.map(({account,address})=>({account,address})),status:'ARMED',mode:c.mode,createdAt:this.now(),expiresAt:this.now()+86400000,
   preflight:c.preflight,authorization:'用户在本地看板点击启动开盘卖出：'+JSON.stringify(c.config)+'；检测到支持的外盘流动性后按实时持仓卖出一次，必要时仅授权本次数量。',
   rows:c.rows.map(r=>({account:r.account,status:'WAITING',attempts:0})),message:c.snapshot.open?'已检测到流动性，正在检查可卖出路线':'等待链上加池开盘'};
  this.jobs.set(id,job);this.persist();this.schedule(job,0);this.scheduleFollow(job);return job;
 }
 schedule(job,ms=this.pollMs){if(!this.autoSchedule||this.closed||!ACTIVE.has(job.status)||this.timers.has(job.id))return;
  const t=setTimeout(()=>{this.timers.delete(job.id);const start=this.now();this.tick(job.id).catch(e=>{job.message=e.message;this.persist();}).finally(()=>this.schedule(job,Math.max(25,this.pollMs-(this.now()-start))));},ms);t.unref?.();this.timers.set(job.id,t);
 }
 stop(id){const j=this.jobs.get(id);if(!j)throw Error('没有该开盘任务');j.cancelRequested=true;for(const r of j.rows)if(WATCHING.has(r.status))r.status='CANCELLED';j.status='CANCELLED';j.message='已停止监测；已经提交的原单仍需核对，无法撤回。';clearTimeout(this.timers.get(id));this.timers.delete(id);this.persist();return j;}
 close(){this.closed=true;for(const t of [...this.timers.values(),...this.followTimers.values()])clearTimeout(t);this.timers.clear();this.followTimers.clear();}
 scheduleFollow(j){if(!this.autoSchedule||this.closed||this.followTimers.has(j.id)||!ACTIVE.has(j.status)&&!j.rows.some(r=>r.status==='TRACKING'))return;
  const timer=setTimeout(()=>{this.followTimers.delete(j.id);this.followPending(j).catch(e=>{j.followError=e.message;}).finally(()=>this.scheduleFollow(j));},500);timer.unref?.();this.followTimers.set(j.id,timer);
 }
 async followPending(j){if(this.closed||this.followBusy.has(j.id)||!j.rows.some(r=>r.status==='TRACKING'&&!this.rowBusy.has(j.id+':'+r.account)&&this.now()-(r.lastFollowAt||0)>=500))return;this.followBusy.add(j.id);try{
   await Promise.all(j.rows.filter(r=>r.status==='TRACKING'&&!this.rowBusy.has(j.id+':'+r.account)&&this.now()-(r.lastFollowAt||0)>=500).map(async r=>{
    r.lastFollowAt=this.now();try{let o=await this.engine.follow(r.orderId);
     // Continue only the same order's confirmed approval, never a second sale.
     if(o.status==='READY_TO_CONTINUE'&&!j.cancelRequested&&!this.closed&&ACTIVE.has(j.status)&&this.now()<=j.expiresAt)o=await this.engine.execute(o.id,{authorization:j.authorization,acknowledgeReview:false,swapReceiptWaitMs:0,continueAllowed:()=>!j.cancelRequested&&!this.closed&&ACTIVE.has(j.status)&&this.now()<=j.expiresAt});
     this.result(r,o);
     if(o.status==='READY_TO_CONTINUE'&&(j.cancelRequested||this.closed||!ACTIVE.has(j.status)||this.now()>j.expiresAt)){
      r.status='REVIEW';r.error={message:'授权已确认，监测已停止、暂停或到期；卖出未提交，请核对原单'};
     }
    }catch(e){r.error=publicError(e);}
   }));
   this.persist();
  }finally{this.followBusy.delete(j.id);}
 }
 warm(j){if(!this.preparation||this.warmBusy.has(j.id)||this.now()-(j.preflight?.at||0)<5000)return;
  this.warmBusy.add(j.id);void this.preparation.warm(j.config).then(p=>{
   if(j.cancelRequested||this.closed||!ACTIVE.has(j.status))return;
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
    if(!s.open){this.warm(j);j.message=s.partial?'部分池子查询失败，继续监测':'等待链上加池开盘';return j;}
    j.detectedAt??=this.now();j.detectedBlock??=s.block;j.status='FIRING';j.message='检测到流动性，按当前持仓独立准备各钱包';this.persist();
    await Promise.all(waiting.map(r=>this.fire(j,r,s)));
   }
   if(!j.cancelRequested&&ACTIVE.has(j.status)){j.status=j.rows.some(r=>WATCHING.has(r.status))?'ARMED':j.rows.some(r=>r.status==='TRACKING')?'TRACKING':'COMPLETED';j.message=j.status==='COMPLETED'?'本次开盘任务已结束，请查看各钱包结果':j.status==='TRACKING'?'仅跟踪已提交原单':'池子已出现，等待可执行的卖出预览';}
   this.persist();return j;
  }finally{this.running.delete(id);}
 }
 async fire(j,r,snapshot){
  if(j.cancelRequested||this.closed||this.now()<(r.retryAt||0))return;
  if(r.attempts>=20){r.status='BLOCKED';r.error={message:'开盘后 20 次预览仍未通过，已停止；没有自动提交失败交易'};return;}
  const key=j.id+':'+r.account;this.rowBusy.add(key);
  r.attempts++;r.status='PREPARING';r.orderId='opening-'+j.id+'-a'+r.account+'-p'+r.attempts;this.persist();
  try{
   const intent={account:r.account,side:'sell',asset:j.config.asset,percent:j.config.percent,slippageBps:j.config.slippageBps,slippageMode:'fixed',currency:j.config.currency,openingOnly:true};
   let o=await this.engine.prepare(intent,r.orderId,{openingSnapshot:snapshot});
   if(j.cancelRequested||this.closed||!ACTIVE.has(j.status)||this.now()>j.expiresAt){r.status='CANCELLED';return;}
   if(o.status==='BLOCKED'&&!o.steps?.length){r.status='WAITING';r.retryAt=this.now()+1000;r.error=o.error;return;}
   if(o.status!=='PREPARED'||o.review?.length){this.result(r,o);return;}
   // Durable commit marker BEFORE dispatch. Neither exceptions nor restarts
   // return this wallet to the preflight retry loop after this point.
   r.status='TRACKING';r.commitStartedAt=this.now();r.detectToPrepareMs=this.now()-j.detectedAt;this.persist();
   o=await this.engine.execute(o.id,{authorization:j.authorization,acknowledgeReview:false,swapReceiptWaitMs:0,continueAllowed:()=>!j.cancelRequested&&!this.closed&&ACTIVE.has(j.status)&&this.now()<=j.expiresAt});this.result(r,o);
  }catch(e){r.error=publicError(e);r.status=r.commitStartedAt?'REVIEW':'BLOCKED';}finally{this.rowBusy.delete(key);}
 }
 result(r,o){r.orderStatus=o.status;r.error=o.error;r.txHash=o.txHash||o.steps?.at(-1)?.txHash;r.chainOrderId=o.orderId;r.timing=o.timing;
  r.status=['PENDING','READY_TO_CONTINUE'].includes(o.status)?'TRACKING':['PREPARED','SUBMISSION_UNKNOWN','SUBMITTING','RECEIPT_REVIEW'].includes(o.status)?'REVIEW':o.status;
 }
}
