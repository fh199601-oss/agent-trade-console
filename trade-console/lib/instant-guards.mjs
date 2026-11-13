import {hash} from './common.mjs';

// One operation, one first step, memory only. These are reads started during
// the official preview, not permission to submit or a cross-order state cache.
export class InstantGuards {
 constructor({now=Date.now,maxAgeMs=1000,limit=64}={}){Object.assign(this,{now,maxAgeMs,limit});this.entries=new Map();}
 key(o){return hash({intent:o.intent,plan:o.plan});}
 current(entry,o){const age=this.now()-entry.startedAt;return age>=0&&age<=this.maxAgeMs&&entry.key===this.key(o);}
 start(o,check){
  // Only the fixed, zero-value Corla claim joins immediate trades. Generic
  // Mint/refund/fill plans can change during execution and are not eligible.
  const claim=o.intent.side==='mint'&&o.intent.routeId==='corla:claim'&&o.plan.route==='corla:claim'&&o.plan.requireAssetCredit===true&&
   o.plan.steps?.length===1&&o.plan.steps[0].kind==='mint'&&String(o.plan.steps[0].value)==='0'&&o.plan.steps[0].data==='0x4e71d92d';
  if((!['buy','sell'].includes(o.intent.side)&&!claim)||o.plan.kind!=='contract'||o.steps?.length)return;
  const entry={key:this.key(o),startedAt:this.now()};
  entry.promise=Promise.resolve().then(check).then(()=>({}),error=>({error}));
  this.entries.set(o.id,entry);
  while(this.entries.size>this.limit)this.entries.delete(this.entries.keys().next().value);
 }
 take(o){const entry=this.entries.get(o.id);this.entries.delete(o.id);return entry&&this.current(entry,o)?entry:null;}
 discard(id){this.entries.delete(id);}
}
