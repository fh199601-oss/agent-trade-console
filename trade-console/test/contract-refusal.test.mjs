import {executeReviewed,runReviewed} from './support/reviewed-execution.mjs';
// Synthetic wallet/RPC only. No signing, real wallet calls or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Engine} from '../lib/engine.mjs';
import {contractRefusal,repairRejectedOrder,applyContractRefusal,unsubmittedContractStep} from '../lib/provider-outcome.mjs';
import {bindings,BNB,ERC20,Interface,ZeroAddress,hash,save} from '../lib/common.mjs';
const w=bindings()[0],token='0x'+'61'.repeat(20),mint='0x'+'62'.repeat(20),txHash='0x'+'63'.repeat(32);
const rejection=()=>Object.assign(Error('simulation error'),{code:953401,responseReceived:true,dispatched:true});
const intent={account:w.account,side:'mint',asset:mint,quantity:'max',scope:'free',maxBnb:'0',autoClaim:false};
const plan=()=>({kind:'contract',route:'fixture:mint',wallet:w.address,token,inputToken:BNB,outputToken:token,quantity:1,amountIn:'0',minOutput:'1',metaVerified:true,expectedAsset:{kind:'Erc20',token,amount:'1'},review:[],fill:{continue:false},steps:[{kind:'mint',to:mint,value:'0',data:'0x12345678'}]});
const legacy=()=>{const p=plan();return {id:'legacy-contract',createdAt:1,intent,status:'SUBMISSION_UNKNOWN',timing:{prepareMs:4},plan:p,error:{code:953401,message:'simulation error'},steps:[{index:0,stage:0,status:'SUBMISSION_UNKNOWN',plan:p,step:p.steps[0],submitStartedAt:10,requestId:'synthetic-preview',preview:{},error:{code:953401,message:'simulation error'}}]};};
function fixture(t,{side='mint',failAt=1,error=rejection(),batch=false,previewFailure=false}={}){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'contract-refusal-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 let sends=0,previews=0;const p=plan();p.fill.continue=batch;
 const i=side==='mint'?intent:{account:w.account,side,asset:token,...(side==='sell'?{percent:'50'}:{amount:'0.01'})};
 if(side!=='mint'){p.steps[0].kind=side;p.holdingBefore='100';Object.assign(p,{poolFees:{version:1,poolFeePpm:3000,pools:[{address:'0x'+'18'.repeat(20),feePpm:3000}]},audit:{available:true,taxes:{sellTax:'0'}},});}
 const transfer=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
 const receipt={from:w.address,to:mint,status:'0x1',transactionHash:txHash,logs:[{address:token,...transfer.encodeEventLog(transfer.getEvent('Transfer'),[ZeroAddress,w.address,1n])}]};
 const bridge={ready:async()=>({}),call:async(a,args)=>{
  if(args[1]==='preview'){previews++;if(previewFailure&&sends===1)throw Error('later preview failed');return {requestId:'preview-'+previews,simulationResult:{simulationCode:'000000000'}};}
  assert.equal(args.slice(0,2).join(' '),'contract-call execute');sends++;if(sends===failAt)throw error;return {txHash};
 }};
 const rpc={call:async()=>ERC20.encodeFunctionResult('balanceOf',[100n]),getTransactionReceipt:async()=>receipt,getTransaction:async()=>({hash:txHash,from:w.address,to:mint,input:p.steps[0].data,value:'0x0'})};
 const engine=new Engine({rpc,bridge,data,live:true,planFn:async()=>p});return {engine,i,data,p,counts:()=>({sends,previews})};
}
test('953401 requires exact complete contract rejection; message or generic network failure alone is insufficient',()=>{
 assert.equal(contractRefusal(rejection()).accepted,false);
 for(const e of [{code:953401,message:'simulation error'},{code:953401,message:'simulation error',responseReceived:false},{code:50001002,message:'simulation error',responseReceived:true},{code:953401,message:'network simulation error',responseReceived:true}])assert.equal(contractRefusal(e),null);
});
for(const side of ['mint','buy','sell'])test(`${side}: execute simulation rejection is terminal, unlocks wallet and never resends the original`,async t=>{
 const h=fixture(t,{side});await h.engine.prepare(h.i,'rejected');const o=await executeReviewed(h.engine,'rejected',{authorization:'synthetic test only'});
 assert.equal(o.status,'FAILED');assert.equal(o.steps[0].status,'FAILED');assert.equal(o.steps[0].submissionOutcome.accepted,false);assert.ok(o.timing.finishedAt);assert.match(o.error.message,/未提交链上/);
 assert.equal((await h.engine.reconcileAccount(w.account)).ready,true);
 assert.equal((await h.engine.prepare(h.i,'next-click')).status,'PREPARED');await h.engine.follow('rejected');await executeReviewed(h.engine,'rejected',{authorization:'duplicate'});assert.equal(h.counts().sends,1);
});
test('max mint interrupted by execute rejection keeps confirmed lots and releases the remaining operation',async t=>{
 const h=fixture(t,{batch:true,failAt:2});await h.engine.prepare(h.i,'partial');const o=await executeReviewed(h.engine,'partial',{authorization:'synthetic only'});
 assert.equal(o.status,'PARTIAL');assert.equal(o.completedQuantity,1);assert.deepEqual(o.steps.map(e=>e.status),['CONFIRMED','FAILED']);assert.equal(o.steps[0].txHash,txHash);assert.equal((await h.engine.reconcileAccount(w.account)).ready,true);await h.engine.follow(o.id);assert.equal(h.counts().sends,2);
});
test('generic max mint failing at the next preview is partial, not receipt review',async t=>{
 const h=fixture(t,{batch:true,failAt:99,previewFailure:true});await h.engine.prepare(h.i,'partial-preview');const o=await executeReviewed(h.engine,'partial-preview',{authorization:'synthetic only'});
 assert.equal(o.status,'PARTIAL');assert.equal(o.completedQuantity,1);assert.ok(o.timing.finishedAt);assert.equal((await h.engine.reconcileAccount(w.account)).ready,true);assert.equal(h.counts().sends,1);
});
for(const error of [Object.assign(Error('network timeout'),{dispatched:true}),Object.assign(Error('simulation error'),{code:953401,dispatched:true,responseReceived:false})])test('an ambiguous dispatch still tracks original and prevents a duplicate despite matching text',async t=>{
 const h=fixture(t,{error});await h.engine.prepare(h.i,'uncertain');const o=await executeReviewed(h.engine,'uncertain',{authorization:'synthetic only'});
 assert.equal(o.status,'SUBMISSION_UNKNOWN');assert.equal(o.steps[0].submissionOutcome,undefined);assert.equal((await h.engine.reconcileAccount(w.account)).ready,false);await h.engine.follow(o.id);await executeReviewed(h.engine,o.id,{authorization:'duplicate'});assert.equal(h.counts().sends,1);
});
test('legacy numeric rejection repairs require exact original+step provenance and no acceptance',()=>{
 const original=legacy(),fixed=repairRejectedOrder(original);assert.equal(fixed.status,'FAILED');assert.equal(original.status,'SUBMISSION_UNKNOWN');assert.equal(fixed.timing.finishedAt,undefined);
 for(const mutate of [o=>o.txHash=txHash,o=>o.orderId='accepted',o=>o.result={},o=>o.receipt={},o=>o.steps[0].result={},o=>o.steps[0].receipt={},o=>o.steps[0].submittedAt=20,o=>o.steps[0].txHash=txHash,o=>o.steps[0].orderId='accepted',o=>o.steps[0].status='PENDING',o=>o.steps[0].error.responseReceived=false,o=>o.error.message='timeout',o=>delete o.steps[0].requestId,o=>delete o.steps[0].preview,o=>delete o.steps[0].submitStartedAt,o=>o.steps.unshift({status:'PENDING'}),o=>o.plan.kind='swap']){const o=legacy();mutate(o);assert.equal(repairRejectedOrder(o),null);}
});
test('restart backs up legacy rejection once, unlocks without calling wallet, and preserves another pending record',async t=>{
 const h=fixture(t),old=legacy();save(h.engine.file(old.id),old);
 const engine=new Engine({data:h.data,rpc:{},bridge:{call:()=>assert.fail('No wallet calls while repairing')}});
 assert.equal(engine.get(old.id).status,'FAILED');const backup=path.join(h.data,'order-repair-backups',hash(old.id)+'.json');assert.deepEqual(JSON.parse(fs.readFileSync(backup)),old);assert.equal((await engine.reconcileAccount(w.account)).ready,true);
 await engine.follow(old.id);assert.deepEqual(JSON.parse(fs.readFileSync(backup)),old);
 engine.write({...legacy(),id:'real-unknown',error:{code:'TIMEOUT'},steps:[]});assert.equal((await engine.reconcileAccount(w.account)).ready,false);
});
test('auto recovery requires both unsubmitted outcome and exact rejection evidence',()=>{
 const o=legacy();applyContractRefusal(o,rejection());assert.equal(unsubmittedContractStep(o,o.steps[0]),true);
 for(const fields of [{txHash},{orderId:'pending'},{result:{}},{receipt:{}},{submittedAt:1},{error:{code:'TIMEOUT'}},{error:{code:953401,message:'simulation error',responseReceived:false}}]){const copy=structuredClone(o);Object.assign(copy.steps[0],fields);assert.equal(unsubmittedContractStep(copy,copy.steps[0]),false);}
});
