import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {OpeningPools,FACTORY,POOL} from '../lib/opening-pools.mjs';
import {OpeningApprovalPreviews} from '../lib/opening-approval-previews.mjs';
import {Engine,verifyPreview} from '../lib/engine.mjs';
import {openingPlan} from '../lib/opening-route.mjs';
import {DEXES,V2_ROUTER_ABI} from '../lib/opening-dex.mjs';
import {MULTI,MULTICALL} from '../lib/opening-read.mjs';
import {ERC20,WBNB,BNB,bindings,same} from '../lib/common.mjs';
const token='0x'+'12'.repeat(20),pair='0x'+'34'.repeat(20),d=DEXES[0],w=bindings()[0];
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(){
 let liquid=false;
 const single=tx=>{
  if(same(tx.to,d.factory)){const f=FACTORY.parseTransaction(tx);return FACTORY.encodeFunctionResult(f.name,[pair]);}
  const f=POOL.parseTransaction(tx),values={token0:[token],token1:[WBNB],factory:[d.factory],getReserves:[liquid?1000000n:0n,liquid?2000000n:0n,1]};return POOL.encodeFunctionResult(f.name,values[f.name]);
 };
 const rpc={verifyChain:async()=>{},getBlockNumber:async()=>100,call:async tx=>{
  if(same(tx.to,MULTICALL)){const f=MULTI.parseTransaction(tx);return MULTI.encodeFunctionResult(f.name,[100,'0x'+'0'.repeat(64),f.args[1].map(c=>{try{return [true,single({to:c.target,data:c.callData})];}catch{return [false,'0x'];}})]);}return single(tx);
 }};
 const detector=new OpeningPools(rpc,{dexes:[d],quotes:[WBNB],quoteDiscovery:null,infinity:null});
 return {rpc,detector,open:()=>liquid=true};
}
test('watch scans never wait for slow Infinity/history discovery and still observe the next opening',async()=>{
 const f=fixture(),gate=deferred();let deep=0;f.detector.infinity={scan:async()=>{deep++;await gate.promise;return {pools:[],errors:[]};}};
 let done=false;const work=f.detector.scan(token,{watch:true}).then(s=>{done=true;return s;});
 const first=await Promise.race([work,new Promise((_,reject)=>setTimeout(()=>reject(Error('watch blocked on discovery')),1000))]);
 assert.equal(done,true);assert.equal(first.open,false);assert.equal(deep,1);assert.equal(first.partial,true);
 f.open();assert.equal((await f.detector.scan(token,{watch:true})).open,true);
 gate.resolve();await tick();
});
test('a deep manual scan cannot hold the watcher inflight key hostage',async()=>{
 const f=fixture(),gate=deferred();f.detector.infinity={scan:async()=>{await gate.promise;return {pools:[],errors:[]};}};
 let manualDone=false;const manual=f.detector.scan(token).then(s=>{manualDone=true;return s;});await tick();
 const watcher=await f.detector.scan(token,{watch:true});assert.equal(watcher.open,false);assert.equal(manualDone,false);
 gate.resolve();await manual;
});
test('watcher consumes late verified Infinity results without renewing stale data',async()=>{
 const f=fixture(),gate=deferred();let calls=0;
 const found={pools:[{kind:'infinity-cl',pool:'0x'+'ab'.repeat(32),block:100,liquid:true}],errors:[]};
 f.detector.infinity={scan:async()=>{calls++;if(calls===1){await gate.promise;return found;}return new Promise(()=>{});}};
 assert.equal((await f.detector.scan(token,{watch:true})).open,false);
 gate.resolve();await tick();assert.equal((await f.detector.scan(token,{watch:true})).open,true);
 const recent=f.detector.infinityRecent.get(token.toLowerCase());recent.startedAt-=1300;
 assert.equal((await f.detector.scan(token,{watch:true})).open,false);
});
async function warmFixture({risk=false}={}){
 const f=fixture(),snapshot=await f.detector.scan(token),calls=[];let now=Date.now(),allowed=true,busy=false;
 const identity={token,fingerprint:'fixed-contract-code'},venue={assets:[{token:d.router,codeHash:'router-code'}]};
 const prep={token:async()=>({identity,decimals:18}),venue:async()=>venue};
 const config={asset:token,accounts:[w.account],percent:'50',currency:'AUTO',slippageBps:5000};
 const preflight={fingerprint:identity.fingerprint,rows:[{account:w.account,address:w.address,balance:'1000',routes:[{id:d.id,approvalNeeded:true}]}]};
 const cache=new OpeningApprovalPreviews({now:()=>now,busy:()=>busy,preview:async(plan,intent)=>{
  calls.push({plan,intent});const step=plan.steps[0],raw={requestId:'synthetic-preview',parsedTx:{contractAddress:token},simulationResult:{simulationCode:'000000000',allowanceChanges:[{owner:w.address,tokenAddress:token,spender:d.router,postAmount:step.allowance}],balanceChanges:[]},risks:risk?[{title:'test-risk'}]:[]};
  return {raw,review:verifyPreview(raw,plan,step),at:now};
 }});
 const warm=()=>cache.warm(config,preflight,snapshot,prep,()=>allowed);
 await warm();
 return {...f,snapshot,cache,config,preflight,prep,calls,warm,plan:structuredClone(calls[0]?.plan),intent:{...config,account:w.account,side:'sell',openingOnly:true},setNow:x=>now+=x,setBusy:x=>busy=x,setAllowed:x=>allowed=x};
}
test('waiting prewarm produces exact single-use approval preview only, with all original risks',async()=>{
 const f=await warmFixture({risk:true});assert.equal(f.calls.length,1);assert.equal(f.plan.steps.length,1);assert.equal(f.plan.steps[0].kind,'approve');assert.equal(f.plan.steps[0].allowance,'500');
 const hit=f.cache.take(f.plan,f.intent,0);assert.equal(hit.approvalPrewarmed,true);assert.equal(hit.raw.requestId,'synthetic-preview');assert.equal(hit.review.risks.length,1);assert.equal(f.cache.take(f.plan,f.intent,0),null);
});
test('stale or foreign previews never cross wallet, amount, balance, route, code or call boundaries',async()=>{
 const changes=[p=>p.wallet=bindings()[1].address,p=>p.holdingBefore='1001',p=>p.amountIn='499',p=>p.identity.fingerprint='changed',p=>p.identity.learnedAssets[0].codeHash='changed-router',p=>p.steps[0].spender=token,p=>p.steps[0].kind='sell',p=>p.steps[0].value='1'];
 for(const change of changes){const f=await warmFixture(),plan=structuredClone(f.plan);change(plan);assert.equal(f.cache.take(plan,f.intent,0),null);assert.ok(f.cache.take(f.plan,f.intent,0));}
 const f=await warmFixture();f.setNow(10001);assert.equal(f.cache.take(f.plan,f.intent,0),null);
});
test('copied pool snapshots, paused jobs and busy accounts cannot warm approvals',async()=>{
 const f=await warmFixture();f.cache.entries.clear();f.calls.length=0;
 await f.cache.warm(f.config,f.preflight,{...f.snapshot},f.prep);assert.equal(f.calls.length,0);
 f.setAllowed(false);await f.warm();assert.equal(f.calls.length,0);
 f.setAllowed(true);f.setBusy(true);await f.warm();assert.equal(f.calls.length,0);
});
test('warming failed or in-flight preview cannot block or overwrite foreground work',async()=>{
 const f=await warmFixture(),gate=deferred();f.cache.entries.clear();f.cache.preview=async()=>{await gate.promise;return {at:Date.now()};};
 const warming=f.warm();await tick();assert.equal(f.cache.pending.size,1);assert.equal(f.cache.take(f.plan,f.intent,0),null);
 f.setAllowed(false);gate.resolve();await warming;assert.equal(f.cache.entries.size,0);assert.equal(f.cache.pending.size,0);
 f.setAllowed(true);f.cache.preview=async()=>{throw Error('timeout');};await f.warm();assert.equal(f.cache.entries.size,0);
});
test('engine revalidates warmed official response, never uses it for a sale or changed allowance',async()=>{
 const f=await warmFixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'opening-preview-'));
 let calls=0;const bridge={ready:async()=>{},call:async()=>{calls++;throw Error('normal-preview');}},e=new Engine({rpc:{},bridge,data:dir});e.openingApprovalPreviews=f.cache;
 try{const p=await e.preview(f.plan,f.intent);assert.equal(p.approvalPrewarmed,true);assert.equal(calls,0);
  await assert.rejects(e.preview(f.plan,f.intent),/normal-preview/);assert.equal(calls,1);
  await f.warm();const hit=f.cache.entries.values().next().value;hit.raw.simulationResult.allowanceChanges[0].postAmount='501';
  await assert.rejects(e.preview(f.plan,f.intent),/授权范围超出/);assert.equal(calls,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('the real opening planner consumes the exact warmed approval after fresh balance and allowance reads',async()=>{
 const f=await warmFixture();f.open();const snapshot=await f.detector.scan(token);
 const base=f.rpc.call;f.rpc.call=async tx=>{
  if(same(tx.to,token)){const fn=ERC20.parseTransaction(tx);return ERC20.encodeFunctionResult(fn.name,[fn.name==='balanceOf'?1000n:0n]);}
  if(same(tx.to,d.router))return V2_ROUTER_ABI.encodeFunctionResult('getAmountsOut',[[500n,990n]]);
  return base(tx);
 };
 const plan=await openingPlan(f.rpc,{},f.intent,{snapshot,preparation:f.prep});
 assert.equal(plan.steps.length,2);assert.equal(plan.amountIn,'500');assert.ok(f.cache.take(plan,f.intent,0));
 await f.warm();f.rpc.call=async tx=>same(tx.to,token)?ERC20.encodeFunctionResult(ERC20.parseTransaction(tx).name,[ERC20.parseTransaction(tx).name==='balanceOf'?800n:0n]):same(tx.to,d.router)?V2_ROUTER_ABI.encodeFunctionResult('getAmountsOut',[[400n,790n]]):base(tx);
 const changed=await openingPlan(f.rpc,{},f.intent,{snapshot,preparation:f.prep});assert.equal(changed.amountIn,'400');assert.equal(f.cache.take(changed,f.intent,0),null);
});
test('post-approval quote is overlapped, single-use, and never reused after repricing or amount change',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'opening-refresh-'));let reads=0,balance=1000n;
 const rpc={getBlockNumber:async()=>100,call:async tx=>{
  reads++;const encode=t=>{const abi=same(t.to,token)?ERC20:same(t.to,pair)?POOL:V2_ROUTER_ABI,f=abi.parseTransaction(t);return abi.encodeFunctionResult(f.name,f.name==='balanceOf'?[balance]:f.name==='getReserves'?[1000000n,2000000n,1]:[[f.args[0],900n]]);};
  if(same(tx.to,MULTICALL)){const f=MULTI.parseTransaction(tx);return MULTI.encodeFunctionResult(f.name,[100,'0x'+'0'.repeat(64),f.args[1].map(c=>[true,encode({to:c.target,data:c.callData})])]);}return encode(tx);
 }};
 const plan={account:w.account,token,wallet:w.address,amountIn:'500',holdingBefore:'1000',requireSellCredit:true,outputToken:BNB,slippage:{bps:5000},opening:{...d,pool:pair,quote:WBNB,token0:token,token1:WBNB},steps:[{kind:'approve',to:token},{kind:'sell',to:d.router,data:'0x',value:'0'}]};
 const e=new Engine({rpc,bridge:{},data:dir}),o={id:'synthetic',intent:{account:w.account,side:'sell'},plan,timing:{}};
 try{e.primeOpeningRefresh(o,{step:plan.steps[0]},plan);await e.openingRefreshes.get(o.id).promise;const before=reads;
  assert.equal((await e.freshOpeningSale(o)).minOutput,'450');assert.equal(reads,before);assert.equal(o.timing.postApprovalReadsOverlapped,true);
  await e.freshOpeningSale(o);assert.ok(reads>before);
  e.primeOpeningRefresh(o,{step:plan.steps[0]},plan);await e.openingRefreshes.get(o.id).promise;const prior=reads;await e.freshOpeningSale(o,{repriced:true});assert.ok(reads>prior);
  e.primeOpeningRefresh(o,{step:plan.steps[0]},plan);await e.openingRefreshes.get(o.id).promise;balance=999n;o.plan={...plan,holdingBefore:'999',amountIn:'499'};assert.equal((await e.freshOpeningSale(o)).amountIn,'499');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
