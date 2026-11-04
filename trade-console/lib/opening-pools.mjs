import {Interface,address,same,ZeroAddress} from './common.mjs';
import {DEXES,QUOTES,matchesCurrency} from './opening-dex.mjs';
import {openingReads} from './opening-read.mjs';
export {QUOTES};export const V2_FACTORY=DEXES[0].factory,V2_ROUTER=DEXES[0].router,V3_FACTORY=DEXES[2].factory;
export const FACTORY=new Interface(['function getPair(address,address) view returns(address)','function getPool(address,address,uint24) view returns(address)']);
export const POOL=new Interface(['function token0() view returns(address)','function token1() view returns(address)','function factory() view returns(address)','function getReserves() view returns(uint112,uint112,uint32)','function liquidity() view returns(uint128)']);
const checkedSnapshots=new WeakSet();
export function freshOpeningSnapshot(s,token,maxAge=1200){return !!s&&checkedSnapshots.has(s)&&same(s.token,token)&&Date.now()-s.at>=0&&Date.now()-s.at<=maxAge;}
export class OpeningPools{
 constructor(rpc,{dexes=DEXES,quotes=QUOTES}={}){Object.assign(this,{rpc,dexes,quotes});this.known=new Map();this.inflight=new Map();}
 async scan(input,{currency='AUTO'}={}){
  const token=address(input),key=token.toLowerCase()+':'+currency;if(this.inflight.has(key))return this.inflight.get(key);
  const task=this.inspect(token,currency);this.inflight.set(key,task);try{return await task;}finally{this.inflight.delete(key);}
 }
 async inspect(token,currency){
  const rpc=this.rpc;await rpc.verifyChain();
  const specs=this.quotes.filter(q=>!same(q,token)&&matchesCurrency({quote:q},currency)).flatMap(quote=>this.dexes.flatMap(d=>d.kind==='v2'?[{...d,quote}]:d.fees.map(fee=>({...d,quote,fee}))));
  const keys=specs.map(s=>[token,s.factory,s.quote,s.fee||0].join(':').toLowerCase());
  const requests=specs.map((s,n)=>{const cached=this.known.get(keys[n]);return cached?{to:cached.pool,abi:POOL,method:s.kind==='v2'?'getReserves':'liquidity'}:{to:s.factory,abi:FACTORY,method:s.kind==='v2'?'getPair':'getPool',args:[token,s.quote,...(s.kind==='v3'?[s.fee]:[])]};});
  const first=await openingReads(rpc,requests),pools=[],errors=[],newPairs=[];const block=first.block;
  const add=(s,p,state)=>{const liquid=s.kind==='v2'?state[0]>0n&&state[1]>0n:state[0]>0n;pools.push(Object.freeze({...s,...p,token,block,liquid,...(s.kind==='v2'?{reserve0:String(state[0]),reserve1:String(state[1])}:{liquidity:String(state[0])})}));};
  first.results.forEach((r,n)=>{const s=specs[n],cached=this.known.get(keys[n]);if(r.status==='rejected'){errors.push(s.id+': '+r.reason.message);if(cached)this.known.delete(keys[n]);return;}
   if(cached){if(block<cached.verifiedBlock){this.known.delete(keys[n]);errors.push('RPC 区块回退，重新核验池子');return;}add(s,cached,r.value);}
   else if(!same(r.value[0],ZeroAddress))newPairs.push({s,key:keys[n],pool:address(r.value[0])});
  });
  const pending=newPairs.flatMap(p=>['token0','token1','factory',p.s.kind==='v2'?'getReserves':'liquidity'].map(method=>({to:p.pool,abi:POOL,method})));
  const parts=await Promise.all(Array.from({length:Math.ceil(pending.length/64)},(_,n)=>openingReads(rpc,pending.slice(n*64,n*64+64),block)));const results=parts.flatMap(p=>p.results);
  newPairs.forEach((p,n)=>{const r=results.slice(n*4,n*4+4);if(r.some(x=>x.status!=='fulfilled')){errors.push(p.s.id+': 新池核验暂未完成');return;}
   const [t0,t1,factory]=r.slice(0,3).map(x=>x.value[0]);if(!same(factory,p.s.factory)||!([t0,t1].some(t=>same(t,token))&&[t0,t1].some(t=>same(t,p.s.quote)))){errors.push('池子身份不匹配');return;}
   const entry={pool:p.pool,token0:t0,token1:t1,verifiedBlock:block};this.known.set(p.key,entry);if(this.known.size>512)this.known.delete(this.known.keys().next().value);add(p.s,entry,r[3].value);
  });
  if(specs.length&&first.results.every(r=>r.status==='rejected'))throw Error('开盘池读取失败：'+errors[0]);
  const snapshot=Object.freeze({token,block,at:Date.now(),pools:Object.freeze(pools),open:pools.some(p=>p.liquid),partial:errors.length>0,errors:Object.freeze(errors)});checkedSnapshots.add(snapshot);return snapshot;
 }
}
