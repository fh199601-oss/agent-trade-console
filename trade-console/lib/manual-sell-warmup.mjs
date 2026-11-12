import {address} from './common.mjs';
import {dexFor} from './opening-dex.mjs';

// Demand-driven read-only warmup as soon as a valid trading CA is entered. Cache only the
// verified token/venue identities already owned by OpeningPreparation/Pools;
// never store holdings, allowance, price, calldata or a wallet preview here.
export class ManualSellWarmup{
 constructor({scan,preparation,busy=()=>false,now=Date.now}){Object.assign(this,{scan,preparation,busy,now});this.after=new Map();this.pending=null;this.closed=false;}
 request(input){
  if(this.closed||this.pending||this.busy())return null;
  let token;try{token=address(input);}catch{return null;}
  if((this.after.get(token)||0)>this.now())return null;
  this.after.set(token,this.now()+15000);if(this.after.size>128)this.after.delete(this.after.keys().next().value);
  const task=Promise.allSettled([
   Promise.resolve().then(()=>this.preparation.token(token)),
   Promise.resolve().then(()=>this.scan(token,{currency:'BNB',watch:true})).then(async snapshot=>{
    if(this.closed||this.busy())return;
    const venues=[...new Map(snapshot.pools.filter(p=>p.liquid).map(p=>{const d=dexFor(p);return [d?.id,d];})).values()].filter(Boolean).slice(0,4);
    await Promise.allSettled(venues.map(d=>this.preparation.venue(d)));
   })
  ]).finally(()=>{if(this.pending===task)this.pending=null;});
  this.pending=task;return task;
 }
 close(){this.closed=true;}
}
