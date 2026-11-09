import {Interface,address,same,ZeroAddress,BNB} from './common.mjs';
import {openingReads} from './opening-read.mjs';
import {DEXES} from './opening-dex.mjs';
import {OpeningSources} from './opening-sources.mjs';

export const QUOTE_GETTERS=['quoteToken','quoteAsset','quote'];
export const PAIR_GETTERS=['pair','uniswapV2Pair','pancakePair','liquidityPair','lpPair','mainPair','pool'];
export const HINT_ABI=new Interface([...QUOTE_GETTERS,...PAIR_GETTERS].map(m=>`function ${m}() view returns(address)`));
const PAIR_ABI=new Interface(['function token0() view returns(address)','function token1() view returns(address)','function factory() view returns(address)','function fee() view returns(uint24)']);
const valid=a=>/^0x[\da-f]{40}$/i.test(a)&&!same(a,ZeroAddress)&&!same(a,BNB);
const unique=items=>[...new Map(items.map(q=>[q.toLowerCase(),q])).values()].slice(0,12);

export class OpeningQuotes{
 constructor(rpc,{now=Date.now,sources=typeof rpc.send==='function'?new OpeningSources(rpc):null}={}){Object.assign(this,{rpc,now,sources});this.cache=new Map();this.pending=new Map();this.routes=new Map();this.external=new Map();this.unknown=new Map();}
 known(token){return unique([...(this.cache.get(token.toLowerCase())?.quotes||[]),...this.knownRoutes(token).map(p=>p.quote)]);}
 knownRoutes(token){return this.routes.get(token.toLowerCase())||[];}
 unsupported(token){return this.unknown.get(token.toLowerCase())||[];}
 async discover(token){
  const key=token.toLowerCase();
  if(this.pending.has(key))return this.pending.get(key);
  const work=(async()=>{
   const old=this.cache.get(key),external=this.sources?this.sources.discover(token).then(pairs=>this.readPairs(token,pairs)).catch(()=>{}):Promise.resolve();
   if(!old||this.now()-old.at>=(old.quotes.length?15000:2000)){
    const quotes=await this.read(token);this.cache.set(key,{at:this.now(),quotes});if(this.cache.size>128){const evict=this.cache.keys().next().value;this.cache.delete(evict);this.routes.delete(evict);this.external.delete(evict);}
   }
   await external.catch(()=>{});return this.known(token);
  })();this.pending.set(key,work);try{return await work;}finally{this.pending.delete(key);}
 }
 async readPairs(token,pairs,block='latest'){
  const key=token.toLowerCase(),known=this.external.get(key)||new Map(),fresh=unique(pairs.filter(valid)).filter(p=>!known.has(p.toLowerCase())||this.now()-known.get(p.toLowerCase())>15000);
  if(!fresh.length)return;
  const methods=['token0','token1','factory','fee'],parts=await openingReads(this.rpc,fresh.flatMap(to=>methods.map(method=>({to,abi:PAIR_ABI,method}))),block);
  const routes=[];fresh.forEach((pool,n)=>{const row=parts.results.slice(n*4,n*4+4);if(row.slice(0,3).some(r=>r.status!=='fulfilled'))return;
   const [t0,t1,factory]=row.slice(0,3).map(r=>r.value[0]),d=DEXES.find(d=>same(d.factory,factory));
   const quote=same(t0,token)?t1:same(t1,token)?t0:null;if(!valid(quote)||same(quote,token))return;
   if(!d){this.unknown.set(key,[...new Map([...this.unsupported(token),{pool,factory}].map(p=>[p.pool.toLowerCase(),p])).values()].slice(0,8));if(this.unknown.size>128)this.unknown.delete(this.unknown.keys().next().value);return;}
   const fee=d.kind==='v3'&&row[3].status==='fulfilled'?Number(row[3].value[0]):null;if(d.kind==='v3'&&!(fee>0&&fee<1000000))return;
   routes.push({pool,quote:address(quote),factory:d.factory,kind:d.kind,...(fee?{fee}:{})});known.set(pool.toLowerCase(),this.now());
  });
  this.external.set(key,known);this.routes.set(key,[...new Map([...routes,...this.knownRoutes(token)].map(p=>[p.pool.toLowerCase(),p])).values()].slice(0,24));
  if(this.routes.size>128){const evict=this.routes.keys().next().value;this.routes.delete(evict);this.external.delete(evict);}
 }
 async read(token){
  const methods=[...QUOTE_GETTERS,...PAIR_GETTERS],first=await openingReads(this.rpc,methods.map(method=>({to:token,abi:HINT_ABI,method})));
  const values=first.results.map(r=>r.status==='fulfilled'&&valid(r.value[0])?address(r.value[0]):null);
  const quotes=values.slice(0,QUOTE_GETTERS.length).filter(Boolean),pairs=unique(values.slice(QUOTE_GETTERS.length).filter(Boolean));
  await this.readPairs(token,pairs,first.block);
  return unique(quotes.filter(q=>!same(q,token)));
 }
}
