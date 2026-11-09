import {executeReviewed,runReviewed} from './support/reviewed-execution.mjs';
// All RPC and wallet responses are synthetic. No credentials or network used.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Engine} from '../lib/engine.mjs';import {Interface,bindings,ERC20,BNB,ZeroAddress} from '../lib/common.mjs';
import {CORLA_MINT} from '../lib/corla.mjs';import {settlementFixture} from './support/settlement-fixture.mjs';
const bound=bindings()[0],token='0x'+'67'.repeat(20),mint='0x'+'68'.repeat(20),hash='0x'+'ab'.repeat(32);
const transfer=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
function fixture(side){
 if(side==='sell'){const f=settlementFixture();return {...f,changes:[]};}
 const owner=bound.address,step={kind:'mint',to:mint,value:'0',data:CORLA_MINT.encodeFunctionData('claim')};
 const plan={kind:'contract',route:'corla:claim',token,wallet:owner,inputToken:BNB,outputToken:token,amountIn:'0',quantity:1,minOutput:'100',requireAssetCredit:true,expectedAsset:{kind:'Erc20',token,amount:'100'},steps:[step],review:[]};
 const receipt={transactionHash:hash,from:owner,to:mint,status:'0x1',logs:[{address:token,...transfer.encodeEventLog(transfer.getEvent('Transfer'),[ZeroAddress,owner,100n])}]};
 return {plan,step,receipt,tx:{hash,from:owner,to:mint,input:step.data,value:'0x0'},hash,changes:[{owner,contractAddress:token,tokenType:'Erc20',change:'100'}]};
}
for(const side of ['claim','sell'])for(const failure of ['receipt','transaction','transaction-lag'])test(`${side}: ${failure} after accepted send keeps polling the original and completes without another submission`,async t=>{
 const f=fixture(side),data=fs.mkdtempSync(path.join(os.tmpdir(),'receipt-resilience-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));let unavailable=true,sends=0;
 const rpc={call:async()=>ERC20.encodeFunctionResult('balanceOf',[2000n]),getTransactionReceipt:async()=>{if(unavailable&&failure==='receipt')throw Error('fixture RPC timeout');return f.receipt;},getTransaction:async()=>{if(unavailable&&failure==='transaction')throw Error('fixture RPC timeout');return unavailable&&failure==='transaction-lag'?null:f.tx;}};
 const bridge={ready:async()=>{},call:async(a,args)=>{if(args[1]==='preview')return {requestId:'fixture',simulationResult:{simulationCode:'000000000',balanceChanges:f.changes}};assert.equal(args[1],'execute');sends++;return {txHash:f.hash};}};
 const engine=new Engine({rpc,bridge,data,live:true,planFn:async()=>f.plan});
 const intent={account:bound.account,asset:side==='sell'?f.token:mint,side:side==='sell'?'sell':'mint',...(side==='sell'?{percent:'50'}:{quantity:1,scope:'free',maxBnb:'0',routeId:'corla:claim',autoClaim:false})};
 await engine.prepare(intent,'original');let o=await executeReviewed(engine,'original',{authorization:'synthetic test only',swapReceiptWaitMs:0});
 assert.equal(o.status,'PENDING');assert.equal(o.steps[0].status,'PENDING');assert.equal(o.followError.code,'ORIGINAL_READ_UNAVAILABLE');assert.equal(sends,1);
 for(let i=0;i<3;i++){o=await engine.follow(o.id);assert.equal(o.status,'PENDING');}
 assert.equal((await executeReviewed(engine,'original',{authorization:'synthetic test'})).duplicateSuppressed,true);assert.equal(sends,1);
 unavailable=false;o=await engine.follow(o.id);assert.equal(o.status,'CONFIRMED');assert.equal(o.followError,undefined);assert.ok(o.resolvedErrors.length);assert.equal(sends,1);
 if(side==='claim')assert.equal(o.steps[0].received,'100');
});
test('mismatched original is still a hard review and cannot be mislabeled as a temporary RPC error',async t=>{
 const f=fixture('claim'),data=fs.mkdtempSync(path.join(os.tmpdir(),'receipt-resilience-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 const engine=new Engine({data,bridge:{call:()=>assert.fail('cannot send')},rpc:{getTransactionReceipt:async()=>f.receipt,getTransaction:async()=>({...f.tx,input:'0x00000000'})}});
 engine.write({id:'bad-original',intent:{account:bound.account,side:'mint'},status:'PENDING',createdAt:Date.now(),timing:{},plan:f.plan,steps:[{index:0,step:f.step,status:'PENDING',txHash:f.hash,submittedAt:1}]});
 assert.equal((await engine.follow('bad-original')).status,'RECEIPT_REVIEW');assert.equal((await engine.reconcileAccount(bound.account)).ready,false);
});
