import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Engine} from '../lib/engine.mjs';import {providerRefusal,repairRejectedOrder} from '../lib/provider-outcome.mjs';import {bindings,BNB,ERC20,hash,save} from '../lib/common.mjs';import {runInstantTrades} from '../public/trade-workflow.mjs';import {reviewSummary,totalTimeLabel} from '../public/review-model.mjs';
import {OriginalTracker} from '../lib/original-tracker.mjs';import {lateSink} from '../lib/late-result.mjs';
const raw='This token has been flagged as potentially risky. Please open the Binance app to review the risk warning and decide whether to proceed.',w=bindings()[0],token='0x'+'1'.repeat(40),intent={account:w.account,side:'buy',asset:token,amount:'0.02',currency:'BNB',slippageBps:100};
const legacy=()=>({id:'legacy-risk',createdAt:1000,intent,status:'SUBMISSION_UNKNOWN',steps:[],plan:{kind:'swap',inputToken:BNB,outputToken:token},error:{code:30003001,message:'old mislabel',providerMessage:raw}});
const insufficientBnb='The transaction failed because your BNB balance is insufficient to cover this trade. Please top up your BNB balance and retry.';
const insufficientError=()=>({code:30003001,message:insufficientBnb,providerMessage:insufficientBnb,responseReceived:true,dispatched:true});
function harness(t){const data=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-test-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));let sends=0,reads=0,reject=true,finished=false;const bridge={ready:async()=>({}),call:async(a,args)=>{if(args[1]==='swap'){sends++;if(reject)throw Object.assign(Error(raw),{code:30003001,responseReceived:true,dispatched:true});return {orderId:'accepted-'+sends};}if(args[1]==='list'){reads++;return {list:[{orderId:'accepted-'+sends,status:finished?'FAILED':'PENDING'}]};}throw Error('Unexpected command');}};
 const planFn=async()=>({kind:'swap',wallet:w.address,token,inputToken:BNB,outputToken:token,amountIn:'20000000000000000',review:['test audit warning'],steps:[],args:['--fromTokenQty','0.02','--slippage','1']});const engine=new Engine({data,bridge,rpc:{},live:true,planFn});return {data,engine,setReject:x=>reject=x,setFinished:x=>finished=x,counts:()=>({sends,reads})};}
test('specific provider refusal is terminal; code alone, transport errors and vague reasons are not',()=>{assert.equal(providerRefusal({code:30003001,message:raw,responseReceived:true}).accepted,false);for(const e of [{code:30003001,message:raw},{code:30003001,message:'Timeout',responseReceived:true},{code:30003001,message:'Slippage',responseReceived:true},{code:'TIMEOUT',message:raw,responseReceived:true}])assert.equal(providerRefusal(e),null);});
test('legacy repair requires preserved exact provider error and no submission evidence',()=>{assert.equal(repairRejectedOrder(legacy()).status,'REJECTED');for(const override of [{txHash:'0x123'},{orderId:'123'},{steps:[{kind:'sell'}]},{result:{orderId:'123'}},{error:{code:30003001,message:raw}},{status:'PENDING'}])assert.equal(repairRejectedOrder({...legacy(),...override}),null);});
test('complete invalid-parameter refusal releases the failed operation, not ambiguous submissions',()=>{
 const text='The transaction failed due to invalid parameters. Please review the parameters then submit again.';
 const error={code:30003001,providerMessage:text,responseReceived:true};
 assert.equal(providerRefusal(error).kind,'INVALID_PARAMETERS');
 const original={...legacy(),id:'parameter-rejection',error};const repaired=repairRejectedOrder(original);
 assert.equal(repaired.status,'REJECTED');assert.equal(repaired.error.providerMessage,text);assert.equal(original.status,'SUBMISSION_UNKNOWN');
 for(const override of [{orderId:'pending'},{txHash:'0x123'},{result:{}},{receipt:{}},{steps:[{}]},{error:{...error,responseReceived:false}},{error:{...error,providerMessage:'Invalid parameters or unknown submission'}}])assert.equal(repairRejectedOrder({...original,...override}),null);
});
test('invalid-parameter submit response cannot pin a wallet or resend the old operation',async t=>{
 const h=harness(t);let sends=0;
 h.engine.bridge.call=async(a,args)=>{assert.equal(args[1],'swap');sends++;throw Object.assign(Error('The transaction failed due to invalid parameters. Please review the parameters then submit again.'),{code:30003001,responseReceived:true,dispatched:true});};
 const failed=await h.engine.run(intent,'invalid-parameters',{execute:true,acknowledgeReview:true,authorization:'synthetic test',swapReceiptWaitMs:0});
 assert.equal(failed.status,'REJECTED');assert.equal((await h.engine.reconcileAccount(w.account)).ready,true);
 assert.equal((await h.engine.prepare(intent,'fresh-user-click')).status,'PREPARED');assert.equal(sends,1);
 await h.engine.execute('invalid-parameters',{authorization:'same old operation'});assert.equal(sends,1);
});
test('legacy records are backed up, repaired without wallet calls and never automatically resent',async t=>{const h=harness(t);h.engine.write(legacy());const result=await h.engine.reconcileAccount(w.account);assert.equal(result.ready,true);assert.equal(h.engine.get('legacy-risk').status,'REJECTED');assert.equal(JSON.parse(fs.readFileSync(path.join(h.data,'order-repair-backups',hash('legacy-risk')+'.json'))).status,'SUBMISSION_UNKNOWN');assert.deepEqual(h.counts(),{sends:0,reads:0});await h.engine.execute('legacy-risk',{authorization:'duplicate'});assert.equal(h.counts().sends,0);});
test('explicit instant click acknowledges local review without modal policy, refusal unlocks a subsequent fresh click',async t=>{const h=harness(t);const a=await h.engine.run(intent,'click1',{execute:true,acknowledgeReview:true,authorization:'fake instant click',swapReceiptWaitMs:0});assert.equal(a.status,'REJECTED');assert.equal(h.counts().sends,1);h.setReject(false);const b=await h.engine.run(intent,'click2',{execute:true,acknowledgeReview:true,authorization:'fake second click',swapReceiptWaitMs:0});assert.equal(b.status,'PENDING');assert.equal(h.counts().sends,2);await h.engine.execute('click1',{authorization:'old ID'});assert.equal(h.counts().sends,2);});
test('confirmation disabled does not silently acknowledge review',async t=>{const h=harness(t),o=await h.engine.run(intent,'review',{execute:true,authorization:'fake click'});assert.equal(o.status,'PREPARED');assert.equal(o.needsReview,true);assert.equal(h.counts().sends,0);});
test('next click first reads a pending original; verified failure releases only that wallet',async t=>{const h=harness(t);h.setReject(false);await h.engine.run(intent,'pending',{execute:true,acknowledgeReview:true,authorization:'fake',swapReceiptWaitMs:0});await assert.rejects(h.engine.prepare(intent,'blocked'),e=>e.code==='ORDER_UNRESOLVED'&&e.details.orderId==='pending');assert.equal(h.counts().sends,1);h.setFinished(true);const next=await h.engine.prepare(intent,'retry');assert.equal(next.status,'PREPARED');assert.equal(h.engine.get('pending').status,'FAILED');assert.equal(h.counts().sends,1);});
test('busy/unresolved server rejection is never presented as a new uncertain submission',async()=>{const r=await runInstantTrades([{id:'new',intent}],async()=>{throw Object.assign(Error('Original still pending'),{code:'ORDER_UNRESOLVED',details:{orderId:'original',requestAccepted:false}});});assert.equal(r[0].status,'BLOCKED');assert.equal(r[0].error.details.orderId,'original');assert.equal(reviewSummary([{status:'SUBMISSION_UNKNOWN',intent}]).canConfirm,false);});
test('service restart repairs only explicit preacceptance refusals and preserves real unknown states',async t=>{const h=harness(t);h.engine.write(legacy());h.engine.write({...legacy(),id:'uncertain',error:{code:'TIMEOUT',message:'connection lost'},intent:{...intent,account:bindings()[1].account}});const fresh=new Engine({data:h.data,bridge:{call:()=>assert.fail('No wallet operation on load')},rpc:{}});assert.equal(fresh.get('legacy-risk').status,'REJECTED');assert.equal(fresh.get('uncertain').status,'SUBMISSION_UNKNOWN');});

test("repaired historical refusals never invent total duration",()=>{assert.equal(totalTimeLabel({status:"REJECTED",createdAt:1000,updatedAt:90000,timing:{prepareMs:500}}).endsWith(" \u2014"),true);assert.equal(totalTimeLabel({status:"REJECTED",createdAt:1000,updatedAt:90000,timing:{prepareMs:500,finishedAt:3000}}).includes("2.00"),true);});

test('BNB-insufficient response requires the exact complete provider rejection, not code or balance guesses',()=>{
 assert.equal(providerRefusal(insufficientError()).kind,'INSUFFICIENT_BNB');
 for(const override of [{responseReceived:false},{responseReceived:undefined},{code:'TIMEOUT'},{code:100},{providerMessage:'Insufficient balance'},{providerMessage:insufficientBnb+' Submission status unknown.'}]){
  const error={...insufficientError(),...override};assert.equal(providerRefusal(error),null);assert.equal(providerRefusal(error,{legacy:true}),null);
 }
});
for(const side of ['buy','sell'])test(`historical ${side} rejection ends stale tracking but preserves evidence and original failure time`,()=>{
 const original={...legacy(),intent:{...intent,side},error:insufficientError(),tracking:{attempts:482,state:'needs-provider-check',lastCheckedAt:90000},followError:{message:'temporary lookup failure'},timing:{receivedAt:1000,finishedAt:2800}};
 const fixed=repairRejectedOrder(original,{now:100000});assert.equal(fixed.status,'REJECTED');assert.equal(fixed.submissionOutcome.accepted,false);assert.equal(fixed.tracking.state,'finished');assert.equal(fixed.tracking.attempts,482);
 assert.match(fixed.error.message,/BNB 余额不足/);assert.equal(fixed.error.providerMessage,insufficientBnb);assert.equal(fixed.error.responseReceived,true);assert.equal(fixed.followError,undefined);assert.equal(fixed.resolvedErrors[0].followError,original.followError);
 assert.equal(fixed.timing.finishedAt,2800);assert.equal(totalTimeLabel(fixed),'总耗时 1.80 秒');assert.equal(original.status,'SUBMISSION_UNKNOWN');assert.equal(original.tracking.state,'needs-provider-check');
 for(const evidence of [{orderId:'accepted'},{txHash:'0x123'},{transactionHash:'0x123'},{submittedAt:2000},{timing:{submittedAt:2000}},{receipt:{}},{result:{}},{steps:[{}]}])assert.equal(repairRejectedOrder({...original,...evidence}),null);
});
test('new balance refusal releases a wallet immediately, with retry only on a fresh explicit user action',async t=>{
 const h=harness(t);let sends=0;
 h.engine.bridge.call=async(a,args)=>{assert.equal(args[1],'swap');sends++;throw Object.assign(Error(insufficientBnb),insufficientError());};
 const failed=await h.engine.run(intent,'no-bnb',{execute:true,acknowledgeReview:true,authorization:'synthetic test',swapReceiptWaitMs:0});
 assert.equal(failed.status,'REJECTED');assert.match(failed.error.message,/BNB 余额不足/);assert.equal((await h.engine.reconcileAccount(w.account)).ready,true);assert.equal(sends,1);
 await h.engine.follow('no-bnb');await h.engine.execute('no-bnb',{authorization:'same original'});assert.equal(sends,1);
 assert.equal((await h.engine.prepare(intent,'fresh-click')).status,'PREPARED');assert.equal(sends,1);
 await h.engine.execute('fresh-click',{acknowledgeReview:true,authorization:'new explicit click',swapReceiptWaitMs:0});assert.equal(sends,2);
});
test('background tracking repairs a stored balance rejection once, with backup and without wallet/RPC requests',async t=>{
 const h=harness(t),o={...legacy(),id:'balance-stuck',error:insufficientError(),tracking:{attempts:482,state:'needs-provider-check'}};h.engine.write(o);
 const tracker=new OriginalTracker({engine:h.engine});t.after(()=>tracker.close());await tracker.tick();await tracker.tick();
 assert.equal(h.engine.get(o.id).status,'REJECTED');assert.equal((await h.engine.reconcileAccount(w.account)).ready,true);assert.deepEqual(h.counts(),{sends:0,reads:0});
 const backup=JSON.parse(fs.readFileSync(path.join(h.data,'order-repair-backups',hash(o.id)+'.json')));assert.equal(backup.status,'SUBMISSION_UNKNOWN');assert.equal(backup.error.providerMessage,insufficientBnb);assert.equal(backup.tracking.attempts,482);
});
test('restart repairs balance rejection while preserving accepted or genuinely uncertain originals',t=>{
 const h=harness(t),o={...legacy(),error:insufficientError()};h.engine.write(o);h.engine.write({...o,id:'accepted',orderId:'provider-id'});h.engine.write({...o,id:'uncertain',error:{code:'TIMEOUT',message:'connection lost'}});
 const fresh=new Engine({data:h.data,bridge:{call:()=>assert.fail('No wallet command on repair')},rpc:{}});
 assert.equal(fresh.get(o.id).status,'REJECTED');assert.equal(fresh.get('accepted').status,'SUBMISSION_UNKNOWN');assert.equal(fresh.get('uncertain').status,'SUBMISSION_UNKNOWN');
});
test('late balance rejection settles the timed-out original and never starts another swap',async t=>{
 const h=harness(t),o={...legacy(),id:'late-balance',error:{code:'TIMEOUT',message:'response timeout'},timing:{submitStartedAt:Date.now()},tracking:{attempts:1,state:'needs-provider-check'}};h.engine.write(o);
 lateSink(h.data,o)({error:insufficientError()});const fixed=await h.engine.follow(o.id);
 assert.equal(fixed.status,'REJECTED');assert.match(fixed.error.message,/BNB 余额不足/);assert.equal(fixed.tracking.state,'finished');assert.equal((await h.engine.reconcileAccount(w.account)).ready,true);
 await h.engine.execute(o.id,{authorization:'same original'});assert.deepEqual(h.counts(),{sends:0,reads:0});
});
