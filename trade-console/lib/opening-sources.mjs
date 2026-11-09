import {Interface,address,same} from './common.mjs';
import {DEXES} from './opening-dex.mjs';

export const CREATED=new Interface([
 'event PairCreated(address indexed token0,address indexed token1,address pair,uint256)',
 'event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)'
]);
const valid=v=>/^0x[\da-f]{40}$/i.test(v||'');
// These are candidate addresses only. Nothing from the index or logs becomes a
// spender or route until the supported factory and both assets are re-read.
export class OpeningSources{
 constructor(rpc,{dexes=DEXES,now=Date.now,fetchImpl=fetch}={}){Object.assign(this,{rpc,dexes,now,fetchImpl});this.cache=new Map();}
 entry(token){const key=token.toLowerCase();let e=this.cache.get(key);if(!e){e={pairs:[],cursor:null};this.cache.set(key,e);if(this.cache.size>128)this.cache.delete(this.cache.keys().next().value);}return e;}
 async discover(token){
  token=address(token);const e=this.entry(token);
  const pending=Promise.allSettled([this.run(e,'logs',500,()=>this.logs(token,e)),this.run(e,'index',15000,()=>this.index(token))]);
  let timer;try{await Promise.race([pending,new Promise(resolve=>timer=setTimeout(resolve,200))]);}finally{clearTimeout(timer);}
  return e.pairs;
 }
 async run(e,key,ttl,read){
  if(e[key]?.pending)return e[key].pending;
  if(e[key]?.at!==undefined&&this.now()-e[key].at<ttl)return;
  const slot=e[key]={at:this.now()};slot.pending=(async()=>{const pairs=await read();e.pairs=[...new Map([...pairs,...e.pairs].filter(valid).map(p=>[p.toLowerCase(),address(p)])).values()].slice(0,24);})();
  try{await slot.pending;}finally{delete slot.pending;}
 }
 async logs(token,e){
  const height=await this.rpc.getBlockNumber(),from=e.cursor===null?Math.max(0,height-255):Math.max(0,Math.min(height,e.cursor)-8);
  // Bounded catch-up after sleeping/offline. The index covers older creations.
  const start=Math.max(from,height-255),topic='0x'+token.slice(2).toLowerCase().padStart(64,'0'),queries=[];
  for(const kind of ['v2','v3']){
   const factories=this.dexes.filter(d=>d.kind===kind).map(d=>d.factory);if(!factories.length)continue;
   const event=CREATED.getEvent(kind==='v2'?'PairCreated':'PoolCreated');
   for(const position of [1,2])queries.push({kind,factories,filter:{address:factories,fromBlock:'0x'+start.toString(16),toBlock:'0x'+height.toString(16),topics:position===1?[event.topicHash,topic]:[event.topicHash,null,topic]}});
  }
  const rows=await Promise.allSettled(queries.map(q=>this.rpc.send('eth_getLogs',[q.filter]))),pairs=[];
  rows.forEach((r,n)=>{if(r.status!=='fulfilled'||!Array.isArray(r.value))return;for(const log of r.value.slice(0,128))try{
   if(log.removed||!queries[n].factories.some(f=>same(f,log.address)))continue;
   const block=Number(BigInt(log.blockNumber));if(block<start||block>height)continue;
   const event=CREATED.parseLog(log);if(!same(event.args.token0,token)&&!same(event.args.token1,token))continue;
   pairs.push(event.args.pair||event.args.pool);
  }catch{}});
  // A partial RPC failure must not advance over potentially missed creations.
  if(rows.every(r=>r.status==='fulfilled'&&Array.isArray(r.value)))e.cursor=height;
  return pairs;
 }
 async index(token){
  const response=await this.fetchImpl('https://api.dexscreener.com/token-pairs/v1/bsc/'+token,{signal:AbortSignal.timeout(1800),redirect:'error',credentials:'omit'});
  if(!response.ok)throw Error('池子索引暂不可用');
  const data=await response.json();if(!Array.isArray(data))return [];
  return data.slice(0,100).filter(p=>p.chainId==='bsc'&&[p.baseToken?.address,p.quoteToken?.address].some(t=>valid(t)&&same(t,token))).map(p=>p.pairAddress).filter(valid).slice(0,24);
 }
}
