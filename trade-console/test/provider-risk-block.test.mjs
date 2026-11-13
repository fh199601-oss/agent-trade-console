import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {highRiskBlockText,describeError} from '../public/error-message.mjs';
import {providerRefusal,repairRejectedOrder} from '../lib/provider-outcome.mjs';
import {Engine} from '../lib/engine.mjs';import {bindings,BNB} from '../lib/common.mjs';
import {lateSink} from '../lib/late-result.mjs';import {tradeError} from '../lib/sell-policy.mjs';
import {rejectedAggregateSale} from '../lib/manual-sell-recovery.mjs';
import {statusLabel,reviewSummary} from '../public/review-model.mjs';
import {mergeTradeUpdate,canRetryTrade,tradeResultMessage,runInstantTrades} from '../public/trade-workflow.mjs';
const error=()=>({code:30003001,message:highRiskBlockText,responseReceived:true,dispatched:true});
const token='0x'+'ab'.repeat(20),wallets=bindings();
const intent={account:wallets[0].account,side:'buy',asset:token,currency:'BNB',amount:'0.02',slippageBps:2000};
const unknown=()=>({id:'risk-original',status:'SUBMISSION_UNKNOWN',intent,createdAt:1000,timing:{submitStartedAt:1200,finishedAt:2000},plan:{kind:'swap'},steps:[],error:{...error(),...tradeError(error())}});
function fixture(t){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'risk-refusal-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));const calls=[];
 const bridge={ready:async()=>({}),call:async(account,args)=>{calls.push({account,args});assert.equal(args[1],'swap','explicit refusal needs no follow-up lookup');throw Object.assign(Error(highRiskBlockText),error());}};
 const engine=new Engine({data,bridge,rpc:{},live:true,planFn:async i=>({kind:'swap',wallet:wallets.find(w=>w.account===i.account).address,token,inputToken:BNB,outputToken:token,amountIn:'20000000000000000',args:['--fromTokenQty','0.02','--slippage','20'],steps:[],review:[]})});
 return {data,engine,calls};
}
test('hard risk rejection requires exact complete reason and parsed response; shared code alone is never sufficient',()=>{
 assert.equal(providerRefusal(error()).kind,'HIGH_RISK_BLOCKED');
 for(const override of [{responseReceived:undefined},{responseReceived:false},{code:'TIMEOUT'},{message:'High risk'},{message:highRiskBlockText+' Submission status unknown.'}])assert.equal(providerRefusal({...error(),...override},{legacy:true}),null);
 const old=unknown(),fixed=repairRejectedOrder(old);assert.equal(fixed.status,'REJECTED');assert.equal(fixed.timing.finishedAt,2000);assert.equal(old.status,'SUBMISSION_UNKNOWN');
 for(const evidence of [{orderId:'accepted'},{txHash:'0x123'},{result:{}},{receipt:{}},{steps:[{}]},{timing:{submittedAt:1500}},{error:{...old.error,responseReceived:undefined}}])assert.equal(repairRejectedOrder({...old,...evidence}),null);
});
test('all wallets finish a provider hard refusal independently without automatic lookup, retry or alternate route',async t=>{
 const f=fixture(t),rows=wallets.map(w=>({id:'click-'+w.account,intent:{...intent,account:w.account}}));
 const result=await runInstantTrades(rows,o=>f.engine.run(o.intent,o.id,{execute:true,acknowledgeReview:true,authorization:'isolated fake click',swapReceiptWaitMs:0}));
 assert.deepEqual(result.map(o=>o.status),wallets.map(()=>'REJECTED'));assert.equal(f.calls.length,wallets.length);
 for(const o of result){assert.equal((await f.engine.reconcileAccount(o.intent.account)).ready,true);await f.engine.follow(o.id);await f.engine.execute(o.id,{authorization:'same ID'});assert.equal(rejectedAggregateSale({...o,intent:{...o.intent,side:'sell'}},{...o.intent,side:'sell'}),false);}
 assert.equal(f.calls.length,wallets.length);
 assert.equal((await f.engine.prepare({...intent,asset:'0x'+'cd'.repeat(20)},'another-token')).status,'PREPARED');
});
test('a late hard refusal releases only the original; ambiguous timeout stays unknown',async t=>{
 const f=fixture(t),o={...unknown(),error:{code:'TIMEOUT',message:'response timeout'}};f.engine.write(o);
 lateSink(f.data,o)({error:error()});assert.equal((await f.engine.follow(o.id)).status,'REJECTED');assert.equal(f.calls.length,0);
 const ambiguous={...o,id:'ambiguous'};f.engine.write(ambiguous);assert.equal((await f.engine.follow(ambiguous.id)).status,'SUBMISSION_UNKNOWN');assert.equal(f.calls.length,0);
});
test('Chinese hard-block diagnosis replaces old generic text without promising an App confirmation or retry fix',()=>{
 const e={...tradeError(error()),message:'请求失败：接口返回了未识别的错误'};
 assert.match(describeError(e),/币安风控.*不允许执行/);
 for(const status of ['FAILED','REJECTED','BLOCKED']){const o={...unknown(),status,error:e};assert.equal(statusLabel(o),'币安风控拦截');assert.equal(canRetryTrade(o),false);assert.doesNotMatch(tradeResultMessage([o]),/可重新|待核对|未识别/);assert.doesNotMatch(reviewSummary([o]).message,/重新发起|App/);}
 assert.equal(statusLabel({...unknown(),orderId:'accepted'}),'提交待核对');
 assert.equal(canRetryTrade({...unknown(),status:'FAILED',error:{code:'TRANSACTION_REVERTED'}}),true);
});
test('history reconciliation refreshes unknown quick feedback and discards delayed stale responses',()=>{
 const full={...unknown(),updatedAt:2000,intent:{...intent,slippageBps:2000},plan:{kind:'swap',args:['preserve']}};
 const summary={id:full.id,summary:true,status:'FAILED',updatedAt:3000,error:full.error,orderId:'official-failed',tracking:{state:'finished'},plan:{route:'binance-aggregate'},intent:{account:1}};
 const latest=mergeTradeUpdate(full,summary);assert.equal(latest.status,'FAILED');assert.deepEqual(latest.intent,full.intent);assert.deepEqual(latest.plan,full.plan);assert.equal(latest.orderId,'official-failed');assert.equal(canRetryTrade(latest),false);
 assert.equal(mergeTradeUpdate(latest,full),latest);assert.equal(mergeTradeUpdate(latest,{...full,updatedAt:4000}),latest);assert.equal(mergeTradeUpdate(latest,{...summary,id:'other'}),latest);
 assert.doesNotMatch(tradeResultMessage([latest]),/待核对/);
 const confirmed=mergeTradeUpdate(full,{...summary,status:'CONFIRMED',error:undefined});assert.equal(confirmed.error,undefined);assert.equal(statusLabel(confirmed),'链上确认');
});
