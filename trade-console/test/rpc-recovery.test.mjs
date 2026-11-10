// Deterministic transports only. No wallet, signature, broadcast or real RPC.
import test from 'node:test';import assert from 'node:assert/strict';
import {RpcEndpoints} from '../lib/rpc-endpoints.mjs';
const primary='https://primary.example/',backup='https://backup.example/';
const query=(id,method)=>({jsonrpc:'2.0',id,method,params:[]});
const ok=q=>({id:q.id,result:q.method==='eth_chainId'?'0x38':'0x123'});
const tick=()=>new Promise(r=>setImmediate(r));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(handler,options={}){
 const seen=[];const pool=new RpcEndpoints({primary,publicUrls:[backup],hedgeMs:20,timeoutMs:100,...options,fetchImpl:async(url,o)=>{
  const value=JSON.parse(o.body),qs=Array.isArray(value)?value:[value];seen.push({url,qs});
  const rows=await handler(url,qs,o.signal);return {ok:true,json:async()=>Array.isArray(value)?rows:rows[0]};
 }});
 const call=async(q,signal)=>(await pool.fetch('',{body:JSON.stringify(q),signal})).json();return {pool,call,seen};
}
test('slow preferred RPC is hedged without waiting for timeout; cancelled loser stays healthy',async()=>{
 let cancelled=0;
 const h=fixture(async(url,qs,signal)=>{
  if(url===primary&&qs[0].method!=='eth_chainId')await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{cancelled++;reject(signal.reason);},{once:true}));
  return qs.map(ok);
 });
 const r=await h.call(query(1,'eth_blockNumber'));assert.equal(r.result,'0x123');await tick();
 assert.equal(cancelled,1);assert.equal(h.pool.state(primary).until,0);assert.equal(h.pool.last.kind,'public');
 assert.equal(h.seen.filter(c=>c.url===backup&&c.qs[0].method==='eth_blockNumber').length,1);
});
test('one transient batch item cannot discard successful reads or cool down a healthy endpoint',async()=>{
 const h=fixture(async(url,qs)=>qs.map(q=>q.method==='eth_getLogs'?{id:q.id,error:{code:-32005,message:'rate limit'}}:ok(q)));
 const result=await h.call([query(1,'eth_getBalance'),query(2,'eth_getLogs')]);
 assert.equal(result[0].result,'0x123');assert.equal(result[1].error.code,'RPC_UNAVAILABLE');assert.equal(h.pool.state(primary).until,0);
 assert.ok(h.seen.filter(c=>c.url===backup).every(c=>c.qs.every(q=>q.method!=='eth_getBalance')));
 h.seen.length=0;assert.equal((await h.call(query(3,'eth_getBalance'))).result,'0x123');assert.equal(h.seen[0].url,primary);
});
test('a slow preferred node yields between dependent reads, then regains first priority',async()=>{
 let now=1000;const h=fixture(async(url,qs,signal)=>{
  if(url===primary&&qs[0].method!=='eth_chainId')await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  if(url===backup&&qs[0].method!=='eth_chainId')now+=100;return qs.map(ok);
 },{now:()=>now});
 await h.call(query(1,'eth_blockNumber'));assert.equal(h.pool.state(primary).until,0);assert.equal(h.pool.candidates()[0],backup);
 h.seen.length=0;await h.call(query(2,'eth_getBalance'));assert.equal(h.seen[0].url,backup);assert.equal(h.seen.length,1);
 now+=3001;assert.equal(h.pool.candidates()[0],primary);
});
test('reverted calls are authoritative and are never retried on a different node',async()=>{
 const h=fixture(async(url,qs)=>qs.map(q=>q.method==='eth_call'?{id:q.id,error:{code:3,message:'execution reverted: forbidden'}}:ok(q)));
 const r=await h.call([query(1,'eth_call'),query(2,'eth_getBalance')]);assert.equal(r[0].error.code,3);assert.equal(r[1].result,'0x123');assert.ok(h.seen.every(c=>c.url===primary));
});
test('cancelling one caller cannot poison the shared chain verification of another caller',async()=>{
 let release,begin;const gate=new Promise(r=>release=r),started=new Promise(r=>begin=r);
 const h=fixture(async(url,qs)=>{if(qs[0].method==='eth_chainId'){begin();await gate;}return qs.map(ok);},{hedgeMs:1000});
 const controller=new AbortController();const one=h.call(query(1,'eth_blockNumber'),controller.signal);await started;
 const two=h.call(query(2,'eth_getBalance'));controller.abort(Error('caller cancelled'));release();
 await assert.rejects(one,/cancelled/);assert.equal((await two).result,'0x123');assert.equal(h.pool.state(primary).until,0);
 assert.equal(h.seen.filter(c=>c.qs[0].method==='eth_chainId').length,1);
});
test('all endpoints in cooldown allow bounded half-open recovery without waiting three seconds',async()=>{
 let down=true;const h=fixture(async(url,qs)=>{if(down)throw Error('connection reset');return qs.map(ok);});
 await assert.rejects(h.call(query(1,'eth_blockNumber')),e=>e.code==='RPC_UNAVAILABLE');assert.equal(h.pool.candidates().length,1);
 down=false;assert.equal((await h.call(query(2,'eth_blockNumber'))).result,'0x123');
});
test('wrong-chain quarantine cannot be bypassed by half-open fallback or a race',async()=>{
 const h=fixture(async(url,qs)=>qs.map(q=>({id:q.id,result:'0x1'})));
 await assert.rejects(h.call(query(1,'eth_getBalance')),e=>e.code==='RPC_UNAVAILABLE');assert.deepEqual(h.pool.candidates(),[]);
 const count=h.seen.length;await assert.rejects(h.call(query(2,'eth_getBalance')));assert.equal(h.seen.length,count);assert.ok(h.seen.every(c=>c.qs.every(q=>q.method==='eth_chainId')));
});
test('temporary chain verification error is not treated as a wrong chain for five minutes',async()=>{
 let limited=true;const h=fixture(async(url,qs)=>qs.map(q=>limited?{id:q.id,error:{code:-32005,message:'rate limit'}}:ok(q)));
 await assert.rejects(h.call(query(1,'eth_blockNumber')));limited=false;assert.equal((await h.call(query(2,'eth_blockNumber'))).result,'0x123');
});
test('receipt fallback operates per item in mixed batches and never repeats successful balance reads',async()=>{
 const hash='0x'+'11'.repeat(32),h=fixture(async(url,qs)=>qs.map(q=>q.method==='eth_getTransactionReceipt'?{id:q.id,result:url===primary?null:{transactionHash:hash,status:'0x1'}}:ok(q)));
 const r=await h.call([query(1,'eth_getBalance'),query(2,'eth_getTransactionReceipt')]);assert.equal(r[0].result,'0x123');assert.equal(r[1].result.transactionHash,hash);
 assert.ok(h.seen.filter(c=>c.url===backup).every(c=>c.qs.every(q=>q.method!=='eth_getBalance')));
});
test('all hedge lanes retain the read-only allowlist',async()=>{
 const h=fixture(async(url,qs)=>qs.map(ok));for(const method of ['eth_sendRawTransaction','eth_sendTransaction','personal_sign','eth_sign'])await assert.rejects(h.call(query(1,method)),/forbidden/);assert.equal(h.seen.length,0);
});
test('partial omitted response with failed single fallback still preserves good members',async()=>{
 const h=fixture(async(url,qs)=>{if(qs[0].method==='eth_chainId')return qs.map(ok);if(qs.length>1)return [ok(qs[0])];throw Error('read timeout');});
 const r=await h.call([query(1,'eth_getBalance'),query(2,'eth_getLogs')]);assert.equal(r[0].result,'0x123');assert.equal(r[1].error.code,'RPC_UNAVAILABLE');
});
test('a response with the right id but no result/error is never accepted as a balance',async()=>{
 const h=fixture(async(url,qs)=>qs.map(q=>url===primary&&q.method==='eth_getBalance'?{id:q.id}:ok(q)));
 const r=await h.call([query(1,'eth_blockNumber'),query(2,'eth_getBalance')]);assert.equal(r[0].result,'0x123');assert.equal(r[1].result,'0x123');assert.ok(h.seen.some(c=>c.url===backup&&c.qs.some(q=>q.id===2)));
});
