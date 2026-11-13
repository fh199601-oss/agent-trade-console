import path from 'node:path';
import {load,save} from './common.mjs';
import {RpcTransport} from './rpc-transport.mjs';

const PUBLIC=['https://bsc-dataseed.bnbchain.org','https://bsc-dataseed1.defibit.io','https://bsc-dataseed1.ninicoin.io'];
const READS=new Set(['eth_chainId','eth_blockNumber','eth_call','eth_getCode','eth_getStorageAt','eth_getBalance','eth_gasPrice','eth_getBlockByNumber','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getLogs','eth_getTransactionCount','eth_estimateGas']);
const transient=r=>r?.error&&!/revert|invalid (argument|param)|insufficient funds/i.test(r.error.message||'')&&(/rate|limit|busy|timeout|timed out|unavailable|overload|upstream|header not found|missing trie/i.test(r.error.message||'')||[-32005,-32016,-32603].includes(r.error.code));
const missingReceipt=r=>r?.result===null;
const unavailable=()=>Object.assign(Error('RPC 网络读取失败，备用节点也未返回有效结果；钱包登录未因此改变，网络恢复后会自动重试'),{code:'RPC_UNAVAILABLE'});
function withSignal(promise,signal){
 if(!signal)return promise;
 if(signal.aborted)return Promise.reject(signal.reason);
 return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
function hideEndpointSecrets(error,url){
 const u=new URL(url),secrets=[url,...u.searchParams.values(),...u.pathname.split('/').map(x=>{try{return decodeURIComponent(x);}catch{return x;}})].filter(x=>x.length>=8);
 const clean=v=>typeof v==='string'?secrets.reduce((s,key)=>s.split(key).join('[已隐藏]'),v):Array.isArray(v)?v.map(clean):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,clean(x)])):v;
 return clean(error);
}
export function rpcUrl(value){
 if(typeof value!=='string'||value.length>4096)throw Error('RPC 地址无效');
 let u;try{u=new URL(value.trim());}catch{throw Error('请输入完整的 HTTPS RPC 地址');}
 if(u.protocol!=='https:'||u.username||u.password||u.hash)throw Error('RPC 仅支持 HTTPS，不接受用户名密码或片段；服务商 API Key 可放在路径或查询参数中');
 return u.href;
}
// Only this transport knows the full URL. Status and errors never include URL
// paths/query strings or provider messages which might echo an API key.
export class RpcEndpoints{
 constructor({data,primary,fetchImpl=fetch,publicUrls=PUBLIC,now=Date.now,timeoutMs=2500,hedgeMs=200}={}){
  this.file=data?path.join(data,'rpc-settings.json'):null;this.rawFetch=fetchImpl;this.now=now;this.timeoutMs=timeoutMs;this.hedgeMs=hedgeMs;this.publicUrls=publicUrls.map(rpcUrl);this.health=new Map();this.revision=0;this.saving=false;this.last=null;
  if(fetchImpl===globalThis.fetch){this.transport=new RpcTransport();this.rawFetch=this.transport.fetch;}
  const stored=this.file?load(this.file,{}):{};this.custom=stored.url?rpcUrl(stored.url):null;this.primary=primary?rpcUrl(primary):this.publicUrls[0];this.fetch=this.fetch.bind(this);
 }
 state(url){if(!this.health.has(url))this.health.set(url,{until:0,verifiedAt:0});return this.health.get(url);}
 close(){return this.transport?.close();}
 status(){return {configured:!!this.custom,host:this.custom?new URL(this.custom).hostname:null,chainId:56,active:this.last?.kind||'public',fallback:this.last?.kind==='public'&&!!this.custom,scope:'chain-reads',checkedAt:this.last?.at||null};}
 candidates(){
  const urls=[...new Set([this.custom,this.primary,...this.publicUrls].filter(Boolean))],ready=urls.filter(u=>this.state(u).until<=this.now());
  // Do not turn a shared cooldown into a total, self-sustaining outage. When
  // every transport failed, allow one half-open probe. A wrong chain is never
  // eligible for this shortcut.
  // A preferred node that just lost a slow-read race yields briefly. Otherwise
  // every dependent balance/quote/identity read would pay the same hedge delay.
  // This is not a failure quarantine; normal priority returns after 3 seconds.
  return ready.length?ready.sort((a,b)=>Number((this.state(a).slowUntil||0)>this.now())-Number((this.state(b).slowUntil||0)>this.now())):urls.filter(u=>this.state(u).failure!=='chain').sort((a,b)=>this.state(a).until-this.state(b).until).slice(0,1);
 }
 async request(url,queries,signal){
  const signals=[AbortSignal.timeout(this.timeoutMs),...(signal?[signal]:[])];
  const response=await this.rawFetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(queries),redirect:'error',signal:AbortSignal.any(signals)});
  if(!response.ok)throw Error('RPC HTTP '+response.status);
  const body=await response.json(),rows=Array.isArray(body)?body:[body];
  const expected=Array.isArray(queries)?queries:[queries];
  if(rows.some(r=>!r||typeof r!=='object'))throw Error('RPC response incomplete');
  if(expected.some(q=>rows.filter(r=>r.id===q.id).length>1))throw Error('RPC duplicate response');
  for(const r of rows)if(r.error)r.error=hideEndpointSecrets(r.error,url);
  const validRows=rows.filter(r=>expected.some(q=>q.id===r.id)&&('result'in r||r.error));
  const missing=expected.filter(q=>!rows.some(r=>r.id===q.id&&('result'in r||r.error)));
  if(missing.length&&Array.isArray(queries)&&!rows.some(transient)){
   const singles=await Promise.allSettled(missing.map(q=>this.request(url,q,signal)));
   return [...validRows,...singles.map((r,i)=>r.status==='fulfilled'?r.value:{id:missing[i].id,error:{code:-32005,message:'RPC response incomplete'}})];
  }
  // Preserve successful members when a provider rate-limits just one method
  // or drops part of a batch. Only unresolved reads go to the next provider.
  const result=[...validRows,...missing.map(q=>({id:q.id,error:{code:-32005,message:'RPC response incomplete'}}))];
  return Array.isArray(queries)?result:result[0];
 }
 async verify(url,signal){
  const state=this.state(url);if(state.verifiedAt&&this.now()-state.verifiedAt<300000)return;
  // A shared chain probe owns its timeout. Cancelling one UI/scan request must
  // not cancel verification for a concurrent order or poison endpoint health.
  if(!state.verifying)state.verifying=(async()=>{const r=await this.request(url,[{jsonrpc:'2.0',id:2000000056,method:'eth_chainId',params:[]}]),v=(Array.isArray(r)?r:[r])[0];if(v.error||!/^0x[\da-f]+$/i.test(v.result||''))throw Error('RPC chain probe unavailable');if(BigInt(v.result)!==56n)throw Error('RPC_CHAIN_MISMATCH');state.verifiedAt=this.now();})().finally(()=>{state.verifying=null;});
  return withSignal(state.verifying,signal);
 }
 async warm(){
  // Resolve and verify backup connections before an order needs them. No
  // account data, quotes, signing or broadcast; at most one chain probe per
  // endpoint per refresh. Share only verification, not a caller's cancellation.
  const now=this.now(),urls=[...new Set([this.custom,this.primary,...this.publicUrls].filter(Boolean))];
  return Promise.allSettled(urls.filter(url=>{const s=this.state(url);return s.until<=now&&(s.warmAfter||0)<=now&&(!s.verifiedAt||now-s.verifiedAt>=240000);}).map(async url=>{
   const s=this.state(url);s.warmAfter=now+30000;
   try{await this.verify(url);}catch(error){
    if(error.message==='RPC_CHAIN_MISMATCH'){s.failure='chain';s.until=this.now()+300000;}
    // Ordinary probe failures do not invalidate another completed read or
    // rewrite RPC settings. Foreground still tries the configured failover.
   }
  }));
 }
 async configure(value){
  if(this.saving)throw Error('正在保存 RPC，请稍候');this.saving=true;
  try{
   const url=value===''?null:rpcUrl(value);
   if(url)try{this.state(url).verifiedAt=0;await this.verify(url);const r=await this.request(url,[{jsonrpc:'2.0',id:2000000057,method:'eth_blockNumber',params:[]}]);if(!/^0x[\da-f]+$/i.test(r[0]?.result||''))throw Error('Invalid block');}catch{throw Error('RPC 连接或 BNB 链验证失败，原设置保持不变');}
   if(this.file)save(this.file,{url});this.custom=url;this.revision++;this.last=null;if(url)this.state(url).until=0;return this.status();
  }finally{this.saving=false;}
 }
 async fetch(_url,options){
  const q=JSON.parse(options.body),queries=Array.isArray(q)?q:[q];
  if(!queries.length||queries.some(x=>!READS.has(x.method)))throw Error('RPC signing/broadcast is forbidden');
  options.signal?.throwIfAborted();
  const revision=this.revision,candidates=this.candidates(),accepted=new Map(),nulls=new Map(),active=new Map(),started=new Map(),stop=new AbortController();let cursor=0,timer;
  const signal=options.signal?AbortSignal.any([options.signal,stop.signal]):stop.signal;
  const launch=()=>{
   const url=candidates[cursor++],pending=queries.filter(x=>!accepted.has(x.id));started.set(url,this.now());
   const task=(async()=>{
    try{
     await this.verify(url,signal);signal.throwIfAborted();
     // verify() has already established this endpoint's chain. Re-querying it
     // for each isolated scanner added a whole network round trip (and could
     // fail after successful verification). Reuse that same bounded proof.
     const chainRows=pending.filter(x=>x.method==='eth_chainId').map(x=>({jsonrpc:'2.0',id:x.id,result:'0x38'}));
     const remote=pending.filter(x=>x.method!=='eth_chainId');
     const result=remote.length?await this.request(url,Array.isArray(q)?remote:remote[0],signal):[];
     signal.throwIfAborted();
     this.state(url).until=0;this.state(url).failure=null;
     return {url,rows:[...chainRows,...(Array.isArray(result)?result:[result])]};
    }catch(e){
     // Loser cancellation and caller deadlines say nothing about RPC health.
     if(!signal.aborted){const state=this.state(url);state.failure=e.message==='RPC_CHAIN_MISMATCH'?'chain':'transport';state.until=this.now()+(state.failure==='chain'?300000:3000);}
     return {url,error:true};
    }
   })();active.set(url,task);
  };
  try{
   if(candidates.length)launch();
   while(active.size){
    // Private RPC gets first opportunity. A slow read is hedged after 200ms,
    // at most two transports in flight. No signature/broadcast is allowed here.
    const event=cursor<candidates.length&&active.size<2?await Promise.race([...active.values(),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),this.hedgeMs);})]):await Promise.race(active.values());
    clearTimeout(timer);signal.throwIfAborted();
    if(!event){launch();continue;}
    active.delete(event.url);
    for(const row of event.rows||[]){
     const query=queries.find(x=>x.id===row.id);if(!query||accepted.has(row.id)||transient(row))continue;
     if(['eth_getTransactionByHash','eth_getTransactionReceipt'].includes(query.method)&&missingReceipt(row)){nulls.set(row.id,row);continue;}
     accepted.set(row.id,row);
     if(revision===this.revision)this.last={kind:event.url===this.custom?'custom':'public',at:this.now()};
    }
    if(accepted.size===queries.length){
     for(const url of active.keys())if(this.now()-started.get(url)>=this.hedgeMs)this.state(url).slowUntil=this.now()+3000;
     break;
    }
    if(cursor<candidates.length&&active.size<2)launch();
   }
   const rows=queries.map(x=>accepted.get(x.id)||nulls.get(x.id)||{jsonrpc:'2.0',id:x.id,error:{code:'RPC_UNAVAILABLE',message:unavailable().message}});
   if(!accepted.size&&!nulls.size)throw unavailable();
   return {ok:true,json:async()=>Array.isArray(q)?rows:rows[0]};
  }finally{clearTimeout(timer);stop.abort();}
 }
}
