import {Agent,Client,ProxyAgent,EnvHttpProxyAgent,setGlobalDispatcher,fetch as ufetch} from 'undici';
import dns from 'node:dns/promises';
import net from 'node:net';
import {ReadRpc} from '../support/curve-trader/rpc.mjs';
import {normalizeAssetInput} from '../public/asset-input.mjs';
import {count,measure} from './diagnostics.mjs';
import {boundedPageText} from './page-text.mjs';
setGlobalDispatcher(new EnvHttpProxyAgent({connect:{timeout:4000},keepAliveTimeout:60000}));
export class Rpc extends ReadRpc{
 constructor(...args){super(...args);this.multicallReads=true;this.activeReads=0;this.waitingReads=[];this.inflightReads=new Map();}
 send(method,params){
  count('rpcLogicalReads');
  const key=JSON.stringify([this.endpoints?.revision,method,params]);if(this.inflightReads.has(key)){count('rpcCoalescedReads');return this.inflightReads.get(key);}
  const task=this.limitedRead(method,params);this.inflightReads.set(key,task);
  task.finally(()=>this.inflightReads.delete(key)).catch(()=>{});return task;
 }
 async limitedRead(method,params){
  const allowed=()=>{if(this.readAllowed&&!this.readAllowed())throw Object.assign(Error('只读预热已让位于交易'),{code:'WARM_YIELDED'});};
  allowed();
  // Public RPCs impose small batch limits. Multiple wallets plus per-index NFT
  // prices must not become one oversized batch with missing responses.
  if(this.activeReads>=16)await measure('rpcQueue',()=>new Promise(resolve=>this.waitingReads.push(resolve)));
  else this.activeReads++;
  try{allowed();count('rpcDispatchedReads');return await measure('rpcRead',async()=>{
   try{return await (method==='eth_getStorageAt'?this.storage(...params):super.send(method,params));}
   catch(e){
    // Some providers reject an entire batch with id:null or omit a costly
    // eth_call result. Recover only the missing read, once, as a single request.
    // Explicit EVM errors and all signing/submission methods are never retried.
    if(e.message!=='RPC batch response missing')throw e;
    count('rpcSingleFallbackReads');return this.singleRead(method,params);
   }
  });}
  finally{const next=this.waitingReads.shift();if(next)next();else this.activeReads--;}
 }
 async singleRead(method,params){
  if(!new Set(['eth_chainId','eth_blockNumber','eth_call','eth_getCode','eth_getBalance','eth_gasPrice','eth_getBlockByNumber','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getLogs','eth_getTransactionCount','eth_estimateGas']).has(method))throw Error('RPC signing/broadcast is forbidden');
  const id=++this.nextId,response=await this.fetch(this.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(this.timeoutMs)});
  if(!response.ok)throw Error('RPC HTTP '+response.status);const r=await response.json();
  if(r.error)throw Object.assign(Error(r.error.message),{code:r.error.code,data:r.error.data});
  if(r.id!==id||!Object.hasOwn(r,'result'))throw Error('RPC single response missing');return r.result;
 }
 async storage(a,s,b='latest'){const response=await this.fetch(this.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getStorageAt',params:[a,s,b]}),signal:AbortSignal.timeout(this.timeoutMs)});if(!response.ok)throw Error('RPC HTTP '+response.status);const r=await response.json();if(r.error)throw Error(r.error.message);if(r.id!==1||!/^0x[0-9a-f]{64}$/i.test(r.result||''))throw Error('RPC storage response invalid');return r.result;}
}
// Queue isolation must not silently shorten the transport's failover budget.
// Deadlines are upper bounds, not a delay on successful reads.
export function forkReadRpc(source){
 if(!(source instanceof Rpc))return source;
 const client=new Rpc(source.url,{timeoutMs:source.timeoutMs,fetchImpl:source.fetch});
 client.endpoints=source.endpoints;return client;
}
export function preemptibleReadRpc(source,allowed){
 const client=forkReadRpc(source);if(client===source)return client;
 let controller=new AbortController();const fetcher=client.fetch;
 client.readAllowed=allowed;
 client.fetch=(url,options)=>fetcher(url,{...options,signal:AbortSignal.any([controller.signal,...(options.signal?[options.signal]:[])])});
 client.interrupt=()=>{controller.abort(Object.assign(Error('只读预热已让位于交易'),{code:'WARM_YIELDED'}));controller=new AbortController();};
 return client;
}
export async function getJson(url,options={},timeout=6000){const r=await fetch(url,{...options,signal:AbortSignal.timeout(timeout)});if(!r.ok)throw Error(`HTTP ${r.status}`);return r.json();}
export function publicIp(ip){
 if(net.isIP(ip)!==4)return false;const [a,b]=ip.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0))||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19)));
}
export function websiteUrl(s){const u=new URL(normalizeAssetInput(String(s)));if(u.hostname==='localhost'||u.hostname.endsWith('.local')||net.isIP(u.hostname)&&!publicIp(u.hostname))throw Error('项目网站只接受公开 HTTPS 地址');return u;}
export function websiteProxy(u,env=process.env){
 const bypass=(env.no_proxy||env.NO_PROXY||'').split(/[\s,]+/).filter(Boolean).some(rule=>{
  if(rule==='*')return true;const [host,port]=rule.toLowerCase().split(':');
  if(port&&port!==(u.port||'443'))return false;
  const suffix=host.replace(/^\*?\./,'');return u.hostname===suffix||/^[*.]/.test(host)&&u.hostname.endsWith('.'+suffix);
 });
 return bypass?null:env.https_proxy||env.HTTPS_PROXY||env.http_proxy||env.HTTP_PROXY||null;
}
export function pinnedWebsiteDispatcher(u,ips,proxyUri){
 if(!ips.length||ips.some(x=>!publicIp(x.address)))throw Error('拒绝访问本地或保留网络地址');
 if(!proxyUri)return new Agent({connect:{timeout:3000,lookup:(h,o,cb)=>o.all?cb(null,ips):cb(null,ips[0].address,4)}});
 if(!['http:','https:'].includes(new URL(proxyUri).protocol))throw Error('项目读取暂不支持此代理协议');
 const endpoint=ips[0].address+':'+(u.port||'443');
 // Preserve the HTTPS hostname (SNI and certificate verification), but send
 // CONNECT to the already validated public IP. The proxy never re-resolves the
 // untrusted website name to localhost/private targets. Redirects revalidate.
 return new ProxyAgent({uri:proxyUri,requestTls:{servername:u.hostname,timeout:3000},clientFactory:(origin,options)=>{
  const client=new Client(origin,options),connect=client.connect.bind(client);
  client.connect=(params,callback)=>connect({...params,path:endpoint,headers:{...params.headers,host:endpoint}},callback);
  return client;
 }});
}
export class PublicWebsiteReader{
 constructor({lookup=(host)=>dns.lookup(host,{all:true,family:4}),resolvePublic=async host=>{
  const r=await getJson('https://cloudflare-dns.com/dns-query?type=A&name='+encodeURIComponent(host),{headers:{accept:'application/dns-json'}},4000);return (r.Answer||[]).filter(x=>x.type===1).map(x=>({address:x.data,family:4}));
 },fetch=ufetch,dispatcherFactory=pinnedWebsiteDispatcher,proxy=websiteProxy,now=Date.now,dnsTtlMs=30000,idleMs=15000,maxPools=16}={}){
  Object.assign(this,{lookup,resolvePublic,fetch,dispatcherFactory,proxy,now,dnsTtlMs,idleMs,maxPools});this.dnsCache=new Map();this.dnsPending=new Map();this.pools=new Map();
 }
 async addresses(host){
  const cached=this.dnsCache.get(host);if(cached?.until>this.now()){count('websiteDnsCacheHits');return cached.ips;}
  if(this.dnsPending.has(host)){count('websiteDnsCoalesced');return this.dnsPending.get(host);}
  const task=measure('websiteDns',async()=>{
   let timer;const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('网站域名解析超时')),4000);timer.unref?.();});
   try{let ips=await Promise.race([this.lookup(host),deadline]);
    // VPN fake IPs get independent public resolution, then a pinned socket.
    if(ips.length&&ips.every(x=>/^198\.(18|19)\./.test(x.address)))ips=await this.resolvePublic(host);
    if(!ips.length||ips.some(x=>!publicIp(x.address)))throw Error('拒绝访问本地或保留网络地址');
    this.dnsCache.set(host,{ips,until:this.now()+this.dnsTtlMs});if(this.dnsCache.size>128)this.dnsCache.delete(this.dnsCache.keys().next().value);return ips;
   }finally{clearTimeout(timer);}
  });this.dnsPending.set(host,task);try{return await task;}finally{this.dnsPending.delete(host);}
 }
 acquire(u,ips){
  const proxy=this.proxy(u),key=JSON.stringify([u.origin,proxy,ips.map(x=>x.address)]);let pool=this.pools.get(key);
  if(pool){clearTimeout(pool.timer);count('websiteConnectionReuse');}
  else{
   if(this.pools.size>=this.maxPools){const idle=[...this.pools.values()].find(p=>!p.active);if(idle)this.retire(idle);}
   pool={key,dispatcher:this.dispatcherFactory(u,ips,proxy),active:0,temporary:this.pools.size>=this.maxPools};
   if(!pool.temporary)this.pools.set(key,pool);count('websiteConnectionCreated');
  }
  pool.active++;return pool;
 }
 retire(pool){clearTimeout(pool.timer);if(this.pools.get(pool.key)===pool)this.pools.delete(pool.key);pool.dispatcher.close().catch(()=>{});}
 release(pool){if(--pool.active!==0)return;if(pool.temporary)return this.retire(pool);pool.timer=setTimeout(()=>this.retire(pool),this.idleMs);pool.timer.unref?.();}
 async text(url,remaining=3){
  const u=websiteUrl(String(url)),ips=await this.addresses(u.hostname),pool=this.acquire(u,ips);let redirect=null;
  try{
   const r=await this.fetch(u,{dispatcher:pool.dispatcher,redirect:'manual',signal:AbortSignal.timeout(6000),headers:{'user-agent':'AgentTradeConsole/0.1','accept':'text/html,application/json,text/plain'}});
   if(r.status>=300&&r.status<400){await r.body?.cancel();if(remaining<=0)throw Error('重定向过多');const location=r.headers.get('location');if(!location)throw Error('重定向缺少目标');redirect=new URL(location,u);}
   else{
    if(!r.ok){await r.body?.cancel();throw Error(`HTTP ${r.status}`);}
    return await boundedPageText(r.body);
   }
  }finally{this.release(pool);}
  // Each redirect validates its URL and public IP pin. No cookies, credentials
  // or arbitrary headers are forwarded; only transport connections are reused.
  return this.text(redirect,remaining-1);
 }
 async close(){const pools=[...this.pools.values()];this.pools.clear();this.dnsCache.clear();await Promise.all(pools.map(p=>{clearTimeout(p.timer);return p.dispatcher.close();}));}
}
const publicReader=new PublicWebsiteReader();
export const publicText=(url,remaining=3)=>publicReader.text(url,remaining);
