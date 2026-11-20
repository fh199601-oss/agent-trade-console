import {bounded} from './trigger.mjs';
// Shared scheduler for fast-sale tasks. Does not restore or enrol legacy tasks.
// Background preparation and read failures never occupy normal wallet queues.
export class FastSaleRuntime {
 constructor(service,{pollMs=300,onError=()=>{}}={}){this.service=service;this.pollMs=pollMs;this.onError=onError;this.closed=false;this.running=false;this.assets=new Set();this.jobs=new Set();}
 async tick(){
  if(this.closed||this.running||!this.service.jobs?.length)return;
  this.running=true;
  try{
   if(this.service.reconcile){
    const pending=this.service.jobs.filter(j=>['AUTHORIZING','REGISTERING'].includes(j.status)||j.rows.some(r=>['APPROVAL_PENDING','REGISTRATION_PENDING'].includes(r.status)));
    for(const j of pending){
     if(Date.now()-(this.pollTimes?.get(j.id)||0)<1500)continue;
     (this.pollTimes??=new Map()).set(j.id,Date.now());void this.service.reconcile(j).catch(this.onError);
    }
   }
   const jobs=this.service.jobs.filter(j=>j.status==='ARMED'||j.batches.some(b=>['PENDING','UNKNOWN','SUBMITTING'].includes(b.status)));
   if(!jobs.length)return;
   if(this.service.trigger&&!this.warming&&Date.now()-(this.warmedAt||0)>5000){this.warming=true;void this.service.trigger.warm().then(()=>{this.warmedAt=Date.now();}).catch(e=>this.onError(e)).finally(()=>{this.warming=false;});}
   const work=[];
   for(const asset of new Set(jobs.filter(j=>j.status==='ARMED').map(j=>j.asset))){
    if(this.assets.has(asset))continue;this.assets.add(asset);
    const task=(async()=>{try{const s=await bounded(this.service.adapter.opening(asset),5000);await this.service.notifyOpening(asset,s);}catch(e){this.onError(e);}finally{this.assets.delete(asset);}})();work.push(task);
   }
   for(const j of jobs){
    if(this.jobs.has(j.id))continue;this.jobs.add(j.id);
    const task=(async()=>{try{
     const terminal=r=>['SOLD','FAILED','EXPIRED','REVIEW','SKIPPED'].includes(r.status);
     const due=j.rows.some(r=>r.plan&&!terminal(r)&&this.service.now()/1000>r.plan.deadline);
     if(due||j.rows.every(terminal)||j.batches.some(b=>['PENDING','UNKNOWN','SUBMITTING'].includes(b.status)))await this.service.follow(j.id);
     if(j.rows.some(r=>r.status==='WAIT_TAX'))await this.service.recheckTax(j);
     if(j.status==='ARMED'&&j.rows.some(r=>r.status==='RETRY'))await this.service.retry(j.id);
    }catch(e){this.onError(e);}finally{this.jobs.delete(j.id);}})();work.push(task);
   }
   // Do not make future ticks wait for another asset's network or receipt.
   this.running=false;
   await Promise.all(work);
  }finally{this.running=false;}
 }
 start(){
  if(this.timer||this.closed)return;
  const prepared=this.service.jobs?.some(j=>j.status==='ARMED'&&j.batches.some(b=>b.status==='PREPARED'));
  this.timer=setTimeout(()=>{this.timer=null;void this.tick().catch(e=>this.onError(e));this.start();},prepared?Math.min(150,this.pollMs):this.pollMs);
  this.timer.unref?.();
 }
 close(){this.closed=true;clearTimeout(this.timer);this.timer=null;}
}
