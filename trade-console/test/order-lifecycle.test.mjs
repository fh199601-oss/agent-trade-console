// Synthetic orders, wallet responses and RPC only; no live submission.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Engine} from '../lib/engine.mjs';import {OriginalTracker} from '../lib/original-tracker.mjs';import {Wallets} from '../lib/wallet.mjs';
import {lateSink,lateFile} from '../lib/late-result.mjs';import {bindings,BNB,ERC20,Interface,ZeroAddress} from '../lib/common.mjs';
import {trackingLabel,totalTimeLabel} from '../public/review-model.mjs';import {followSubmittedOrder} from '../public/trade-workflow.mjs';
import {createServer} from '../server.mjs';
const w=bindings()[0],token='0x'+'71'.repeat(20),target='0x'+'72'.repeat(20),txHash='0x'+'73'.repeat(32);
const transfer=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const clone=x=>structuredClone(x),wait=ms=>new Promise(r=>setTimeout(r,ms));
function setup(t,{kind='mint',logs=true}={}){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'order-lifecycle-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 const step={kind,to:target,data:'0x12345678',value:'0',...(kind==='approve'?{spender:target,allowance:'100'}:{})};
 const plan={kind:'contract',route:kind==='mint'?'fixture:mint':'fixture:sell',token,wallet:w.address,steps:[step],quantity:1,amountIn:'0',budgetCurrency:'BNB',minOutput:'1',outputToken:token,expectedAsset:{kind:'Erc20',token,amount:'100'}};
 const receipt={transactionHash:txHash,from:w.address,to:target,status:'0x1',logs:logs?[{address:token,...transfer.encodeEventLog(transfer.getEvent('Transfer'),[ZeroAddress,w.address,100n])}]:[]};
 const rpc={getTransactionReceipt:async()=>clone(receipt),getTransaction:async()=>({hash:txHash,from:w.address,to:target,input:step.data,value:'0x0'}),call:async()=>ERC20.encodeFunctionResult('allowance',[0n])};
 const bridge={call:()=>assert.fail('No wallet command allowed'),queues:new Map()},engine=new Engine({data,rpc,bridge,live:true});
 const o={id:'original',intent:{account:w.account,side:kind==='sell'?'sell':'mint',asset:target},createdAt:Date.now(),status:'PENDING',timing:{},plan,steps:[{index:0,stage:0,step,status:'PENDING',requestId:'fixture-request',txHash,submittedAt:Date.now(),submitStartedAt:Date.now()-5}]};
 engine.write(o);return {data,engine,rpc,bridge,o,receipt};
}
test('closed browser: backend alone resolves a direct-contract sale hash stored inside its step',async t=>{
 const h=setup(t,{kind:'sell'});const tracker=new OriginalTracker({engine:h.engine});await tracker.tick();
 assert.equal(h.engine.get(h.o.id).status,'CONFIRMED');assert.equal((await h.engine.reconcileAccount(w.account)).ready,true);assert.equal(h.engine.get(h.o.id).tracking.state,'finished');tracker.close();
});
for(const kind of ['mint','approve'])test(`successful ${kind} receipt with unverified credit ends without occupying wallet or sending next step`,async t=>{
 const h=setup(t,{kind,logs:false});const o=await h.engine.follow(h.o.id);
 assert.equal(o.status,'CONFIRMED_REVIEW');assert.equal(o.steps[0].status,'CONFIRMED_REVIEW');assert.match(o.error.message,/已成功上链/);assert.equal((await h.engine.reconcileAccount(w.account)).ready,true);
 assert.equal((await h.engine.execute(o.id,{authorization:'synthetic'})).duplicateSuppressed,true);
});
test('temporary read error recovers to pending and clears stale query error without inventing success',async t=>{
 const h=setup(t);h.rpc.getTransactionReceipt=async()=>{throw Error('fixture outage');};let o=await h.engine.follow(h.o.id);assert.equal(o.tracking.state,'read-unavailable');
 h.rpc.getTransactionReceipt=async()=>null;o=await h.engine.follow(h.o.id);assert.equal(o.status,'PENDING');assert.equal(o.tracking.state,'waiting');assert.equal(o.followError,undefined);assert.ok(o.resolvedErrors.length);
});
test('missing/invalid receipt status is never converted to a proven failure',async t=>{
 const h=setup(t);for(const status of [undefined,null,'0x2','garbage']){h.rpc.getTransactionReceipt=async()=>({...h.receipt,status});const o=await h.engine.follow(h.o.id);assert.equal(o.status,'PENDING');assert.equal(o.steps[0].revertVerified,undefined);assert.equal(o.tracking.state,'read-unavailable');}
 h.rpc.getTransactionReceipt=async()=>({...h.receipt,status:'0x0'});const o=await h.engine.follow(h.o.id);assert.equal(o.status,'FAILED');assert.equal((await h.engine.reconcileAccount(w.account)).ready,true);
});
test('a delayed receipt observed by UI, backend and next click uses one read and releases the wallet',async t=>{
 const h=setup(t);let reads=0,release;const gate=new Promise(r=>release=r);h.rpc.getTransactionReceipt=async()=>{reads++;await gate;return h.receipt;};
 const a=h.engine.follow(h.o.id,{background:true}),b=h.engine.follow(h.o.id),ready=h.engine.reconcileAccount(w.account);release();
 assert.equal((await a).status,'CONFIRMED');assert.equal((await b).status,'CONFIRMED');assert.equal((await ready).ready,true);assert.equal(reads,1);assert.equal(h.engine.following.size,0);
});
for(const kind of ['mint','approve'])test(`user can end only unsubmitted continuation after confirmed ${kind}`,async t=>{
 const h=setup(t,{kind});h.o.status='READY_TO_CONTINUE';h.o.steps[0].status='CONFIRMED';h.engine.write(h.o);
 const stopped=await h.engine.stopRemaining(h.o.id);assert.equal(stopped.status,kind==='mint'?'PARTIAL':'CANCELLED');assert.equal(stopped.remainingCancelled,true);assert.ok(stopped.timing.finishedAt);
 assert.equal((await h.engine.reconcileAccount(w.account)).ready,true);assert.equal((await h.engine.execute(h.o.id,{authorization:'synthetic'})).duplicateSuppressed,true);assert.equal((await h.engine.stopRemaining(h.o.id)).status,stopped.status);
});
test('end remaining cannot dismiss an unknown/pending transaction, even if requested directly via API',async t=>{
 const h=setup(t);for(const status of ['SUBMISSION_UNKNOWN','PENDING','RECEIPT_REVIEW','SUBMITTING']){h.o.status=status;h.engine.write(h.o);await assert.rejects(h.engine.stopRemaining(h.o.id),/只有已确认/);assert.equal(h.engine.get(h.o.id).status,status);}
 h.o.status='READY_TO_CONTINUE';h.engine.write(h.o);await assert.rejects(h.engine.stopRemaining(h.o.id),/只有已确认/);
});
test('background swap receipt lookup is bounded and uses only the exact original order ID',async t=>{
 const h=setup(t);h.o.plan={kind:'swap'};h.o.steps=[];h.o.orderId='original-provider-id';h.engine.write(h.o);
 h.bridge.call=async(a,args,options)=>{assert.equal(a,w.account);assert.deepEqual(args,['market-order','list','--orderId','original-provider-id']);assert.deepEqual(options,{background:true,readOnlyTimeoutMs:1000});return {list:[{orderId:'original-provider-id',status:'FAILED'}]};};
 await new OriginalTracker({engine:h.engine}).tick();assert.equal(h.engine.get(h.o.id).status,'FAILED');assert.equal((await h.engine.reconcileAccount(w.account)).ready,true);
});
test('tracker skips busy wallets, limits concurrency, never advances ready continuations, and recovers from synchronous exceptions',async()=>{
 let now=10000;const calls=[],rows=Array.from({length:12},(_,i)=>({id:'o'+i,intent:{account:i},status:'PENDING',createdAt:now}));rows.push({id:'ready',intent:{account:20},status:'READY_TO_CONTINUE'});
 const engine={list:()=>rows,running:new Set([0]),bridge:{queues:new Map([[1,Promise.resolve()]])},follow(id){calls.push(id);throw Error('fixture synchronous failure');}};
 const tracker=new OriginalTracker({engine,now:()=>now});await tracker.tick();assert.equal(calls.length,8);assert.ok(!calls.includes('o0')&&!calls.includes('o1')&&!calls.includes('ready'));assert.equal(tracker.inflight.size,0);
 now+=3000;await tracker.tick();assert.ok(calls.length>8);tracker.close();const count=calls.length;await tracker.tick();assert.equal(calls.length,count);
});
test('fresh direct receipts get a 250ms retry cadence; failures and old originals back off',async()=>{
 let now=10000,result={status:'PENDING'},calls=0;
 const o={id:'a',intent:{account:1},status:'PENDING',createdAt:now,steps:[{txHash,submitStartedAt:now}]};
 const tracker=new OriginalTracker({engine:{list:()=>[o],follow:async()=>{calls++;return result;}},now:()=>now});
 assert.equal(tracker.intervalMs,250);await tracker.tick();assert.equal(tracker.next.get('a'),now+250);
 now+=249;await tracker.tick();assert.equal(calls,1);now++;await tracker.tick();assert.equal(calls,2);
 result={followError:{message:'offline'}};now+=250;await tracker.tick();assert.equal(tracker.next.get('a'),now+3000);
 now+=40000;result={status:'PENDING'};await tracker.tick();assert.equal(tracker.next.get('a'),now+3000);tracker.close();
});
test('tracker does not overlap a wallet or duplicate a follow while an earlier tick is unfinished',async()=>{
 let release,reads=0;const gate=new Promise(r=>release=r),rows=[{id:'a',intent:{account:1},status:'PENDING',createdAt:Date.now()},{id:'b',intent:{account:1},status:'PENDING',createdAt:Date.now()}];
 const engine={list:()=>rows,follow:async()=>{reads++;await gate;return {status:'PENDING'};}};const tracker=new OriginalTracker({engine});const first=tracker.tick();await Promise.resolve();await tracker.tick();release();await first;assert.equal(reads,1);tracker.close();
});
function unknown(h){h.o.status='SUBMISSION_UNKNOWN';const e=h.o.steps[0];e.status='SUBMISSION_UNKNOWN';delete e.txHash;delete e.submittedAt;h.o.error={message:'timeout'};h.engine.write(h.o);return e;}
test('late contract acceptance survives restart, confirms only the original and ignores duplicate data/secret fields',async t=>{
 const h=setup(t),e=unknown(h),sink=lateSink(h.data,h.o,e);sink({data:{transactionHash:txHash,orderId:'provider-id',secret:'SYNTHETIC_DO_NOT_PERSIST'}});sink({data:{txHash:'0x'+'99'.repeat(32)}});
 assert.ok(!fs.readFileSync(lateFile(h.data,h.o,e),'utf8').includes('SYNTHETIC_DO_NOT_PERSIST'));
 const restarted=new Engine({data:h.data,rpc:h.rpc,bridge:h.bridge,live:true}),o=await restarted.follow(h.o.id);assert.equal(o.status,'CONFIRMED');assert.equal(o.steps[0].txHash,txHash);assert.ok(o.lateResponseAppliedAt);assert.equal((await restarted.reconcileAccount(w.account)).ready,true);assert.equal((await restarted.execute(h.o.id,{authorization:'synthetic'})).duplicateSuppressed,true);
});
test('late explicit contract rejection releases wallet; late generic transport error never invents a refusal',async t=>{
 const h=setup(t),e=unknown(h);lateSink(h.data,h.o,e)({error:{code:953401,message:'simulation error',responseReceived:true,dispatched:true}});
 const o=await h.engine.follow(h.o.id);assert.equal(o.status,'FAILED');assert.equal(o.steps[0].submissionOutcome.accepted,false);assert.equal((await h.engine.reconcileAccount(w.account)).ready,true);
 const next=clone(h.o);next.id='another';h.engine.write(next);lateSink(h.data,next,next.steps[0])({error:{code:'TIMEOUT',message:'timeout',responseReceived:true,dispatched:true}});assert.equal((await h.engine.follow(next.id)).status,'SUBMISSION_UNKNOWN');
});
test('a late result for a different request/stage cannot be applied to another submission',async t=>{
 const h=setup(t),e=unknown(h);lateSink(h.data,h.o,e)({data:{txHash}});h.o.steps[0].requestId='another-request';h.engine.write(h.o);
 assert.equal((await h.engine.follow(h.o.id)).status,'SUBMISSION_UNKNOWN');assert.equal(h.engine.get(h.o.id).lateResponseAppliedAt,undefined);
});
test('late swap response yields its original provider ID and is tracked without a second swap',async t=>{
 const h=setup(t);h.o.plan={kind:'swap'};h.o.steps=[];h.o.status='SUBMISSION_UNKNOWN';h.o.timing.submitStartedAt=Date.now();h.engine.write(h.o);
 lateSink(h.data,h.o)({data:{orderId:'late-original'}});let reads=0;h.bridge.call=async(a,args)=>{assert.deepEqual(args,['market-order','list','--orderId','late-original']);reads++;return {list:[{orderId:'late-original',status:'FINISHED',toTokenActualQty:'10'}]};};
 const o=await h.engine.follow(h.o.id);assert.equal(o.status,'CONFIRMED');assert.equal(o.actualReceived,'10');assert.equal(reads,1);
});
test('wallet timeout retains the late execution callback and preserves provider metadata; read calls cannot create late journals',async()=>{
 const bridge=new Wallets({responseTimeoutMs:5}),messages=[],state={ready:Promise.resolve(),pending:new Map(),process:{stdin:{write(line){messages.push(JSON.parse(line));}}}};bridge.worker=()=>state;
 const results=[];await assert.rejects(bridge.call(w.account,['contract-call','execute','--requestId','synthetic'],{onLateResponse:r=>results.push(r)}),e=>e.dispatched===true);assert.equal(bridge.queues.size,0);
 bridge.receive(state,{id:messages[0].id,result:{success:false,error:{code:953401,message:'simulation error'}}});assert.equal(results.length,1);assert.equal(results[0].error.code,953401);assert.equal(results[0].error.responseReceived,true);assert.equal(state.late.size,0);
 await assert.rejects(bridge.call(w.account,['wallet','status'],{onLateResponse:()=>assert.fail('read must not persist a late response')}));assert.equal(state.late.size,0);
});
for(const refused of [false,true])test(`full synthetic execution timeout receives late ${refused?'refusal':'hash'} and settles the same original exactly once`,async t=>{
 const h=setup(t),bridge=new Wallets({responseTimeoutMs:5});let executeId,sends=0;
 const state={ready:Promise.resolve(),pending:new Map(),process:{stdin:{write(line){const r=JSON.parse(line);if(r.args[1]==='preview')queueMicrotask(()=>bridge.receive(state,{id:r.id,result:{success:true,data:{requestId:'late-preview',simulationResult:{simulationCode:'000000000'}}}}));else{assert.equal(r.args[1],'execute');executeId=r.id;sends++;}}}}};
 bridge.worker=()=>state;bridge.ready=async()=>{};h.engine.bridge=bridge;h.o.plan.metaVerified=true;h.o.status='PREPARED';h.o.timing.preparedAt=Date.now();h.o.steps=[];h.engine.write(h.o);
 let o=await h.engine.execute(h.o.id,{authorization:'synthetic only'});assert.equal(o.status,'SUBMISSION_UNKNOWN');assert.equal(sends,1);
 bridge.receive(state,{id:executeId,result:refused?{success:false,error:{code:953401,message:'simulation error'}}:{success:true,data:{txHash}}});
 o=await h.engine.follow(h.o.id);assert.equal(o.status,refused?'FAILED':'CONFIRMED');assert.equal((await h.engine.reconcileAccount(w.account)).ready,true);await h.engine.execute(o.id,{authorization:'synthetic duplicate'});assert.equal(sends,1);
});
test('UI follows nested contract hashes and shows backend progress instead of only an indefinite timer',async()=>{
 const o={id:'nested',status:'PENDING',steps:[{txHash}],tracking:{attempts:4,lastCheckedAt:Date.now(),state:'waiting'}};let reads=0;
 assert.equal((await followSubmittedOrder(o,async()=>{reads++;return {...o,status:'CONFIRMED'};})).status,'CONFIRMED');assert.equal(reads,1);assert.match(trackingLabel(o),/已核对 4 次/);assert.equal(trackingLabel({...o,status:'FAILED'}),'');
 assert.equal(totalTimeLabel({status:'FAILED',createdAt:100,timing:{finishedAt:2100},updatedAt:999999}),'总耗时 2.00 秒');
});
test('HTTP service tracks an original without any browser poll, and stopping a continuation requires the local session',async t=>{
 const h=setup(t,{kind:'sell'}),app=createServer({data:h.data,engine:h.engine,rpc:h.rpc,bridge:h.bridge});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{app.server.close(r);app.server.closeAllConnections();}));
 for(let n=0;n<100&&h.engine.get(h.o.id).status!=='CONFIRMED';n++)await wait(5);assert.equal(h.engine.get(h.o.id).status,'CONFIRMED');
 const base='http://127.0.0.1:'+app.server.address().port,send=auth=>fetch(base+'/api/stop-remaining',{method:'POST',headers:{'content-type':'application/json',...(auth?{'x-console-token':app.token}:{})},body:JSON.stringify({id:'continuation'})});
 const o=clone(h.o);o.id='continuation';o.status='READY_TO_CONTINUE';o.steps[0].status='CONFIRMED';h.engine.write(o);
 assert.equal((await send(false)).status,401);assert.equal(h.engine.get(o.id).status,'READY_TO_CONTINUE');const stopped=await send(true);assert.equal(stopped.status,200);assert.equal((await stopped.json()).status,'CANCELLED');
 const boot=await(await fetch(base+'/api/bootstrap')).json();assert.equal(boot.capabilities.originalTrackingVersion,1);
});
test('successful response missing a hash stays unknown, rather than falsely releasing a dispatched mint as failed',async t=>{
 const h=setup(t);h.o.plan.metaVerified=true;h.o.status='PREPARED';h.o.timing.preparedAt=Date.now();h.o.steps=[];h.engine.write(h.o);h.bridge.ready=async()=>{};
 h.bridge.call=async(a,args)=>args[1]==='preview'?{requestId:'malformed',simulationResult:{simulationCode:'000000000'}}:undefined;
 const o=await h.engine.execute(h.o.id,{authorization:'synthetic only'});assert.equal(o.status,'SUBMISSION_UNKNOWN');assert.equal((await h.engine.reconcileAccount(w.account)).ready,false);
});
test('late response is retained when first durable save fails and retried on the next read response',()=>{
 let attempts=0,stored;const bridge=new Wallets(),state={pending:new Map(),late:new Map([['old',{onLateResponse:r=>{attempts++;if(attempts===1)throw Error('temporary storage failure');stored=r;}}]])};
 bridge.receive(state,{id:'old',result:{success:true,data:{txHash}}});assert.equal(state.late.size,1);assert.equal(stored,undefined);bridge.receive(state,{id:'unrelated',result:{success:true,data:{}}});assert.equal(state.late.size,0);assert.equal(stored.data.txHash,txHash);
});
