// Server-owned read-only tracking survives browser closure/refresh. This class
// has no prepare/execute callback and never resumes an automation or sends a tx.
const TRACK=new Set(['PENDING','SUBMISSION_UNKNOWN','RECEIPT_REVIEW','SUBMITTING']);
export class OriginalTracker{
 constructor({engine,onUpdate=()=>{},now=Date.now,intervalMs=250}){Object.assign(this,{engine,onUpdate,now,intervalMs});this.next=new Map();this.inflight=new Map();this.closed=false;this.scanAt=null;this.rows=[];}
 start(){if(this.timer||this.closed)return;this.timer=setInterval(()=>this.tick().catch(()=>{}),this.intervalMs);this.timer.unref?.();void this.tick().catch(()=>{});}
 async tick(){
  if(this.closed||!this.engine.list||!this.engine.follow)return;
  // Poll fresh originals quickly without cloning/stat-ing the entire historical
  // journal four times a second. follow() still reloads each original from disk.
  if(this.scanAt===null||this.now()-this.scanAt>=1000){this.rows=this.engine.list().filter(o=>TRACK.has(o.status));this.scanAt=this.now();}
  const rows=this.rows.filter(o=>TRACK.has(o.status)),ids=new Set(rows.map(o=>o.id));
  for(const id of this.next.keys())if(!ids.has(id))this.next.delete(id);
  const accounts=new Set(rows.filter(o=>this.inflight.has(o.id)).map(o=>o.intent.account)),work=[];
  for(const o of rows.sort((a,b)=>(this.next.get(a.id)||0)-(this.next.get(b.id)||0))){
   if(work.length>=8)break;
   if(this.inflight.has(o.id)||accounts.has(o.intent.account)||this.engine.running?.has(o.intent.account)||this.engine.bridge?.queues?.has(o.intent.account)||(this.next.get(o.id)||0)>this.now())continue;
   accounts.add(o.intent.account);
   const promise=Promise.resolve().then(async()=>{
    let result;
    try{result=await this.engine.follow(o.id,{background:true});if(result?.status)this.rows=this.rows.map(r=>r.id===o.id?{...r,...result,id:o.id}:r);if(!this.closed)await this.onUpdate(result);}
    catch{/* Retain the original; a read failure never makes a new order. */}
    finally{
     const age=this.now()-(o.timing?.submitStartedAt||o.steps?.at(-1)?.submitStartedAt||o.createdAt);
     const slow=result?.tracking?.state==='needs-provider-check'||age>300000;
     // Fresh, identified contract receipts use a short read-only cadence.
     // Unknown submissions/provider orders and long pending orders back off.
     const directHash=o.txHash||o.steps?.at(-1)?.txHash;
     this.next.set(o.id,this.now()+(slow?15000:!result||result.followError?3000:age>30000?3000:directHash&&age<10000?250:750));this.inflight.delete(o.id);
    }
   });this.inflight.set(o.id,promise);work.push(promise);
  }
  await Promise.allSettled(work);
 }
 close(){this.closed=true;clearInterval(this.timer);this.timer=null;}
}
