// All wallets/transports are fixtures; no signing and no network calls.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ERC20,bindings,BNB,WBNB,USDT,same,formatUnits} from '../lib/common.mjs';
import {DEXES,V2_ROUTER_ABI as ROUTER} from '../lib/opening-dex.mjs';
import {openingPlan} from '../lib/opening-route.mjs';
import {OpeningValues} from '../lib/opening-value.mjs';
import {poolFeeProof,assessSellFees,compareFeeRoutes,v2QuoteLoss} from '../lib/trade-fees.mjs';
import {Engine} from '../lib/engine.mjs';
const token='0x'+'c1'.repeat(20),small='0x'+'11'.repeat(20),main='0x'+'ee'.repeat(20),w=bindings()[0],d=DEXES[0],block=77;
const raw=9829671373449393522952138n;
const dust={...d,pool:small,token0:USDT,token1:token,quote:USDT,block,liquid:true,reserve0:'188468241060662822',reserve1:'66677341435516405181731'};
const deep={...d,pool:main,token0:token,token1:WBNB,quote:WBNB,block,liquid:true,reserve0:'31972644097514521670935932808',reserve1:'146523275132384922274'};
const quote=(p,x)=>{const ri=BigInt(same(p.token0,token)?p.reserve0:p.reserve1),ro=BigInt(same(p.token0,token)?p.reserve1:p.reserve0),a=x*9975n;return a*ro/(ri*10000n+a);};
const result=p=>({pool:p,output:quote(p,raw),fees:poolFeeProof(p,[raw,quote(p,raw)],token,block)});
function fixture(pools=[dust,deep]){
 let valuationReads=0;
 const rpc={call:async(tx,b)=>{
  if(same(tx.to,token)){const f=ERC20.parseTransaction(tx);return ERC20.encodeFunctionResult(f.name,[f.name==='balanceOf'?raw:raw*2n]);}
  assert.equal(tx.to,d.router);assert.equal(b,block);const f=ROUTER.parseTransaction(tx);assert.equal(f.name,'getAmountsOut');
  const [x,route]=f.args;
  if(same(route[0],USDT)){valuationReads++;return ROUTER.encodeFunctionResult(f.name,[[x,x/600n]]);}
  assert.ok(same(route[0],token));const p=pools.find(p=>same(p.quote,route[1]));return ROUTER.encodeFunctionResult(f.name,[[x,quote(p,x)]]);
 }};
 const preparation={token:async()=>({decimals:18,identity:{fingerprint:'fixture'}}),venue:async()=>({assets:[]})};
 const intent={account:w.account,side:'sell',asset:token,currency:'AUTO',percent:'100',slippageBps:5000};
 return {rpc,preparation,intent,scan:async()=>({at:Date.now(),pools}),valuationReads:()=>valuationReads};
}
test('dust V2 pool has 0.25% LP fee but over 99% full-size quote loss',()=>{
 const bad=result(dust),good=result(deep);
 assert.ok(bad.fees.poolFeePpm<=2501);assert.ok(bad.fees.quoteLossPpm>990000);
 assert.ok(good.fees.quoteLossPpm<3000);assert.equal([bad,good].sort(compareFeeRoutes)[0],good);
 const reversed={...dust,token0:token,token1:USDT,reserve0:dust.reserve1,reserve1:dust.reserve0};
 assert.deepEqual(result(reversed).fees.quoteLossPpm,bad.fees.quoteLossPpm);
 assert.deepEqual(v2QuoteLoss(dust,[raw,bad.output],token,block+1),{});
});
test('two-hop impact includes both legs with exact integer ratios',()=>{
 const second={...dust,pool:'0x'+'22'.repeat(20),token0:USDT,token1:WBNB,reserve0:'1000000000000000000000',reserve1:'1000000000000000000'};
 const firstOut=quote(dust,raw),out=firstOut*9975n*BigInt(second.reserve1)/(BigInt(second.reserve0)*10000n+firstOut*9975n);
 const f=poolFeeProof({...dust,quote:WBNB,path:[token,USDT,WBNB],legs:[dust,second]},[raw,firstOut,out],token,block);
 assert.ok(f.quoteLossPpm>990000);assert.ok(f.poolFeePpm>4900&&f.poolFeePpm<5100);
});
for(const openingOnly of [false,true])test(`${openingOnly?'automatic opening':'manual'} sale selects deep pool without a token label`,async()=>{
 const f=fixture(),p=await openingPlan(f.rpc,{}, {...f.intent,...(openingOnly?{openingOnly:true}:{})},f);
 assert.equal(p.opening.pool,main);assert.equal(p.outputToken,BNB);assert.ok(p.poolFees.quoteLossPpm<3000);
 assert.equal(p.routeSearch.comparison.length,2);assert.equal(p.steps.at(-1).to,d.router);
 const call=ROUTER.parseTransaction(p.steps.at(-1));assert.equal(call.args[0],raw);assert.equal(call.args[3],w.address);assert.deepEqual([...call.args[2]].map(x=>x.toLowerCase()),[token,WBNB].map(x=>x.toLowerCase()));
});
test('tiny fee differences cannot outweigh common-currency proceeds',()=>{
 const a={pool:deep,output:1n,fees:{poolFeePpm:3001,quoteLossPpm:4000},value:{token:WBNB,amount:'1000'}},b={pool:dust,output:10000000n,fees:{poolFeePpm:2500,quoteLossPpm:3000},value:{token:WBNB,amount:'100'}};
 assert.equal([b,a].sort(compareFeeRoutes)[0],a);
 assert.equal([b,{...a,fees:{poolFeePpm:600000}}].sort(compareFeeRoutes)[0],b,'high fee cannot be bought off by a large quote');
});
test('primary discovered during first quote batch is still quoted before choosing a secondary',async()=>{
 let reads=0;
 const pools=Array.from({length:9},(_,n)=>({...deep,pool:'0x'+(n+1).toString(16).padStart(40,'0')}));
 Object.defineProperty(pools[8],'declaredByToken',{enumerable:true,get:()=>reads>=8});
 const f=fixture(pools),call=f.rpc.call;
 f.rpc.call=async(tx,b)=>{if(same(tx.to,d.router))reads++;return call(tx,b);};
 const plan=await openingPlan(f.rpc,{},f.intent,f);
 assert.equal(plan.opening.pool,pools[8].pool);assert.equal(plan.routeSearch.quoted,9);assert.equal(reads,9);
});
test('adequately liquid verified primary wins; a primary label never rescues an exhausted pool',()=>{
 const a={...result(deep),pool:{...deep,declaredByToken:true},value:{token:WBNB,amount:'100'}},b={...result(deep),pool:{...deep,pool:small},fees:{poolFeePpm:100,quoteLossPpm:300},value:{token:WBNB,amount:'101'}};
 assert.equal([b,a].sort(compareFeeRoutes)[0],a);
 const exhausted={...result(dust),pool:{...dust,declaredByToken:true}};assert.equal([exhausted,b].sort(compareFeeRoutes)[0],b);
});
test('verified deep primary selection needs no extra cross-currency request',async()=>{
 const f=fixture([dust,{...deep,declaredByToken:true}]),p=await openingPlan(f.rpc,{},f.intent,f);
 assert.equal(p.opening.pool,main);assert.equal(f.valuationReads(),0);
});
test('manual and automatic primary paths finish while an optional secondary quote is still pending',async()=>{
 for(const openingOnly of [false,true]){
  const f=fixture([dust,{...deep,declaredByToken:true}]),call=f.rpc.call;let release,slowFinished=false;
  const gate=new Promise(r=>release=r);
  f.rpc.call=async(tx,b)=>{if(same(tx.to,d.router)){const args=ROUTER.parseTransaction(tx).args;if(same(args[1][1],USDT)){await gate;slowFinished=true;}}return call(tx,b);};
  let timer;try{
   const plan=await Promise.race([openingPlan(f.rpc,{}, {...f.intent,openingOnly},f),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('primary waited for secondary')),700))]);
   assert.equal(plan.opening.pool,main);assert.equal(slowFinished,false);assert.equal(f.valuationReads(),0);
  }finally{clearTimeout(timer);release();}
 }
});
test('a thin declared primary cannot shortcut the still-loading healthy alternative',async()=>{
 const f=fixture([{...dust,declaredByToken:true},deep]),call=f.rpc.call;let release,completed=false;
 const gate=new Promise(r=>release=r);
 f.rpc.call=async(tx,b)=>{if(same(tx.to,d.router)&&same(ROUTER.parseTransaction(tx).args[1][1],WBNB))await gate;return call(tx,b);};
 const pending=openingPlan(f.rpc,{},f.intent,f).then(r=>{completed=true;return r;});
 await new Promise(r=>setTimeout(r,20));assert.equal(completed,false);release();const plan=await pending;assert.equal(plan.opening.pool,main);
});
test('primary fast path still awaits current allowance and venue identity',async()=>{
 const f=fixture([dust,{...deep,declaredByToken:true}]),call=f.rpc.call;let release,completed=false;
 const gate=new Promise(r=>release=r);
 f.rpc.call=async(tx,b)=>{if(same(tx.to,token)&&ERC20.parseTransaction(tx).name==='allowance')await gate;return call(tx,b);};
 const pending=openingPlan(f.rpc,{},f.intent,f).then(r=>{completed=true;return r;});
 await new Promise(r=>setTimeout(r,20));assert.equal(completed,false);release();assert.equal((await pending).opening.pool,main);
 const invalid=fixture([dust,{...deep,declaredByToken:true}]);invalid.preparation.venue=async()=>{throw Error('路由身份不匹配');};
 await assert.rejects(openingPlan(invalid.rpc,{}, {...invalid.intent,openingOnly:true},invalid),/路由身份不匹配/);
});
test('concurrent wallets share only the same-block valuation; no new roundtrip for a single quote currency',async()=>{
 const f=fixture(),v=new OpeningValues(f.rpc),groups=Array.from({length:4},()=>[result(dust),result(deep)]);
 await Promise.all(groups.map(r=>v.compare(r,f.preparation)));assert.equal(f.valuationReads(),1);
 for(const g of groups){assert.equal(g[0].value.block,block);assert.equal(g[1].value.amount,String(g[1].output));}
 await v.compare([result(dust)],f.preparation);assert.equal(f.valuationReads(),1);
 const next=groups[0].map(r=>({...r,pool:{...r.pool,block:block+1}}));
 let failed=0;const f2={call:async()=>{failed++;throw Error('unavailable');}};
 const retry=new OpeningValues(f2);await retry.compare(next,f.preparation);await retry.compare(next,f.preparation);assert.equal(failed,2,'failure is never cached as a zero price');
});
test('old prepared V2 order reconstructs missing impact and instant mode cannot send it',async t=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'sell-impact-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 const output=quote(dust,raw),proof=poolFeeProof(dust,[raw,output],token,block);delete proof.quoteLossPpm;delete proof.referenceOutput;
 const plan={kind:'contract',route:'pancake-v2-opening',account:w.account,wallet:w.address,token,inputToken:token,outputToken:USDT,amountIn:String(raw),holdingBefore:String(raw),outputDecimals:18,minOutput:String(output/2n),quote:{toCoinAmount:formatUnits(output,18)},opening:dust,state:dust,poolFees:proof,audit:{available:true,taxes:{sellTax:'0'}},requireSellCredit:true,steps:[{kind:'sell',to:d.router,value:'0',data:ROUTER.encodeFunctionData('swapExactTokensForTokensSupportingFeeOnTransferTokens',[raw,output/2n,[token,USDT],w.address,9999999999])}],review:[]};
 assert.ok(assessSellFees(plan).quoteLossPpm>990000);
 let submissions=0;const bridge={ready:async()=>{},call:async(_a,args)=>{if(args[1]!=='preview'){submissions++;throw Error('must not submit');}return {requestId:'mock',simulationResult:{simulationCode:'000000000',balanceChanges:[{owner:w.address,contractAddress:USDT,change:String(output)}]}};}};
 const e=new Engine({data,live:true,rpc:{call:async()=>ERC20.encodeFunctionResult('balanceOf',[raw])},bridge,planFn:async()=>plan});e.feeRoutePlanner=async()=>{throw Error('no alternative');};
 const intent={account:w.account,side:'sell',asset:token,currency:'AUTO',percent:'100',slippageBps:5000};
 const order=await e.prepare(intent,'dust');const r=await e.execute(order.id,{authorization:'synthetic instant click',acknowledgeReview:true,swapReceiptWaitMs:0});
 assert.equal(r.status,'PREPARED');assert.equal(r.needsFeeReview,true);assert.equal(submissions,0);assert.equal((await e.reconcileAccount(w.account)).ready,true);
 const auto=await e.execute(order.id,{authorization:'synthetic auto task',acknowledgeReview:true,feeAcknowledgement:r.feeReview.id,rejectRisks:true});assert.equal(auto.needsFeeReview,true);assert.equal(submissions,0);
});
