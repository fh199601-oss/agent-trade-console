import dns from 'node:dns/promises';
import {Agent,fetch as httpFetch} from 'undici';
import {publicIp,pinnedWebsiteDispatcher,websiteProxy} from './network.mjs';

const fake=ip=>/^198\.(18|19)\./.test(ip);
// Fake-IP DNS is useful to a working VPN but some local routes reset these
// connections. Resolve ONLY the hostname via public DoH, then pin the RPC TLS
// connection. The private URL path/key never goes to the DNS service. Do not
// modify OS DNS/proxies, replace the RPC provider, or disable TLS verification.
export class RpcTransport{
 constructor({fetchImpl=httpFetch,lookup=host=>dns.lookup(host,{all:true,family:4}),resolvePublic,dispatcherFactory=pinnedWebsiteDispatcher,proxy=websiteProxy,now=Date.now,idleMs=60000,maxPools=8}={}){
  Object.assign(this,{fetchImpl,lookup,dispatcherFactory,proxy,now,idleMs,maxPools});this.cache=new Map();this.pending=new Map();this.pools=new Map();this.closed=false;
  this.resolvePublic=resolvePublic||this.resolveDns.bind(this);this.fetch=this.fetch.bind(this);
 }
 async resolveDns(host){
  // Fixed bootstrap address avoids asking the broken/fake DNS for DoH itself.
  this.dnsAgent??=new Agent({connect:{timeout:1500,lookup:(h,o,cb)=>o.all?cb(null,[{address:'1.1.1.1',family:4}]):cb(null,'1.1.1.1',4)}});
  const r=await this.fetchImpl('https://cloudflare-dns.com/dns-query?type=A&name='+encodeURIComponent(host),{dispatcher:this.dnsAgent,signal:AbortSignal.timeout(2000),headers:{accept:'application/dns-json'},redirect:'error'});
  if(!r.ok){await r.body?.cancel();throw Error('RPC DNS unavailable');}
  const json=await r.json();if(json.Status!==0)throw Error('RPC DNS unavailable');
  const rows=(json.Answer||[]).filter(x=>x.type===1);return {ips:rows.map(x=>({address:x.data,family:4})),ttlMs:Math.min(60,...rows.map(x=>Number(x.TTL)||30))*1000};
 }
 async addresses(host){
  const cached=this.cache.get(host);if(cached?.until>this.now())return cached.ips;
  if(this.pending.has(host))return this.pending.get(host);
  const task=(async()=>{
   let timer;try{
    const local=await Promise.race([this.lookup(host),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('RPC DNS timeout')),1500);})]);
    let ips=null,ttlMs=60000;
    if(local.length&&local.every(x=>fake(x.address))){
     const result=await this.resolvePublic(host);ips=result.ips;ttlMs=Math.max(1000,Math.min(60000,result.ttlMs||30000));
     if(!ips?.length||ips.some(x=>x.family!==4||!publicIp(x.address)))throw Error('RPC DNS did not return public addresses');
    }
    this.cache.set(host,{ips,until:this.now()+ttlMs});if(this.cache.size>64)this.cache.delete(this.cache.keys().next().value);return ips;
   }finally{clearTimeout(timer);}
  })();this.pending.set(host,task);try{return await task;}finally{this.pending.delete(host);}
 }
 retire(pool){clearTimeout(pool.timer);if(this.pools.get(pool.key)===pool)this.pools.delete(pool.key);void pool.dispatcher.close().catch(()=>{});}
 async fetch(url,options){
  if(this.closed)throw Error('RPC transport closed');
  const u=new URL(url),ips=await this.addresses(u.hostname);options.signal?.throwIfAborted();if(this.closed)throw Error('RPC transport closed');
  if(!ips)return this.fetchImpl(url,options);
  const proxy=this.proxy(u),key=JSON.stringify([u.origin,proxy,ips.map(x=>x.address)]);let pool=this.pools.get(key);
  if(!pool){
   if(this.pools.size>=this.maxPools){const idle=[...this.pools.values()].find(p=>!p.active);if(idle)this.retire(idle);}
   pool={key,active:0,dispatcher:this.dispatcherFactory(u,ips,proxy),temporary:this.pools.size>=this.maxPools};if(!pool.temporary)this.pools.set(key,pool);
  }
  clearTimeout(pool.timer);pool.active++;
  try{return await this.fetchImpl(url,{...options,dispatcher:pool.dispatcher});}
  catch(e){if(!options.signal?.aborted)this.cache.delete(u.hostname);throw e;}
  finally{if(--pool.active===0){if(pool.temporary)this.retire(pool);else{pool.timer=setTimeout(()=>this.retire(pool),this.idleMs);pool.timer.unref?.();}}}
 }
 async close(){this.closed=true;const pools=[...this.pools.values()];this.pools.clear();this.cache.clear();await Promise.all(pools.map(p=>{clearTimeout(p.timer);return p.dispatcher.close();}));await this.dnsAgent?.close();}
}
