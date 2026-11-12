// Only conflicting sells share a lane. Metadata, approvals and unrelated pools
// remain parallel. Uncertain originals are followed, never signed again.
export function sellLane(plan,step){
 if(step?.kind!=='sell')return null;
 const venue=plan.opening?.pool||plan.state?.pair&&plan.state.migrated&&plan.state.pair||plan.state?.pad||plan.state?.spender;
 return venue&&plan.token?`${String(venue).toLowerCase()}:${plan.token.toLowerCase()}`:null;
}
export class SellCoordinator{
 constructor(){this.tails=new Map();}
 async enter(key){
  if(!key)return {waited:false,release:()=>{}};
  const prior=this.tails.get(key);let release;const done=new Promise(r=>{release=r;});
  const tail=(prior||Promise.resolve()).then(()=>done);this.tails.set(key,tail);
  let timer;
  try{if(prior)await Promise.race([prior,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('同一池子前一笔卖出仍在处理，本次尚未提交；原单确认后可重试'),{code:'SELL_POOL_BUSY'})),15000);})]);}
  catch(e){release();tail.finally(()=>{if(this.tails.get(key)===tail)this.tails.delete(key);});throw e;}finally{clearTimeout(timer);}
  return {waited:!!prior,release:()=>{release();if(this.tails.get(key)===tail)this.tails.delete(key);}};
 }
}
