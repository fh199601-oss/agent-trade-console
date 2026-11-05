// All managers use synthetic RPC/bridge and isolated journals. No real signing.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {OpeningSell} from '../lib/opening-sell.mjs';import {CorlaAutomation} from '../lib/corla-automation.mjs';import {TaskEnrollment} from '../lib/task-enrollment.mjs';import {editTasks,editCorla,editOpening} from '../lib/task-edit.mjs';import {bindings,ERC20,ZeroAddress} from '../lib/common.mjs';import {createConsoleClient} from '../public/session-client.mjs';
const [w,w2]=bindings(),mint='0x'+'2'.repeat(40),token='0x'+'3'.repeat(40),identity={target:mint,fingerprint:'mint'},factory={fingerprint:'factory'};
const parent=(account=w.account,extra={})=>({id:'parent-'+account,createdAt:10000,intent:{account,side:'mint',autoClaim:false},status:'PARTIAL',simulationOnly:false,steps:[{status:'CONFIRMED',step:{kind:'mint'},settlement:{kind:'subscription'},received:'1'}],plan:{route:'corla:mint',wallet:bindings().find(w=>w.account===account).address,subscription:{mint},identity,protocolIdentities:[factory],outputToken:token,afterMint:null},project:{name:'Test Corla'},...extra});
function harness(t){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'task-edit-add-')),s={phase:1n,balance:1000n,open:false,partial:false,claimed:false,refunded:false,participated:true,changed:false,execs:0},orders=[parent(),parent(w2.account)],prepared=new Map();
 const rpc={call:async tx=>{const f=ERC20.parseTransaction(tx);return ERC20.encodeFunctionResult(f.name,[f.name==='decimals'?18n:s.balance]);}},bridge={ready:async()=>({})},detector={scan:async()=>({open:s.open,partial:s.partial,at:10000,block:1,pools:[]})};
 const engine={live:true,running:new Set(),list:()=>orders,get:id=>prepared.get(id)||orders.find(o=>o.id===id),prepare:async(intent,id)=>{const o={id,intent,status:'PREPARED',steps:[],review:[]};prepared.set(id,o);return o;},execute:async(id)=>{s.execs++;const o=prepared.get(id);o.status='PENDING';return o;},follow:async id=>prepared.get(id)};
 const opening=new OpeningSell({engine,rpc,bridge,detector,data,now:()=>10000,autoSchedule:false}),client={locate:async()=>({record:{mint,expectedToken:token}}),verify:async()=>({identity:s.changed?{fingerprint:'changed'}:identity,factoryIdentity:factory}),get:async(a,b,name)=>name==='getMintState'?[1n,s.phase]:[s.participated,100n,0n,s.claimed,s.refunded,true]};
 const corla=new CorlaAutomation({engine,rpc,opening,client,data,now:()=>10000,autoSchedule:false}),add=new TaskEnrollment({engine,corla,opening,rpc,now:()=>10000});t.after(()=>{opening.close();corla.close();fs.rmSync(data,{recursive:true,force:true});});
 const input={candidateId:'claim:'+mint,accounts:[w.account,w2.account],requestId:'synthetic-request-one',action:'claim-sell',percent:'50',confirmed:true};return {s,engine,orders,prepared,corla,opening,add,input,data};
}
test('recent task candidates exclude preview, simulation, uncredited, NFT, stale and rebound orders',async t=>{
 const h=harness(t);h.orders.push(parent(w.account,{id:'simulation',simulationOnly:true}),parent(w.account,{id:'preview',steps:[]}),parent(w.account,{id:'old',createdAt:-31*86400000}),parent(w.account,{id:'changed-wallet',plan:{...parent().plan,wallet:ZeroAddress}}));
 const r=await h.add.candidates();assert.equal(r.projects.length,1);assert.equal(r.projects[0].wallets.length,2);assert.ok(r.projects[0].wallets.every(w=>w.available));assert.equal(h.s.execs,0);
 h.s.phase=3n;assert.match((await h.add.candidates()).projects[0].unavailable,/已经开盘/);
});
test('explicit post-Mint add creates one watcher per wallet, never continues original Mint, and is durable-idempotent',async t=>{
 const h=harness(t),before=JSON.stringify(h.orders);const [a,b]=await Promise.all([h.add.add(h.input),h.add.add(h.input)]);assert.equal(a,b);assert.equal(a.created,2);assert.equal(h.corla.jobs.size,2);
 assert.ok(h.corla.list().every(j=>j.status==='WATCHING'&&j.policy.sell.percent==='50'));assert.equal(JSON.stringify(h.orders),before);assert.equal(h.s.execs,0);assert.equal((await h.add.add(h.input)).created,0);assert.equal(h.corla.jobs.size,2);
 await assert.rejects(h.add.add({...h.input,percent:'100'}),/请求 ID/);h.corla.remove(a.results[0].id);const again=await h.add.add(h.input);assert.equal(again.results[0].status,'DELETED');assert.equal(h.corla.list().length,1);
});
test('add rechecks allocations, live mode, binding/identity and phase; never invents a task from an unknown selection',async t=>{
 for(const alter of [h=>h.s.phase=3n,h=>h.s.changed=true,h=>h.s.claimed=true,h=>h.s.refunded=true,h=>h.s.participated=false]){const h=harness(t);alter(h);try{const r=await h.add.add(h.input);assert.equal(r.created,0);}catch(e){assert.match(e.message,/开盘|身份/);}assert.equal(h.corla.jobs.size,0);}
 const h=harness(t);for(const input of [{...h.input,confirmed:false},{...h.input,percent:'101'},{...h.input,accounts:[w.account,w.account]}])assert.throws(()=>h.add.add(input));await assert.rejects(h.add.add({...h.input,candidateId:'unknown'}));h.engine.live=false;assert.throws(()=>h.add.add(h.input),/模拟/);assert.equal(h.s.execs,0);
});
test('existing paused claim blocks duplicates; edit can enable sale and paused state is preserved',async t=>{
 const h=harness(t),r=await h.add.add({...h.input,action:'claim'}),j=h.corla.jobs.get(r.results[0].id);h.corla.pause(j.id);
 assert.equal((await h.add.candidates()).projects[0].wallets[0].available,false);assert.equal((await h.add.add({...h.input,requestId:'new-request-duplicate'})).created,0);
 editCorla(h.corla,j.id,{percent:'100',sellEnabled:true},{revision:0});assert.equal(j.policy.sell.percent,'100');assert.equal(j.status,'PAUSED');assert.equal(j.policy.sell.slippageBps,5000);assert.equal(j.parents[0],'parent-'+w.account);assert.equal(h.s.execs,0);
 assert.throws(()=>editCorla(h.corla,j.id,{percent:'20'},{revision:0}),/变化/);editCorla(h.corla,j.id,{percent:'20',sellEnabled:false},{revision:1});assert.equal(j.policy.sell,null);
});
test('editing during a pending preview discards old 50% plan, prepares 100%, and submits once',async t=>{
 const h=harness(t),c=await h.opening.check({asset:token,accounts:[w.account],percent:'50'}),j=h.opening.arm(c.id,{confirmed:true});h.s.open=true;
 let release;const original=h.engine.prepare;h.engine.prepare=async(...args)=>{await new Promise(r=>release=r);return original(...args);};
 const tick=h.opening.tick(j.id);await new Promise(r=>setImmediate(r));editOpening(h.opening,j.id,{percent:'100'},{revision:0});release();await tick;assert.equal(h.s.execs,0);assert.equal(j.rows[0].status,'WAITING');
 h.engine.prepare=original;await h.opening.tick(j.id);assert.equal(h.s.execs,1);assert.equal(j.rows[0].submittedPercent,'100');assert.equal([...h.prepared.values()].at(-1).intent.percent,'100');await h.opening.tick(j.id);assert.equal(h.s.execs,1);
});
test('edit changes only unsubmitted wallets and never rewrites uncertain or confirmed original orders',async t=>{
 const h=harness(t),c=await h.opening.check({asset:token,accounts:[w.account,w2.account],percent:'50'}),j=h.opening.arm(c.id,{confirmed:true});Object.assign(j.rows[0],{status:'TRACKING',commitStartedAt:1,submittedPercent:'50',orderId:'original'});editOpening(h.opening,j.id,{percent:'100'});assert.equal(j.rows[0].submittedPercent,'50');assert.equal(j.rows[0].orderId,'original');assert.equal(j.config.percent,'100');
 Object.assign(j.rows[1],{status:'CONFIRMED',commitStartedAt:1});assert.throws(()=>editOpening(h.opening,j.id,{percent:'20'}),/提交/);assert.equal(h.s.execs,0);
});
test('linked parent and child edit together, preserve paused state, rollback on disk failure, reject direct child edits',async t=>{
 const h=harness(t),r=await h.add.add(h.input),j=h.corla.jobs.get(r.results[0].id),c=await h.opening.check({asset:token,accounts:[w.account],percent:'50'}),child=h.opening.arm(c.id,{confirmed:true});child.sourceClaim='claim';j.sellJobId=child.id;j.status='SELLING';h.corla.pause(j.id);
 editCorla(h.corla,j.id,{percent:'100'});assert.equal(j.policy.sell.percent,'100');assert.equal(child.config.percent,'100');assert.equal(child.status,'PAUSED');assert.throws(()=>editOpening(h.opening,child.id,{percent:'10'}),/领取任务/);
 const persist=h.corla.persist;h.corla.persist=()=>{throw Error('disk full');};assert.throws(()=>editCorla(h.corla,j.id,{percent:'70'}),/disk full/);h.corla.persist=persist;assert.equal(j.policy.sell.percent,'100');assert.equal(child.config.percent,'100');assert.equal(h.s.execs,0);
});
test('group edit validates all references first and reports individual stale versions without rearming paused jobs',async t=>{
 const h=harness(t),r=await h.add.add(h.input),refs=r.results.map(x=>({kind:'corla',id:x.id,revision:0}));assert.throws(()=>editTasks(h.corla,h.opening,{confirmed:true,tasks:[...refs,{kind:'shell',id:'bad',revision:0}],settings:{percent:'100'}}));assert.ok(h.corla.list().every(j=>j.policy.sell.percent==='50'));
 h.corla.pause(refs[0].id);h.corla.jobs.get(refs[1].id).revision=2;const out=editTasks(h.corla,h.opening,{confirmed:true,tasks:refs,settings:{percent:'100'}});assert.equal(out.changed,1);assert.equal(h.corla.jobs.get(refs[0].id).status,'PAUSED');assert.equal(h.s.execs,0);
});
test('credited ERC20 mint can add an opening sale; opened, empty or incomplete pools cannot arm',async t=>{
 const h=harness(t);h.orders.splice(0,h.orders.length,parent(w.account,{plan:{wallet:w.address,route:'ordinary',expectedAsset:{kind:'Erc20'},outputToken:token},steps:[{status:'CONFIRMED',step:{kind:'mint'},received:'100'}]}));const input={...h.input,candidateId:'sell:'+token,accounts:[w.account],action:'sell'};
 assert.equal((await h.add.candidates()).projects[0].wallets[0].available,true);const r=await h.add.add(input);assert.equal(r.created,1);const j=h.opening.jobs.get(r.results[0].id);assert.equal(j.sourceMint,h.orders[0].id);assert.equal(j.config.percent,'50');assert.equal(h.s.execs,0);assert.equal((await h.add.add(input)).created,0);
 h.opening.remove(j.id);h.s.balance=0n;assert.equal((await h.add.add({...input,requestId:'new-request-zero'})).created,0);h.s.open=true;await assert.rejects(h.add.add({...input,requestId:'new-request-open'}),/开盘/);
});
test('task edit/add are never auto-retried on session expiry',async()=>{
 for(const route of ['tasks/edit','tasks/add']){let posts=0;const client=createConsoleClient({fetchImpl:async url=>{if(url.endsWith('bootstrap'))return Response.json({service:'agent-trade-console',token:'1'.repeat(64),mode:'LIVE',wallets:[]});posts++;return Response.json({error:{code:'LOCAL_SESSION_EXPIRED'},details:{requestAccepted:false}},{status:401});}});await assert.rejects(client.request(route,{confirmed:true}),e=>e.code==='SESSION_REFRESHED_RETRY');assert.equal(posts,1);}
});
test('late tasks count unique tokens, rollback failed disk writes, and stop when service closes during inspection',async t=>{
 const h=harness(t);
 for(let i=0;i<4;i++)h.opening.jobs.set('other-'+i,{id:'other-'+i,status:'ARMED',config:{asset:token,accounts:[w2.account]},createdAt:0});
 const check=await h.opening.check({asset:token,accounts:[w.account],percent:'50'}),persist=h.opening.persist;
 h.opening.persist=()=>{throw Error('disk full');};assert.throws(()=>h.opening.arm(check.id,{confirmed:true}),/disk full/);assert.equal(h.opening.jobs.has(check.id),false);h.opening.persist=persist;
 const j=h.opening.arm(check.id,{confirmed:true});assert.equal(j.status,'ARMED');h.opening.pause(j.id);h.opening.resume(j.id);assert.equal(j.status,'ARMED');
 const verify=h.corla.client.verify;h.corla.client.verify=async(...args)=>{h.corla.close();return verify(...args);};const r=await h.add.add(h.input);assert.equal(r.created,0);assert.ok(r.results.every(r=>/停止/.test(r.message)));assert.equal(h.corla.jobs.size,0);assert.equal(h.s.execs,0);
});
test('concurrent different add requests cannot duplicate the same wallet and project',async t=>{
 const h=harness(t);const results=await Promise.all([h.add.add(h.input),h.add.add({...h.input,requestId:'second-request-id'})]);assert.equal(results.reduce((n,r)=>n+r.created,0),2);assert.equal(h.corla.jobs.size,2);assert.equal(h.s.execs,0);
});
