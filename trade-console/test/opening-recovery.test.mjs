import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {recoverableOpeningSale,openingRecoveryPlan} from '../lib/opening-recovery.mjs';
import {OpeningSell} from '../lib/opening-sell.mjs';
import {DEXES,V2_ROUTER_ABI} from '../lib/opening-dex.mjs';
import {BNB,WBNB,ERC20,bindings} from '../lib/common.mjs';
const token='0x1111111111111111111111111111111111111111',bound=bindings()[0],hash='0x'+'1'.repeat(64);
const intent={account:bound.account,asset:token,side:'sell',percent:'50',slippageBps:5000,currency:'AUTO',openingOnly:true};
const pool={...DEXES[0],pool:'0x2222222222222222222222222222222222222222',quote:WBNB,liquid:true};
function original(id='original'){
 const plan={requireSellCredit:true,opening:pool,wallet:bound.address,amountIn:'500',holdingBefore:'1000',outputToken:BNB,identity:{fingerprint:'fixture'}};
 return {id,intent,status:'FAILED',error:{code:'TRANSACTION_REVERTED'},plan,steps:[{status:'CONFIRMED',step:{kind:'approve'}},{status:'FAILED',step:{kind:'sell'},revertVerified:true,receipt:{status:'0x0'},txHash:hash,plan}]};
}
test('wallet-confirmed non-dispatch allows recovery, but unknown acceptance never does',()=>{
 const o=original(),e=o.steps[1];delete e.receipt;delete e.txHash;delete e.revertVerified;o.error={code:'WORKER_OFFLINE'};e.submissionOutcome={source:'local-wallet',accepted:false};assert.equal(recoverableOpeningSale(o),true);
 for(const extra of [{result:{}},{txHash:hash},{receipt:{status:'0x1'}},{submissionOutcome:{source:'provider',accepted:false}}]){const x=structuredClone(o);Object.assign(x.steps[1],extra);assert.equal(recoverableOpeningSale(x),false);}
});
test('alternate route requires exact proven revert, never ambiguous dispatch, successful receipt or approval failure',()=>{
 assert.equal(recoverableOpeningSale(original()),true);
 for(const mutate of [o=>o.status='PENDING',o=>o.status='SUBMISSION_UNKNOWN',o=>o.status='CONFIRMED_REVIEW',o=>o.error.code='TIMEOUT',o=>delete o.steps[1].revertVerified,o=>o.steps[1].receipt.status='0x1',o=>o.steps[1].receipt.status='bad',o=>o.steps[1].step.kind='approve',o=>o.steps[0].status='PENDING',o=>o.plan.opening={kind:'v2'},o=>o.steps[1].txHash='wrong']){const o=original();mutate(o);assert.equal(recoverableOpeningSale(o),false);}
});
function reads(){let balance=1000n;const commands=[];
 const rpc={call:async tx=>{assert.equal(ERC20.parseTransaction(tx).name,'balanceOf');return ERC20.encodeFunctionResult('balanceOf',[balance]);}};
 const bridge={call:async(a,args)=>{commands.push(args);assert.equal(a,bound.account);assert.equal(args[1],'quote');return {toCoinAmount:'0.01'};}};
 const options={scan:async()=>({pools:[pool]}),preparation:{token:async()=>({decimals:3,identity:{fingerprint:'fixture'}})}};
 return {rpc,bridge,options,commands,balance:v=>balance=v};
}
test('recovery quotes only original amount, output and slippage; manual holdings changes stop before quote',async()=>{
 const h=reads(),plan=await openingRecoveryPlan(h.rpc,h.bridge,intent,original(),h.options);
 assert.equal(plan.kind,'swap');assert.equal(plan.amountIn,'500');assert.equal(plan.outputToken,BNB);assert.equal(plan.slippage.bps,5000);assert.equal(plan.recovery.originalId,'original');
 assert.equal(h.commands[0][h.commands[0].indexOf('--fromTokenQty')+1],'0.5');assert.equal(h.commands[0][h.commands[0].indexOf('--slippage')+1],'50');
 h.balance(500n);await assert.rejects(openingRecoveryPlan(h.rpc,h.bridge,intent,original(),h.options),e=>e.code==='OPENING_RECOVERY_HOLDINGS_CHANGED');assert.equal(h.commands.length,1);
 for(const extra of [{percent:'100'},{slippageBps:4900},{currency:'USDT'},{openingOnly:false}])await assert.rejects(openingRecoveryPlan(h.rpc,h.bridge,{...intent,...extra},original(),h.options));
 h.balance(1000n);await assert.rejects(openingRecoveryPlan(h.rpc,h.bridge,intent,original(),{...h.options,scan:async()=>({pools:[{...pool,liquid:false}]})}),/流动性/);assert.equal(h.commands.length,1);
 await assert.rejects(openingRecoveryPlan(h.rpc,h.bridge,intent,original(),{...h.options,preparation:{token:async()=>({decimals:3,identity:{fingerprint:'changed'}})}}),e=>e.code==='OPENING_RECOVERY_IDENTITY_CHANGED');assert.equal(h.commands.length,1);
});
test('explicit gas ceiling survives recovery through a fresh direct route, never an aggregate that ignores it',async()=>{
 const h=reads(),i={...intent,gasLimit:800000},o=original();o.intent=i;
 const rpc={call:async tx=>{
  if(tx.to.toLowerCase()===token.toLowerCase()){const f=ERC20.parseTransaction(tx);assert.ok(['balanceOf','allowance'].includes(f.name));return ERC20.encodeFunctionResult(f.name,[1000n]);}
  const f=V2_ROUTER_ABI.parseTransaction(tx);assert.equal(f.name,'getAmountsOut');return V2_ROUTER_ABI.encodeFunctionResult(f.name,[[500n,100n]]);
 }};
 const opts={...h.options,preparation:{...h.options.preparation,venue:async()=>({assets:[]})}};
 const p=await openingRecoveryPlan(rpc,h.bridge,i,o,opts);
 assert.equal(p.kind,'contract');assert.equal(p.amountIn,'500');assert.equal(p.outputToken,BNB);assert.equal(p.recovery.maxAttempts,1);assert.equal(p.slippage.bps,5000);assert.equal(h.commands.length,0);
 for(const cap of [undefined,900000])await assert.rejects(openingRecoveryPlan(rpc,h.bridge,{...i,gasLimit:cap},o,opts),/约束不一致/);
});
function harness(t){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'opening-recovery-'));let now=10000,execs=0;const plans=[],orders=new Map();
 const engine={live:true,get:id=>orders.get(id),prepare:async(input,id,context)=>{plans.push({id,context});const o={id,intent:input,status:'PREPARED',review:[],steps:[]};orders.set(id,o);return o;},execute:async(id,opts)=>{assert.equal(opts.continueAllowed(),true);execs++;const o=original(id);orders.set(id,o);return o;},follow:async id=>orders.get(id)};
 const options={data,engine,rpc:{},bridge:{},detector:{scan:async()=>({open:true,pools:[pool],at:now})},autoSchedule:false,now:()=>now};
 const m=new OpeningSell(options),j={id:'fixture',config:{asset:token,accounts:[bound.account],percent:'50',slippageBps:5000,currency:'AUTO'},bindings:[{account:bound.account,address:bound.address}],recoveryVersion:1,status:'ARMED',mode:'LIVE',createdAt:now,expiresAt:now+60000,authorization:'synthetic only',rows:[{account:bound.account,status:'WAITING',attempts:0}]};m.jobs.set(j.id,j);
 t.after(()=>{m.close();fs.rmSync(data,{recursive:true,force:true});});return {m,j,engine,plans,orders,options,execs:()=>execs,advance:n=>now+=n};
}
test('proven sale revert schedules one alternate, keeps original evidence and never loops after another failure',async t=>{
 const h=harness(t);await h.m.tick(h.j.id);const row=h.j.rows[0];assert.equal(row.status,'WAITING');assert.equal(row.recoveryAttempts,1);assert.equal(row.previousOrders[0].txHash,hash);
 await h.m.tick(h.j.id);assert.equal(h.execs(),2);assert.deepEqual(h.plans[1].context.openingRecovery,{sourceId:h.plans[0].id});assert.notEqual(h.plans[0].id,h.plans[1].id);assert.equal(row.status,'FAILED');assert.equal(h.j.status,'COMPLETED');
 for(let i=0;i<5;i++)await h.m.tick(h.j.id);assert.equal(h.execs(),2);
});
test('recovery quote/read failures retry preflight only and do not spend another submission until ready',async t=>{
 const h=harness(t);await h.m.tick(h.j.id);let blocked=true;const prepare=h.engine.prepare;
 h.engine.prepare=async(...args)=>blocked?{status:'BLOCKED',steps:[],error:{code:'RPC_UNAVAILABLE'}}:prepare(...args);
 for(let i=0;i<3;i++){await h.m.tick(h.j.id);h.advance(501);}assert.equal(h.execs(),1);assert.equal(h.j.rows[0].status,'WAITING');
 blocked=false;await h.m.tick(h.j.id);assert.equal(h.execs(),2);assert.equal(h.j.rows[0].recoveryAttempts,1);
 const b=harness(t);await b.m.tick(b.j.id);b.engine.prepare=async()=>({status:'BLOCKED',steps:[],error:{code:'OPENING_QUOTE_UNAVAILABLE'}});for(let i=0;i<12;i++){await b.m.tick(b.j.id);b.advance(501);}assert.equal(b.execs(),1);assert.equal(b.j.rows[0].status,'BLOCKED');assert.equal(b.j.rows[0].recoveryPreviews,10);
});
test('legacy, stopped, paused and expired tasks never rearm on a confirmed revert',t=>{
 for(const change of [j=>delete j.recoveryVersion,j=>j.cancelRequested=true,j=>j.status='PAUSED',j=>j.expiresAt=0]){const h=harness(t);change(h.j);h.m.autoResult(h.j,h.j.rows[0],original());assert.equal(h.j.rows[0].status,'FAILED');assert.equal(h.j.rows[0].recoveryAttempts,undefined);assert.equal(h.execs(),0);}
});
test('restart after scheduling recovery pauses; explicit resume uses exactly the recorded original',async t=>{
 const h=harness(t);await h.m.tick(h.j.id);const restored=new OpeningSell(h.options);t.after(()=>restored.close());const j=restored.jobs.get(h.j.id);assert.equal(j.status,'PAUSED');await restored.tick(j.id);assert.equal(h.execs(),1);
 restored.resume(j.id);await restored.tick(j.id);assert.equal(h.execs(),2);assert.equal(h.plans[1].context.openingRecovery.sourceId,h.plans[0].id);
});
test('stop during recovery quote prevents fallback submission; missing/changed holdings block without retry loop',async t=>{
 const h=harness(t);await h.m.tick(h.j.id);let release;h.engine.prepare=async()=>{await new Promise(r=>release=r);return {status:'PREPARED',id:'never',review:[]};};const pending=h.m.tick(h.j.id);await new Promise(r=>setImmediate(r));h.m.stop(h.j.id);release();await pending;assert.equal(h.execs(),1);
 const b=harness(t);await b.m.tick(b.j.id);b.engine.prepare=async()=>({status:'BLOCKED',steps:[],error:{code:'OPENING_RECOVERY_HOLDINGS_CHANGED'}});await b.m.tick(b.j.id);assert.equal(b.j.status,'COMPLETED');await b.m.tick(b.j.id);assert.equal(b.execs(),1);
});
