import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {RpcEndpoints,rpcUrl} from '../lib/rpc-endpoints.mjs';
import {Rpc} from '../lib/network.mjs';import {createServer} from '../server.mjs';
const primary='https://primary.example',backup='https://backup.example',secret='https://private.example/v3/FAKE_TEST_SECRET?key=TEST_ONLY';
function harness(t){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'rpc-private-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 let now=1000,handler=(url,q)=>({id:q.id,result:q.method==='eth_chainId'?'0x38':'0x123'});const calls=[];
 const fetchImpl=async(url,o)=>{const q=JSON.parse(o.body);calls.push({url,q});const result=await Promise.all((Array.isArray(q)?q:[q]).map(x=>{assert.ok(Number.isSafeInteger(x.id)&&x.id>=0,'BSC public providers require unsigned request IDs');return handler(url,x);}));return {ok:true,json:async()=>Array.isArray(q)?result:result[0]};};
 const endpoints=new RpcEndpoints({data,primary,publicUrls:[backup],fetchImpl,now:()=>now,timeoutMs:50}),rpc=new Rpc(primary,{fetchImpl:endpoints.fetch});
 return {data,endpoints,rpc,calls,fetchImpl,set:f=>handler=f,advance:n=>now+=n};
}
test('custom RPC is validated, saved privately, preferred and shared by every server read lane',async t=>{
 const h=harness(t);await h.endpoints.configure(secret);h.calls.length=0;assert.equal(await h.rpc.getBlockNumber(),0x123);assert.equal(h.calls[0].url,secret);
 const state=h.endpoints.status();assert.equal(state.host,'private.example');assert.equal(state.active,'custom');assert.equal(JSON.stringify(state).includes('TEST'),false);
 assert.equal(fs.statSync(path.join(h.data,'rpc-settings.json')).mode&0o777,0o600);
 const app=createServer({rpc:new Rpc(primary,{fetchImpl:h.fetchImpl}),data:h.data,bridge:{},engine:{}});t.after(()=>{app.corla.close();app.opening.close();});
 assert.equal(app.rpc.fetch,app.readRpc.fetch);assert.equal(app.rpc.endpoints,app.readRpc.endpoints);assert.equal(app.opening.rpc.fetch,app.rpc.fetch);
 h.calls.length=0;await app.readRpc.getBlockNumber();assert.ok(h.calls.every(c=>c.url===secret));
 await app.rpcSettings.configure('');h.calls.length=0;await app.opening.rpc.getBlockNumber();assert.ok(h.calls.every(c=>c.url!==secret));
});
test('failed endpoint switches and cools down; custom priority returns after recovery',async t=>{
 const h=harness(t);await h.endpoints.configure(secret);let down=true;h.set((u,q)=>{if(u===secret&&down)throw Error('network '+secret);return {id:q.id,result:q.method==='eth_chainId'?'0x38':'0x123'};});h.calls.length=0;
 assert.equal(await h.rpc.getBlockNumber(),0x123);assert.equal(h.endpoints.status().fallback,true);assert.ok(h.calls.some(c=>c.url===primary+'/'));
 h.calls.length=0;await h.rpc.getBlockNumber();assert.ok(h.calls.every(c=>c.url!==secret));down=false;h.advance(3001);h.calls.length=0;await h.rpc.getBlockNumber();assert.equal(h.calls[0].url,secret);
});
test('wrong chain never serves reads and invalid settings preserve the previous configuration',async t=>{
 const h=harness(t);await h.endpoints.configure(secret);h.set((u,q)=>({id:q.id,result:q.method==='eth_chainId'?'0x1':'0x123'}));
 await assert.rejects(h.endpoints.configure('https://wrong.example'),/原设置保持不变/);assert.equal(h.endpoints.custom,secret);assert.equal(h.calls.filter(c=>c.url==='https://wrong.example/'&&c.q.some(q=>q.method!=='eth_chainId')).length,0);
 for(const url of ['file:///tmp/a','http://localhost:8797','https://user:pass@example.com','https://a.example/#fragment'])assert.throws(()=>rpcUrl(url));
});
test('EVM reverts remain errors, while rate limits fail over; transaction writes never reach a provider',async t=>{
 const h=harness(t);h.set((u,q)=>q.method==='eth_chainId'?{id:q.id,result:'0x38'}:{id:q.id,error:{code:3,message:'execution reverted'}});
 await assert.rejects(h.rpc.call({}),/execution reverted/);assert.ok(h.calls.every(c=>c.url===primary+'/'));
 h.calls.length=0;h.set((u,q)=>q.method==='eth_chainId'?{id:q.id,result:'0x38'}:u===primary+'/'?{id:q.id,error:{code:-32005,message:'rate limit'}}:{id:q.id,result:'0x456'});assert.equal(await h.rpc.getBlockNumber(),0x456);assert.ok(h.calls.some(c=>c.url===backup+'/'));
 const count=h.calls.length;await assert.rejects(h.endpoints.fetch('',{body:JSON.stringify({method:'eth_sendRawTransaction',params:[]})}),/forbidden/);assert.equal(h.calls.length,count);
});
test('a lagging receipt node falls back without rebroadcast; missing receipts remain pending',async t=>{
 const h=harness(t),tx='0x'+'1'.repeat(64);let mined=true;
 h.set((u,q)=>({id:q.id,result:q.method==='eth_chainId'?'0x38':u===backup+'/'&&mined?{transactionHash:tx,status:'0x1'}:null}));
 assert.equal((await h.rpc.getTransactionReceipt(tx)).transactionHash,tx);mined=false;assert.equal(await h.rpc.getTransactionReceipt(tx),null);assert.ok(h.calls.every(c=>(Array.isArray(c.q)?c.q:[c.q]).every(q=>!q.method.startsWith('eth_send'))));
});
test('network errors never disclose private URL credentials; failed chain probe also stays masked',async t=>{
 const h=harness(t);await h.endpoints.configure(secret);h.set(()=>{throw Error(secret);});await assert.rejects(h.rpc.getBlockNumber(),e=>e.code==='RPC_UNAVAILABLE'&&!e.message.includes('SECRET'));
 await assert.rejects(h.endpoints.configure(secret),e=>!e.message.includes('SECRET'));assert.equal(JSON.stringify(h.endpoints.status()).includes('SECRET'),false);
});
test('provider JSON errors cannot echo an endpoint API key into order logs',async t=>{
 const h=harness(t);await h.endpoints.configure(secret);h.set((u,q)=>({id:q.id,error:{code:3,message:'execution reverted '+secret,data:{reason:'FAKE_TEST_SECRET'}}}));
 await assert.rejects(h.rpc.call({}),e=>e.message.includes('execution reverted')&&!e.message.includes('TEST')&&!JSON.stringify(e.data).includes('SECRET'));
});
test('single-only RPC providers work without disabling chain verification or batching elsewhere',async t=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'rpc-single-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));let singles=0;
 const pool=new RpcEndpoints({data,primary,publicUrls:[],fetchImpl:async(u,o)=>{const q=JSON.parse(o.body);if(!Array.isArray(q))singles++;return {ok:true,json:async()=>Array.isArray(q)?{id:null,error:{code:-32600,message:'batch unsupported'}}:{id:q.id,result:q.method==='eth_chainId'?'0x38':'0x123'}};}});
 await pool.configure(secret);const rpc=new Rpc(primary,{fetchImpl:pool.fetch});assert.equal(await rpc.getBlockNumber(),0x123);assert.equal(singles,3);
});
test('RPC API requires local auth; neither GET nor save returns a URL/key',async t=>{
 const h=harness(t),app=createServer({rpc:new Rpc(primary,{fetchImpl:h.fetchImpl}),data:h.data,bridge:{},engine:{}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>{app.server.close();app.server.closeAllConnections();app.corla.close();app.opening.close();});const url='http://127.0.0.1:'+app.server.address().port+'/api/rpc';
 assert.equal((await fetch(url)).status,401);const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-console-token':app.token},body:JSON.stringify({url:secret})});assert.equal(response.status,200);assert.equal((await response.text()).includes('SECRET'),false);
 const current=await (await fetch(url,{headers:{'x-console-token':app.token}})).json();assert.equal(current.configured,true);assert.equal(Object.hasOwn(current,'url'),false);
});
