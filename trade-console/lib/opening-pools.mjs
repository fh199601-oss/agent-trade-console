import {Interface,address,same,ZeroAddress,WBNB,USDT} from './common.mjs';
import {DEXES,QUOTES,matchesCurrency} from './opening-dex.mjs';
import {openingReads} from './opening-read.mjs';
import {OpeningQuotes} from './opening-quotes.mjs';
export {QUOTES};export const V2_FACTORY=DEXES[0].factory,V2_ROUTER=DEXES[0].router,V3_FACTORY=DEXES[2].factory;
export const FACTORY=new Interface(['function getPair(address,address) view returns(address)','function getPool(address,address,uint24) view returns(address)']);
export const POOL=new Interface(['function token0() view returns(address)','function token1() view returns(address)','function factory() view returns(address)','function getReserves() view returns(uint112,uint112,uint32)','function liquidity() view returns(uint128)']);
const checkedSnapshots=new WeakSet();
export function freshOpeningSnapshot(s,token,maxAge=1200){return !!s&&checkedSnapshots.has(s)&&same(s.token,token)&&Date.now()-s.at>=0&&Date.now()-s.at<=maxAge;}
export class OpeningPools{
 constructor(rpc,{dexes=DEXES,quotes=QUOTES,quoteDiscovery=new OpeningQuotes(rpc)}={}){Object.assign(this,{rpc,dexes,quotes,quoteDiscovery});this.known=new Map();this.inflight=new Map();this.discoveryAfter=new Map();this.paths=new Map();}
 async scan(input,{currency='AUTO',expand=false}={}){
  const token=address(input),key=token.toLowerCase()+':'+currency+(expand?':expanded':'');if(this.inflight.has(key))return this.inflight.get(key);
  const task=this.inspect(token,currency,{expand});this.inflight.set(key,task);try{return await task;}finally{this.inflight.delete(key);}
 }
 async inspect(token,currency,{expand=false}={}){
  await this.rpc.verifyChain();
  const cachedPath=expand?null:await this.refreshPaths(token,currency);if(cachedPath)return cachedPath;
  const quotes=[...new Map([...this.quotes,...(this.quoteDiscovery?.known(token)||[])].map(q=>[q.toLowerCase(),q])).values()];
  const before=this.quoteDiscovery?.knownRoutes?.(token)||[];
  const key=token.toLowerCase()+':'+currency;
  const discoverDue=expand||Date.now()>=(this.discoveryAfter.get(key)||0);
  const hints=this.quoteDiscovery&&discoverDue?this.quoteDiscovery.discover(token).catch(()=>[]):Promise.resolve(this.quoteDiscovery?.known(token)||[]);
  const base=await this.inspectQuotes(token,expand?'AUTO':currency,quotes);
  // Normal liquid routes never wait for slow third-party hints. Empty scans
  // also have a fixed discovery wait; outstanding reads populate the next scan.
  let learned=[];
  if(expand||!base.pools.some(p=>p.liquid)){
   let timer;try{learned=await Promise.race([hints,new Promise(r=>timer=setTimeout(()=>r([]),expand?750:300))]);}finally{clearTimeout(timer);}
  }
  const fees=this.quoteDiscovery?.knownRoutes?.(token)||[];
  const changed=fees.filter(p=>p.kind==='v3'&&!before.some(x=>same(x.pool,p.pool))).map(p=>p.quote);
  const missing=learned.filter(q=>!quotes.some(x=>same(x,q)));
  const expanded=[...new Set([...missing,...changed,...(currency!=='AUTO'&&!base.pools.some(p=>p.liquid)?quotes:[])])];
  const extra=expanded.length?await this.inspectQuotes(token,'AUTO',expanded,base.block).catch(e=>({pools:[],errors:['扩展池查询暂不可用：'+e.message]})):null;
  let pools=[...new Map([...base.pools,...(extra?.pools||[])].map(p=>[p.pool.toLowerCase(),p])).values()];
  const observedLiquidity=pools.some(p=>p.liquid);
  const errors=[...base.errors,...(extra?.errors||[])];
  if(currency!=='AUTO'){
   const direct=pools.filter(p=>matchesCurrency(p,currency));
   if(expand||!direct.some(p=>p.liquid))direct.push(...await this.bridges(token,currency,pools,base.block,errors));
   pools=direct;
  }
  if(pools.some(p=>p.liquid)){if(discoverDue)this.discoveryAfter.set(key,Date.now()+5000);if(this.discoveryAfter.size>128)this.discoveryAfter.delete(this.discoveryAfter.keys().next().value);}else this.discoveryAfter.delete(key);
  const paths=pools.filter(p=>p.legs);if(paths.length&&!pools.some(p=>p.liquid&&!p.legs)){this.paths.set(key,{at:Date.now(),paths});if(this.paths.size>128)this.paths.delete(this.paths.keys().next().value);}else if(expand)this.paths.delete(key);
  const open=pools.some(p=>p.liquid),unsupported=this.quoteDiscovery?.unsupported?.(token)||[];
  const routeIssue=open?null:observedLiquidity?'已发现流动性，但暂未找到指定到账币种的可用路径':unsupported.length?'发现尚未适配的池子线索，当前没有可核验卖出路径':null;
  const snapshot=Object.freeze({token,block:base.block,at:Date.now(),pools:Object.freeze(pools),open,expanded:expand,routeIssue,partial:errors.length>0,errors:Object.freeze(errors)});checkedSnapshots.add(snapshot);return snapshot;
 }
 async refreshPaths(token,currency){
  const key=token.toLowerCase()+':'+currency,cache=this.paths.get(key);if(!cache||Date.now()-cache.at>30000)return null;
  // Both previously verified legs are refreshed in ONE pinned RPC batch.
  // Cache contains venue identity only, never holdings, allowance or a quote.
  try{
   const r=await openingReads(this.rpc,cache.paths.flatMap(p=>p.legs.map(l=>({to:l.pool,abi:POOL,method:'getReserves'}))));
   const pools=cache.paths.flatMap((p,n)=>{const rows=r.results.slice(n*2,n*2+2);if(rows.some(x=>x.status!=='fulfilled'||x.value[0]<=0n||x.value[1]<=0n)||p.legs.some(l=>r.block<l.verifiedBlock))return [];
    const legs=p.legs.map((l,i)=>Object.freeze({...l,block:r.block,reserve0:String(rows[i].value[0]),reserve1:String(rows[i].value[1])}));
    return [Object.freeze({...p,block:r.block,reserve0:legs[0].reserve0,reserve1:legs[0].reserve1,legs:Object.freeze(legs)})];
   });
   if(pools.length){const snapshot=Object.freeze({token,block:r.block,at:Date.now(),pools:Object.freeze(pools),open:true,routeIssue:null,partial:false,errors:Object.freeze([])});checkedSnapshots.add(snapshot);return snapshot;}
  }catch{}
  this.paths.delete(key);return null;
 }
 async bridges(token,currency,pools,block,errors){
  const output=currency==='USDT'?USDT:WBNB,first=pools.filter(p=>p.kind==='v2'&&p.liquid&&!same(p.quote,output)&&!same(p.quote,token)).slice(0,12);
  const mids=[...new Set(first.map(p=>p.quote))],second=new Map();
  await Promise.all(mids.map(async mid=>{try{second.set(mid,await this.inspectQuotes(mid,currency,[output],block));}catch(e){errors.push('中转池暂不可用：'+e.message);}}));
  return first.flatMap(p=>{const q=second.get(p.quote)?.pools.find(q=>q.kind==='v2'&&q.liquid&&same(q.factory,p.factory)&&!same(q.pool,p.pool));
   return q?[Object.freeze({...p,quote:output,path:Object.freeze([token,p.quote,output]),legs:Object.freeze([p,q])})]:[];
  });
 }
 async inspectQuotes(token,currency,quotes,atBlock='latest'){
  const rpc=this.rpc;
  const specs=quotes.filter(q=>!same(q,token)&&matchesCurrency({quote:q},currency)).flatMap(quote=>this.dexes.flatMap(d=>d.kind==='v2'?[{...d,quote}]:[...new Set([...d.fees,...(this.quoteDiscovery?.knownRoutes?.(token)||[]).filter(p=>same(p.factory,d.factory)&&same(p.quote,quote)&&p.fee>0&&p.fee<1000000).map(p=>p.fee)])].map(fee=>({...d,quote,fee}))));
  const keys=specs.map(s=>[token,s.factory,s.quote,s.fee||0].join(':').toLowerCase());
  const requests=specs.map((s,n)=>{const cached=this.known.get(keys[n]);return cached?{to:cached.pool,abi:POOL,method:s.kind==='v2'?'getReserves':'liquidity'}:{to:s.factory,abi:FACTORY,method:s.kind==='v2'?'getPair':'getPool',args:[token,s.quote,...(s.kind==='v3'?[s.fee]:[])]};});
  const chunks=await Promise.all(Array.from({length:Math.ceil(requests.length/64)},(_,n)=>openingReads(rpc,requests.slice(n*64,n*64+64),atBlock)));
  const block=chunks[0]?.block??(atBlock==='latest'?await rpc.getBlockNumber():Number(atBlock));
  if(chunks.some(c=>c.block!==block))return this.inspectQuotes(token,currency,quotes,block);
  const first={results:chunks.flatMap(c=>c.results)},pools=[],errors=[],newPairs=[];
  const add=(s,p,state)=>{const liquid=s.kind==='v2'?state[0]>0n&&state[1]>0n:state[0]>0n;const declaredByToken=!!this.quoteDiscovery?.knownRoutes?.(token).some(r=>same(r.pool,p.pool)&&r.declaredByToken);pools.push(Object.freeze({...s,...p,declaredByToken,token,block,liquid,...(s.kind==='v2'?{reserve0:String(state[0]),reserve1:String(state[1])}:{liquidity:String(state[0])})}));};
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
  return {block,pools,errors};
 }
}
