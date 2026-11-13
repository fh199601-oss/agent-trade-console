import {parallelSellProof} from './parallel-sell.mjs';
// Only conflicting sells share a lane. Metadata, approvals and unrelated pools
// remain parallel. Uncertain originals are followed, never signed again.
export function sellLane(plan,step){
 if(step?.kind!=='sell')return null;
 const venue=plan.opening?.pool||plan.state?.pair&&plan.state.migrated&&plan.state.pair||plan.state?.pad||plan.state?.spender;
 return venue&&plan.token?`${String(venue).toLowerCase()}:${plan.token.toLowerCase()}`:null;
}
export class SellCoordinator{
 constructor({idleTimeoutMs=15000,maxWaitMs=60000}={}){this.tails=new Map();this.waiters=new Map();this.plans=new Map();this.parallel=new Map();this.idleTimeoutMs=idleTimeoutMs;this.maxWaitMs=maxWaitMs;}
 tryParallel(key,record,originals=[]){
  if(!key||this.tails.has(key))return null; // A serial owner/waiter has priority.
  const peers=this.parallel.get(key)||new Set(),records=new Map(originals.map(r=>[r.id,r]));
  for(const peer of peers)records.set(peer.record.id,peer.record);
  if(records.has(record.id))return null;
  records.set(record.id,record);const proof=parallelSellProof([...records.values()]);if(!proof)return null;
  let finish;const done=new Promise(r=>{finish=r;}),ticket={record,done};peers.add(ticket);this.parallel.set(key,peers);
  let released=false;return {waited:false,proof,release:()=>{if(released)return;released=true;peers.delete(ticket);if(!peers.size)this.parallel.delete(key);finish();for(const notify of this.waiters.get(key)||[])notify();}};
 }
 preceding(key){return [...(this.plans.get(key)||[])].map(t=>t.plan).filter(Boolean);}
 async enter(key,plan){
  if(!key)return {waited:false,release:()=>{}};
  const previous=this.tails.get(key),parallel=[...(this.parallel.get(key)||[])].map(t=>t.done);
  const prior=previous||parallel.length?Promise.all([previous,...parallel]):null;let release;const done=new Promise(r=>{release=r;});
  const tickets=this.plans.get(key)||new Set(),ticket={plan};tickets.add(ticket);this.plans.set(key,tickets);
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
   waiters.add(progress);progress();totalTimer=setTimeout(expired,this.maxWaitMs);
  })]);}
  catch(e){remove();release();tail.then(cleanup);throw e;}finally{clearTimeout(idleTimer);clearTimeout(totalTimer);waiters.delete(progress);}
  let released=false;
  return {waited:!!prior,release:()=>{if(released)return;released=true;remove();release();for(const notify of waiters)notify();cleanup();}};
 }
}
