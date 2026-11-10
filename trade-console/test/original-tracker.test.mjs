import test from 'node:test';import assert from 'node:assert/strict';
import {OriginalTracker} from '../lib/original-tracker.mjs';
const txHash='0x'+'11'.repeat(32);
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Engine} from '../lib/engine.mjs';import {bindings} from '../lib/common.mjs';
import {createServer} from '../server.mjs';
function swapFixture(t){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'tracker-test-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 const w=bindings()[0],bridge={queues:new Map(),call:()=>assert.fail('unexpected wallet call')},engine=new Engine({data,rpc:{},bridge});
 const order={id:'synthetic-original',intent:{account:w.account,side:'sell',asset:'0x'+'22'.repeat(20)},status:'PENDING',createdAt:Date.now(),timing:{},plan:{kind:'swap'},steps:[],orderId:'synthetic-provider-id'};
 engine.write(order);return {data,w,engine,bridge,order};
}
test('background original reads carry a bounded wallet timeout and simultaneous UI follow shares the same read',async t=>{
 const h=swapFixture(t);let release,reads=0;const gate=new Promise(r=>release=r);
 h.bridge.call=async(account,args,options)=>{reads++;assert.equal(account,h.w.account);assert.deepEqual(args,['market-order','list','--orderId','synthetic-provider-id']);assert.deepEqual(options,{readOnlyTimeoutMs:1000,background:true});await gate;return {list:[{orderId:'synthetic-provider-id',status:'FAILED'}]};};
 const a=h.engine.follow(h.order.id,{background:true}),b=h.engine.follow(h.order.id);assert.equal(a,b);release();
 assert.equal((await a).status,'FAILED');await b;assert.equal(reads,1);assert.equal(h.engine.following.size,0);assert.equal((await h.engine.reconcileAccount(h.w.account)).ready,true);
});
test('a recovered original read clears a stale read error without re-submitting',async t=>{
 const h=swapFixture(t);h.order.followError={message:'temporary outage'};h.engine.write(h.order);
 h.bridge.call=async()=>({list:[]});const o=await h.engine.follow(h.order.id,{background:true});assert.equal(o.status,'PENDING');assert.equal(o.followError,undefined);
});
test('HTTP service starts original tracking without a browser and closes the timer',async t=>{
 const h=swapFixture(t);let reads=0;h.bridge.call=async()=>{reads++;return {list:[{orderId:'synthetic-provider-id',status:'FAILED'}]};};
 const idle={active:()=>false,list:()=>[],close(){},reconcileOrder(){}},app=createServer({rpc:{},engine:h.engine,bridge:h.bridge,data:h.data,opening:idle,corla:idle});
 t.after(async()=>{if(app.server.listening)await new Promise(r=>app.server.close(r));});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 for(let i=0;i<50&&h.engine.get(h.order.id).status!=='FAILED';i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(h.engine.get(h.order.id).status,'FAILED');assert.equal(reads,1);await new Promise(r=>app.server.close(r));assert.equal(app.tracker.closed,true);assert.equal(app.tracker.timer,null);
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
