import path from 'node:path';
import {load,save} from './common.mjs';

const PUBLIC=['https://bsc-dataseed.bnbchain.org','https://bsc-dataseed1.defibit.io','https://bsc-dataseed1.ninicoin.io'];
const READS=new Set(['eth_chainId','eth_blockNumber','eth_call','eth_getCode','eth_getStorageAt','eth_getBalance','eth_gasPrice','eth_getBlockByNumber','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getLogs','eth_getTransactionCount','eth_estimateGas']);
const transient=r=>r?.error&&!/revert|invalid (argument|param)|insufficient funds/i.test(r.error.message||'')&&(/rate|limit|busy|timeout|timed out|unavailable|overload|upstream|header not found|missing trie/i.test(r.error.message||'')||[-32005,-32016,-32603].includes(r.error.code));
const missingReceipt=r=>r?.result===null;
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
 constructor({data,primary,fetchImpl=fetch,publicUrls=PUBLIC,now=Date.now,timeoutMs=1000}={}){
  this.file=data?path.join(data,'rpc-settings.json'):null;this.rawFetch=fetchImpl;this.now=now;this.timeoutMs=timeoutMs;this.publicUrls=publicUrls.map(rpcUrl);this.health=new Map();this.revision=0;this.saving=false;this.last=null;
  const stored=this.file?load(this.file,{}):{};this.custom=stored.url?rpcUrl(stored.url):null;this.primary=primary?rpcUrl(primary):this.publicUrls[0];this.fetch=this.fetch.bind(this);
 }
 state(url){if(!this.health.has(url))this.health.set(url,{until:0,verifiedAt:0});return this.health.get(url);}
 status(){return {configured:!!this.custom,host:this.custom?new URL(this.custom).hostname:null,chainId:56,active:this.last?.kind||'public',fallback:this.last?.kind==='public'&&!!this.custom,scope:'chain-reads',checkedAt:this.last?.at||null};}
 candidates(){const urls=[...new Set([this.custom,this.primary,...this.publicUrls].filter(Boolean))];return urls.filter(u=>this.state(u).until<=this.now());}
 async request(url,queries,signal){
  const signals=[AbortSignal.timeout(this.timeoutMs),...(signal?[signal]:[])];
  const response=await this.rawFetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(queries),redirect:'error',signal:AbortSignal.any(signals)});
  if(!response.ok)throw Error('RPC HTTP '+response.status);
  const body=await response.json(),rows=Array.isArray(body)?body:[body];
  const expected=Array.isArray(queries)?queries:[queries];
  if(rows.some(r=>!r||typeof r!=='object'))throw Error('RPC response incomplete');
  for(const r of rows)if(r.error)r.error=hideEndpointSecrets(r.error,url);
  const missing=expected.filter(q=>!rows.some(r=>r.id===q.id&&('result'in r||r.error)));
  if(missing.length&&Array.isArray(queries)&&!rows.some(transient)){
   const singles=await Promise.all(missing.map(q=>this.request(url,q,signal)));
   return [...rows.filter(r=>expected.some(q=>q.id===r.id)),...singles];
  }
  if(missing.length)throw Error('RPC response incomplete');
  return body;
 }
 async verify(url,signal){
  const state=this.state(url);if(state.verifiedAt&&this.now()-state.verifiedAt<300000)return;
  if(!state.verifying)state.verifying=(async()=>{const r=await this.request(url,[{jsonrpc:'2.0',id:2000000056,method:'eth_chainId',params:[]}],signal),v=(Array.isArray(r)?r:[r])[0];if(v.result!=='0x38'&&v.result!=='0x038')throw Error('RPC_CHAIN_MISMATCH');state.verifiedAt=this.now();})().finally(()=>{state.verifying=null;});
  return state.verifying;
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
  const revision=this.revision,candidates=this.candidates();let nullResult=null;
  for(const url of candidates){
   if(options.signal?.aborted)break;
   try{
    await this.verify(url,options.signal);const result=await this.request(url,q,options.signal),rows=Array.isArray(result)?result:[result];
    if(rows.some(transient))throw Error('RPC temporarily unavailable');
    // A lagging endpoint can return null for a mined original. Ask the next
    // verified endpoint, without ever resubmitting the transaction.
    const receiptOnly=queries.every(x=>['eth_getTransactionByHash','eth_getTransactionReceipt'].includes(x.method));
    if(receiptOnly&&rows.every(missingReceipt)){nullResult??=result;continue;}
    if(revision===this.revision)this.last={kind:url===this.custom?'custom':'public',at:this.now()};
    return {ok:true,json:async()=>result};
   }catch(e){this.state(url).until=this.now()+(e.message==='RPC_CHAIN_MISMATCH'?300000:3000);}
  }
  if(nullResult!==null)return {ok:true,json:async()=>nullResult};
  throw Object.assign(Error('RPC 节点暂不可用，已尝试备用节点；请稍后重试'),{code:'RPC_UNAVAILABLE'});
 }
}
