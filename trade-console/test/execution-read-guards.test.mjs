import {executeReviewed,runReviewed} from './support/reviewed-execution.mjs';
// In-memory bridge only. No wallet process, RPC network or real submission.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Engine} from '../lib/engine.mjs';import {codeIdentity} from '../lib/discovery.mjs';import {bindings,BNB,ERC20} from '../lib/common.mjs';
const w=bindings()[0],token='0x'+'67'.repeat(20),mint={account:w.account,side:'mint',asset:token,quantity:1,maxBnb:'0'};
test('each contract step gets one final identity check; changed runtime still blocks submission',async()=>{
 for(const changed of [false,true]){
  let code='0x6000',identityReads=0,submits=0;const rpc={getCode:async()=>{identityReads++;return code;},send:async()=> '0x'+'00'.repeat(32)},identity=await codeIdentity(rpc,token);
  const plan={kind:'contract',wallet:w.address,identity,token,inputToken:BNB,outputToken:token,amountIn:'0',quantity:1,metaVerified:true,review:[],steps:[{kind:'mint',to:token,data:'0x12345678',value:'0'}]};
  const bridge={ready:async()=>({}),call:async(a,args)=>{if(args[1]==='preview')return {requestId:'mock',simulationResult:{simulationCode:'000000000',balanceChanges:[]}};assert.equal(args[1],'execute');submits++;return {txHash:'mock'};}};
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'guard-test-')),engine=new Engine({data,rpc,bridge,live:true,planFn:async()=>plan});engine.observeContract=async(o,e)=>{e.status='CONFIRMED';};
  try{await engine.prepare(mint,'guard');identityReads=0;if(changed)code='0x6001';const r=await executeReviewed(engine,'guard',{authorization:'mock test'});assert.equal(identityReads,1);assert.equal(submits,changed?0:1);assert.equal(r.status,changed?'BLOCKED':'CONFIRMED');}finally{fs.rmSync(data,{recursive:true,force:true});}
 }
});
test('connection and current balance guards overlap; changed holdings prevent even a mocked swap',async()=>{
 let startedReady=false,startedBalance=false,release,checking=false;const data=fs.mkdtempSync(path.join(os.tmpdir(),'guard-test-'));
 const bridge={ready:async()=>{if(checking){startedReady=true;await new Promise(r=>release=r);}},call:async(a,args)=>{assert.equal(args[1],'preview');return {requestId:'synthetic',simulationResult:{simulationCode:'000000000'}};}},rpc={call:async()=>{startedBalance=true;return ERC20.encodeFunctionResult('balanceOf',[2n]);}};
 const engine=new Engine({data,bridge,rpc,live:true,planFn:async()=>({kind:'contract',poolFees:{version:1,poolFeePpm:3000,pools:[{address:'0x'+'18'.repeat(20),feePpm:3000}]},audit:{available:true,taxes:{sellTax:'0'}},wallet:w.address,token,holdingBefore:'10',amountIn:'5',inputToken:token,outputToken:BNB,review:[],steps:[{kind:'sell',to:token,value:'0',data:'0x12345678'}]})});
 try{await engine.prepare({...mint,side:'sell',percent:50},'balance');checking=true;const running=executeReviewed(engine,'balance',{authorization:'mock test'});await new Promise(r=>setImmediate(r));assert.ok(startedReady&&startedBalance);release();assert.equal((await running).status,'BLOCKED');}finally{fs.rmSync(data,{recursive:true,force:true});}
});
test('free max finishes after confirmed free share when next current-wallet quote is paid; all and unknown errors stay partial',async()=>{
 for(const [scope,errorCode,expected]of [['free','NO_FREE_MINT','CONFIRMED'],['all','NO_FREE_MINT','PARTIAL'],['free','MINT_ADAPTER_INCOMPLETE','PARTIAL']]){
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'free-completion-test-')),rpc={getCode:async()=> '0x6000',send:async()=> '0x'+'00'.repeat(32)},identity=await codeIdentity(rpc,token);let plans=0,submits=0;
  const plan={kind:'contract',wallet:w.address,identity,token,inputToken:BNB,outputToken:token,amountIn:'0',quantity:1,budgetCurrency:'BNB',metaVerified:true,review:[],fill:{continue:true},steps:[{kind:'mint',to:token,data:'0x12345678',value:'0'}]};
  const bridge={ready:async()=>({}),call:async(a,args)=>{if(args[1]==='preview')return {requestId:'mock',simulationResult:{simulationCode:'000000000',balanceChanges:[]}};assert.equal(args[1],'execute');submits++;return {txHash:'mock'};}};
  const engine=new Engine({data,rpc,bridge,live:true,planFn:async()=>{if(plans++)throw Object.assign(Error('next quote'),{code:errorCode});return plan;}});engine.observeContract=async(o,e)=>{e.status='CONFIRMED';};
  try{await engine.prepare({...mint,scope,quantity:'max'},'free-max');const r=await executeReviewed(engine,'free-max',{authorization:'mock test'});assert.equal(r.status,expected);assert.equal(r.completedQuantity,1);assert.equal(submits,1);assert.equal(plans,2);}finally{fs.rmSync(data,{recursive:true,force:true});}
 }
});
