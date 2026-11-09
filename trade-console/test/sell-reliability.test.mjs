import {POOL} from '../lib/opening-pools.mjs';
import {MULTI,MULTICALL} from '../lib/opening-read.mjs';
// Synthetic RPC/bridge only: these tests cannot sign or broadcast.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Engine} from '../lib/engine.mjs';import {OpeningSell} from '../lib/opening-sell.mjs';
import {provenAggregateRoute,preferProvenOpeningRoute} from '../lib/sell-route-history.mjs';
import {hasPreviewRisks} from '../lib/preview-risks.mjs';
import {DEXES,V2_ROUTER_ABI} from '../lib/opening-dex.mjs';import {ERC20,BNB,WBNB,bindings,same} from '../lib/common.mjs';
const w=bindings()[0],token='0x'+'12'.repeat(20),hash='0x'+'ab'.repeat(32),dex=DEXES[0];
const intent={account:w.account,side:'sell',asset:token,percent:'50',currency:'AUTO',slippageBps:5000,openingOnly:true};
const pool={...dex,pool:'0x'+'34'.repeat(20),quote:WBNB,liquid:true};
const plan=()=>({kind:'contract',poolFees:{version:1,poolFeePpm:3000,pools:[]},audit:{available:true,taxes:{sellTax:'0'}},route:dex.id+'-opening',account:w.account,opening:pool,wallet:w.address,token,inputToken:token,outputToken:BNB,amountIn:'500',holdingBefore:'1000',minOutput:'100',decimals:3,identity:{fingerprint:'same-code'},slippage:{mode:'fixed',bps:5000,capBps:5000},requireSellCredit:true,review:[],steps:[{kind:'sell',to:dex.router,value:'0',data:V2_ROUTER_ABI.encodeFunctionData('swapExactTokensForETHSupportingFeeOnTransferTokens',[500n,100n,[token,WBNB],w.address,BigInt(Math.floor(Date.now()/1000)+120)])}]});
function temp(t){const data=fs.mkdtempSync(path.join(os.tmpdir(),'sell-reliability-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));return data;}
test('multiple pending originals can be reconciled without circular wallet blocking; no trade is dispatched',async t=>{
 const calls=[],engine=new Engine({data:temp(t),live:true,rpc:{},bridge:{call:async(a,args)=>{calls.push(args);assert.equal(args[1],'list');return {list:[{orderId:args.at(-1),status:'FAILED'}]};}},planFn:async()=>({kind:'swap',review:[],steps:[]})});
 for(const id of ['one','two'])engine.write({id,intent,createdAt:1,status:'PENDING',orderId:id,plan:{kind:'swap'},steps:[]});
 assert.equal((await engine.follow('one')).status,'FAILED');assert.equal(engine.get('two').status,'PENDING');
 assert.equal((await engine.reconcileAccount(w.account)).ready,true);assert.equal(engine.get('two').status,'FAILED');assert.equal(calls.length,2);
 assert.equal((await engine.prepare(intent,'fresh')).error.code,'SELL_FEES_UNVERIFIABLE');assert.equal((await engine.reconcileAccount(w.account)).ready,true);assert.equal(calls.length,2);
});
test('one unknown original still forbids new orders but never prevents tracking the other original',async t=>{
 const engine=new Engine({data:temp(t),rpc:{},bridge:{call:async()=>({list:[{orderId:'known',status:'FAILED'}]})}});
 engine.write({id:'unknown',intent,createdAt:1,status:'SUBMISSION_UNKNOWN',plan:{kind:'swap'},steps:[]});engine.write({id:'known',intent,createdAt:2,status:'PENDING',orderId:'known',plan:{kind:'swap'},steps:[]});
 assert.equal((await engine.reconcileAccount(w.account)).ready,false);assert.equal(engine.get('known').status,'FAILED');assert.equal(engine.get('unknown').status,'SUBMISSION_UNKNOWN');
 await assert.rejects(engine.prepare(intent,'new'),e=>e.code==='ORDER_UNRESOLVED');
});
test('opening wallet contention before or at dispatch defers same attempt, does not consume attempts or create a stuck review',async t=>{
 for(const stage of ['prepare','execute']){
  let now=1000,busy=true,sends=0;const orders=new Map(),ids=[];
  const error=()=>Object.assign(Error('busy'),{code:'WALLET_BUSY',details:{requestAccepted:false}});
  const engine={live:true,get:id=>orders.get(id),prepare:async(i,id)=>{ids.push(id);if(stage==='prepare'&&busy)throw error();const o={id,intent:i,status:'PREPARED',steps:[],review:[]};orders.set(id,o);return o;},execute:async id=>{if(stage==='execute'&&busy)throw error();sends++;const o={...orders.get(id),status:'PENDING',orderId:'chain'};orders.set(id,o);return o;}};
  const manager=new OpeningSell({engine,data:temp(t),rpc:{},bridge:{},detector:{scan:async()=>({open:true,pools:[pool]})},now:()=>now,autoSchedule:false});t.after(()=>manager.close());
  const job={id:stage,status:'ARMED',config:{...intent,accounts:[w.account]},bindings:[{account:w.account,address:w.address}],expiresAt:100000,authorization:'fixture only',rows:[{account:w.account,status:'WAITING',attempts:0}]};manager.jobs.set(job.id,job);
  for(let i=0;i<25;i++){await manager.tick(job.id);now+=500;}
  assert.equal(job.rows[0].status,'WAITING');assert.equal(job.rows[0].attempts,0);assert.equal(job.rows[0].commitStartedAt,undefined);assert.equal(sends,0);
  busy=false;await manager.tick(job.id);assert.equal(sends,1);assert.equal(new Set(ids).size,1);assert.equal(job.rows[0].status,'TRACKING');
 }
});
function history(now=Date.now()){
 const p=plan(),failed={id:'failed',simulationOnly:false,intent,status:'FAILED',createdAt:now-2000,plan:p,error:{code:'TRANSACTION_REVERTED'},steps:[{step:{kind:'sell'},status:'FAILED',revertVerified:true,receipt:{status:'0x0'},txHash:hash,plan:p}]};
 const success={id:'success',simulationOnly:false,intent,status:'CONFIRMED',createdAt:now-1000,plan:{kind:'swap',outputToken:BNB},orderId:'official',txHash:hash,receipt:{status:'FINISHED'}};
 return [failed,success];
}
test('successful alternate is preferred before next first submission, with exact current amount and slippage and no gas override',async()=>{
 const calls=[],p=await preferProvenOpeningRoute({call:async(a,args)=>{calls.push(args);return {toCoinAmount:'0.01'};}},intent,plan(),history());
 assert.equal(p.kind,'swap');assert.equal(p.routePreference.successfulId,'success');assert.equal(p.amountIn,'500');assert.equal(p.holdingBefore,'1000');assert.equal(p.outputToken,BNB);assert.equal(p.gasLimit,undefined);
 assert.equal(calls.length,1);assert.equal(calls[0][1],'quote');assert.equal(calls[0][calls[0].indexOf('--slippage')+1],'50');assert.equal(calls[0][calls[0].indexOf('--fromTokenQty')+1],'0.5');
});
test('route evidence cannot cross token/code/output, use simulations, ignore later rejection, or override chosen gas limit',()=>{
 const now=Date.now(),p=plan();assert.ok(provenAggregateRoute(history(now),intent,p,now));
 for(const mutate of [r=>r[0].plan.identity.fingerprint='changed',r=>r[1].simulationOnly=true,r=>r[1].intent={...intent,asset:WBNB},r=>r[1].plan.outputToken=WBNB,r=>r[1].status='REJECTED',r=>r[1].refund=[{}],r=>r[1].createdAt=now-3700000,r=>r[1].receipt.status='PENDING']){const rows=history(now);mutate(rows);assert.equal(provenAggregateRoute(rows,intent,p,now),null);}
 assert.equal(provenAggregateRoute(history(now),{...intent,gasLimit:800000},p,now),null);
});
test('unavailable alternate quote keeps verified direct route; app risk request is not bypassed',async()=>{
 const p=plan(),bridge={call:async()=>{throw Error('quote unavailable');}};assert.equal((await preferProvenOpeningRoute(bridge,intent,p,history())).kind,'contract');
 bridge.call=async()=>{throw Object.assign(Error('This token has been flagged as potentially risky. Please open the Binance app to review the risk warning and decide whether to proceed.'),{code:30003001,responseReceived:true});};await assert.rejects(preferProvenOpeningRoute(bridge,intent,p,history()),/risk warning/);
});
test('opening sale refreshes quote and preview; ambiguous tiny-sample pool fee is hard blocked without changing gas',async t=>{
 let previews=0,sends=0,quoted=0;const p=plan();delete p.identity;
 const rpc={getBlockNumber:async()=>100,call:async tx=>{if(same(tx.to,MULTICALL))throw Error('unsupported fixture multicall');if(same(tx.to,pool.pool))return POOL.encodeFunctionResult('getReserves',[1000000n,2000000n,1]);if(same(tx.to,token))return ERC20.encodeFunctionResult('balanceOf',[1000n]);quoted++;return V2_ROUTER_ABI.encodeFunctionResult('getAmountsOut',[[500n,100n]]);}};
 const bridge={ready:async()=>({}),call:async(a,args)=>{if(args[1]==='preview'){previews++;assert.equal(args.includes('--gasLimit'),false);return {requestId:'p'+previews,simulationResult:{simulationCode:'000000000',balanceChanges:[{owner:w.address,contractAddress:BNB,change:'100'}]}};}assert.equal(args[1],'execute');assert.equal(args.at(-1),'p2');sends++;return {txHash:hash};}};
 const engine=new Engine({rpc,bridge,data:temp(t),live:true,planFn:async()=>p});engine.observeContract=async()=>{};
 await engine.prepare(intent,'fresh-preview');const o=engine.get('fresh-preview');o.previewAt=Date.now()-2000;engine.write(o);engine.previews.get(o.id).at=o.previewAt;
 const result=await engine.execute(o.id,{authorization:'fixture only',swapReceiptWaitMs:0});assert.equal(result.status,'BLOCKED');assert.equal(result.error.code,'SELL_FEES_UNVERIFIABLE');assert.equal(result.needsFeeReview,false);assert.equal(previews,2);assert.equal(sends,0);assert.equal(quoted,1);assert.equal(result.plan.minOutput,'50');
});
test('structured official risks are detected at preparation and automatic dispatch, including after quote refresh',async t=>{
 for(const empty of [undefined,[],{},{riskDetails:[],addresses:{},riskBehaviors:[]},{addresses:{[token]:{riskLevel:0,riskDetails:[]}}}])assert.equal(hasPreviewRisks(empty),false);
 for(const risks of [['risk'],{riskDetails:[{title:'new risk'}]},{addresses:{[token]:{riskLevel:'HIGH',riskDetails:[]}}},{riskBehaviors:[{title:'new risk'}]}]){
  assert.equal(hasPreviewRisks(risks),true);
  let risky=false,sends=0;const p=plan();delete p.identity;
  const bridge={ready:async()=>({}),call:async(a,args)=>{assert.equal(args[1],'preview');return {requestId:'fixture',risks:risky?risks:{},simulationResult:{simulationCode:'000000000',balanceChanges:[{owner:w.address,contractAddress:BNB,change:'100'}]}};}};
  const rpc={getBlockNumber:async()=>100,call:async tx=>{if(same(tx.to,MULTICALL))throw Error('unsupported fixture multicall');if(same(tx.to,pool.pool))return POOL.encodeFunctionResult('getReserves',[1000000n,2000000n,1]);return same(tx.to,token)?ERC20.encodeFunctionResult('balanceOf',[1000n]):V2_ROUTER_ABI.encodeFunctionResult('getAmountsOut',[[500n,100n]]);}};
  const engine=new Engine({rpc,bridge,data:temp(t),live:true,planFn:async()=>p});
  const old=await engine.prepare(intent,'old');assert.equal(old.review.length,0);risky=true;engine.previews.delete('old');
  const result=await engine.execute('old',{authorization:'fixture',acknowledgeReview:true,rejectRisks:true});assert.equal(result.status,'BLOCKED');assert.match(result.error.message,/风险/);assert.equal(sends,0);
  const fresh=await engine.prepare(intent,'new');assert.ok(fresh.review.length);assert.equal((await engine.execute('new',{authorization:'fixture'})).needsReview,true);
 }
});
test('local contention labels cannot rearm an accepted or uncertain dispatch',async t=>{
 for(const status of ['PENDING','SUBMITTING','SUBMISSION_UNKNOWN']){
  const orders=new Map(),engine={live:true,get:id=>orders.get(id),prepare:async(i,id)=>{const o={id,intent:i,status:'PREPARED',steps:[],review:[]};orders.set(id,o);return o;},execute:async id=>{orders.set(id,{...orders.get(id),status,orderId:'accepted-original'});throw Object.assign(Error('late busy'),{code:'WALLET_BUSY',details:{requestAccepted:false}});}};
  const manager=new OpeningSell({engine,data:temp(t),rpc:{},bridge:{},detector:{scan:async()=>({open:true,pools:[pool]})},now:()=>1000,autoSchedule:false});t.after(()=>manager.close());
  const job={id:status,status:'ARMED',config:{...intent,accounts:[w.account]},bindings:[{account:w.account,address:w.address}],expiresAt:100000,authorization:'fixture only',rows:[{account:w.account,status:'WAITING',attempts:0}]};manager.jobs.set(job.id,job);await manager.tick(job.id);
  assert.equal(job.rows[0].status,'REVIEW');assert.equal(job.rows[0].attempts,1);assert.ok(job.rows[0].commitStartedAt);assert.equal(job.rows[0].busyDeferrals,undefined);
 }
});
