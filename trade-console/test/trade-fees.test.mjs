// Synthetic transports only. These tests never launch a wallet or use a network RPC.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Engine} from '../lib/engine.mjs';
import {openingPlan} from '../lib/opening-route.mjs';
import {OpeningSell} from '../lib/opening-sell.mjs';
import {DEXES,QUOTER} from '../lib/opening-dex.mjs';
import {v2FeePpm,poolFeeProof,compoundFees,assessSellFees,compareFeeRoutes,feePercent,updateFeeReview,HIGH_FEE_PPM} from '../lib/trade-fees.mjs';
import {BNB,WBNB,ERC20,bindings} from '../lib/common.mjs';
const w=bindings()[0],token='0x'+'17'.repeat(20),pool='0x'+'18'.repeat(20),router='0x'+'19'.repeat(20);
const intent={account:w.account,side:'sell',asset:token,percent:'50',currency:'BNB',slippageBps:100};
const direct=()=>({kind:'contract',route:'fixture',wallet:w.address,token,inputToken:token,outputToken:BNB,holdingBefore:'2000000',amountIn:'1000000',quote:{toCoinAmount:'1'},outputDecimals:6,minOutput:'990000',requireSellCredit:true,poolFees:{version:1,poolFeePpm:3000,pools:[{address:pool,feePpm:3000}]},audit:{available:true,taxes:{sellTax:'0'}},steps:[{kind:'sell',to:router,value:'0',data:'0x12345678'}],review:[]});
function setup(t,plan=direct()){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'fee-guard-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));let calls=0;
 const bridge={ready:async()=>{},call:async(_a,args)=>{if(args[1]==='preview')return {requestId:'preview',simulationResult:{simulationCode:'000000000',balanceChanges:plan.steps?.[0]?.kind==='approve'?[]:[{owner:w.address,contractAddress:BNB,change:'1000000'}]}};calls++;return {txHash:'0x'+'ab'.repeat(32),orderId:'fixture'};}};
 const rpc={call:async()=>ERC20.encodeFunctionResult('balanceOf',[2000000n])};
 const engine=new Engine({data,live:true,rpc,bridge,planFn:async()=>plan});engine.observeContract=async()=>{};
 return {engine,plan,bridge,get calls(){return calls;}};
}
test('V3 850150 PPM is 85.015%, even with a token audit reporting zero tax',()=>{
 const p=direct();p.poolFees=poolFeeProof({kind:'v3',pool,quote:WBNB,fee:850150},null,token,1);
 const f=assessSellFees(p);assert.equal(f.poolFeePpm,850150);assert.equal(f.taxPpm,0);assert.equal(f.required,true);assert.equal(feePercent(f.poolFeePpm),'85.015%');
});
test('50% threshold is inclusive for pool fees, token tax and simulated shortfall',()=>{
 assert.equal(HIGH_FEE_PPM,500000);
 for(const source of ['pool','tax','shortfall'])for(const value of [499999,500000,500001]){
  const p=direct();p.poolFees.poolFeePpm=source==='pool'?value:0;p.audit.taxes.sellTax=source==='tax'?String(value/10000):'0';
  const preview={balanceChanges:[{owner:w.address,contractAddress:BNB,change:String(source==='shortfall'?1000000-value:1000000)}]};
  const f=assessSellFees(p,preview,{beforeSell:true});assert.equal(f.required,value>=500000,source+': '+value);assert.equal(f.blocked,false);assert.equal(f.thresholdPpm,500000);
 }
 const p=direct();p.poolFees.poolFeePpm=30000;p.audit.taxes.sellTax='3';assert.equal(assessSellFees(p).required,false);
});
test('V2 infers fee from same-block reserves and quotes with conservative rounding',()=>{
 const ri=1000000000000n,ro=900000000000n,x=100000000n;
 for(const fee of [0n,2500n,3000n,50000n,850150n]){const a=x*(1000000n-fee),y=a*ro/(ri*1000000n+a),f=v2FeePpm({reserveIn:ri,reserveOut:ro,amountIn:x,amountOut:y});assert.ok(f>=Number(fee)&&f<=Number(fee)+1);}
 assert.equal(v2FeePpm({reserveIn:100, reserveOut:100,amountIn:1,amountOut:1}),null);
 assert.equal(v2FeePpm({reserveIn:100, reserveOut:100,amountIn:10,amountOut:99}),null);
});
test('missing, inconsistent and different-block fee evidence is unknown, not zero',()=>{
 const p={kind:'v2',pool,quote:WBNB,token0:token,reserve0:'100000',reserve1:'100000',block:7};
 assert.equal(poolFeeProof(p,[100,99],token,8).poolFeePpm,null);
 assert.equal(poolFeeProof(p,undefined,token,7).poolFeePpm,null);
 for(const fee of [null,undefined,'',false]){
  assert.equal(poolFeeProof({kind:'v3',pool,fee},null,token,7).poolFeePpm,null);
  assert.equal(assessSellFees({...direct(),route:'gang',state:{feeBps:fee},poolFees:undefined}).poolFeePpm,null);
 }
 const f=assessSellFees({...direct(),poolFees:undefined});assert.equal(f.required,true);assert.equal(f.poolFeePpm,null);
});
test('multi-hop fees compound retention and a missing leg makes the total unknown',()=>{
 assert.equal(compoundFees([30000,30000]),59100);assert.equal(compoundFees([3000,null]),null);
 const p={kind:'v3',legs:[{kind:'v3',pool,fee:30000},{kind:'v3',pool:router,fee:30000}]};assert.equal(poolFeeProof(p,null,token,1).poolFeePpm,59100);
});
test('official/declarative labels and prior approval cannot prefer a high fee pool',()=>{
 const low={pool:{pool,quote:WBNB},fees:{poolFeePpm:3000},output:5n,allowance:0n};
 const high={pool:{pool:router,quote:WBNB,declaredByToken:true},fees:{poolFeePpm:850150},output:100n,allowance:999999n};
 assert.deepEqual([high,low].sort(compareFeeRoutes),[low,high]);assert.ok(compareFeeRoutes(low,{...high,fees:{poolFeePpm:null}})<0);
 const official={...low,pool:{...low.pool,declaredByToken:true},output:4n};assert.ok(compareFeeRoutes(official,low)<0);
});
test('an opaque aggregator cannot inherit a direct pool fee proof or a token tax zero result',()=>{
 const f=assessSellFees({...direct(),kind:'swap',opening:{pool,fee:3000}});assert.equal(f.poolFeePpm,null);assert.equal(f.pools.length,0);assert.equal(f.required,true);assert.equal(f.opaque,true);
});
test('combined moderate pool and token taxes still trigger the high fee threshold',()=>{
 const p=direct();p.poolFees.poolFeePpm=300000;p.audit.taxes.sellTax='30';assert.equal(assessSellFees(p).totalFeePpm,510000);assert.equal(assessSellFees(p).required,true);
 for(const tax of [null,'','unavailable',-1,101]){p.audit.taxes.sellTax=tax;const f=assessSellFees(p);assert.equal(f.taxPpm,null);assert.equal(f.pendingSellPreview,true);assert.equal(f.required,false);assert.equal(assessSellFees(p,undefined,{beforeSell:true}).blocked,true);}
});
test('large simulated output shortfall is a separate warning despite low pool fee and zero reported tax',()=>{
 const f=assessSellFees(direct(),{balanceChanges:[{owner:w.address,contractAddress:BNB,change:'150000'}]});assert.equal(f.additionalLossPpm,850000);assert.equal(f.required,true);assert.equal(f.poolFeePpm,3000);
});
for(const kind of ['high','opaque','legacy'])test(`${kind}: quick acknowledgement cannot submit or approve and does not lock the wallet`,async t=>{
 const p=direct();if(kind==='high')p.poolFees.poolFeePpm=850150;if(kind==='opaque'){p.kind='swap';p.steps=[];p.args=[];}if(kind==='legacy')delete p.poolFees;
 const f=setup(t,p),o=await f.engine.prepare(intent,'quick'),r=await f.engine.execute(o.id,{authorization:'synthetic quick click',acknowledgeReview:true,swapReceiptWaitMs:0});
 const blocked=['opaque','legacy'].includes(kind);assert.equal(r.status,blocked?'BLOCKED':'PREPARED');assert.equal(r.needsFeeReview,!blocked);if(blocked)assert.equal(r.error.code,'SELL_FEES_UNVERIFIABLE');assert.equal(f.calls,0);assert.equal((await f.engine.reconcileAccount(w.account)).ready,true);assert.equal((await f.engine.prepare(intent,'another')).status,blocked?'BLOCKED':'PREPARED');
});
test('explicit matching fee confirmation submits once; another order cannot reuse it',async t=>{
 const p=direct();p.poolFees.poolFeePpm=850150;const f=setup(t,p),o=await f.engine.prepare(intent,'confirmed'),other=await f.engine.prepare(intent,'other');
 const rejected=await f.engine.execute(other.id,{authorization:'synthetic',acknowledgeReview:true,feeAcknowledgement:o.feeReview.id});assert.equal(rejected.needsFeeReview,true);assert.equal(f.calls,0);
 const r=await f.engine.execute(o.id,{authorization:'synthetic explicit fee consent',acknowledgeReview:true,feeAcknowledgement:o.feeReview.id,swapReceiptWaitMs:0});assert.equal(r.status,'PENDING');assert.equal(f.calls,1);
 await f.engine.execute(o.id,{authorization:'duplicate',acknowledgeReview:true,feeAcknowledgement:o.feeReview.id});assert.equal(f.calls,1);
});
test('automatic rejectRisks cannot accept high fees even if a caller copies a valid review ID',async t=>{
 const p=direct();p.poolFees.poolFeePpm=850150;const f=setup(t,p),o=await f.engine.prepare(intent,'auto');
 assert.equal((await f.engine.execute(o.id,{authorization:'synthetic auto',acknowledgeReview:true,feeAcknowledgement:o.feeReview.id,rejectRisks:true})).needsFeeReview,true);assert.equal(f.calls,0);
});
test('changed route or fees invalidate prior confirmation; no stale acknowledgement dispatches',async t=>{
 const p=direct();p.poolFees.poolFeePpm=800000;const f=setup(t,p),o=await f.engine.prepare(intent,'changed');p.poolFees.poolFeePpm=850150;
 o.timing.preparedAt=Date.now()-20000;f.engine.write(o);
 const r=await f.engine.execute(o.id,{authorization:'synthetic consent',acknowledgeReview:true,feeAcknowledgement:o.feeReview.id});assert.equal(r.needsFeeReview,true);assert.notEqual(r.feeReview.id,o.feeReview.id);assert.equal(f.calls,0);
});
test('verified low fee sale stays one-click without a new consent flag',async t=>{
 const f=setup(t),r=await f.engine.run(intent,'low',{execute:true,authorization:'synthetic quick',acknowledgeReview:true,swapReceiptWaitMs:0});assert.equal(r.status,'PENDING');assert.equal(f.calls,1);
});
test('a verified 20% fee now executes without the former 5% confirmation',async t=>{
 const p=direct();p.poolFees.poolFeePpm=200000;const f=setup(t,p);
 const r=await f.engine.run(intent,'below-new-threshold',{execute:true,authorization:'synthetic quick',acknowledgeReview:true,swapReceiptWaitMs:0});
 assert.equal(r.status,'PENDING');assert.equal(r.needsFeeReview,false);assert.equal(f.calls,1);assert.equal(r.feeRouteSearch,undefined);
});
test('high fees stop before an ERC20 approval, and a changed fee after approval releases the wallet for review',async t=>{
 const p=direct(),approval={kind:'approve',to:token,value:'0',spender:router,allowance:p.amountIn,data:ERC20.encodeFunctionData('approve',[router,p.amountIn])};p.steps.unshift(approval);p.poolFees.poolFeePpm=850150;
 const f=setup(t,p),o=await f.engine.prepare(intent,'approval');assert.equal((await f.engine.execute(o.id,{authorization:'quick',acknowledgeReview:true})).needsFeeReview,true);assert.equal(f.calls,0);
 // Reproduce a confirmed approval journal with an unsubmitted sale and a new fee.
 o.steps=[{step:approval,status:'CONFIRMED'}];o.nextStep=1;o.status='READY_TO_CONTINUE';o.plan.poolFees.poolFeePpm=900000;f.engine.write(o);
 const r=await f.engine.execute(o.id,{authorization:'stale consent',acknowledgeReview:true,feeAcknowledgement:o.feeReview.id});assert.equal(r.status,'PREPARED');assert.equal(r.nextStep,1);assert.equal(r.needsFeeReview,true);assert.equal((await f.engine.reconcileAccount(w.account)).ready,true);assert.equal(f.calls,0);
});
test('review identity excludes timestamps but includes amount, route, wallet, slippage and opaque quote',()=>{
 const o={id:'id',intent,plan:direct()};const original=updateFeeReview(o).id;for(const [key,val]of [['amountIn','1'],['wallet',router],['route','other'],['slippage',{bps:5000}]]){const next=structuredClone(o);next.plan[key]=val;assert.notEqual(updateFeeReview(next).id,original);}
 const a={...o,plan:{...o.plan,kind:'swap'}},first=updateFeeReview(a).id;a.plan.quote={toCoinAmount:'0.1'};assert.notEqual(updateFeeReview(a).id,first);
});
test('real parallel route planning waits for a slower low-fee quote instead of racing into an approved high-fee pool',async()=>{
 const dex=DEXES[2],pools=[{...dex,pool,quote:WBNB,liquid:true,fee:850150,declaredByToken:true},{...dex,pool:router,quote:WBNB,liquid:true,fee:500}];let quotes=0;
 const rpc={call:async tx=>{if(tx.to.toLowerCase()===token.toLowerCase()){const f=ERC20.parseTransaction(tx);return ERC20.encodeFunctionResult(f.name,[2000000n]);}const f=QUOTER.parseTransaction(tx);quotes++;if(f.args[0].fee===500n)await new Promise(r=>setTimeout(r,75));return QUOTER.encodeFunctionResult(f.name,[1000000n,1n,0n,100000n]);}};
 const p=await openingPlan(rpc,{},intent,{scan:async()=>({pools,at:Date.now()}),preparation:{token:async()=>({decimals:6,identity:{}}),venue:async()=>({assets:[]})}});
 assert.equal(p.opening.pool,router);assert.equal(p.poolFees.poolFeePpm,500);assert.equal(p.amountIn,'1000000');assert.equal(quotes,2);
});
test('automatic high-fee task remains visible for review and never loops into an alternate submission',async t=>{
 const p=direct();p.poolFees.poolFeePpm=850150;const f=setup(t,p),manager=new OpeningSell({engine:f.engine,data:f.engine.data,rpc:f.engine.rpc,bridge:f.bridge,detector:{scan:async()=>({open:true,pools:[{pool}]})},autoSchedule:false,now:()=>1000});t.after(()=>manager.close());
 const job={id:'high-fee-task',status:'ARMED',config:{...intent,accounts:[w.account]},bindings:[{account:w.account,address:w.address}],expiresAt:100000,authorization:'synthetic auto only',rows:[{account:w.account,status:'WAITING',attempts:0}]};manager.jobs.set(job.id,job);
 await manager.tick(job.id);assert.equal(job.status,'REVIEW');assert.equal(job.rows[0].error.code,'SELL_FEE_REVIEW');assert.equal(job.rows[0].attempts,1);assert.equal(f.calls,0);
 for(let i=0;i<5;i++)await manager.tick(job.id);assert.equal(job.rows[0].attempts,1);assert.equal(f.calls,0);assert.equal((await f.engine.reconcileAccount(w.account)).ready,true);
});

for(const consent of ['none','matching','copied'])test(`unknown pool fee cannot be consented away (${consent}), including legacy prepared records`,async t=>{
 const p={...direct(),kind:'swap',steps:[],args:[]},f=setup(t,p);
 const o=await f.engine.prepare(intent,'opaque');assert.equal(o.status,'BLOCKED');assert.equal(o.feeReview.blocked,true);
 // Emulate a PREPARED v1 journal/UI, not an executed order. Dispatch must
 // recompute current policy rather than trusting saved flags or confirmation.
 o.status='PREPARED';o.feeReview.version=1;o.feeReview.blocked=false;o.needsFeeReview=false;f.engine.write(o);
 const r=await f.engine.execute(o.id,{authorization:'synthetic explicit confirmation',acknowledgeReview:true,feeAcknowledgement:consent==='none'?undefined:consent==='matching'?o.feeReview.id:'copied-review',swapReceiptWaitMs:0});
 assert.equal(r.status,'BLOCKED');assert.equal(r.error.code,'SELL_FEES_UNVERIFIABLE');assert.equal(f.calls,0);assert.equal((await f.engine.reconcileAccount(w.account)).ready,true);
 // The actual provider boundary is guarded even when called independently.
 o.status='PREPARED';const boundary=await f.engine.submitSwap(o,0);assert.equal(boundary.status,'BLOCKED');assert.equal(f.calls,0);
 // A rejected opaque sale must not freeze a later known-fee sale or a mint.
 f.engine.planFn=async()=>direct();assert.equal((await f.engine.run(intent,'known-next',{execute:true,authorization:'synthetic',acknowledgeReview:true,swapReceiptWaitMs:0})).status,'PENDING');assert.equal(f.calls,1);
});
test('missing fee after a confirmed approval ends the unsubmitted sale and releases wallet, with no resubmission',async t=>{
 const f=setup(t),o=await f.engine.prepare(intent,'after-approval');
 o.steps=[{step:{kind:'approve'},status:'CONFIRMED'}];o.nextStep=1;o.status='READY_TO_CONTINUE';delete o.plan.poolFees;f.engine.write(o);
 const r=await f.engine.execute(o.id,{authorization:'synthetic',acknowledgeReview:true,feeAcknowledgement:o.feeReview.id});
 assert.equal(r.status,'BLOCKED');assert.equal(r.error.code,'SELL_FEES_UNVERIFIABLE');assert.equal(r.steps[0].status,'CONFIRMED');assert.equal(f.calls,0);assert.equal((await f.engine.reconcileAccount(w.account)).ready,true);
});
for(const recovery of [false,true])test(`automatic unknown-fee ${recovery?'recovery':'first'} attempt remains visible without retrying or consuming wallet lock`,async t=>{
 const p={...direct(),kind:'swap',steps:[],args:[]},f=setup(t,p),manager=new OpeningSell({engine:f.engine,data:f.engine.data,rpc:f.engine.rpc,bridge:f.bridge,detector:{scan:async()=>({open:true,pools:[{pool}]})},autoSchedule:false,now:()=>1000});t.after(()=>manager.close());
 const job={id:'opaque-task',status:'ARMED',config:{...intent,accounts:[w.account]},bindings:[{account:w.account,address:w.address}],expiresAt:100000,authorization:'synthetic auto',rows:[{account:w.account,status:'WAITING',attempts:0,...(recovery?{recovery:{sourceId:'failed-original'}}:{})}]};manager.jobs.set(job.id,job);
 await manager.tick(job.id);assert.equal(job.status,'REVIEW');assert.equal(job.rows[0].status,'REVIEW');assert.equal(job.rows[0].error.code,'SELL_FEES_UNVERIFIABLE');
 for(let n=0;n<25;n++)await manager.tick(job.id);
 assert.equal(job.rows[0].attempts,1);assert.equal(f.calls,0);assert.equal(manager.active(),false);assert.equal((await f.engine.reconcileAccount(w.account)).ready,true);
});
test('invalid persisted fee numbers cannot masquerade as verified zero',()=>{
 for(const v of [NaN,Infinity,-1,1000001,'',false,undefined]){const p=direct();p.poolFees.poolFeePpm=v;assert.equal(assessSellFees(p).blocked,true);}
});

test('missing audit tax uses fresh simulated net credit; it never becomes reported zero tax',()=>{
 const p=direct();delete p.audit;
 const preview=credit=>({balanceChanges:[{owner:w.address,contractAddress:BNB,change:String(credit)}]});
 const low=assessSellFees(p,preview(980010),{beforeSell:true});assert.equal(low.required,false);assert.equal(low.blocked,false);assert.equal(low.taxPpm,null);assert.equal(low.additionalLossPpm,19990);assert.equal(low.pendingSellPreview,false);
 const high=assessSellFees(p,preview(500000),{beforeSell:true});assert.equal(high.required,true);assert.match(high.reasons.join(),/模拟到账/);
 const combined=assessSellFees({...p,poolFees:{poolFeePpm:300000}},preview(700000),{beforeSell:true});assert.equal(combined.totalFeePpm,510000);assert.equal(combined.required,true);
 for(const evidence of [undefined,{balanceChanges:[]},{balanceChanges:[{owner:router,contractAddress:BNB,change:'1000000'}]},{balanceChanges:[{owner:w.address,contractAddress:token,change:'1000000'}]}])assert.equal(assessSellFees(p,evidence,{beforeSell:true}).blocked,true);
 for(const bad of [{...p,requireSellCredit:false},{...p,quote:{}},{...p,outputToken:null}]){const f=assessSellFees(bad);assert.equal(f.required,true);assert.equal(f.pendingSellPreview,false);}
});
test('ordinary preview rounding does not change review ID; material fee rise still does',()=>{
 const o={id:'stable',intent,plan:direct()};delete o.plan.audit;
 const review=n=>updateFeeReview(o,{balanceChanges:[{owner:w.address,contractAddress:BNB,change:String(n)}]}).id;
 const first=review(980010);assert.equal(review(980022),first);assert.notEqual(review(500000),first);
});
test('unknown vendor tax no longer requires a second confirmation for an approved low-fee route',async t=>{
 const p=direct();delete p.audit;const f=setup(t,p);
 const result=await f.engine.run(intent,'unknown-tax-low',{execute:true,authorization:'synthetic one click',acknowledgeReview:true,swapReceiptWaitMs:0});
 assert.equal(result.status,'PENDING');assert.equal(result.needsFeeReview,false);assert.equal(result.needsReview,false);assert.equal(result.feeReview.taxPpm,null);assert.equal(f.calls,1);
});
for(const loss of ['low','high','missing','failed'])test(`one click approval -> ${loss} sell preview is checked without repetitive confirmation`,async t=>{
 const p=direct();delete p.audit;p.minOutput='500000';
 p.steps.unshift({kind:'approve',to:token,value:'0',spender:router,allowance:p.amountIn,data:ERC20.encodeFunctionData('approve',[router,p.amountIn])});
 const f=setup(t,p),commands=[];let approvals=0;
 f.bridge.call=async(_a,args)=>{
  if(args[1]==='preview'){
   const approve=args[args.indexOf('--inputData')+1]===p.steps[0].data;commands.push(approve?'preview-approve':'preview-sell');
   return {requestId:approve?'approve':'sell',simulationResult:{simulationCode:!approve&&loss==='failed'?'failed':'000000000',balanceChanges:approve?[]:loss==='missing'?[]:[{owner:w.address,contractAddress:BNB,change:loss==='high'?'500000':'980010'}]}};
  }
  commands.push('execute-'+args.at(-1));if(args.at(-1)==='approve')approvals++;
  return {txHash:'0x'+'ab'.repeat(32)};
 };
 f.engine.observeContract=async(o,e)=>{e.status='CONFIRMED';};
 const r=await f.engine.run(intent,'single-click-'+loss,{execute:true,authorization:'synthetic quick sell',acknowledgeReview:true});
 assert.equal(approvals,1);assert.equal(commands.filter(c=>c==='preview-sell').length,1);
 assert.equal(commands.filter(c=>c==='execute-sell').length,loss==='low'?1:0);
 assert.equal(r.status,loss==='low'?'CONFIRMED':loss==='high'?'PREPARED':'BLOCKED');
 if(loss==='low'){assert.equal(r.needsReview,false);assert.equal(r.needsFeeReview,false);assert.equal(r.feeReview.additionalLossPpm,19990);}
 if(loss==='high'){assert.equal(r.nextStep,1);assert.equal(r.needsFeeReview,true);assert.match(r.feeReview.reasons.join(),/模拟到账/);}
 assert.equal((await f.engine.reconcileAccount(w.account)).ready,true);
 await f.engine.execute(r.id,{authorization:'same click again',acknowledgeReview:true});assert.equal(approvals,1);
});
