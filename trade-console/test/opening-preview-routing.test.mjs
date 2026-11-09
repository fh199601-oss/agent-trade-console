import test from 'node:test';import assert from 'node:assert/strict';
import {recentOpeningPreviewFailures} from '../lib/sell-route-history.mjs';
import {openingPlan} from '../lib/opening-route.mjs';import {Engine,verifyPreview} from '../lib/engine.mjs';
import {DEXES,V2_ROUTER_ABI} from '../lib/opening-dex.mjs';import {ERC20,BNB,WBNB,bindings,same} from '../lib/common.mjs';
const token='0x'+'56'.repeat(20),bound=bindings()[0],intent={account:bound.account,side:'sell',asset:token,percent:'50',currency:'AUTO',slippageBps:5000,openingOnly:true};
const pools=DEXES.filter(d=>d.kind==='v2').slice(0,2).map((d,i)=>({...d,quote:WBNB,pool:'0x'+String(i+1).repeat(40),liquid:true,token0:token,token1:WBNB,reserve0:'1000',reserve1:String(2000-i*100)}));
const meta={decimals:18,identity:{fingerprint:'current-code'}};
const failure=(now=Date.now())=>({status:'BLOCKED',createdAt:now,intent,error:{code:'OFFICIAL_SIMULATION_FAILED'},steps:[],plan:{requireSellCredit:true,identity:meta.identity,opening:pools[0],amountIn:'500',holdingBefore:'1000',steps:[{kind:'sell'}]}});
test('pool with a usable quote but failed official simulation gives another verified pool its next preview before any send',async()=>{
 let quoteCalls=[];
 const rpc={call:async tx=>{if(same(tx.to,token)){const f=ERC20.parseTransaction(tx);return ERC20.encodeFunctionResult(f.name,[1000n]);}quoteCalls.push(tx.to);if(same(tx.to,pools[1].router))await new Promise(r=>setTimeout(r,10));return V2_ROUTER_ABI.encodeFunctionResult('getAmountsOut',[[500n,200n]]);}};
 const options={scan:async()=>({pools}),preparation:{token:async()=>meta,venue:async()=>({assets:[]})}},bridge={call:()=>assert.fail('planner cannot sign')};
 const first=await openingPlan(rpc,bridge,intent,options);assert.equal(first.opening.pool,pools[0].pool);
 assert.throws(()=>verifyPreview({requestId:'failed-official-preview',simulationResult:{simulationCode:'351805'}},first,first.steps[0]),{code:'OFFICIAL_SIMULATION_FAILED'});
 quoteCalls=[];const next=await openingPlan(rpc,bridge,intent,{...options,failedPreviews:recentOpeningPreviewFailures([failure()],intent)});
 assert.equal(next.opening.pool,pools[1].pool);assert.deepEqual(quoteCalls,[pools[1].router]);assert.equal(next.amountIn,first.amountIn);assert.equal(next.outputToken,first.outputToken);assert.deepEqual(next.slippage,first.slippage);
 assert.doesNotThrow(()=>verifyPreview({requestId:'new-official-preview',simulationResult:{simulationCode:'000000000',balanceChanges:[{owner:bound.address,contractAddress:BNB,change:'200'}]}},next,next.steps[0]));
});
test('route preference excludes signing ambiguity, risk blocks, approvals, other wallets and stale evidence',()=>{
 assert.equal(recentOpeningPreviewFailures([failure()],intent).length,1);
 for(const patch of [{status:'PENDING'},{steps:[{}]},{orderId:'pending'},{txHash:'hash'},{error:{code:'ERROR'}},{intent:{...intent,account:999}},{intent:{...intent,slippageBps:3000}},{intent:{...intent,asset:WBNB}},{createdAt:Date.now()-11000},{plan:{...failure().plan,steps:[{kind:'approve'}]}}])assert.deepEqual(recentOpeningPreviewFailures([{...failure(),...patch}],intent),[]);
 assert.deepEqual(recentOpeningPreviewFailures([failure()],{...intent,openingOnly:false}),[]);
});
test('different current amount or code invalidates failed-pool preference; a single available pool is never hidden',async()=>{
 const rpc={call:async tx=>same(tx.to,token)?ERC20.encodeFunctionResult(ERC20.parseTransaction(tx).name,[1000n]):V2_ROUTER_ABI.encodeFunctionResult('getAmountsOut',[[500n,200n]])};
 const options={preparation:{token:async()=>meta,venue:async()=>({assets:[]})},scan:async()=>({pools})};
 for(const patch of [{amountIn:'100'},{holdingBefore:'2000'},{fingerprint:'changed-code'}]){
  const failedPreviews=recentOpeningPreviewFailures([failure()],intent).map(x=>({...x,...patch}));const p=await openingPlan(rpc,{},intent,{...options,failedPreviews});assert.equal(p.opening.pool,pools[0].pool);
 }
 const p=await openingPlan(rpc,{},intent,{...options,scan:async()=>({pools:[pools[0]]}),failedPreviews:recentOpeningPreviewFailures([failure()],intent)});assert.equal(p.opening.pool,pools[0].pool);
});
test('official generic simulation refusal retains its raw code; risk blocks and transport errors never become route hints',async()=>{
 for(const [code,responseReceived,hint] of [[351805,true,true],[351803,true,false],[351805,false,false]]){
  const engine=Object.create(Engine.prototype);engine.bridge={ready:async()=>{},call:async()=>{throw Object.assign(Error('fixture preview rejection'),{code,responseReceived});}};
  const plan={...failure().plan,wallet:bound.address,steps:[{kind:'sell',to:pools[0].router,value:'0',data:'0x'}]};let error;
  try{await engine.preview(plan,intent);}catch(e){error=e;}
  assert.equal(error.code,code);assert.equal(recentOpeningPreviewFailures([{...failure(),error}],intent).length,hint?1:0);
 }
});
