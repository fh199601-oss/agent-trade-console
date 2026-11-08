import path from 'node:path';
import {bindings,hash,load,save,validateIntent,publicError} from './common.mjs';
import {independentOrder} from '../public/trade-workflow.mjs';
// Shared message ID fixes the child order IDs across retries and bot restarts.
export class Batches{
 constructor(engine){this.engine=engine;this.running=new Set();}
 async run(request){
  const {id,intent,execute=false,authorization,acknowledgeReview=false}=request;
  if(typeof id!=='string'||!/^[a-zA-Z0-9_.:-]{1,140}$/.test(id))throw Error('批次须使用稳定消息 ID（最多 140 字符）');
  const accounts=request.accounts??bindings().map(w=>w.account);
  if(!Array.isArray(accounts)||!accounts.length||new Set(accounts).size!==accounts.length)throw Error('钱包列表为空或有重复');
  const sorted=[...accounts].sort((a,b)=>a-b);for(const account of sorted)validateIntent({...intent,account});
  const fingerprint=hash({intent,accounts:sorted}),file=path.join(this.engine.data,'batches',hash(id)+'.json'),old=load(file);
  if(old&&old.fingerprint!==fingerprint)throw Error('同一批次 ID 不可更换参数或钱包');
  if(this.running.has(id))throw Error('本批次正在处理，请查询原单');
  this.running.add(id);const row=old||{id,fingerprint,accounts:sorted,intent,createdAt:Date.now(),orders:[]};
  try{
   row.orders=[];delete row.stoppedAt;
   // Read-only preparation is isolated per wallet. A failed first wallet must
   // not hide another wallet's verified independent platform. Generic mints
   // retain their inviter ordering; every actual run still validates its plan.
   const prepared=intent.side==='mint'&&execute&&this.engine.live?await Promise.all(sorted.map(async account=>{try{return await this.engine.prepare({...intent,account},`${id}-a${account}`);}catch{return null;}})):[];
   const independent=prepared.some(o=>o&&(independentOrder(o)||['corla','binancians'].includes(o.project?.platform)))&&prepared.every(o=>!o?.plan||independentOrder(o));
   if(intent.side!=='mint'||!execute||!this.engine.live||independent){
    row.orders=await Promise.all(sorted.map(async account=>{try{return await this.engine.run({...intent,account},`${id}-a${account}`,{execute,authorization,acknowledgeReview});}catch(e){return {id:`${id}-a${account}`,intent:{...intent,account},status:'BLOCKED',error:publicError(e)};}}));
    const active=row.orders.filter(o=>o.status!=='SKIPPED');
    const available=intent.side==='mint'?active.filter(o=>o.error?.code!=='NO_QUOTA'):active;
    row.status=!active.length?'SKIPPED':!available.length?'NO_QUOTA':available.every(o=>['CONFIRMED','SIMULATED'].includes(o.status))?(this.engine.live?'CONFIRMED':'SIMULATED'):available.every(o=>o.status==='PREPARED')?'PREPARED':'INCOMPLETE';
    row.updatedAt=Date.now();save(file,row);return row;
   }
   for(const account of sorted){
    const result=await this.engine.run({...intent,account},`${id}-a${account}`,{execute,authorization,acknowledgeReview});
    row.orders.push(result);row.updatedAt=Date.now();save(file,row);
    // Inviter must have confirmed before subsequent paid referrals. No speculative parallel submit.
    if(execute&&this.engine.live&&!['CONFIRMED','SIMULATED'].includes(result.status)&&result.error?.code!=='NO_QUOTA'){row.stoppedAt=account;break;}
   }
   const complete=row.orders.length===sorted.length,available=row.orders.filter(o=>o.error?.code!=='NO_QUOTA');
   row.status=!available.length&&complete?'NO_QUOTA':complete&&available.every(o=>['CONFIRMED','SIMULATED'].includes(o.status))?(this.engine.live?'CONFIRMED':'SIMULATED'):complete&&available.every(o=>o.status==='PREPARED')?'PREPARED':'INCOMPLETE';
   save(file,row);return row;
  }finally{this.running.delete(id);}
 }
}
