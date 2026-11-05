import test from 'node:test';import assert from 'node:assert/strict';
import {rejectedAggregateSale,manualDirectSell} from '../lib/manual-sell-recovery.mjs';
import {BNB,WBNB,ERC20,bindings,same} from '../lib/common.mjs';
import {DEXES,V2_ROUTER_ABI} from '../lib/opening-dex.mjs';
const token='0x'+'1'.repeat(40),owner=bindings()[0],d=DEXES[0];
const intent={account:owner.account,asset:token,side:'sell',percent:'50',currency:'AUTO',slippageBps:5000,slippageMode:'auto'};
const rejected={status:'REJECTED',intent,plan:{kind:'swap'},steps:[],error:{code:30003001,responseReceived:true,providerMessage:'The transaction failed due to invalid parameters. Please review the parameters then submit again.'}};
test('manual direct route hint requires exact rejected sale, same wallet and token, and no submission evidence',()=>{
 assert.equal(rejectedAggregateSale(rejected,intent),true);
 for(const patch of [{status:'SUBMISSION_UNKNOWN'},{orderId:'accepted'},{txHash:'hash'},{result:{}},{receipt:{}},{steps:[{}]},{intent:{...intent,account:999}},{intent:{...intent,asset:WBNB}},{error:{...rejected.error,responseReceived:false}}])assert.equal(rejectedAggregateSale({...rejected,...patch},intent),false);
 assert.equal(rejectedAggregateSale(rejected,{...intent,side:'buy'}),false);assert.equal(rejectedAggregateSale(rejected,{...intent,openingOnly:true}),false);
});
test('fresh manual retry uses verified direct pool with current amount and official auto-slippage; no wallet write or gas override',async()=>{
 let balance=1000n;
 const rpc={call:async tx=>{const abi=same(tx.to,token)?ERC20:V2_ROUTER_ABI,f=abi.parseTransaction(tx);return abi.encodeFunctionResult(f.name,{balanceOf:[balance],allowance:[1000n],getAmountsOut:[[balance/2n,100n]]}[f.name]);}};
 const options={scan:async()=>({pools:[{...d,pool:'0x'+'2'.repeat(40),quote:WBNB,liquid:true}]}),preparation:{token:async()=>({decimals:18,identity:{fingerprint:'test'}}),venue:async()=>({assets:[]})}};
 const aggregate={kind:'swap',wallet:owner.address,token,inputToken:token,outputToken:BNB,amountIn:'500',holdingBefore:'1000',slippage:{mode:'auto',bps:1000,capBps:5000}};
 const bridge={call:()=>assert.fail('No wallet command while building direct plan')},p=await manualDirectSell(rpc,bridge,intent,aggregate,options);
 assert.equal(p.kind,'contract');assert.equal(p.manualRouteRecovery,true);assert.equal(p.minOutput,'90');assert.equal(p.steps.length,1);assert.deepEqual(p.slippage,aggregate.slippage);assert.equal(p.gasLimit,undefined);
 const tx=V2_ROUTER_ABI.parseTransaction(p.steps[0]);assert.equal(tx.args[0],500n);assert.equal(tx.args[3],owner.address);
 balance=500n;await assert.rejects(manualDirectSell(rpc,bridge,intent,aggregate,options),/持仓或交易资产已变化/);
});
