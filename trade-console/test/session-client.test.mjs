import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createConsoleClient} from '../public/session-client.mjs';import {createServer} from '../server.mjs';
const expired=()=>Response.json({error:{code:'LOCAL_SESSION_EXPIRED',message:'本地会话验证失败'},details:{requestAccepted:false}},{status:401});
const boot=token=>({service:'agent-trade-console',token,mode:'SIMULATION',wallets:[],settings:{buy:[],sell:[]}});
test('parallel and late auth failures share one renewal and recover reads without reloading',async()=>{
 let token='a'.repeat(64),loads=0,reads=0;let late;const sessions=[];
 const c=createConsoleClient({onSession:b=>sessions.push(b.mode),fetchImpl:async(url,o)=>{
  if(url.endsWith('bootstrap')){loads++;return Response.json(boot(token));}reads++;
  if(o.headers['x-console-token']!==token){if(url.endsWith('orders'))await new Promise(r=>late=r);return expired();}
  return Response.json({ok:true});
 }});
 await c.refreshSession();token='b'.repeat(64);
 const p=c.request('orders'),results=await Promise.all([c.request('holdings?ca=test'),c.request('wallets'),c.request('market?ca=test')]);late();results.push(await p);
 assert.ok(results.every(r=>r.ok));assert.equal(loads,2);assert.equal(reads,8);assert.equal(sessions.length,2);
});
test('a rejected write renews the local session but is never automatically resubmitted',async()=>{
 let token='a'.repeat(64),writes=0,accepted=0;const body={id:'stable-id',execute:true};
 const c=createConsoleClient({fetchImpl:async(url,o)=>{if(url.endsWith('bootstrap'))return Response.json(boot(token));writes++;assert.equal(o.body,JSON.stringify(body));if(o.headers['x-console-token']!==token)return expired();accepted++;return Response.json({ok:true});}});
 await c.refreshSession();token='b'.repeat(64);await assert.rejects(c.request('run',body),e=>e.code==='SESSION_REFRESHED_RETRY'&&e.details.requestAccepted===false);assert.equal(writes,1);assert.equal(accepted,0);
 assert.deepEqual(await c.request('run',body),{ok:true});assert.equal(accepted,1);
});
test('timeouts, malformed responses and wallet failures never trigger a retry or local renewal',async()=>{
 for(const fail of [()=>{throw Object.assign(Error('timeout'),{name:'TimeoutError'});},()=>{throw Error('network lost');},()=>new Response('bad json'),()=>Response.json({error:{code:'WALLET_SESSION_EXPIRED',message:'session expired'}},{status:401}),()=>Response.json({error:{code:'LOCAL_SESSION_EXPIRED'}},{status:500})]){
  let loads=0,requests=0;const c=createConsoleClient({fetchImpl:async url=>{if(url.endsWith('bootstrap')){loads++;return Response.json(boot('a'.repeat(64)));}requests++;return fail();}});
  await assert.rejects(c.request('run',{id:'original'}));assert.equal(loads,1);assert.equal(requests,1);
 }
});
test('a second rejection stops after one read retry; old-server exact errors remain compatible',async()=>{
 let loads=0,requests=0;const c=createConsoleClient({fetchImpl:async url=>{if(url.endsWith('bootstrap')){loads++;return Response.json(boot(String(loads).repeat(64)));}requests++;return expired();}});
 await assert.rejects(c.request('orders'));assert.equal(loads,2);assert.equal(requests,2);
 let old=true;const legacy=createConsoleClient({fetchImpl:async url=>url.endsWith('bootstrap')?Response.json(boot('a'.repeat(64))):old?(old=false,Response.json({error:{message:'本地会话验证失败',code:'ERROR'}},{status:400})):Response.json([])});assert.deepEqual(await legacy.request('orders'),[]);
});
test('failed bootstrap does not poison the next recovery and wrong services are rejected',async()=>{
 let fail=true;const c=createConsoleClient({fetchImpl:async()=>fail?Promise.reject(Error('offline')):Response.json(boot('a'.repeat(64)))});await assert.rejects(c.refreshSession(),/offline/);fail=false;await c.refreshSession();
 const wrong=createConsoleClient({fetchImpl:async()=>Response.json({...boot('a'.repeat(64)),service:'other-service'})});await assert.rejects(wrong.refreshSession(),/身份/);
});
test('actual HTTP service restart rotates auth; the same client recovers reads without entering any write handler',async()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'session-http-'));let accepted=0,app;
 const engine={list:()=>[],running:new Set(),run:async()=>{accepted++;throw Error('fake only');}},make=live=>createServer({engine,rpc:{},bridge:{},data,live});
 app=make(false);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const port=app.server.address().port,base='http://127.0.0.1:'+port,modes=[];
 // Close test sockets to isolate token rotation from stale keep-alive transport
 // errors, which are covered above and must never replay a write.
 const c=createConsoleClient({fetchImpl:(u,o)=>fetch(base+u,{...o,headers:{...o.headers,connection:'close'}}),onSession:b=>modes.push(b.mode)});
 try{
  await c.refreshSession();await c.request('orders');await new Promise(r=>app.server.close(r));app=make(true);await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
  await assert.rejects(c.request('run',{id:'never-submit'}),e=>e.code==='SESSION_REFRESHED_RETRY');assert.equal(accepted,0);assert.deepEqual(await c.request('orders'),[]);assert.deepEqual(modes,['SIMULATION','LIVE']);
  const noAuth=await fetch(base+'/api/run',{method:'POST',headers:{'content-type':'application/json'},body:'{"id":"also-never"}'});assert.equal(noAuth.status,401);assert.equal((await noAuth.json()).details.requestAccepted,false);assert.equal(accepted,0);
  const cross=await fetch(base+'/api/bootstrap',{headers:{origin:'https://evil.test'}});assert.equal(cross.status,400);
  assert.equal((await fetch(base+'/session-client.mjs')).status,200);
 }finally{await new Promise(r=>app.server.close(r));fs.rmSync(data,{recursive:true,force:true});}
});
test('opening read/arm endpoints are supported but arbitrary subpaths and auto retry of arm are forbidden',async()=>{
 let token='a'.repeat(64),arms=0,checks=0;const c=createConsoleClient({fetchImpl:async(url,opts)=>{if(url.endsWith('bootstrap'))return Response.json(boot(token));if(url.endsWith('opening/check'))checks++;if(url.endsWith('opening/arm'))arms++;return opts.headers['x-console-token']!==token?expired():Response.json({ok:true});}});
 await c.refreshSession();token='b'.repeat(64);assert.deepEqual(await c.request('opening/check',{}),{ok:true});assert.equal(checks,2);token='c'.repeat(64);await assert.rejects(c.request('opening/arm',{id:'stable',confirmed:true}),e=>e.code==='SESSION_REFRESHED_RETRY');assert.equal(arms,1);await assert.rejects(c.request('opening/../../execute',{}),/路径无效/);
});
