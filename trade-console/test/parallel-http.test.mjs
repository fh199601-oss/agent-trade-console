import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createServer} from '../server.mjs';import {createConsoleClient} from '../public/session-client.mjs';import {prepareIndependent,runInstantTrades,executeIndependent} from '../public/trade-workflow.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const token='0x'+'e1'.repeat(20),rows=Array.from({length:100},(_,n)=>({id:'parallel-'+(n+1),intent:{account:n+1,asset:token,side:'sell',percent:'100',currency:'WBNB',slippageBps:300},status:'PREPARED'}));
async function fixture(t){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'parallel-http-')),started=[],slow=deferred(),allStarted=deferred(),calls=[];
 const work=async(intent,id,options)=>{started.push(id);if(started.length===100)allStarted.resolve();assert.equal(options.swapReceiptWaitMs,0);if(id===rows[0].id)await slow.promise;return {id,intent,status:'PENDING',orderId:'synthetic-'+id};};
 const engine={list:()=>[],running:new Set(),run:work,prepare:(i,id)=>work(i,id,{swapReceiptWaitMs:0}),execute:(id,o)=>work(rows.find(r=>r.id===id).intent,id,o)},app=createServer({data,engine,rpc:{},bridge:{}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{slow.resolve();await new Promise(r=>{app.server.close(r);app.server.closeAllConnections();});fs.rmSync(data,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.server.address().port,client=createConsoleClient({fetchImpl:(url,o)=>{calls.push(url);return fetch(base+url,o);}});
 return {app,base,client,calls,slow,started,allStarted};
}
for(const action of ['run','execute','prepare'])test('100 '+action+' wallets use one HTTP dispatch and stream 99 results before a slow wallet',async t=>{
 const h=await fixture(t),visible=[],almostDone=deferred(),options={onResult:r=>{visible.push(r);if(visible.length===99)almostDone.resolve();},runMany:(selected,onResult)=>h.client.requestMany(selected.map(o=>({path:action,body:{id:o.id,intent:o.intent,execute:true,fastReturn:true,authorization:'synthetic only'}})),{onResult})};
 const running=action==='prepare'?prepareIndependent(rows,()=>assert.fail('per-wallet HTTP forbidden'),options):action==='run'?runInstantTrades(rows,()=>assert.fail('per-wallet HTTP forbidden'),options):executeIndependent(rows,()=>assert.fail('per-wallet HTTP forbidden'),options);
 await h.allStarted.promise;await almostDone.promise;assert.equal(visible.length,99);assert.equal(h.started.length,100);assert.equal(h.calls.filter(x=>x==='/api/parallel').length,1);h.slow.resolve();const results=await running;assert.equal(results.length,100);assert.ok(results.every(o=>o.status==='PENDING'));assert.deepEqual(results.map(o=>o.id),rows.map(o=>o.id));
});
test('parallel HTTP validates auth and duplicate IDs before any dispatch',async t=>{
 const h=await fixture(t),post=(requests,auth=true)=>fetch(h.base+'/api/parallel',{method:'POST',headers:{'content-type':'application/json',...(auth?{'x-console-token':h.app.token}:{})},body:JSON.stringify({requests})});
 const r={path:'run',body:{id:'same',intent:rows[0].intent}};
 assert.equal((await post([r],false)).status,401);for(const rs of [[r,r],Array.from({length:201},(_,n)=>({...r,body:{...r.body,id:'p'+n}})),[{...r,path:'shutdown'}]])assert.equal((await post(rs)).status,400);assert.equal(h.started.length,0);
});
test('stream disconnect preserves completed wallets and never resends unknown ones',async()=>{
 const ids=rows.slice(0,3),visible=[],calls=[];
 const client=createConsoleClient({fetchImpl:async(url)=>{calls.push(url);if(url==='/api/bootstrap')return Response.json({service:'agent-trade-console',token:'a'.repeat(64),mode:'LIVE',wallets:[]});let count=0;return new Response(new ReadableStream({pull(c){if(count++===0)c.enqueue(new TextEncoder().encode(JSON.stringify({id:ids[1].id,value:{...ids[1],status:'CONFIRMED'}})+'\n'));else c.error(Error('synthetic disconnect'));}}),{headers:{'content-type':'application/x-ndjson'}});}});
 const result=await runInstantTrades(ids,()=>assert.fail(),{runMany:(selected,onResult)=>client.requestMany(selected.map(o=>({path:'run',body:{id:o.id}})),{onResult}),onResult:o=>visible.push(o)});
 assert.deepEqual(result.map(o=>o.status),['SUBMISSION_UNKNOWN','CONFIRMED','SUBMISSION_UNKNOWN']);assert.equal(calls.filter(x=>x==='/api/parallel').length,1);assert.equal(visible.length,3);
});
