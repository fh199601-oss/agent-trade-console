import {parallelSellProof,pipelinePreparationEligible} from './parallel-sell.mjs';
// Only conflicting sells share a lane. Metadata, approvals and unrelated pools
// remain parallel. Uncertain originals are followed, never signed again.
export function sellLane(plan,step){
 if(step?.kind!=='sell')return null;
 const venue=plan.opening?.pool||plan.state?.pair&&plan.state.migrated&&plan.state.pair||plan.state?.pad||plan.state?.spender;
 return venue&&plan.token?`${String(venue).toLowerCase()}:${plan.token.toLowerCase()}`:null;
}
export class SellCoordinator{
 constructor({idleTimeoutMs=15000,maxWaitMs=null}={}){this.tails=new Map();this.waiters=new Map();this.plans=new Map();this.parallel=new Map();this.proofCache=new Map();this.preparations=new Map();this.idleTimeoutMs=idleTimeoutMs;this.maxWaitMs=maxWaitMs;}
 prepareParallel(key,plan){
  // Shallow-pool unsigned refreshes use a small sliding window. Rebuilding
  // 100 now-stale wallet previews on every wave wastes both RPC and wallet
  // capacity. This only schedules reads; actual admission remains below.
  const group=this.preparations.get(key)||{active:0,queue:[],limit:8,maxInput:0n,minBps:9900,pipelineEligible:true};this.preparations.set(key,group);
  // Retain the strictest starting exposure while this queue is occupied.
  // An extreme pool gains input reserves as holders sell and its price falls;
  // that alone must not suddenly enable faster preparation for the same batch.
  group.pipelineEligible=group.pipelineEligible&&pipelinePreparationEligible(plan);
  try{const amount=BigInt(plan?.amountIn);if(amount>group.maxInput)group.maxInput=amount;}catch{}
  const bps=plan?.slippage?.bps;group.minBps=Math.min(group.minBps,Number.isInteger(bps)&&bps>=0&&bps<=9900?bps:0);
  this.resizePreparation(group);
  const cleanup=()=>{if(!group.active&&!group.queue.length)this.preparations.delete(key);};
  const grant=waited=>{group.active++;let released=false;return {waited,pipelineEligible:()=>group.pipelineEligible,release:()=>{
   if(released)return;released=true;group.active--;
   this.drainPreparation(group);
   for(const waiter of group.queue)waiter.progress();cleanup();
  }};};
  if(group.active<group.limit&&!group.queue.length)return Promise.resolve(grant(false));
  return new Promise((resolve,reject)=>{
   let idle,total;const clear=()=>{clearTimeout(idle);clearTimeout(total);};
   const waiter={start:()=>{clear();resolve(grant(true));},progress:()=>{clearTimeout(idle);idle=setTimeout(expire,this.idleTimeoutMs);}};
   const expire=()=>{const at=group.queue.indexOf(waiter);if(at<0)return;group.queue.splice(at,1);clear();cleanup();reject(Object.assign(Error('同一池子卖出仍在准备，本钱包尚未提交；可稍后重试'),{code:'SELL_POOL_BUSY'}));};
   group.queue.push(waiter);waiter.progress();total=setTimeout(expire,this.maxWaitMs??Math.max(60000,Math.min(200,group.queue.length)*this.idleTimeoutMs));this.drainPreparation(group);
  });
 }
 resizePreparation(group){
  // Expansion is only scheduling: actual submission still needs the complete
  // worst-order proof. Use the largest input and smallest ACTUAL slippage
  // across the waiting group, never an auto-slippage cap. More restrictive
  // minima need a smaller unsigned window to avoid stale-preview reverts.
  const age=Date.now()-group.reserveAt;
  const reserveFactor=group.minBps===9900?2n:4n;
  group.limit=group.reserveIn&&group.maxInput>0n&&age>=0&&age<=15000?Math.max(8,Math.min(64,Number(group.reserveIn/(group.maxInput*reserveFactor)))):8;
 }
 drainPreparation(group){this.resizePreparation(group);while(group.active<group.limit&&group.queue.length)group.queue.shift().start();}
 observePreparation(key,record){
  const group=this.preparations.get(key);if(!group)return;
  try{
   const p=record.plan,pool=p.opening,block=BigInt(pool.block),reserve=BigInt(pool.token0.toLowerCase()===p.token.toLowerCase()?pool.reserve0:pool.reserve1);
   if(block<=0n||reserve<=0n||group.block!==undefined&&block<group.block)return;
   group.reserveIn=block===group.block&&group.reserveIn<reserve?group.reserveIn:reserve;group.block=block;group.reserveAt=record.at;
   this.resizePreparation(group);this.drainPreparation(group);
  }catch{} // Optional scheduling metadata must not orphan an admitted ticket.
 }
 tryParallel(key,record,originals=[]){
  if(!key||this.tails.has(key))return null; // A serial owner/waiter has priority.
  const peers=this.parallel.get(key)||new Set(),records=new Map(originals.map(r=>[r.id,r]));
  for(const peer of peers)records.set(peer.record.id,peer.record);
  if(records.has(record.id))return null;
  records.set(record.id,record);const proof=parallelSellProof([...records.values()],Date.now(),this.proofCache);if(!proof)return null;
  let finish;const done=new Promise(r=>{finish=r;}),ticket={record,done};peers.add(ticket);this.parallel.set(key,peers);
  this.observePreparation(key,record);
  let released=false;return {waited:false,proof,release:()=>{if(released)return;released=true;peers.delete(ticket);if(!peers.size)this.parallel.delete(key);finish();for(const notify of this.waiters.get(key)||[])notify();}};
 }
 preceding(key){return [...(this.plans.get(key)||[])].map(t=>t.plan).filter(Boolean);}
 waitParallelWave(key){
  // Do not turn every rejected wide-slippage joiner into a serial waiter.
  // Wait only for the current owners; the caller must then read fresh state
  // and pass admission again. Release is NOT evidence of chain confirmation.
  if(!key||this.tails.has(key))return null;
  const peers=[...(this.parallel.get(key)||[])];if(!peers.length)return null;
  let timer;
  return Promise.race([Promise.all(peers.map(t=>t.done)),new Promise((_,reject)=>{
   timer=setTimeout(()=>reject(Object.assign(Error('同一池子本轮卖出仍在处理，本钱包尚未提交；后台继续核对原单'),{code:'SELL_POOL_BUSY'})),Math.min(this.idleTimeoutMs,this.maxWaitMs??this.idleTimeoutMs));
  })]).finally(()=>clearTimeout(timer));
 }
 async enter(key,plan){
  if(!key)return {waited:false,release:()=>{}};
  const previous=this.tails.get(key),parallel=[...(this.parallel.get(key)||[])].map(t=>t.done);
  const prior=previous||parallel.length?Promise.all([previous,...parallel]):null;let release;const done=new Promise(r=>{release=r;});
  const tickets=this.plans.get(key)||new Set(),ticket={plan};tickets.add(ticket);this.plans.set(key,tickets);
  // Large, high-impact groups must re-quote in sequence. Give each preceding
  // owner its bounded inactivity budget instead of expiring wallet 100 after
  // the same fixed minute as wallet 2. Actual progress still drives the idle
  // deadline; a silent owner cannot extend this queue indefinitely.
  const totalBudget=this.maxWaitMs??Math.max(60000,Math.min(200,tickets.size+parallel.length)*this.idleTimeoutMs);
  const remove=()=>{tickets.delete(ticket);if(!tickets.size&&this.plans.get(key)===tickets)this.plans.delete(key);};
  const tail=(prior||Promise.resolve()).then(()=>done);this.tails.set(key,tail);
  const waiters=this.waiters.get(key)||new Set();this.waiters.set(key,waiters);
  const cleanup=()=>{if(this.tails.get(key)===tail){this.tails.delete(key);this.waiters.delete(key);}};
  let idleTimer,totalTimer,progress;
  // A healthy queue may take longer than one receipt. Only a real owner's
  // release renews the inactivity deadline; cancelled waiters cannot keep it alive.
  // Retain a hard total limit, and never enter past an unresolved lane owner.
  try{if(prior)await Promise.race([prior,new Promise((_,reject)=>{
   const expired=()=>reject(Object.assign(Error('同一池子前一笔卖出仍在处理，本次尚未提交；原单确认后可重试'),{code:'SELL_POOL_BUSY'}));
   progress=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(expired,this.idleTimeoutMs);};
   waiters.add(progress);progress();totalTimer=setTimeout(expired,totalBudget);
  })]);}
  catch(e){remove();release();tail.then(cleanup);throw e;}finally{clearTimeout(idleTimer);clearTimeout(totalTimer);waiters.delete(progress);}
  let released=false;
  return {waited:!!prior,release:()=>{if(released)return;released=true;remove();release();for(const notify of waiters)notify();cleanup();}};
 }
}
