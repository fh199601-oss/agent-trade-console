import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {pausedTasks,resumeTasks,controlTasks} from '../lib/task-center.mjs';import {taskModel,controlTaskMembers} from '../public/task-center.mjs';
import {OpeningSell} from '../lib/opening-sell.mjs';import {bindings,save} from '../lib/common.mjs';
import {createConsoleClient} from '../public/session-client.mjs';
import {createServer} from '../server.mjs';
const w=bindings()[0],token='0x'+'1'.repeat(40);
function services(){let calls=[];const c=[{id:'c1',status:'PAUSED',account:1,sellJobId:'child'},{id:'stopped',status:'STOPPED'},{id:'done',status:'DONE'},{id:'bad',status:'PAUSED',cancelled:true}];const o=[{id:'child',status:'PAUSED',sourceClaim:'claim'},{id:'standalone',status:'PAUSED'},{id:'cancelled',status:'PAUSED',cancelRequested:true}];
 const service=(kind,rows)=>({list:()=>rows,resume:id=>{calls.push(kind+':'+id);const j=rows.find(j=>j.id===id);j.status='ARMED';return j;}});return {corla:service('c',c),opening:service('o',o),calls};}
test('bulk restore targets explicit paused snapshot, not stopped/completed tasks or linked children twice',()=>{
 const h=services(),refs=pausedTasks(h.corla,h.opening);assert.deepEqual(refs,[{kind:'corla',id:'c1'},{kind:'opening',id:'standalone'}]);
 const input={tasks:[...refs,{kind:'corla',id:'stopped'}],confirmed:true};assert.equal(resumeTasks(h.corla,h.opening,input).resumed,2);assert.deepEqual(h.calls,['c:c1','o:standalone']);assert.equal(resumeTasks(h.corla,h.opening,input).resumed,0);assert.equal(h.calls.length,2);
});
test('invalid or unconfirmed bulk request is rejected before any mutation; per-task error preserves other results',()=>{
 const h=services(),refs=pausedTasks(h.corla,h.opening);for(const input of [{tasks:refs},{tasks:[],confirmed:true},{tasks:[...refs,refs[0]],confirmed:true},{tasks:[...refs,{kind:'shell',id:'bad'}],confirmed:true}])assert.throws(()=>resumeTasks(h.corla,h.opening,input));assert.equal(h.calls.length,0);
 h.corla.resume=()=>{throw Error('Wallet binding changed');};const r=resumeTasks(h.corla,h.opening,{tasks:refs,confirmed:true});assert.equal(r.resumed,1);assert.match(r.results[0].message,/binding/);
});
test('task model keeps all old paused tasks visible and hides linked child duplication',()=>{
 const corla=Array.from({length:30},(_,i)=>({id:'job'+i,status:i<20?'DONE':'PAUSED',account:1,name:'Synthetic',sellJobId:'child'+i}));const opening=corla.map(j=>({id:j.sellJobId,status:j.status==='DONE'?'COMPLETED':'PAUSED',config:{accounts:[1]}}));const r=taskModel({corla,opening,paused:[]});assert.equal(r.active.length,10);assert.equal(r.corlaHistory.length,20);assert.equal(r.openingHistory.length,0);
});
function openingHarness(t){const data=fs.mkdtempSync(path.join(os.tmpdir(),'resume-opening-'));let sends=0;const orders=new Map(),engine={live:true,get:id=>orders.get(id),execute:()=>{sends++;assert.fail('Resume must not sign directly');}};const options={data,engine,rpc:{},bridge:{},detector:{},autoSchedule:false,now:()=>1000};const m=new OpeningSell(options);t.after(()=>{m.close();fs.rmSync(data,{recursive:true,force:true});});
 const job={id:'paused',status:'PAUSED',mode:'LIVE',config:{asset:token,accounts:[w.account],percent:'50',slippageBps:5000,currency:'AUTO'},bindings:[w],createdAt:0,expiresAt:10000,rows:[{account:w.account,status:'WAITING',attempts:0}],authorization:'fixture policy'};m.jobs.set(job.id,job);return {m,job,options,orders,sends:()=>sends};}
test('standalone restart resumes original policy and expiry only on explicit click',t=>{
 const h=openingHarness(t);h.job.status='ARMED';h.m.persist();const restarted=new OpeningSell(h.options);t.after(()=>restarted.close());assert.equal(restarted.jobs.get(h.job.id).status,'PAUSED');assert.equal(h.sends(),0);const j=restarted.resume(h.job.id);assert.equal(j.status,'ARMED');assert.equal(j.expiresAt,10000);assert.equal(j.config.percent,'50');assert.equal(h.sends(),0);assert.throws(()=>restarted.resume(j.id));
});
test('stopped, expired, mode/identity changed and linked standalone jobs cannot be restored',t=>{
 for(const alter of [j=>j.cancelRequested=true,j=>j.expiresAt=0,j=>j.mode='SIMULATION',j=>j.bindings=[{...w,address:'0x'+'a7'.repeat(20)}],j=>j.sourceClaim='claim']){const h=openingHarness(t);alter(h.job);assert.throws(()=>h.m.resume(h.job.id));assert.equal(h.sends(),0);assert.equal(h.job.status,'PAUSED');}
});
test('resuming submitted original never creates replacement order or retries an uncertain boundary',t=>{
 for(const status of ['PENDING','READY_TO_CONTINUE','SUBMISSION_UNKNOWN','CONFIRMED','FAILED']){const h=openingHarness(t),r=h.job.rows[0];Object.assign(r,{status:'TRACKING',orderId:'original',commitStartedAt:1});h.orders.set('original',{id:'original',status});h.m.resume(h.job.id);assert.equal(r.orderId,'original');assert.equal(h.sends(),0);assert.equal(r.status,['PENDING','READY_TO_CONTINUE'].includes(status)?'TRACKING':status==='SUBMISSION_UNKNOWN'?'REVIEW':status);}
});
test('bulk resume route is allowed but never automatically resent after session renewal',async()=>{
 let posts=0;const boot={service:'agent-trade-console',token:'1'.repeat(64),mode:'LIVE',wallets:[]};const client=createConsoleClient({fetchImpl:async url=>{if(url.endsWith('bootstrap'))return Response.json(boot);posts++;return Response.json({error:{code:'LOCAL_SESSION_EXPIRED'},details:{requestAccepted:false}},{status:401});}});
 await assert.rejects(client.request('tasks/resume',{confirmed:true,tasks:[{kind:'corla',id:'a'}]}),e=>e.code==='SESSION_REFRESHED_RETRY');assert.equal(posts,1);
});
test('failed resume persistence leaves original task paused and never schedules it',t=>{const h=openingHarness(t);let scheduled=0;h.m.persist=()=>{throw Error('disk full');};h.m.schedule=()=>scheduled++;h.m.scheduleFollow=()=>scheduled++;assert.throws(()=>h.m.resume(h.job.id),/disk full/);assert.equal(h.job.status,'PAUSED');assert.equal(scheduled,0);});
test('pause/delete/restore validate every task reference before mutation, allow partial results and forbid orphan child control',()=>{
 const h=services(),calls=[];h.opening.jobs=new Map([['child',{sourceClaim:'claim'}]]);for(const [kind,m]of [['corla',h.corla],['opening',h.opening]])for(const method of ['pause','remove','restore'])m[method]=id=>{calls.push([kind,method,id]);if(id==='bad')throw Error('missing');return {status:method==='remove'?'DELETED':'PAUSED'};};
 for(const input of [{confirmed:false,tasks:[{kind:'corla',id:'c1'}]},{confirmed:true,tasks:[{kind:'corla',id:'c1'},{kind:'shell',id:'x'}]},{confirmed:true,tasks:[{kind:'corla',id:'c1'},{kind:'corla',id:'c1'}]}])assert.throws(()=>controlTasks(h.corla,h.opening,'delete',input));assert.equal(calls.length,0);
 const r=controlTasks(h.corla,h.opening,'delete',{confirmed:true,tasks:[{kind:'corla',id:'c1'},{kind:'corla',id:'bad'},{kind:'opening',id:'child'}]});assert.equal(r.changed,1);assert.equal(r.results[1].changed,false);assert.match(r.results[2].message,/联动/);assert.deepEqual(calls,[['corla','remove','c1'],['corla','remove','bad']]);
});
test('UI controls pause active tasks only, delete reviewed/finished rows, and deduplicate grouped members',async()=>{
 const model=taskModel({corla:[{id:'a',account:1,status:'WATCHING'},{id:'b',account:2,status:'PAUSED'},{id:'c',account:3,status:'REVIEW'},{id:'d',account:4,status:'DONE'}]});const all=[...model.active,...model.corlaHistory],calls=[],api=async(...args)=>{calls.push(args);return {changed:args[1].tasks.length,results:[]};};
 await controlTaskMembers([...all,...all],'pause',api);assert.deepEqual(calls[0],['tasks/pause',{confirmed:true,tasks:[{kind:'corla',id:'a'}]}]);await controlTaskMembers(all,'delete',api);assert.equal(calls[1][1].tasks.length,4);
 const deleted=taskModel({corla:[{id:'hidden',account:1,status:'DELETED',deletedAt:1,sellJobId:'child'}],opening:[{id:'child',status:'DELETED',deletedAt:1,config:{accounts:[1]}}]});assert.equal(deleted.active.length+deleted.corlaHistory.length+deleted.openingHistory.length,0);
});
test('task controls after session renewal require another click and never silently retry mutations',async()=>{
 for(const route of ['tasks/pause','tasks/delete','tasks/restore']){let posts=0;const client=createConsoleClient({fetchImpl:async url=>{if(url.endsWith('bootstrap'))return Response.json({service:'agent-trade-console',token:'1'.repeat(64),mode:'LIVE',wallets:[]});posts++;return Response.json({error:{code:'LOCAL_SESSION_EXPIRED'},details:{requestAccepted:false}},{status:401});}});await assert.rejects(client.request(route,{confirmed:true,tasks:[{kind:'corla',id:'a'}]}),e=>e.code==='SESSION_REFRESHED_RETRY');assert.equal(posts,1);}
});
test('HTTP task controls require auth and confirmation; old stop endpoints now pause without deleting',async t=>{
 const h=services(),calls=[];h.opening.jobs=new Map();for(const [kind,m]of [['corla',h.corla],['opening',h.opening]]){m.close=()=>{};for(const method of ['pause','remove','restore'])m[method]=id=>{calls.push([kind,method,id]);return {id,status:method==='remove'?'DELETED':'PAUSED'};};}
 const app=createServer({rpc:{},readRpc:{},bridge:{close(){}},engine:{list:()=>[],running:new Set()},...h});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{app.server.close(r);app.server.closeAllConnections();}));
 const base='http://127.0.0.1:'+app.server.address().port,send=(route,body,auth=true)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json',...(auth?{'x-console-token':app.token}:{})},body:JSON.stringify(body)}),input={confirmed:true,tasks:[{kind:'corla',id:'c1'}]};
 for(const action of ['pause','delete','restore']){assert.equal((await send('/api/tasks/'+action,input,false)).status,401);assert.equal((await send('/api/tasks/'+action,{...input,confirmed:false})).status,400);assert.equal(calls.length,0);}
 for(const action of ['pause','delete','restore']){const r=await send('/api/tasks/'+action,input);assert.equal(r.status,200);assert.equal((await r.json()).changed,1);}
 for(const route of ['/api/corla-stop','/api/opening/stop']){const r=await send(route,{id:'legacy'});assert.equal(r.status,200);assert.equal((await r.json()).status,'PAUSED');}
 assert.deepEqual(calls.map(c=>c[1]),['pause','remove','restore','pause','pause']);
});
