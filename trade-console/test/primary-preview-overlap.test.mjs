import test from 'node:test';import assert from 'node:assert/strict';
import {primaryPreviewOverlap} from '../lib/primary-preview-overlap.mjs';
import {DEXES} from '../lib/opening-dex.mjs';
import {bindings} from '../lib/common.mjs';
const w=bindings()[0],token='0x'+'12'.repeat(20),intent={account:w.account,side:'sell'};
const plan=()=>({kind:'contract',token,wallet:w.address,requireSellCredit:true,holdingBefore:'100',amountIn:'50',identity:{fingerprint:'fixed'},opening:{...DEXES[0],declaredByToken:true,pool:'0x'+'34'.repeat(20)},steps:[{kind:'sell',to:DEXES[0].router,data:'0x1234',value:'0'}]});
const value=()=>({raw:{requestId:'synthetic',simulationResult:{}},at:Date.now()});
test('primary unsigned preview starts before audit completes and is one-shot, final-plan bound',async()=>{
 let release,started=false;const gate=new Promise(r=>release=r),p=plan();const overlap=primaryPreviewOverlap(intent,async copy=>{started=true;assert.notEqual(copy,p);await gate;return value();});
 overlap.start(p);await Promise.resolve();assert.equal(started,true);p.audit={available:true};p.project={name:'synthetic'};release();assert.equal((await overlap.take(p)).overlapped,true);assert.equal(await overlap.take(p),null);
});
test('wallet/route/amount/call/identity changes discard speculative result',async()=>{
 for(const change of [p=>p.wallet=bindings()[1].address,p=>p.steps[0].data='0x00',p=>p.steps[0].to=token,p=>p.amountIn='51',p=>p.holdingBefore='101',p=>p.identity.fingerprint='new',p=>p.opening.declaredByToken=false]){
  const p=plan(),overlap=primaryPreviewOverlap(intent,async()=>value());overlap.start(p);change(p);assert.equal(await overlap.take(p),null);
 }
});
test('unknown pool, approval-first, swap and wrong wallet never start early preview',()=>{
 for(const change of [p=>p.opening.declaredByToken=false,p=>p.opening.factory=token,p=>p.steps.unshift({kind:'approve'}),p=>p.kind='swap',p=>p.wallet=bindings()[1].address,p=>p.requireSellCredit=false]){
  const p=plan(),overlap=primaryPreviewOverlap(intent,()=>assert.fail('not eligible'));change(p);overlap.start(p);assert.equal(overlap.startedAt(),undefined);
 }
});
test('failed early preview remains a failure, no blind resimulation; old or expired result is discarded',async()=>{
 const p=plan(),bad=primaryPreviewOverlap(intent,async()=>{throw Error('official simulation failed');});bad.start(p);await assert.rejects(bad.take(p),/official simulation failed/);assert.equal(await bad.take(p),null);
 for(const stale of [{...value(),at:Date.now()-1001},{...value(),raw:{requestId:'old',expiresAt:Date.now()}}]){const overlap=primaryPreviewOverlap(intent,async()=>stale);overlap.start(p);assert.equal(await overlap.take(p),null);}
});
