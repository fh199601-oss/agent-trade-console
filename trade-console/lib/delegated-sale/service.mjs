import {pinnedBscSale} from './bsc.mjs';
import {describeError} from '../../public/error-message.mjs';
import {getAddress,id as hashText,parseUnits} from 'ethers';
const same=(a,b)=>a?.toLowerCase()===b?.toLowerCase();
const states={READY:'已准备',WAIT_CLAIM:'等待领取到账',WAIT_AUTH:'等待授权',FAILED:'准备失败',PAUSED:'已暂停',PENDING:'原单待确认',SOLD:'已卖出',RETRY:'待重试',EXPIRED:'已过期',REVIEW:'需核对'};
export function validateFastSettings(input,venue){
 if(!input||Object.keys(input).some(k=>!['trigger','executor','source','expiryHours','minOut','percent','minAmount','quote','quoteDecimals'].includes(k)))throw Error('极速卖出设置无效');
 if(!['opening','after-claim'].includes(input.source))throw Error('请选择开盘卖出或领取后卖出');
 let trigger,executor;try{trigger=getAddress(input.trigger);executor=input.executor?getAddress(input.executor):null;}catch{throw Error('请输入完整有效的触发地址和执行合约地址');}
 if(/^0x0{40}$/i.test(trigger)||executor&&/^0x0{40}$/i.test(executor))throw Error('触发者和执行合约不能是零地址');
 const expiryHours=Number(input.expiryHours??48),percent=String(input.percent??100);
 if(![1,6,12,24,48].includes(expiryHours)||!/^([1-9]\d?|100)$/.test(percent))throw Error('比例或有效期无效，卖出比例请填写 1–100 的整数');
 const config={trigger,executor,source:input.source,expiryHours,percent};
 let minimum=input.minOut??'1';
 if(input.minAmount!==undefined||input.quote!==undefined||input.quoteDecimals!==undefined){
  const {minAmount,quoteDecimals}=input;
  if(typeof minAmount!=='string'||minAmount.length>78||!/^\d+(?:\.\d+)?$/.test(minAmount)||!Number.isInteger(quoteDecimals)||quoteDecimals<0||quoteDecimals>36||(minAmount.split('.')[1]?.length||0)>quoteDecimals)throw Error('最低到账金额或小数位数无效');
  const quote=getAddress(input.quote);
  if(venue&&(!same(venue.quote,quote)||venue.quoteDecimals!==quoteDecimals))throw Error('主池计价币已变化，请重新加载并填写最低到账');
  minimum=parseUnits(minAmount,quoteDecimals).toString();
  if(input.minOut!==undefined&&String(input.minOut)!==minimum)throw Error('最低到账与计价币金额不一致');
  Object.assign(config,{minAmount,quote,quoteDecimals});
 }
 if(!/^[1-9]\d{0,38}$/.test(String(minimum))||BigInt(minimum)>=(1n<<128n))throw Error('最低到账无效，金额必须大于零且在合约范围内');
 return {...config,minOut:String(minimum)};
}
export class DisabledFastSale {
 status(){return {mode:'SIMULATION',enabled:false,reason:'代卖合约尚未部署；此版本仅开放模拟，不会真实授权或交易',expiryHours:48,minOut:'1',jobs:[]};}
 async authorize(){throw Error(this.status().reason);}
 async control(){throw Error(this.status().reason);}
 async notifyOpening(){return null;}
 owns(){return false;}
 async onClaimOrder(){return false;}
 async afterClaim(){return null;}
}

// Only an injected LOCAL EVM adapter may register holder plans in this release.
// No dependency on the production wallet bridge or session files.
export class FastSaleService {
 constructor({adapter,trigger,store,now=Date.now}) {
  if(!(adapter?.chainId===31337&&adapter.simulationOnly===true)&&!(adapter?.chainId===56&&pinnedBscSale(adapter.executor,adapter.executorHash,adapter.payer)))throw Error('极速卖出当前仅支持本地模拟适配器');
  this.adapter=adapter;this.trigger=trigger;this.store=store;this.now=now;this.busy=new Map();this.firing=new Set();this.preparing=new Map();
  this.jobs=store.load();
  for(const j of this.jobs){
   for(const b of j.batches.filter(b=>b.status==='PREPARING')){
    b.status='INTERRUPTED';
    for(const r of j.rows.filter(r=>r.batch===b.id))delete r.batch;
   }
  }
  for(const j of this.jobs)if(!['DELETED','PAUSED','COMPLETED','AUTHORIZED','AUTHORIZING','REGISTERING','REVIEW'].includes(j.status)){j.pausedFrom=j.status;j.status='PAUSED';j.message='服务重启已暂停；只恢复原计划，沿用原有效期';}
  this.persist();
 }
 visibleJobs(){return structuredClone(this.jobs.filter(j=>!j.deletedAt));}
 persist(){this.store.save(this.jobs);}
 status(){return {mode:'SIMULATION',enabled:true,expiryHours:48,minOut:'1',trigger:this.trigger.wallet?.address,jobs:this.visibleJobs()};}
 authorize(input){
  if(this.busy.has(input.id))return this.busy.get(input.id);
  const p=this.enroll(input);this.busy.set(input.id,p);return p.finally(()=>this.busy.delete(input.id));
 }
 async enroll({id,asset,wallets,settings}){
  if(typeof id!=='string'||!/^[a-zA-Z0-9_.:-]{1,100}$/.test(id)||!Array.isArray(wallets)||!wallets.length||wallets.length>100||new Set(wallets.map(w=>w.address?.toLowerCase())).size!==wallets.length)throw Error('请选择 1–100 个不重复的钱包');
  try{asset=getAddress(asset);}catch{throw Error('代币 CA 无效');}settings=validateFastSettings(settings);
  if(!same(settings.trigger,this.trigger.wallet?.address)||!same(settings.executor,this.adapter.executor))throw Error('触发地址或执行合约与已核验配置不一致');
  wallets=wallets.map(w=>({account:w.account,address:getAddress(w.address)}));
  const fingerprint=hashText(JSON.stringify({asset,wallets,settings}));
  const existing=this.jobs.find(j=>j.id===id);
  if(existing){if(existing.deletedAt)throw Error('该任务已删除');if(existing.fingerprint!==fingerprint)throw Error('原授权批次参数已变化，不能覆盖原单');return structuredClone(existing);}
  // Primary provenance is resolved server-side, never accepted as browser calldata.
  const venue=await this.adapter.verifiedVenue(asset);
  if(!venue?.verified||!venue.pair||!same(venue.token,asset))throw Error('未核验主池，不能授权其他池子');
  const j={id,asset,settings,venue,fingerprint,status:'PREPARING',createdAt:this.now(),batches:[],rows:wallets.map(w=>({...w,status:'WAIT_AUTH',attempts:0}))};
  this.jobs.push(j);this.persist();
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(16,wallets.length)},async()=>{
   while(cursor<j.rows.length){if(j.deletedAt||j.status==='PAUSED')return;const r=j.rows[cursor++];
    try {
     if(this.jobs.some(other=>other!==j&&!other.deletedAt&&same(other.asset,asset)&&other.rows.some(x=>same(x.address,r.address)&&!['FAILED','SOLD','EXPIRED'].includes(x.status))))throw Error('此钱包已有该代币的代卖计划');
     const plan=await this.adapter.authorize({asset,owner:r.address,source:settings.source,trigger:settings.trigger,minOut:'1',expiryHours:48,key:id+':'+r.account,venue});
     if(!/^0x[0-9a-f]{64}$/i.test(plan.id)||!same(plan.owner,r.address)||!same(plan.token,asset)||!same(plan.trigger,settings.trigger)||BigInt(plan.cap)<=0n||plan.minOut!=='1'||plan.deadline<=Math.floor(this.now()/1000)||plan.deadline>Math.floor(this.now()/1000)+172801)throw Error('授权计划不符合钱包、数量、有效期限制');
     Object.assign(r,{plan,status:settings.source==='opening'||r.claimHash?'READY':'WAIT_CLAIM'});
    }catch(e){r.status='FAILED';r.message=describeError(e);}
    this.persist();
   }
  }));
  if(j.deletedAt||j.status==='PAUSED')return structuredClone(j);
  j.status=j.rows.some(r=>r.plan)?'ARMED':'REVIEW';
  await this.prepareReady(j);this.persist();return structuredClone(j);
 }
 prepareReady(j){
  // A claim receipt and the opening monitor may wake concurrently.
  // Queue another scan so newly-ready holders are included exactly once.
  const previous=this.preparing.get(j.id)||Promise.resolve();
  const next=previous.catch(()=>{}).then(()=>this.prepareRows(j));this.preparing.set(j.id,next);
  return next.finally(()=>{if(this.preparing.get(j.id)===next)this.preparing.delete(j.id);});
 }
 async prepareRows(j){
  const rows=j.rows.filter(r=>r.status==='READY'&&!r.batch);
  // 64 + 36 for 100 wallets. Each item has its own EVM revert/gas boundary.
  const size=this.adapter.batchSize||64;
  for(let offset=0;offset<rows.length;offset+=size){
   if(j.deletedAt||j.status==='PAUSED')return;
   const group=rows.slice(offset,offset+size),id=j.id+':batch:'+j.batches.length;
   const batch={id,ids:group.map(r=>r.plan.id),status:'PREPARING'};
   j.batches.push(batch);for(const r of group)r.batch=id;this.persist();
   try{const signed=await this.trigger.prepare(id,batch.ids);batch.status=signed.status;batch.hash=signed.hash;}
   catch(e){batch.status='REVIEW';batch.message=describeError(e);for(const r of group){r.status='REVIEW';r.message=describeError(e);}}
   this.persist();
  }
 }
 owns(asset,owner){return this.jobs.some(j=>!j.deletedAt&&same(j.asset,asset)&&j.rows.some(r=>same(r.address,owner)&&r.plan&&this.now()/1000<=r.plan.deadline&&!['FAILED','SOLD','EXPIRED'].includes(r.status)));}
 async onClaimOrder(o){
  const owner=o?.plan?.wallet,token=o?.plan?.outputToken;
  if(!this.jobs.some(j=>same(j.asset,token)&&['PREPARING','REGISTERING','ARMED','PAUSED'].includes(j.status)&&j.settings.source==='after-claim'&&j.rows.some(r=>same(r.address,owner)&&['WAIT_AUTH','REGISTRATION_PENDING','AUTHORIZED','WAIT_CLAIM'].includes(r.status))))return false;
  if(o.status!=='CONFIRMED'||o.plan.route!=='corla:claim')throw Error('领取原单未确认');
  const step=o.steps?.findLast(s=>s.status==='CONFIRMED'&&BigInt(s.received||0)>0n&&s.txHash);
  if(!step)throw Error('领取原单缺少实际到账凭据');
  await this.afterClaim({hash:step.txHash,owner,token});return true;
 }
 async notifyOpening(asset,snapshot){
  const jobs=this.jobs.filter(j=>same(j.asset,asset)&&j.status==='ARMED');
  for(const j of jobs){
   if(this.adapter.taxAware&&same(snapshot?.token,asset)&&snapshot.pair&&!same(snapshot.pair,j.venue.pair)&&(snapshot.changed||snapshot.open)){
    j.status='PAUSED';j.pausedFrom='ARMED';j.message='开盘主池与登记计划不同。请核对新主池后删除旧任务，并重新登记。';this.persist();continue;
   }
   if(!snapshot?.open||!this.adapter.matchesPrimary(j.venue,snapshot))continue;
   await this.fire(j.id);
  }
 }
 async afterClaim(claim){
  // A UI field, a submitted hash or a simulation preview is not a settled claim.
  if(!await this.adapter.verifyClaim(claim))throw Error('领取回执或实际到账尚未核验，未触发代卖');
  for(const j of this.jobs.filter(j=>j.settings.source==='after-claim'&&['ARMED','PAUSED','PREPARING','REGISTERING'].includes(j.status)&&same(j.asset,claim.token))){
   const r=j.rows.find(r=>same(r.address,claim.owner)&&['WAIT_CLAIM','WAIT_AUTH','AUTHORIZED','REGISTRATION_PENDING'].includes(r.status));if(!r)continue;
   r.claimHash=claim.hash;if(r.plan)r.status='READY';this.persist();
   if(j.status!=='ARMED')continue;
   await this.prepareReady(j);
   // Contract still enforces the exact primary. No aggregator fallback.
   const s=await this.adapter.opening(j.asset);if(this.adapter.matchesPrimary(j.venue,s))await this.fire(j.id);
  }
 }
 async fire(id){
  const j=this.jobs.find(j=>j.id===id);if(!j||j.status!=='ARMED'||this.firing.has(id))return;
  this.firing.add(id);
  try{
   // No quote/holder reads on the trigger path. Every plan settles current
   // balances/reserves atomically on chain, with the holder's immutable minimum.
   const batches=j.batches.filter(b=>b.status==='PREPARED');
   for(const b of batches)for(const r of j.rows.filter(r=>r.batch===b.id)){r.status='PENDING';r.attempts++;}
   this.persist();
   await Promise.all(batches.map(async b=>{try{Object.assign(b,await this.trigger.broadcast(b.id));}catch(e){b.status=e.noDispatch?'PREPARED':'UNKNOWN';b.message=e.noDispatch?'等待触发端后台预热；尚未提交':'触发提交需核对原单';if(e.noDispatch)for(const r of j.rows.filter(r=>r.batch===b.id)){r.status='READY';r.attempts--;}}this.persist();}));
  }finally{this.firing.delete(id);}
 }
 async follow(id){
  const j=this.jobs.find(j=>j.id===id);if(!j)throw Error('没有该极速卖出任务');
  await Promise.all(j.batches.filter(b=>['PENDING','UNKNOWN','SUBMITTING'].includes(b.status)).map(async b=>{
   const result=this.trigger?await this.trigger.follow(b.id):this.adapter.followHash?await this.adapter.followHash(b):null;if(!result)return;
   if(!result.receipt){b.status=result.status;return;}
   const outcomes=await this.adapter.outcomes(result.receipt,b.ids,j.rows,b.hash||result.hash);b.status=result.status;
   for(const r of j.rows.filter(r=>r.batch===b.id)){
    const o=outcomes.get(r.plan.id);if(!o){r.status='REVIEW';r.message='原回执缺少钱包结果，未重新提交';continue;}
    r.status=o.sold?'SOLD':o.failed?'FAILED':o.retryable&&r.attempts<3?'RETRY':'REVIEW';r.message=o.message;
    if(o.sold&&o.fill)r.fill=o.fill;
    if(o.reason==='HIGH_TRANSFER_FEE'&&this.adapter.taxAware&&this.adapter.simulateTaxBatch&&r.attempts<3&&result.status==='CONFIRMED'){
     r.status='WAIT_TAX';r.message='本次高税卖出已回滚，等待主池税后到账模拟通过';
    }
    if(o.reason)r.reason=o.reason;else delete r.reason;
    r.receipt=result.hash;
   }
  }));
  for(const r of j.rows)if(r.plan&&r.status!=='SOLD'&&this.now()/1000>r.plan.deadline){r.status='EXPIRED';r.message='计划已到期';}
  if(!j.deletedAt&&j.status!=='PAUSED'&&j.rows.every(r=>['SOLD','FAILED','EXPIRED','REVIEW','SKIPPED'].includes(r.status)))j.status=j.rows.some(r=>r.status==='REVIEW')?'REVIEW':'COMPLETED';
  this.persist();return structuredClone(j);
 }
 async recheckTax(j){
  const rows=j.rows.filter(r=>r.status==='WAIT_TAX'&&this.now()/1000<=r.plan.deadline);
  if(j.status!=='ARMED'||!this.trigger||!rows.length||this.now()<(j.nextTaxCheck||0))return;
  j.nextTaxCheck=this.now()+3000;
  const size=this.adapter.batchSize||20;
  const groups=[];
  for(let i=0;i<rows.length;i+=size)groups.push(rows.slice(i,i+size));
  await Promise.all(groups.map(async group=>{
   try{
    const eligible=await this.adapter.simulateTaxBatch(j.settings.trigger,group);
    if(j.deletedAt||j.status!=='ARMED')return;
    for(const row of eligible){
     if(row.status!=='WAIT_TAX'||this.now()/1000>row.plan.deadline)continue;
     row.status='READY';row.message='税后到账模拟通过';delete row.batch;
    }
   }catch{
    for(const row of group)if(row.status==='WAIT_TAX')row.message='等待节点恢复税后到账模拟；有效期内继续检查';
   }
  }));
  if(j.deletedAt||j.status!=='ARMED'||!rows.some(r=>r.status==='READY'))return;
  await this.prepareReady(j);this.persist();
 }
 async retry(id){
  const j=await this.follow(id),original=this.jobs.find(x=>x.id===id);
  if(j.status!=='ARMED')throw Error('请先恢复原任务');
  for(const r of original.rows.filter(r=>r.status==='RETRY')){r.status='READY';delete r.batch;}
  await this.prepareReady(original);const s=await this.adapter.opening(original.asset);
  if(this.adapter.matchesPrimary(original.venue,s))await this.fire(id);
  return this.follow(id);
 }
 async control(id,action){
  const j=this.jobs.find(x=>x.id===id);if(!j||!['pause','resume','delete'].includes(action))throw Error('任务控制参数无效');
  if(action==='delete'){
   if(!j.deletedAt){j.deletedAt=this.now();j.status='DELETED';this.persist();}
   return {id,deleted:true};
  }
  if(j.deletedAt)throw Error('该任务已删除');
  if(action==='pause'){
   if(j.status==='PAUSED')return structuredClone(j);
   if(!['ARMED','REGISTERING','AUTHORIZED','AUTHORIZING'].includes(j.status))throw Error('该任务已结束');
   j.pausedFrom=j.status;j.status='PAUSED';j.message='已暂停，已提交的原单继续核对';
  }else{
   if(j.status!=='PAUSED')throw Error('只能恢复已暂停的任务');
   const phase=j.pausedFrom||'ARMED';
   if(phase==='ARMED'&&!j.rows.some(r=>r.status==='REGISTRATION_PENDING')&&j.rows.every(r=>!r.plan||this.now()/1000>r.plan.deadline))throw Error('授权已过期，需要重新授权');
   j.status=phase;j.message='';delete j.pausedFrom;
   if(phase==='ARMED'){this.persist();await this.prepareReady(j);}
  }
  this.persist();return structuredClone(j);
 }
}
export const fastStateLabel=s=>states[s]||s;
