// All plans, wallets' transport responses and submissions below are synthetic.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {HIGH_FEE_PPM} from '../lib/trade-fees.mjs';
import {findLowFeeSell,MAX_FEE_ALTERNATIVES} from '../lib/sell-fee-search.mjs';
import {Engine} from '../lib/engine.mjs';import {openingPlan,refreshOpeningSell} from '../lib/opening-route.mjs';
import {BNB,WBNB,USDT,ERC20,bindings,same} from '../lib/common.mjs';
import {DEXES,QUOTER,V2_ROUTER_ABI,V3_LEGACY,poolRouteKey} from '../lib/opening-dex.mjs';
const w=bindings()[0],token='0x'+'17'.repeat(20),router='0x'+'19'.repeat(20);
const intent={account:w.account,side:'sell',asset:token,percent:'50',currency:'BNB',slippageBps:5000};
const plan=(n=1,fee=2500)=>({kind:'contract',route:'fixture',wallet:w.address,token,inputToken:token,outputToken:BNB,holdingBefore:'2000000',amountIn:'1000000',quote:{toCoinAmount:'1'},outputDecimals:6,minOutput:'500000',requireSellCredit:true,opening:{factory:router,pool:'0x'+n.toString(16).padStart(40,'0'),kind:'v2',quote:WBNB},poolFees:{poolFeePpm:fee,pools:[]},audit:{available:true,taxes:{sellTax:'0'}},slippage:{bps:5000,capBps:5000},steps:[{kind:'sell',to:router,value:'0',data:'0x'+n.toString(16).padStart(8,'0')}],review:[]});
const preview=async p=>({at:Date.now(),raw:{risks:[]},review:{balanceChanges:[{owner:p.wallet,contractAddress:BNB,change:'1000000'}]}});
const order=()=>({id:'synthetic',intent,steps:[],plan:plan(1,850150)});

test('high fee route automatically seeks a fixed low-fee route with identical user constraints',async()=>{
 const o=order();let reads=0;
 const r=await findLowFeeSell(o,{preview,minimumOutput:'500000',planFn:async(_r,_b,i,opts)=>{reads++;assert.equal(i.slippageBps,5000);assert.equal(i.currency,'BNB');assert.equal(opts.expand,true);assert.equal(opts.lowFeeOnly,true);assert.equal(opts.outputToken,BNB);assert.equal(opts.minimumOutput,'500000');assert.ok(opts.excludedRoutes.includes(poolRouteKey(o.plan.opening)));return plan(2);}});
 assert.equal(r.plan.poolFees.poolFeePpm,2500);assert.equal(reads,1);assert.equal(o.feeRouteSearch.status,'selected');assert.equal(r.plan.amountIn,o.plan.amountIn);
});
test('failed/expensive simulated alternatives are skipped before any signing; search is bounded',async()=>{
 const o=order();let calls=0;
 const r=await findLowFeeSell(o,{planFn:async()=>plan(++calls+1),preview:async p=>{if(calls===1)throw Object.assign(Error('revert'),{code:'OFFICIAL_SIMULATION_FAILED'});const v=await preview(p);v.review.balanceChanges[0].change=calls===2?'500000':'1000000';return v;}});
 assert.equal(calls,3);assert.equal(r.plan.opening.pool,plan(4).opening.pool);assert.equal(o.feeRouteSearch.status,'selected');
 const never=order();calls=0;const run=()=>findLowFeeSell(never,{planFn:async()=>plan(++calls+1,HIGH_FEE_PPM),preview:()=>assert.fail('known high fee must not preview/approve')});
 assert.equal(await run(),null);assert.equal(calls,MAX_FEE_ALTERNATIVES);assert.equal(await run(),null);assert.equal(calls,MAX_FEE_ALTERNATIVES);assert.equal(never.feeRouteSearch.status,'limit');
});
for(const [name,change]of [['wallet',p=>p.wallet=router],['output',p=>p.outputToken=USDT],['amount',p=>p.amountIn='999999'],['holding',p=>p.holdingBefore='1'],['slippage',p=>p.slippage.bps=5001],['minimum',p=>p.minOutput='499999'],['identity',p=>p.identity={fingerprint:'changed'}]])test('alternative cannot change '+name,async()=>{
 const o=order();o.plan.identity={fingerprint:'pinned'};
 const result=await findLowFeeSell(o,{minimumOutput:'500000',preview:()=>assert.fail('bad binding'),planFn:async()=>{const p=plan(2);p.identity={fingerprint:'pinned'};change(p);return p;}});
 assert.equal(result,null);assert.equal(o.feeRouteSearch.status,'unavailable');
});
test('unresolved sale, failed approval, actual sale and provider risk errors never trigger alternate execution',async()=>{
 for(const patch of [{status:'PENDING'},{status:'SUBMISSION_UNKNOWN'},{orderId:'accepted'},{txHash:'0xabc'},{steps:[{status:'PENDING',step:{kind:'approve'}}]},{steps:[{status:'FAILED',step:{kind:'approve'}}]},{steps:[{status:'CONFIRMED',step:{kind:'sell'}}]}])assert.equal(await findLowFeeSell({...order(),...patch},{planFn:()=>assert.fail('no route construction')}),null);
 for(const code of ['APP_RISK_REVIEW','TIMEOUT']){let count=0;const o=order();assert.equal(await findLowFeeSell(o,{planFn:async()=>{count++;return plan(2);},preview:async()=>{throw Object.assign(Error(code),{code});}}),null);assert.equal(count,1);}
});
const venuePlan=n=>{const p=plan(n),d=DEXES[2];p.opening={...p.opening,...d,fee:n===1?2500:500};p.steps[0].to=d.router;return p;};
function harness(t,first,{previewError=false}={}){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'sell-route-search-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));const sent=[];
 const bridge={ready:async()=>{},call:async(_a,args)=>{if(args[1]==='preview'){
  const input=args[args.indexOf('--inputData')+1],approve=input.startsWith('0x095ea7b3');let bad=input===plan(1).steps[0].data;
  if(!approve&&input.length>10){const tx=V3_LEGACY.parseTransaction({data:input});const inner=V3_LEGACY.parseTransaction({data:tx.name==='multicall'?tx.args[0][0]:input});bad=inner.args[0].fee===2500n;}
  return {requestId:approve?'approve':bad?'bad':'good',simulationResult:{simulationCode:bad&&previewError?'failure':'000000000',balanceChanges:approve?[]:[{owner:w.address,contractAddress:BNB,change:bad?'500000':'1000000'}]}};
 }sent.push(args.at(-1));return {txHash:'0x'+'ab'.repeat(32)};}};
 const rpc={getBlockNumber:async()=>100,call:async tx=>same(tx.to,token)?ERC20.encodeFunctionResult('balanceOf',[2000000n]):same(tx.to,DEXES[2].quoter)?QUOTER.encodeFunctionResult('quoteExactInputSingle',[1000000n,1n,0n,100000n]):Promise.reject(Error('unsupported multicall'))};
 const engine=new Engine({rpc,bridge,data,live:true,planFn:async()=>first});engine.observeContract=async(o,e)=>{e.status='CONFIRMED';};
 engine.feeRoutePlanner=async()=>venuePlan(2);
 return {engine,sent};
}
for(const mode of ['fee','preview-revert','approval'])test('engine '+mode+' continues to low-fee sale in one operation without repeated confirmation',async t=>{
 const first=venuePlan(1);
 if(mode==='approval')first.steps.unshift({kind:'approve',to:token,value:'0',spender:router,allowance:first.amountIn,data:ERC20.encodeFunctionData('approve',[router,first.amountIn])});
 const h=harness(t,first,{previewError:mode==='preview-revert'});
 const result=await h.engine.run(intent,'engine-'+mode,{execute:true,acknowledgeReview:true,authorization:'synthetic user click'});
 assert.equal(result.status,'CONFIRMED');assert.deepEqual(h.sent,mode==='approval'?['approve','good']:['good']);assert.equal(result.needsFeeReview,false);assert.equal(result.feeRouteSearch.status,'selected');
 await h.engine.execute(result.id,{authorization:'repeat'});assert.equal(h.sent.length,mode==='approval'?2:1);
});
test('an ordinary low-fee sale does not run additional pool discovery',async t=>{
 const h=harness(t,venuePlan(2));h.engine.feeRoutePlanner=()=>assert.fail('normal sale must stay on fast path');
 const r=await h.engine.run(intent,'normal-low',{execute:true,acknowledgeReview:true,authorization:'synthetic user click'});
 assert.equal(r.status,'CONFIRMED');assert.deepEqual(h.sent,['good']);assert.equal(r.feeRouteSearch,undefined);
});
test('a ninth low-fee quote is considered when the first eight pools are expensive',async()=>{
 const d=DEXES[0],candidates=Array.from({length:9},(_,n)=>({...d,pool:'0x'+(n+1).toString(16).padStart(40,'0'),quote:WBNB,token0:token,token1:WBNB,liquid:true,block:n+1,reserve0:'1000000000000',reserve1:'1000000000000'}));let quotes=0;
 const rpc={call:async(tx,block)=>{if(same(tx.to,token))return ERC20.encodeFunctionResult(ERC20.parseTransaction(tx).name,[2000000n]);quotes++;const fee=block===9?2500n:850150n,x=1000000n*(1000000n-fee),y=x*1000000000000n/(1000000000000n*1000000n+x);return V2_ROUTER_ABI.encodeFunctionResult('getAmountsOut',[[1000000n,y]]);}};
 const p=await openingPlan(rpc,{},intent,{scan:async()=>({pools:candidates}),preparation:{token:async()=>({decimals:6,identity:{}}),venue:async()=>({assets:[]})}});
 assert.equal(quotes,9);assert.equal(p.opening.pool,candidates[8].pool);assert.ok(p.poolFees.poolFeePpm<HIGH_FEE_PPM);
});
test('alternate route filter uses 50% and reports the same threshold',async()=>{
 const d=DEXES[2],pool={...d,pool:router,quote:WBNB,liquid:true,fee:499999};
 const rpc={call:async tx=>same(tx.to,token)?ERC20.encodeFunctionResult(ERC20.parseTransaction(tx).name,[2000000n]):QUOTER.encodeFunctionResult('quoteExactInputSingle',[1000000n,1n,0n,100000n])};
 const options={scan:async()=>({pools:[pool]}),preparation:{token:async()=>({decimals:6,identity:{}}),venue:async()=>({assets:[]})},lowFeeOnly:true};
 assert.equal((await openingPlan(rpc,{},intent,options)).poolFees.poolFeePpm,499999);
 pool.fee=500000;await assert.rejects(openingPlan(rpc,{},intent,options),/低于 50%/);
});
test('alternate quotes stay on pinned output and encode original minimum when new slippage floor is lower',async()=>{
 const d=DEXES[2],pools=[{...d,pool:router,quote:WBNB,liquid:true,fee:500},{...d,pool:token,quote:USDT,liquid:true,fee:100}];let quotes=0;
 const rpc={getBlockNumber:async()=>100,call:async tx=>same(tx.to,token)?ERC20.encodeFunctionResult(ERC20.parseTransaction(tx).name,[2000000n]):same(tx.to,d.quoter)?(quotes++,QUOTER.encodeFunctionResult('quoteExactInputSingle',[1000000n,1n,0n,100000n])):Promise.reject(Error('no multicall'))};
 const p=await openingPlan(rpc,{}, {...intent,currency:'AUTO'},{scan:async()=>({pools}),preparation:{token:async()=>({decimals:6,identity:{}}),venue:async()=>({assets:[]})},outputToken:BNB,minimumOutput:'800000',lowFeeOnly:true});
 assert.equal(quotes,1);assert.equal(p.outputToken,BNB);assert.equal(p.minOutput,'800000');assert.equal(p.authorizationMinOutput,'800000');
 const fresh=await refreshOpeningSell(rpc,p);assert.equal(fresh.minOutput,'800000');const calls=V3_LEGACY.parseTransaction(fresh.steps[0]).args[0];assert.equal(V3_LEGACY.parseTransaction({data:calls[0]}).args[0].amountOutMinimum,800000n);
});
