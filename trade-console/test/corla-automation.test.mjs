import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {CorlaAutomation} from '../lib/corla-automation.mjs';
import {CORLA_MINT} from '../lib/corla.mjs';
import {corlaBudget} from '../public/corla-budget.mjs';
import {OpeningSell,openingConfig} from '../lib/opening-sell.mjs';
import {validateIntent,bindings,ZeroAddress} from '../lib/common.mjs';
import {Engine} from '../lib/engine.mjs';
const addr=n=>'0x'+String(n).repeat(40),mint=addr(2),token=addr(3),w=addr(1),identity={fingerprint:'mint-code'},factory={fingerprint:'factory-code'};
function harness(t,{sell=true}={}){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'corla-auto-'));let now=10000,phase=1n,execs=0,follows=0,prepares=0,probes=0,handoffs=0;
 const parent={id:'parent',intent:{account:1},simulationOnly:false,authorization:'fake test authorization',acknowledgeReview:true,status:'CONFIRMED',steps:[{status:'CONFIRMED',settlement:{kind:'subscription'}}],plan:{route:'corla:mint',wallet:w,identity,protocolIdentities:[factory],afterMint:{autoClaim:true,mint,expectedToken:token,sell:sell?{percent:'50',slippageBps:5000,currency:'AUTO'}:null}}};
 const orders=new Map([['parent',parent]]),engine={live:true,running:new Set(),get:id=>orders.get(id),prepare:async(intent,id)=>{prepares++;const o={id,intent,simulationOnly:false,status:'PREPARED',review:['routine claim'],preview:{risks:[]},steps:[],plan:{route:'corla:claim',wallet:w,outputToken:token,identity,protocolIdentities:[factory],requireAssetCredit:true,steps:[{to:mint,data:CORLA_MINT.encodeFunctionData('claim'),value:'0'}]}};orders.set(id,o);return o;},execute:async(id,options)=>{execs++;assert.equal(options.rejectRisks,true);assert.equal(options.continueAllowed(),true);const o=orders.get(id);o.status='PENDING';return o;},follow:async id=>{follows++;return orders.get(id);}};
 const opening={jobs:new Map(),afterClaim(id,o,policy){handoffs++;assert.equal(o.status,'CONFIRMED');const sale={id,config:{asset:o.plan.outputToken,...policy},status:'ARMED',rows:[{status:'WAITING'}]};this.jobs.set(id,sale);return sale;},stop(id){this.jobs.get(id).status='CANCELLED';}};
 const options={engine,rpc:{},opening,data,autoSchedule:false,now:()=>now,binding:()=>({account:1,address:w}),client:{get:async()=>{probes++;return [2n,phase];}}},m=new CorlaAutomation(options);t.after(()=>{m.close();fs.rmSync(data,{recursive:true,force:true});});
 return {m,options,engine,opening,parent,orders,advance:n=>now+=n,open:()=>phase=3n,end:()=>phase=4n,calls:()=>({execs,follows,prepares,probes,handoffs}),confirm:j=>{const o=orders.get(j.claimId);o.status='CONFIRMED';o.steps=[{status:'CONFIRMED',received:'1000',txHash:'fake-claim-hash'}];return o;}};
}
for(const code of ['SELL_FEE_REVIEW','SELL_FEES_UNVERIFIABLE'])test(code+': claim-linked high-fee sale waits for explicit review and reconciles only the original without restarting tasks',async t=>{
 const h=harness(t),j=h.m.enroll(h.parent);h.open();await h.m.tick(j.id);h.confirm(j);await h.m.tick(j.id);
 const sale=h.opening.jobs.get(j.sellJobId);sale.status='REVIEW';Object.assign(sale.rows[0],{orderId:'held-sale',status:'REVIEW',error:{code}});
 await h.m.tick(j.id);assert.equal(j.status,'REVIEW');assert.equal(j.feeReviewPending,true);assert.equal(h.m.active(),false);
 const before=h.calls();await h.m.tick(j.id);assert.deepEqual(h.calls(),before);
 sale.status='COMPLETED';sale.rows[0].status='CONFIRMED';delete sale.rows[0].error;
 h.m.reconcileOrder({id:'different-sale',status:'CONFIRMED'});assert.equal(j.status,'REVIEW');
 h.m.reconcileOrder({id:'held-sale',status:'CONFIRMED'});assert.equal(j.status,'DONE');assert.equal(j.feeReviewPending,undefined);assert.deepEqual(h.calls(),before);
 for(const status of ['PAUSED','STOPPED','DELETED']){j.status=status;j.feeReviewPending=true;h.m.reconcileOrder({id:'held-sale',status:'CONFIRMED'});assert.equal(j.status,status);}
});
test('claim verified failures retry twice with new IDs and fresh preview, then stop or hand off once',async t=>{
 for(const failure of ['reverted','not-dispatched','simulation-rejected'])for(const succeeds of [true,false]){
  const h=harness(t),j=h.m.enroll(h.parent);h.open();let submissions=0;
  h.engine.execute=async id=>{
   submissions++;const o=h.orders.get(id);o.status='FAILED';o.error={code:'TRANSACTION_REVERTED'};
   const e={plan:o.plan,step:o.plan.steps[0],status:'FAILED'};
   if(failure==='reverted')Object.assign(e,{revertVerified:true,txHash:'0x'+'1'.repeat(64),receipt:{status:'0x0'}});
   else if(failure==='simulation-rejected'){e.error=o.error={code:953401,message:'simulation error',responseReceived:true};e.submissionOutcome={source:'wallet-provider',operation:'contract-call execute',kind:'SIMULATION_REJECTED',accepted:false};}
   else e.submissionOutcome={source:'local-wallet',accepted:false};
   o.steps=[e];if(submissions===3&&succeeds){o.status='CONFIRMED';e.status='CONFIRMED';e.received='1000';}return o;
  };
  await h.m.tick(j.id);const first=j.claimId;assert.equal(j.status,'WATCHING');assert.equal(j.claimRecoveries,1);assert.equal(j.commitStartedAt,undefined);
  h.advance(300);await h.m.tick(j.id);assert.notEqual(j.claimId,first);h.advance(300);await h.m.tick(j.id);
  assert.equal(submissions,3);assert.equal(h.calls().prepares,3);assert.equal(j.failedClaims.length,2);assert.equal(j.status,succeeds?'SELLING':'REVIEW');assert.equal(h.calls().handoffs,succeeds?1:0);
  for(let i=0;i<5;i++){h.advance(1000);await h.m.tick(j.id);}assert.equal(submissions,3);
 }
});
test('claim success, uncertainty, identity mismatch or incomplete revert proof cannot trigger retries',async t=>{
 const changes=[o=>o.status='SUBMISSION_UNKNOWN',o=>o.steps[0].receipt.status='0x1',o=>delete o.steps[0].revertVerified,o=>o.plan.identity={fingerprint:'changed'},o=>o.steps[0].step={...o.steps[0].step,to:addr(99)},o=>o.plan.outputToken=addr(99),o=>o.status='CONFIRMED_REVIEW'];
 for(const change of changes){const h=harness(t),j=h.m.enroll(h.parent);h.open();await h.m.tick(j.id);const o=h.orders.get(j.claimId);o.status='FAILED';o.error={code:'TRANSACTION_REVERTED'};o.steps=[{plan:o.plan,step:o.plan.steps[0],status:'FAILED',revertVerified:true,receipt:{status:'0x0'},txHash:'0x'+'1'.repeat(64)}];change(o);await h.m.tick(j.id);assert.equal(j.status,'REVIEW');assert.equal(j.claimRecoveries,undefined);assert.equal(h.calls().prepares,1);assert.equal(h.calls().handoffs,0);}
});
test('pause during claim retry cooldown preserves original failures and requires explicit resume',async t=>{
 const h=harness(t),j=h.m.enroll(h.parent);h.open();await h.m.tick(j.id);const o=h.orders.get(j.claimId);o.status='FAILED';o.error={code:'TRANSACTION_REVERTED'};o.steps=[{plan:o.plan,step:o.plan.steps[0],status:'FAILED',revertVerified:true,receipt:{status:'0x0'},txHash:'0x'+'1'.repeat(64)}];await h.m.tick(j.id);assert.equal(j.status,'WATCHING');h.m.pause(j.id);h.advance(1000);await h.m.tick(j.id);assert.equal(h.calls().prepares,1);h.m.resume(j.id);await h.m.tick(j.id);assert.equal(h.calls().prepares,2);assert.equal(j.failedClaims.length,1);
});
test('paid max budgets use exact price times remaining quota, per-wallet maximum not sum',()=>{
 const q=(account,lots)=>({account,paidRemaining:lots,unitPrice:{raw:'123456789012345678'},paymentDecimals:18,budgetCurrency:'BNB',paymentToken:ZeroAddress,currency:'BNB'});
 const p={platform:'corla',quotas:[q(1,'3'),q(2,'2')]};const b=corlaBudget(p,[1,2],'paid','max');assert.equal(b.maxBnb,'0.370370367037037034');assert.equal(b.total,'0.61728394506172839');assert.equal(b.maxUsdt,'0');assert.equal(corlaBudget(p,[1],'free','max'),null);
 p.quotas=[{...q(1,'99'),paymentDecimals:6,budgetCurrency:'QUOTE',paymentToken:token,currency:'TEST',unitPrice:{raw:'1001'}}];assert.equal(corlaBudget(p,[1],'all','max').maxQuote,'0.099099');
 p.quotas[0].paidRemaining='0';assert.equal(corlaBudget(p,[1],'paid','max').maxQuote,'0');p.quotas[0].paidRemaining='1000';const capped=corlaBudget(p,[1],'all','max');assert.equal(capped.costs[0].lots,500);assert.equal(capped.costs[0].limited,true);
 p.quotas[0].error='RPC unavailable';assert.throws(()=>corlaBudget(p,[1],'all','max'),/核验/);
});
test('policy validation forbids claim-sale on buy, invalid percentages, hidden keys, disabled claim',()=>{
 const base={account:bindings()[0].account,asset:mint,side:'mint',quantity:'max',maxBnb:'1',scope:'paid'};
 assert.equal(validateIntent({...base,claimSell:{}}).claimSell.percent,'50');
 for(const extra of [{autoClaim:'true'},{autoClaim:false,claimSell:{}},{claimSell:{percent:101}},{claimSell:{slippageBps:5001}},{claimSell:{to:token}},{side:'buy',amount:'1',autoClaim:true}])assert.throws(()=>validateIntent({...base,...extra}));
 assert.equal(openingConfig({asset:token,accounts:[bindings()[0].account]}).percent,'50');
});
test('only authorized live subscription can enroll; preview and simulation never arm',t=>{
 const h=harness(t);for(const extra of [{authorization:null},{simulationOnly:true},{plan:{route:'corla:claim'}}])h.m.enroll({...h.parent,...extra});h.engine.live=false;h.m.enroll(h.parent);assert.equal(h.m.list().length,0);h.engine.live=true;const j=h.m.enroll(h.parent);assert.equal(h.m.enroll(h.parent).id,j.id);assert.equal(h.m.list().length,1);
});
test('open triggers full claim exactly once and hands off only after credited receipt',async t=>{
 const h=harness(t),j=h.m.enroll(h.parent);await h.m.tick(j.id);assert.equal(j.status,'WATCHING');assert.equal(h.calls().execs,0);
 h.open();h.advance(300);await h.m.tick(j.id);assert.equal(j.status,'CLAIMING');assert.equal(h.calls().execs,1);assert.equal(h.calls().handoffs,0);
 await h.m.tick(j.id);assert.equal(h.calls().execs,1);h.confirm(j);await h.m.tick(j.id);assert.equal(j.status,'SELLING');assert.equal(h.calls().handoffs,1);assert.equal(h.opening.jobs.get(j.sellJobId).config.percent,'50');await h.m.tick(j.id);assert.equal(h.calls().handoffs,1);
 h.opening.jobs.get(j.sellJobId).status='COMPLETED';h.opening.jobs.get(j.sellJobId).rows[0].status='CONFIRMED';await h.m.tick(j.id);assert.equal(j.status,'DONE');
});
test('terminated Corla project stops waiting without submitting or automatically selling',async t=>{
 const h=harness(t),j=h.m.enroll(h.parent);h.options.client.get=async()=>[2n,6n];
 await h.m.tick(j.id);assert.equal(j.status,'REVIEW');assert.match(j.message,/终止/);
 h.advance(1000);await h.m.tick(j.id);assert.equal(h.calls().execs,0);assert.equal(h.calls().prepares,0);assert.equal(h.calls().handoffs,0);
});
test('claim-only leaves all tokens and manual external claim does not authorize a sale',async t=>{
 const h=harness(t,{sell:false}),j=h.m.enroll(h.parent);h.open();await h.m.tick(j.id);h.confirm(j);await h.m.tick(j.id);assert.equal(j.status,'DONE');assert.equal(h.calls().handoffs,0);
 const other=harness(t);other.engine.prepare=async()=>({status:'BLOCKED',steps:[],error:{message:'NothingToClaim'}});const x=other.m.enroll(other.parent);other.open();await other.m.tick(x.id);assert.equal(other.calls().execs,0);assert.equal(other.calls().handoffs,0);
});
test('failed mint and refund phase never claim; partial confirmed subscriptions do',async t=>{
 const h=harness(t);h.parent.status='FAILED';h.parent.steps=[];let j=h.m.enroll(h.parent);h.open();await h.m.tick(j.id);assert.equal(j.status,'REVIEW');assert.equal(h.calls().execs,0);
 const other=harness(t);other.parent.status='PARTIAL';j=other.m.enroll(other.parent);other.end();await other.m.tick(j.id);assert.equal(j.status,'REVIEW');assert.match(j.message,/退款/);
});
test('partial subscription with a rejected later lot still claims confirmed allocation once at opening',async t=>{
 const h=harness(t);h.parent.status='PARTIAL';h.parent.error={code:953401,message:'simulation error'};h.parent.steps.push({status:'FAILED',error:h.parent.error});
 const j=h.m.enroll(h.parent);await h.m.tick(j.id);assert.equal(j.status,'WATCHING');assert.equal(h.calls().execs,0);
 h.open();h.advance(300);await h.m.tick(j.id);assert.equal(j.status,'CLAIMING');assert.equal(h.calls().execs,1);assert.equal(h.calls().handoffs,0);
 h.confirm(j);await h.m.tick(j.id);assert.equal(j.status,'SELLING');assert.equal(h.calls().handoffs,1);
});
test('new wallet risks or changed target, token or identity stop automatic execution',async t=>{
 for(const mutate of [o=>o.preview.risks=['new risk'],o=>o.plan.outputToken=addr(8),o=>o.plan.wallet=addr(8),o=>o.plan.identity={fingerprint:'changed'},o=>o.plan.protocolIdentities=[{fingerprint:'changed'}],o=>o.plan.steps[0].value='1']){
  const h=harness(t),base=h.engine.prepare;h.engine.prepare=async(...args)=>{const o=await base(...args);mutate(o);return o;};const j=h.m.enroll(h.parent);h.open();await h.m.tick(j.id);assert.equal(j.status,'REVIEW');assert.equal(h.calls().execs,0);
 }
});
test('stop during asynchronous claim preview never dispatches or resurrects job',async t=>{
 const h=harness(t),base=h.engine.prepare;let release;h.engine.prepare=async(...a)=>{await new Promise(r=>release=r);return base(...a);};const j=h.m.enroll(h.parent);h.open();const tick=h.m.tick(j.id);await new Promise(r=>setImmediate(r));h.m.stop(j.id);release();await tick;assert.equal(h.calls().execs,0);assert.equal(j.status,'STOPPED');
});
test('unknown dispatch and restart retain same claim ID, never prepare a replacement',async t=>{
 const h=harness(t),j=h.m.enroll(h.parent);h.open();await h.m.tick(j.id);const id=j.claimId;h.orders.get(id).status='SUBMISSION_UNKNOWN';await h.m.tick(j.id);assert.equal(j.status,'REVIEW');h.advance(10000);await h.m.tick(j.id);assert.equal(h.calls().execs,1);assert.equal(h.calls().prepares,1);
 const other=harness(t),k=other.m.enroll(other.parent);other.open();await other.m.tick(k.id);const restored=new CorlaAutomation(other.options);assert.equal(restored.jobs.get(k.id).status,'PAUSED');await restored.tick(k.id);assert.equal(other.calls().execs,1);restored.resume(k.id);other.confirm(k);await restored.tick(k.id);assert.equal(other.calls().execs,1);assert.equal(other.calls().handoffs,1);restored.close();
});
test('concurrent ticks and shared projects deduplicate scan; wallet binding changes stop',async t=>{
 const h=harness(t),j=h.m.enroll(h.parent);h.open();await Promise.all([h.m.tick(j.id),h.m.tick(j.id)]);assert.equal(h.calls().execs,1);
 const other=harness(t);const k=other.m.enroll(other.parent);other.m.binding=()=>({address:addr(9)});await other.m.tick(k.id);assert.equal(k.status,'REVIEW');assert.equal(other.calls().execs,0);
});
test('production opening handoff is idempotent, rejects unconfirmed claim and does not sign',t=>{
 const h=harness(t),account=bindings()[0],m=new OpeningSell({engine:{live:true},rpc:{},bridge:{},detector:{},data:h.options.data,autoSchedule:false});t.after(()=>m.close());
 const claim={id:'fixture-claim',intent:{account:account.account},status:'CONFIRMED',simulationOnly:false,plan:{route:'corla:claim',wallet:account.address,outputToken:token}};
 assert.throws(()=>m.afterClaim('a',{...claim,status:'PENDING'},{percent:'50'},'fake'),/尚未确认/);
 const j=m.afterClaim('a',claim,{percent:'50'},'fake');assert.equal(j.status,'ARMED');assert.equal(m.afterClaim('a',claim,{percent:'50'},'fake').id,'a');assert.equal(m.list().length,1);assert.throws(()=>m.afterClaim('b',claim,{percent:'50'},'fake'),/已有/);
});
test('strict automated execution refuses a new official risk even with routine plan acknowledgement',async t=>{
 const h=harness(t),account=bindings()[0];let dispatched=0;
 const engine=new Engine({rpc:{},data:h.options.data,live:true,bridge:{ready:async()=>{},call:()=>{dispatched++;assert.fail('risk must stop execute');}},planFn:async()=>({kind:'contract',route:'corla:claim',wallet:account.address,token,amountIn:'0',quantity:1,steps:[{kind:'mint',to:mint,value:'0',data:CORLA_MINT.encodeFunctionData('claim')}],review:['routine claim']})});
 engine.preview=async()=>({raw:{requestId:'fixture',risks:['new risk']},review:{risks:['new risk']},at:Date.now()});
 const input={account:account.account,side:'mint',asset:mint,routeId:'corla:claim',quantity:1,maxBnb:'0',scope:'free',autoClaim:false};
 const o=await engine.prepare(input,'strict-risk');assert.equal(o.status,'PREPARED');const result=await engine.execute(o.id,{authorization:'synthetic test',acknowledgeReview:true,rejectRisks:true});assert.equal(result.status,'BLOCKED');assert.match(result.error.message,/风险/);assert.equal(dispatched,0);
});
test('claim local admission contention cannot exhaust attempts or strand a prepared claim; retry keeps the same ID',async t=>{
 for(const stage of ['prepare','execute'])for(const code of ['WALLET_BUSY','ORDER_UNRESOLVED']){
  const h=harness(t),j=h.m.enroll(h.parent),prepare=h.engine.prepare,execute=h.engine.execute,ids=[];let busy=true;
  const guard=()=>Object.assign(Error('fixture local guard'),{code,details:{requestAccepted:false}});
  h.engine.prepare=async(i,id)=>{ids.push(id);if(busy&&stage==='prepare')throw guard();return prepare(i,id);};
  h.engine.execute=async(...args)=>{if(busy&&stage==='execute')throw guard();return execute(...args);};h.open();
  for(let i=0;i<35;i++){await h.m.tick(j.id);h.advance(500);}
  assert.equal(j.status,'WATCHING');assert.equal(j.attempts,0);assert.equal(j.busyDeferrals,35);assert.equal(j.commitStartedAt,undefined);assert.equal(h.calls().execs,0);
  assert.equal(new Set(ids).size,1);assert.equal(j.errorHistory.length,12);assert.equal(j.lastError.code,code);
  busy=false;await h.m.tick(j.id);assert.equal(h.calls().execs,1);assert.equal(j.attempts,1);assert.equal(j.status,'CLAIMING');
  h.confirm(j);await h.m.tick(j.id);await h.m.tick(j.id);assert.equal(h.calls().handoffs,1);assert.equal(h.calls().execs,1);
 }
});
test('receipt read or parent follow contention never creates a fresh claim or loses original evidence',async t=>{
 const h=harness(t),j=h.m.enroll(h.parent);h.open();await h.m.tick(j.id);const original=j.claimId;
 const follow=h.engine.follow;h.engine.follow=async()=>{throw Object.assign(Error('fixture read lock'),{code:'WALLET_BUSY',details:{requestAccepted:false}});};
 for(let i=0;i<35;i++)await h.m.tick(j.id);
 assert.equal(j.status,'CLAIMING');assert.equal(j.claimId,original);assert.equal(j.attempts,1);assert.equal(h.calls().execs,1);
 h.engine.follow=follow;h.confirm(j);await h.m.tick(j.id);assert.equal(h.calls().handoffs,1);
 const b=harness(t),k=b.m.enroll(b.parent);b.parent.status='PENDING';b.engine.follow=async()=>{throw Error('fixture temporary original lookup');};await b.m.tick(k.id);
 assert.equal(k.status,'WAITING_MINT');assert.equal(k.lastError.providerMessage,'fixture temporary original lookup');assert.equal(b.calls().execs,0);
});
test('already claimed and missing allocation stop with specific reasons and never authorize a sale',async t=>{
 for(const code of ['CORLA_ALREADY_CLAIMED','NO_QUOTA','CORLA_REFUND_ONLY']){
  const h=harness(t),j=h.m.enroll(h.parent);h.open();h.engine.prepare=async()=>({status:'BLOCKED',steps:[],error:{code,message:'fixture state',details:{reason:'no-allocation'}}});await h.m.tick(j.id);h.advance(1000);await h.m.tick(j.id);
  assert.equal(j.status,'REVIEW');assert.equal(j.attempts,1);assert.equal(j.lastError.code,code);assert.equal(h.calls().execs,0);assert.equal(h.calls().handoffs,0);
 }
});
test('same-project enrollment during pending scan cannot race a new claim ahead of new mint',async t=>{
 const h=harness(t),j=h.m.enroll(h.parent);await h.m.tick(j.id);h.advance(300);let release;h.m.client.get=()=>new Promise(r=>release=r);const tick=h.m.tick(j.id);await new Promise(r=>setImmediate(r));
 const second={...h.parent,id:'second',status:'PENDING',steps:[]};h.orders.set(second.id,second);h.m.enroll(second);release([3n,3n]);await tick;assert.equal(j.status,'WAITING_MINT');assert.equal(h.calls().execs,0);assert.equal(j.parents.length,2);
});
test('cancel after claim dispatch prevents linked selling, even when receipt arrives',async t=>{
 const h=harness(t),j=h.m.enroll(h.parent);h.open();await h.m.tick(j.id);h.m.stop(j.id);h.confirm(j);await h.m.tick(j.id);assert.equal(h.calls().handoffs,0);assert.equal(j.status,'STOPPED');
});
test('pause during claim preview stays visible, blocks immediate resume and preserves original policy',async t=>{
 const h=harness(t),base=h.engine.prepare,j=h.m.enroll(h.parent);h.open();let release;h.engine.prepare=async(...a)=>{await new Promise(r=>release=r);return base(...a);};const pending=h.m.tick(j.id);await new Promise(r=>setImmediate(r));h.m.pause(j.id);assert.throws(()=>h.m.resume(j.id),/正在结束/);release();await pending;assert.equal(j.status,'PAUSED');assert.equal(h.m.list().length,1);assert.equal(h.calls().execs,0);h.engine.prepare=base;h.m.resume(j.id);await h.m.tick(j.id);assert.equal(h.calls().execs,1);
});
test('delete during claim preview leaves a durable tombstone and cannot enroll the same authorization again',async t=>{
 const h=harness(t),base=h.engine.prepare,j=h.m.enroll(h.parent);h.open();let release;h.engine.prepare=async(...a)=>{await new Promise(r=>release=r);return base(...a);};const pending=h.m.tick(j.id);await new Promise(r=>setImmediate(r));h.m.remove(j.id);release();await pending;assert.equal(j.status,'DELETED');assert.equal(h.calls().execs,0);assert.equal(h.m.list().length,0);
 const restarted=new CorlaAutomation(h.options);t.after(()=>restarted.close());assert.equal(restarted.list().length,0);assert.equal(restarted.enroll(h.parent).status,'DELETED');assert.throws(()=>restarted.restore(j.id));assert.throws(()=>restarted.resume(j.id));assert.equal(h.orders.has(h.parent.id),true);
});
test('late claim error cannot resurrect a paused or deleted task',async t=>{
 for(const method of ['pause','remove']){const h=harness(t),j=h.m.enroll(h.parent);h.open();let reject;h.engine.execute=()=>new Promise((_,r)=>reject=r);const pending=h.m.tick(j.id);await new Promise(r=>setImmediate(r));h.m[method](j.id);reject(Error('late RPC failure'));await pending;assert.equal(j.status,method==='pause'?'PAUSED':'DELETED');assert.equal(h.calls().handoffs,0);}
});
test('old stopped task is restored as paused only; claim and sale IDs are retained',async t=>{
 const h=harness(t),j=h.m.enroll(h.parent);h.m.stop(j.id);h.m.restore(j.id);assert.equal(j.status,'PAUSED');assert.equal(j.resumeStatus,'WAITING_MINT');assert.equal(h.calls().execs,0);await h.m.tick(j.id);assert.equal(h.calls().prepares,0);h.m.resume(j.id);await h.m.tick(j.id);assert.equal(j.status,'WATCHING');
});
test('deleting a submitted claim retains original journal and never hands off its later credit',async t=>{
 const h=harness(t),j=h.m.enroll(h.parent);h.open();await h.m.tick(j.id);const id=j.claimId;h.m.remove(j.id);h.confirm(j);await h.m.tick(j.id);assert.equal(h.orders.get(id).status,'CONFIRMED');assert.equal(h.calls().handoffs,0);assert.equal(h.calls().execs,1);assert.equal(h.m.list().length,0);
});
test('parent pause and delete cascade to linked sale, but never erase claim/subscription orders',async t=>{
 const h=harness(t),j=h.m.enroll(h.parent);h.open();await h.m.tick(j.id);h.confirm(j);await h.m.tick(j.id);const sale=h.opening.jobs.get(j.sellJobId);let paused=0,removed=0;h.opening.pause=id=>{assert.equal(id,sale.id);sale.status='PAUSED';paused++;};h.opening.remove=id=>{assert.equal(id,sale.id);sale.status='DELETED';removed++;};h.m.pause(j.id);assert.equal(paused,1);assert.equal(j.resumeStatus,'SELLING');assert.equal(j.status,'PAUSED');h.m.remove(j.id);assert.equal(removed,1);assert.equal(h.orders.get(j.claimId).status,'CONFIRMED');assert.equal(h.orders.get('parent').status,'CONFIRMED');
});
test('failed parent resume persistence pauses linked child again before its scheduled tick',async t=>{
 const h=harness(t),j=h.m.enroll(h.parent);j.status='PAUSED';j.resumeStatus='SELLING';j.sellJobId='sale';j.claimId='claim';h.orders.set('claim',{status:'CONFIRMED'});const sale={status:'PAUSED'};h.opening.jobs.set('sale',sale);h.opening.resumeAfterClaim=()=>sale.status='ARMED';h.opening.pause=()=>sale.status='PAUSED';h.m.persist=()=>{throw Error('disk full');};assert.throws(()=>h.m.resume(j.id),/disk full/);assert.equal(j.status,'PAUSED');assert.equal(sale.status,'PAUSED');assert.equal(h.calls().execs,0);
});
test('claim-to-sale journal gap recovers with stable handoff ID only after explicit restart resume',async t=>{
 const h=harness(t),j=h.m.enroll(h.parent);h.open();await h.m.tick(j.id);h.confirm(j);const handoff=h.opening.afterClaim.bind(h.opening);h.opening.afterClaim=()=>{throw Error('simulated handoff interruption');};
 await assert.rejects(h.m.claimResult(j,h.orders.get(j.claimId)),/interruption/);assert.equal(j.status,'SELLING');const restored=new CorlaAutomation(h.options);assert.equal(restored.jobs.get(j.id).status,'PAUSED');h.opening.afterClaim=handoff;restored.resume(j.id);await restored.tick(j.id);assert.equal(h.calls().execs,1);assert.equal(h.calls().handoffs,1);restored.close();
});

test('claim registry warmup coalesces across wallets, retries read failures and never signs',async t=>{
 const h=harness(t),j=h.m.enroll(h.parent);let reads=0,release;
 h.engine.warmCorlaClaim=()=>{reads++;return new Promise(r=>release=r);};h.m.warmClaim(j);h.m.warmClaim({...j,account:2});await new Promise(r=>setImmediate(r));assert.equal(reads,1);
 h.advance(6000);h.m.warmClaim(j);assert.equal(reads,1);release();await new Promise(r=>setImmediate(r));
 h.engine.warmCorlaClaim=async()=>{reads++;throw Error('read failure');};h.m.warmClaim(j);await new Promise(r=>setImmediate(r));h.m.warmClaim(j);await new Promise(r=>setImmediate(r));assert.equal(reads,3);assert.equal(h.calls().execs,0);assert.equal(h.calls().prepares,0);
});
test('slow project scan is coalesced even after 250 ms; rejected scans can retry',async t=>{
 const h=harness(t);let release,reads=0;h.m.client.get=()=>{reads++;return new Promise(r=>release=r);};
 const a=h.m.probe(mint);h.advance(900);const b=h.m.probe(mint);assert.equal(reads,1);release([1n,3n]);await Promise.all([a,b]);
 h.m.client.get=async()=>{reads++;throw Error('offline');};await assert.rejects(h.m.probe(mint),/offline/);await assert.rejects(h.m.probe(mint),/offline/);assert.equal(reads,3);
});
test('cancel while authorized max subscription resumes cannot resurrect WATCHING',async t=>{
 const h=harness(t),j=h.m.enroll(h.parent);h.parent.status='READY_TO_CONTINUE';let release;h.engine.execute=async()=>{await new Promise(r=>release=r);return {...h.parent,status:'PARTIAL'};};
 const tick=h.m.tick(j.id);await new Promise(r=>setImmediate(r));h.m.stop(j.id);release();await tick;assert.equal(j.status,'STOPPED');assert.equal(h.calls().prepares,0);
});
test('sale route warming overlaps claim, never waits for a slow pool or hands off before receipt',async t=>{
 const h=harness(t);let tokenReads=0,scans=0,release;const pending=new Promise(r=>release=r);h.engine.openingPreparation={venue:async()=>{},token:async()=>{tokenReads++;return pending;}};h.opening.detector={scan:async()=>{scans++;return pending;}};
 const j=h.m.enroll(h.parent);h.open();await h.m.tick(j.id);assert.equal(j.status,'CLAIMING');assert.equal(scans,1);assert.equal(tokenReads,1);assert.equal(h.calls().handoffs,0);
 h.advance(4000);await h.m.tick(j.id);assert.equal(scans,1);release();h.confirm(j);await h.m.tick(j.id);assert.equal(h.calls().handoffs,1);
});
test('explicit resume continues paused linked sale with the original ID and pending order',async t=>{
 const h=harness(t),bound=bindings()[0];let now=Date.now(),executions=0;
 const options={engine:{live:true,get:()=>({status:'PENDING'}),execute:()=>{executions++;assert.fail('resume cannot sign');}},rpc:{},bridge:{},detector:{},data:h.options.data,autoSchedule:false,now:()=>now};
 const first=new OpeningSell(options);t.after(()=>first.close());const claim={id:'resume-claim',intent:{account:bound.account},status:'CONFIRMED',simulationOnly:false,plan:{route:'corla:claim',wallet:bound.address,outputToken:token}},policy={percent:'50'};
 const j=first.afterClaim('resume-sale',claim,policy,'original');j.status='TRACKING';Object.assign(j.rows[0],{status:'TRACKING',orderId:'original-sale',commitStartedAt:now});first.persist();
 const restored=new OpeningSell(options);t.after(()=>restored.close());assert.equal(restored.jobs.get(j.id).status,'PAUSED');
 const resumed=restored.resumeAfterClaim(j.id,claim,policy,'original');assert.equal(resumed.status,'TRACKING');assert.equal(resumed.rows[0].orderId,'original-sale');assert.equal(executions,0);assert.equal(restored.list().length,1);
 assert.throws(()=>restored.resumeAfterClaim(j.id,claim,{percent:'75'},'changed'),/不一致/);
 restored.stop(j.id);assert.equal(restored.resumeAfterClaim(j.id,claim,policy,'original').status,'CANCELLED');
});
test('resuming linked sale reviews ambiguous dispatch and does not extend expired monitoring',t=>{
 const h=harness(t),bound=bindings()[0];const engine={live:true,get:()=>({status:'PREPARED'})},m=new OpeningSell({engine,rpc:{},bridge:{},detector:{},data:h.options.data,autoSchedule:false});t.after(()=>m.close());
 const claim={id:'resume-check',intent:{account:bound.account},status:'CONFIRMED',plan:{route:'corla:claim',wallet:bound.address,outputToken:token}},j=m.afterClaim('boundary',claim,{percent:'50'},'original');
 j.status='PAUSED';Object.assign(j.rows[0],{status:'PREPARING',orderId:'ambiguous',commitStartedAt:1});m.resumeAfterClaim(j.id,claim,{percent:'50'},'original');assert.equal(j.rows[0].status,'REVIEW');
 j.status='PAUSED';j.rows=[{account:bound.account,status:'WAITING',attempts:0}];j.expiresAt=0;m.resumeAfterClaim(j.id,claim,{percent:'50'},'original');assert.equal(j.rows[0].status,'EXPIRED');
});

test('Corla explicit resume also resumes only its existing linked sale; startup stays paused',async t=>{
 const h=harness(t),j=h.m.enroll(h.parent);h.open();await h.m.tick(j.id);h.confirm(j);await h.m.tick(j.id);h.opening.jobs.get(j.sellJobId).status='PAUSED';let resumes=0;
 h.opening.resumeAfterClaim=(id,o,policy)=>{resumes++;assert.equal(id,j.sellJobId);assert.equal(o.id,j.claimId);assert.equal(policy.percent,'50');h.opening.jobs.get(id).status='ARMED';};
 const restored=new CorlaAutomation(h.options);t.after(()=>restored.close());assert.equal(restored.jobs.get(j.id).status,'PAUSED');assert.equal(resumes,0);
 restored.resume(j.id);assert.equal(resumes,1);assert.equal(restored.jobs.get(j.id).status,'SELLING');await restored.tick(j.id);assert.equal(h.calls().execs,1);assert.equal(h.calls().handoffs,1);
});

test('refund-only phase five stops monitoring; refund-mint version one keeps watching',async t=>{
 for(const version of [0n,1n]){const h=harness(t);h.m.client={get:async(to,abi,name)=>name==='getMintState'?[2n,5n]:[version],locate:async()=>({root:{version:'6'}})};const j=h.m.enroll(h.parent);await h.m.tick(j.id);assert.equal(j.status,version===1n?'WATCHING':'REVIEW');assert.equal(h.calls().execs,0);}
});
test('bulk-compatible Corla resume rejects an overlapping active task and cancelled marker',t=>{const h=harness(t),j=h.m.enroll(h.parent);j.status='PAUSED';j.resumeStatus='WATCHING';const other=h.m.enroll({...h.parent,id:'another-subscription'});assert.throws(()=>h.m.resume(j.id),/已有/);h.m.stop(other.id);j.cancelled=true;assert.throws(()=>h.m.resume(j.id),/未停止/);j.cancelled=false;assert.equal(h.m.resume(j.id).status,'WATCHING');assert.equal(h.calls().execs,0);});
test('Corla resume persistence failure remains paused and does not schedule actions',t=>{const h=harness(t),j=h.m.enroll(h.parent);j.status='PAUSED';j.resumeStatus='WATCHING';h.m.persist=()=>{throw Error('disk full');};let schedules=0;h.m.schedule=()=>schedules++;assert.throws(()=>h.m.resume(j.id),/disk full/);assert.equal(j.status,'PAUSED');assert.equal(j.resumeStatus,'WATCHING');assert.equal(schedules,0);assert.equal(h.calls().execs,0);});
