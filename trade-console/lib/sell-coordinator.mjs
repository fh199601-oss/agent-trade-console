// Only conflicting sells share a lane. Metadata, approvals and unrelated pools
// remain parallel. Uncertain originals are followed, never signed again.
export function sellLane(plan,step){
 if(step?.kind!=='sell')return null;
 const venue=plan.opening?.pool||plan.state?.pair&&plan.state.migrated&&plan.state.pair||plan.state?.pad||plan.state?.spender;
 return venue&&plan.token?`${String(venue).toLowerCase()}:${plan.token.toLowerCase()}`:null;
}
export class SellCoordinator{
 constructor({idleTimeoutMs=15000,maxWaitMs=60000}={}){this.tails=new Map();this.waiters=new Map();this.idleTimeoutMs=idleTimeoutMs;this.maxWaitMs=maxWaitMs;}
 async enter(key){
  if(!key)return {waited:false,release:()=>{}};
  const prior=this.tails.get(key);let release;const done=new Promise(r=>{release=r;});
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
  catch(e){release();tail.then(cleanup);throw e;}finally{clearTimeout(idleTimer);clearTimeout(totalTimer);waiters.delete(progress);}
  let released=false;
  return {waited:!!prior,release:()=>{if(released)return;released=true;release();for(const notify of waiters)notify();cleanup();}};
 }
}
