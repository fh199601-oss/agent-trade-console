import test from 'node:test';import assert from 'node:assert/strict';
import {InstantGuards} from '../lib/instant-guards.mjs';
const order=()=>({id:'test',intent:{account:1,side:'sell',percent:'50'},plan:{kind:'contract',wallet:'wallet',token:'token',holdingBefore:'100',identity:{fingerprint:'old'},steps:[{kind:'sell',to:'router',data:'exact'}]},steps:[]});
test('instant guard is memory-only, one-shot, exact plan/intent/order bound and time bounded',async()=>{
 let now=100;const guards=new InstantGuards({now:()=>now}),o=order();guards.start(o,async()=>{});
 assert.equal(guards.take({...o,id:'another'}),null);const hit=guards.take(o);assert.ok(hit);assert.equal(guards.take(o),null);assert.deepEqual(await hit.promise,{});
 for(const change of [q=>q.intent.account=2,q=>q.intent.percent='100',q=>q.plan.holdingBefore='99',q=>q.plan.identity.fingerprint='upgraded',q=>q.plan.steps[0].to='different',q=>q.plan.steps[0].data='changed']){const q=structuredClone(o);change(q);assert.equal(guards.current(hit,q),false);}
 now=1101;assert.equal(guards.current(hit,o),false);now=99;assert.equal(guards.current(hit,o),false);
});
test('rejected checks are captured; cancellation does not repopulate cache; no mint warm guard',async()=>{
 const guards=new InstantGuards(),o=order(),err=Error('identity changed');guards.start(o,async()=>{throw err;});const entry=guards.entries.get(o.id);guards.discard(o.id);assert.equal((await entry.promise).error,err);assert.equal(guards.entries.size,0);
 guards.start({...o,intent:{...o.intent,side:'mint'}},()=>assert.fail());assert.equal(guards.entries.size,0);
});
test('only exact zero-value Corla claim can overlap; refund, altered call and resumed steps cannot',async()=>{
 const o=order();o.intent={account:1,side:'mint',routeId:'corla:claim'};Object.assign(o.plan,{route:'corla:claim',requireAssetCredit:true,steps:[{kind:'mint',to:'mint-contract',value:'0',data:'0x4e71d92d'}]});
 const guards=new InstantGuards();guards.start(o,async()=>{});assert.ok(guards.take(o));
 for(const change of [q=>q.intent.routeId='corla:refund',q=>q.plan.route='corla:mint',q=>q.plan.requireAssetCredit=false,q=>q.plan.steps[0].value='1',q=>q.plan.steps[0].data='0x12345678',q=>q.plan.steps.push({...q.plan.steps[0]}),q=>q.steps=[{status:'CONFIRMED'}]]){
  const q=structuredClone(o);change(q);guards.start(q,()=>assert.fail('ineligible claim'));assert.equal(guards.take(q),null);
 }
});
