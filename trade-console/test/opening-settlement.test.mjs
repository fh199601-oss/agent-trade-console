import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {openingSettlement} from '../lib/opening-route.mjs';
import {DEXES} from '../lib/opening-dex.mjs';
import {Engine} from '../lib/engine.mjs';
import {OpeningSell} from '../lib/opening-sell.mjs';
import {orderSummary} from '../lib/order-summary.mjs';
import {statusLabel,reviewSummary} from '../public/review-model.mjs';
import {settlementFixture,addresses as a} from './support/settlement-fixture.mjs';

for(const dex of DEXES)for(const reverse of [false,true])test(`${dex.id} ${reverse?'reversed':'normal'}: nested tax swap is not wallet sale, fees count in wallet debit`,()=>{
 const f=settlementFixture({dex,reverse});assert.deepEqual(openingSettlement(f),{amountIn:1000n,amountOut:200n,poolAmountIn:970n,attribution:'wallet-funded-swap'});
});
test('tax swap to same router before wallet funding cannot inflate wallet proceeds',()=>{
 const f=settlementFixture({taxToRouter:true});assert.equal(openingSettlement(f).amountOut,200n);
});
test('ERC20 quote receipt uses recipient net credit, not gross swap output',()=>{
 const f=settlementFixture({native:false,quoteTax:true});assert.equal(openingSettlement(f).amountOut,180n);
});
test('missing wallet debit, recipient, native withdrawal and ambiguous swap never pass',()=>{
 const variants=[f=>{f.wallet=a.tax;},f=>{f.receipt.logs.pop();},f=>{f.receipt.logs.push(f.swap(970,200,DEXES[0].router));},f=>{f.plan.amountIn='999';},f=>{f.step.to=a.tax;},f=>{f.plan.outputToken=a.tax;}];
 for(const alter of variants){const f=settlementFixture();alter(f);assert.throws(()=>openingSettlement(f));}
});
test('opposite V3 direction and unrelated input deposits cannot be counted',()=>{
 const f=settlementFixture({dex:DEXES[2],native:false,nested:false});f.receipt.logs[f.receipt.logs.length-1]=f.swap(-970,-200,a.owner);assert.throws(()=>openingSettlement(f),/方向/);
 const g=settlementFixture();g.receipt.logs.splice(-1,0,g.swap(971,200,DEXES[0].router));assert.throws(()=>openingSettlement(g),/唯一/);
});

function harness(t,{badReceipt=false,failed=false,pending=false,mismatch=false}={}){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'settlement-test-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 const f=settlementFixture();if(badReceipt)f.receipt.logs=[];if(failed)f.receipt.status='0x0';if(mismatch)f.tx.input='0x87654321';
 let sends=0,reads=0;const bridge={call:()=>{sends++;throw Error('No wallet submissions allowed');}},rpc={getTransactionReceipt:async()=>{reads++;return pending?null:f.receipt;},getTransaction:async()=>f.tx};
 const engine=new Engine({data,rpc,bridge,live:true,planFn:async()=>f.plan});engine.preview=async()=>null;
 const o={id:'original',intent:{account:1,side:'sell',asset:f.token,percent:'50'},createdAt:Date.now()-1000,status:'PENDING',timing:{},plan:f.plan,error:{message:'previous parser error'},steps:[{index:0,step:f.step,plan:f.plan,status:'PENDING',txHash:f.hash,submittedAt:Date.now()-100,receipt:f.receipt}]};engine.write(o);
 return {engine,o,f,data,counts:()=>({sends,reads})};
}
test('successful original reconciles, preserves error history, releases wallet and exposes contract receipt link',async t=>{
 const h=harness(t),r=await h.engine.reconcileAccount(1);assert.equal(r.ready,true);assert.equal(r.order.status,'CONFIRMED');assert.equal(r.order.error,undefined);assert.equal(r.order.resolvedErrors[0].error.message,'previous parser error');assert.equal(r.order.steps[0].settlement.amountIn,1000n);
 assert.equal(orderSummary(r.order).txHash,h.f.hash);assert.equal((await h.engine.prepare(h.o.intent,'next-click')).status,'PREPARED');assert.equal((await h.engine.execute('original')).duplicateSuppressed,true);assert.equal(h.counts().sends,0);
});
test('mined success with undecodable amounts is terminal review: no endless follow, no re-execute, new explicit action allowed',async t=>{
 const h=harness(t,{badReceipt:true}),r=await h.engine.follow(h.o.id);assert.equal(r.status,'CONFIRMED_REVIEW');assert.equal(r.steps[0].status,'CONFIRMED_REVIEW');assert.equal(r.error.code,'SETTLEMENT_REVIEW');assert.equal((await h.engine.reconcileAccount(1)).ready,true);
 const reads=h.counts().reads;await h.engine.follow(h.o.id);await h.engine.execute(h.o.id);assert.equal(h.counts().reads,reads);assert.equal(h.counts().sends,0);
 assert.equal((await h.engine.prepare(h.o.intent,'new-explicit-action')).status,'PREPARED');assert.match(statusLabel(r),/已上链/);assert.match(reviewSummary([r]).message,/成功上链/);
});
test('confirmed accounting violation is reported and stops automation; it is not presented as a failed transaction',async t=>{
 const h=harness(t);h.o.plan.minOutput='201';h.engine.write(h.o);const r=await h.engine.follow(h.o.id);assert.equal(r.status,'CONFIRMED_REVIEW');assert.match(r.error.message,/最低到账/);
 const m=new OpeningSell({data:h.data,engine:h.engine,rpc:{},bridge:{},detector:{},autoSchedule:false,now:()=>1000});t.after(()=>m.close());
 const row={account:1,status:'TRACKING',orderId:h.o.id},job={id:'test',status:'TRACKING',rows:[row]};await m.followPending(job);assert.equal(row.status,'REVIEW');await m.followPending(job);assert.equal(h.counts().sends,0);assert.equal(h.counts().reads,1);
});
test('confirmed revert releases original order; retry is a new explicit preview only',async t=>{
 const h=harness(t,{failed:true}),r=await h.engine.follow(h.o.id);assert.equal(r.status,'FAILED');assert.equal(r.steps[0].revertVerified,true);assert.equal(r.error.code,'TRANSACTION_REVERTED');assert.equal((await h.engine.prepare(h.o.intent,'retry-click')).status,'PREPARED');await h.engine.execute(h.o.id);assert.equal(h.counts().sends,0);
});
test('failed receipt with mismatched original input cannot authorize recovery',async t=>{
 const h=harness(t,{failed:true,mismatch:true}),r=await h.engine.follow(h.o.id);assert.equal(r.status,'RECEIPT_REVIEW');assert.equal(r.steps[0].revertVerified,undefined);assert.equal((await h.engine.reconcileAccount(1)).ready,false);
});
test('manual original reconciliation updates stopped task display without restoring automation',async t=>{
 const h=harness(t),m=new OpeningSell({data:h.data,engine:h.engine,rpc:{},bridge:{},detector:{},autoSchedule:false});t.after(()=>m.close());
 const row={account:1,status:'TRACKING',orderId:h.o.id},job={id:'stopped',status:'CANCELLED',cancelRequested:true,rows:[row]};m.jobs.set(job.id,job);
 m.reconcileOrder(await h.engine.follow(h.o.id));assert.equal(row.status,'CONFIRMED');assert.equal(job.status,'CANCELLED');assert.equal(job.cancelRequested,true);assert.equal(m.active(),false);assert.equal(h.counts().sends,0);
});
test('RPC lookup failure is not evidence of a reverted transaction and cannot release the wallet',async t=>{
 const h=harness(t);h.engine.rpc.getTransactionReceipt=async()=>{throw Error('RPC timeout');};assert.equal((await h.engine.follow(h.o.id)).status,'PENDING');assert.equal((await h.engine.reconcileAccount(1)).ready,false);assert.equal(h.counts().sends,0);
});
for(const mode of ['pending','mismatch'])test(`${mode}: unknown or mismatched original remains locked and never resubmits`,async t=>{
 const h=harness(t,{[mode]:true});assert.equal((await h.engine.reconcileAccount(1)).ready,false);await assert.rejects(h.engine.prepare(h.o.intent,'new-click'),e=>e.code==='ORDER_UNRESOLVED');assert.equal(h.counts().sends,0);
});
