import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {hash,bindings} from '../lib/common.mjs';
import {ExperienceStore} from '../lib/experience.mjs';
import {selectMintRoute} from '../lib/mint-selection.mjs';
import {Engine} from '../lib/engine.mjs';
import {profiled,measure,snapshot,count,preflightReport} from '../lib/diagnostics.mjs';
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'mint-experience-'));
const target='0x'+'1'.repeat(40),wallet=bindings()[0].address,identity={target,code:'0x60006000',fingerprint:hash('version1')};
const intent={side:'mint',account:1,asset:target,scope:'free',quantity:1,maxBnb:'0',referral:'account1'};
const context={...intent,wallet};
const order=(id,status='PREPARED',at=1)=>({id,status,intent,updatedAt:at,preview:{},plan:{wallet,identity,quote:{routeId:'auto:freeMint()'},amountIn:'0'},steps:[]});

test('experience is scoped to chain, full fingerprint, wallet, scope and referral; never reuses fees',()=>{
 const data=temp(),store=new ExperienceStore(data);store.record(order('first'));store.record(order('first'));
 assert.equal(store.rows.size,1);const fresh=new ExperienceStore(data);
 assert.equal(fresh.lookup(identity,context).recommendedRouteId,'auto:freeMint()');
 for(const different of [{...context,wallet:'0x'+'2'.repeat(40)},{...context,account:2},{...context,scope:'paid'},{...context,referral:'none'}])assert.equal(fresh.lookup(identity,different).recommendedRouteId,null);
 assert.equal(fresh.lookup({...identity,fingerprint:hash('upgrade')},context).recommendedRouteId,null);
 assert.equal(fresh.lookup({...identity,target:'0x'+'3'.repeat(40)},context).sameCodeMatches,1);
 assert.equal(fresh.lookup({...identity,target:'0x'+'3'.repeat(40)},context).recommendedRouteId,null);
 assert.equal(fresh.lookup({...identity,target:'0x'+'3'.repeat(40),code:'0x60006001'},context).sameCodeMatches,0);
 const row=[...fresh.rows.values()][0];assert.equal(row.amountIn,undefined);assert.equal(row.quote,undefined);assert.equal(row.outcome,'preview_passed');assert.deepEqual(row.txHashes,[]);
});
test('latest failure suppresses recommendation but does not blacklist future current-chain retries',()=>{
 const store=new ExperienceStore(temp());store.record(order('a','PREPARED',1));store.record({...order('b','BLOCKED',2),error:{message:'RPC HTTP 429'}});
 assert.equal(store.lookup(identity,context).recommendedRouteId,null);assert.equal(store.lookup(identity,context).recent[0].failure.kind,'network');
 store.record(order('c','PREPARED',3));assert.equal(store.lookup(identity,context).recommendedRouteId,'auto:freeMint()');
});
test('a construction-only result is not a successful official preview; unresolved inputs retain diagnostic failures',()=>{
 const store=new ExperienceStore(temp());store.record({...order('no-preview'),preview:null});assert.equal(store.rows.size,0);
 store.record({id:'unresolved',intent,status:'BLOCKED',error:{code:'MINT_NOT_VERIFIED',message:'未识别目标'}});
 assert.equal(store.lookupInput(intent.asset).recent[0].failure.kind,'adapter_needed');assert.equal(store.lookup(identity,context).recommendedRouteId,null);
});
test('only confirmed mint receipts become on-chain success; pending and simulation are not successes',()=>{
 const store=new ExperienceStore(temp());for(const s of ['PENDING','SIMULATED','SUBMISSION_UNKNOWN','CONFIRMED'])store.record(order(s,s));assert.equal(store.rows.size,0);
 const txHash='0x'+'a'.repeat(64);store.record({...order('real','CONFIRMED'),steps:[{status:'CONFIRMED',step:{kind:'mint'},txHash,receipt:{status:'0x1'}}]});
 assert.equal([...store.rows.values()][0].outcome,'mint_confirmed');assert.deepEqual([...store.rows.values()][0].txHashes,[txHash]);
});
test('an explicit route wins, stale/unknown experience routes never bypass the current recognized set',()=>{
 const a={id:'auto:freeMint()',method:'freeMint()'},b={id:'auto:mint()',method:'mint()'},recognized={routes:[a,b]};
 assert.equal(selectMintRoute(recognized,null,a.id),a);assert.equal(selectMintRoute(recognized,b.id,a.id),b);
 assert.throws(()=>selectMintRoute(recognized,'invalid',a.id),/失效/);assert.throws(()=>selectMintRoute(recognized,null,'old()'),/请选择/);
});
test('timing and RPC counters stay isolated across concurrent requests, including failed stages',async()=>{
 let release;const gate=new Promise(r=>release=r);
 const a=profiled('first',async()=>{count('reads',2);await measure('wait',()=>gate);return snapshot();});
 const b=await profiled('second',async()=>{count('reads',7);await assert.rejects(measure('broken',async()=>{throw Error('test');}));return snapshot();});release();const first=await a;
 assert.equal(first.counters.reads,2);assert.equal(b.counters.reads,7);assert.equal(first.stages.broken,undefined);assert.equal(b.stages.broken.failed,1);assert.equal(snapshot(),null);
});
test('engine prepares and learns with numbered preview bridge only; simulation failure is preserved',async()=>{
 const data=temp(),calls=[],planFn=async()=>({kind:'contract',wallet,identity,token:target,inputToken:target,outputToken:target,amountIn:'0',metaVerified:true,quote:{routeId:'auto:freeMint()'},review:['尚未审计'],steps:[{kind:'mint',to:target,data:'0x12345678',value:'0'}]});
 let pass=true;const bridge={ready:async()=>{},call:async(account,args)=>{calls.push(args.slice(0,2).join(' '));assert.equal(account,1);assert.equal(args[1],'preview');return {requestId:'read-only',simulationResult:{simulationCode:pass?'000000000':'FAILED'}};}};
 const engine=new Engine({rpc:{},bridge,data,live:true,planFn});const p=await engine.prepare(intent,'preview');
 assert.equal(p.status,'PREPARED');assert.equal(p.preflight.checks.officialPreviewPassed,true);assert.ok(p.diagnostics.stages.officialPreview);assert.equal(engine.experience.lookup(identity,context).recommendedRouteId,'auto:freeMint()');
 pass=false;const failed=await engine.prepare(intent,'failure');assert.equal(failed.status,'BLOCKED');assert.equal(failed.preflight.passed,false);assert.equal(failed.diagnostics.stages.officialPreview.failed,1);assert.equal(failed.steps.length,0);
 assert.ok(calls.every(x=>x==='contract-call preview'));assert.equal(engine.experience.lookup(identity,context).recommendedRouteId,null);
 const restored=new Engine({rpc:{},bridge,data,live:true,planFn});assert.equal(restored.experience.rows.size,2);
});
test('needAiDeep distinguishes unsupported construction from quota and network failures',()=>{
 for(const [error,need] of [[{code:'MINT_UNSUPPORTED',message:'签名参数'},true],[{message:'HTTP 503'},false],[{code:'NO_QUOTA',message:'额度为 0'},false]])assert.equal(preflightReport({status:'BLOCKED',error}).needAiDeep,need);
});
