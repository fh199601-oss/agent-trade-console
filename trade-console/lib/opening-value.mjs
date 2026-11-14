import {read,WBNB,same} from './common.mjs';
import {DEXES,QUOTES,V2_ROUTER_ABI} from './opening-dex.mjs';

const readers=new WeakMap();
// Only established quote currencies are valued here. A custom quote token is
// never assumed to equal a dollar. Compare at the sale's pinned block; cache
// only unsigned reads, share them across wallets, and never extend their age.
export class OpeningValues{
 constructor(rpc){this.rpc=rpc;this.rates=new Map();}
 rate(token,block,preparation){
  const key=token.toLowerCase()+':'+block;
  if(this.rates.has(key))return this.rates.get(key);
  const task=(async()=>{
   const d=DEXES[0];await preparation.venue(d);
   const [amounts]=await read(this.rpc,d.router,V2_ROUTER_ABI,'getAmountsOut',[10n**18n,[token,WBNB]],block);
   if(amounts.length!==2||amounts[0]!==10n**18n||amounts[1]<=0n)throw Error('计价币价值比较报价无效');
   return amounts[1];
  })();
  this.rates.set(key,task);task.catch(()=>{if(this.rates.get(key)===task)this.rates.delete(key);});
  while(this.rates.size>64)this.rates.delete(this.rates.keys().next().value);
  return task;
 }
 async compare(routes,preparation){
  if(new Set(routes.map(r=>r.pool.quote.toLowerCase())).size<2)return;
  await Promise.all(routes.map(async r=>{
   if(same(r.pool.quote,WBNB)){r.value={token:WBNB,amount:String(r.output),block:r.pool.block};return;}
   if(!QUOTES.some(q=>same(q,r.pool.quote))||!Number.isSafeInteger(r.pool.block))return;
   let timer;
   try{
    const rate=await Promise.race([this.rate(r.pool.quote,r.pool.block,preparation),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('计价币价值比较超时')),1200))]);
    const amount=r.output*rate/(10n**18n);if(amount>0n)r.value={token:WBNB,amount:String(amount),block:r.pool.block};
   }catch{r.valueUnavailable=true;}finally{clearTimeout(timer);}
  }));
 }
}
export function openingValues(rpc){if(!readers.has(rpc))readers.set(rpc,new OpeningValues(rpc));return readers.get(rpc);}
