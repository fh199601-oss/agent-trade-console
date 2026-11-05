import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {rejectedSwapQuery,uniqueFailedSwap} from '../lib/order-reconciliation.mjs';import {Engine} from '../lib/engine.mjs';
const createdAt=1793691112852,from='0x'+'1'.repeat(40),to='0x'+'2'.repeat(40);
const order=()=>({id:'old',intent:{account:1,side:'sell'},status:'SUBMISSION_UNKNOWN',error:{code:30003001,message:'slippage'},createdAt,timing:{},plan:{kind:'swap',inputToken:from,outputToken:to,args:['--fromTokenQty','546875.0','--slippage','1']},steps:[]});
const row=()=>({orderId:'original',orderType:'market',chain:'56',fromToken:from,toToken:to,fromTokenQty:'546875.000000000000000000',slippage:'1.0000',status:'FAILED',txHash:null,bookTime:new Date(createdAt+6000).toISOString()});
test('complete provider slippage rejection can recover a uniquely matching FAILED order',()=>{const o=order(),r=row();assert.equal(uniqueFailedSwap(o,{total:1,list:[r]}),r);assert.equal(rejectedSwapQuery(o).args[1],'list');});
test('different amount, chain, time, successful/pending or ambiguous records never resolve uncertainty',()=>{
 const o=order(),r=row();for(const change of [{fromTokenQty:'546876'},{slippage:'2'},{chain:'1'},{bookTime:new Date(createdAt-60000).toISOString()},{status:'FINISHED'},{status:'PENDING'},{txHash:'0x123'}])assert.equal(uniqueFailedSwap(o,{total:1,list:[{...r,...change}]}),null);
 assert.equal(uniqueFailedSwap(o,{total:2,list:[r,r]}),null);assert.equal(uniqueFailedSwap(o,{total:2,list:[r]}),null);assert.equal(uniqueFailedSwap(o,{total:1,list:[r]},[{id:'another',orderId:'original'}]),null);
});
test('transport timeout or unknown provider error never uses field matching to assume failure',()=>{for(const code of ['ERROR','TIMEOUT',123])assert.equal(rejectedSwapQuery({...order(),error:{code}}),null);});
test('follow only queries official history, saves original failure and cannot resend',async()=>{
 let calls=0;const bridge={call:async(account,args)=>{assert.equal(account,1);assert.equal(args[0],'market-order');assert.equal(args[1],'list');calls++;return {total:1,list:[row()]};}};
 const engine=new Engine({bridge,rpc:{},data:fs.mkdtempSync(path.join(os.tmpdir(),'reconcile-')),live:true});engine.write(order());const result=await engine.follow('old');assert.equal(result.status,'FAILED');assert.equal(result.orderId,'original');assert.equal(calls,1);assert.equal((await engine.execute('old',{authorization:'not used'})).status,'FAILED');assert.equal(calls,1);
});
