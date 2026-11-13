import {virtualLatency} from './support/virtual-latency.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {parallelSellCandidate,parallelSellProof} from '../lib/parallel-sell.mjs';
import {SellCoordinator,sellLane} from '../lib/sell-coordinator.mjs';
import {Engine} from '../lib/engine.mjs';
import {bindings,ERC20,WBNB,same,formatUnits} from '../lib/common.mjs';
import {DEXES,V2_ROUTER_ABI} from '../lib/opening-dex.mjs';
import {POOL} from '../lib/opening-pools.mjs';import {MULTI,MULTICALL} from '../lib/opening-read.mjs';
import {poolFeeProof} from '../lib/trade-fees.mjs';
const token='0x'+'d2'.repeat(20),pair='0x'+'d3'.repeat(20),dex=DEXES.find(d=>d.id==='pancake-v2'),unit=10n**18n,ws=bindings().slice(0,4);
const tick=()=>new Promise(r=>setImmediate(r)),deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const output=(x,ri,ro)=>x*9975n*ro/(ri*10000n+x*9975n);
function record(n,{ri=35000000000n*unit,ro=126n*unit,amount=(n===0?2200000n:760000n)*unit,tax=200n}={}){
 const w=ws[n],pool={...dex,pool:pair,token,token0:token,token1:WBNB,quote:WBNB,reserve0:String(ri),reserve1:String(ro),block:100};
 const gross=output(amount,ri,ro),credit=output(amount*(10000n-tax)/10000n,ri,ro),min=gross*9700n/10000n;
 const plan={kind:'contract',account:w.account,wallet:w.address,route:dex.id+'-opening',token,inputToken:token,outputToken:WBNB,amountIn:String(amount),holdingBefore:String(amount),outputDecimals:18,decimals:18,
  opening:pool,state:pool,quote:{toCoinAmount:formatUnits(gross,18)},minOutput:String(min),poolFees:poolFeeProof(pool,[amount,gross],token,100),audit:{available:true,taxes:{sellTax:'0.02'}},requireSellCredit:true,slippage:{bps:300,mode:'fixed',capBps:300},review:[],
  steps:[{kind:'sell',to:dex.router,value:'0',data:V2_ROUTER_ABI.encodeFunctionData('swapExactTokensForTokensSupportingFeeOnTransferTokens',[amount,min,[token,WBNB],w.address,Math.floor(Date.now()/1000)+120])}]};
 return {id:'parallel-'+n,plan,review:{balanceChanges:[{owner:w.address,contractAddress:WBNB,change:String(credit)}]},at:Date.now()};
}
test('deep pool: three 2%-tax sales fit original 3% minimums in every execution order',()=>{
 const rows=[0,1,2].map(n=>record(n));assert.ok(parallelSellProof(rows));
 for(const order of [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]){
  let ri=BigInt(rows[0].plan.opening.reserve0),ro=BigInt(rows[0].plan.opening.reserve1);
  for(const n of order){const p=rows[n].plan,x=BigInt(p.amountIn)*9800n/10000n,y=output(x,ri,ro);assert.ok(y>=BigInt(p.minOutput));ri+=x;ro-=y;}
 }
});
test('thin pools, unknown originals, stale previews and new simulation losses retain serial admission',()=>{
 assert.equal(parallelSellProof([0,1,2].map(n=>record(n,{ri:30000000n*unit}))),null);
 for(const change of [r=>r.status='RECEIPT_REVIEW',r=>r.at-=15001,r=>r.at+=1000,r=>r.plan.opening.kind='v3',r=>r.plan.stagedTrade=true,r=>r.plan.audit.available=false,
  r=>r.plan.opening.factory=token,r=>r.plan.opening.router=token,r=>r.plan.steps[0].to=token,r=>r.plan.minOutput='1',r=>r.plan.poolFees.poolFeePpm=null,
  r=>r.plan.poolFees.poolFeePpm=850150,r=>r.review.balanceChanges[0].change=1.5e25,r=>r.review.balanceChanges[0].owner=token,r=>r.review.balanceChanges[0].change=String(BigInt(r.plan.minOutput)),
  r=>r.plan.opening.path=[token,pair,WBNB],r=>r.plan.opening.legs=[{},{}]]){
  const rows=[record(0),record(1)];change(rows[1]);assert.equal(parallelSellProof(rows),null,String(change));
 }
 const r=record(0);assert.equal(parallelSellProof([r,{...r,id:'duplicate'}]),null);
});
test('parallel admission is synchronous; serial waiter drains all peers and blocks later arrivals',async()=>{
 const c=new SellCoordinator(),a=record(0),b=record(1),key=sellLane(a.plan,a.plan.steps[0]);
 const first=c.tryParallel(key,a),second=c.tryParallel(key,b);assert.ok(first);assert.equal(second.proof.wallets,2);
 let entered=false;const waiting=c.enter(key,record(2).plan).then(l=>{entered=true;return l;});assert.equal(c.tryParallel(key,record(3)),null);
 first.release();await tick();assert.equal(entered,false);second.release();const serial=await waiting;assert.equal(serial.waited,true);serial.release();
 assert.equal(c.parallel.size,0);assert.equal(c.tails.size,0);assert.ok(c.tryParallel(key,record(3)));
});
test('fast-return journal entries count toward impact even after in-memory release',()=>{
 const c=new SellCoordinator(),a=record(0),b=record(1),key=sellLane(a.plan,a.plan.steps[0]);const first=c.tryParallel(key,a);first.release();
 assert.equal(c.tryParallel(key,b,[{...a,status:'RECEIPT_REVIEW'}]),null);
 const next=c.tryParallel(key,b,[{...a,status:'PENDING'}]);assert.equal(next.proof.wallets,2);next.release();
 assert.equal(c.tryParallel(key,record(2,{amount:100000000n*unit}),[{...a,status:'PENDING'}]),null);
 const unknown=c.tryParallel(key,b,[{...a,status:'SUBMISSION_UNKNOWN'}]);assert.equal(unknown.proof.wallets,2);unknown.release();
});

async function engineFixture(t,{fastReturn=false,failAccount=0,approval=false,thin=false,latency=0,uncertain=false,serial=false,automaticReceipt=false,cancelAccount=0}={}){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'parallel-sell-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 let ri=(thin?30000000n:35000000000n)*unit,ro=126n*unit,seq=0;
 const seen=[],requests=new Map(),gate=deferred();const wait=()=>latency?new Promise(r=>setTimeout(r,latency)):Promise.resolve();
 const fixture=n=>record(n,{ri,ro});
 const rpc={getBlockNumber:async()=>100,call:async tx=>{
  await wait();const encode=tx=>{const abi=same(tx.to,token)?ERC20:same(tx.to,pair)?POOL:V2_ROUTER_ABI,f=abi.parseTransaction(tx);
   if(f.name.startsWith('swap'))return '0x';
   return abi.encodeFunctionResult(f.name,f.name==='balanceOf'?[BigInt(fixture(ws.findIndex(w=>same(w.address,f.args[0]))).plan.holdingBefore)]:f.name==='allowance'?[10000000n*unit]:f.name==='getReserves'?[ri,ro,1]:[[f.args[0],output(f.args[0],ri,ro)]]);
  };if(same(tx.to,MULTICALL)){const f=MULTI.parseTransaction(tx);return MULTI.encodeFunctionResult(f.name,[100,'0x'+'0'.repeat(64),f.args[1].map(c=>[true,encode({to:c.target,data:c.callData})])]);}return encode(tx);
 }};
 const bridge={ready:async()=>{},call:async(account,args)=>{
  await wait();
  if(args[1]==='preview'){
   const data=args[args.indexOf('--inputData')+1],to=args[args.indexOf('--to')+1],isApprove=data.startsWith(ERC20.getFunction('approve').selector);
   const f=(isApprove?ERC20:V2_ROUTER_ABI).parseTransaction({data}),id='request-'+(++seq);requests.set(id,{account,f,isApprove,used:false});
   if(account===failAccount&&!isApprove)throw Object.assign(Error('模拟余额不足'),{code:'INSUFFICIENT_BALANCE'});
   return {requestId:id,simulationResult:{simulationCode:'000000000',balanceChanges:isApprove?[]:[{owner:ws.find(w=>w.account===account).address,contractAddress:WBNB,change:String(output(f.args[0]*9800n/10000n,ri,ro))}]}};
  }
  const r=requests.get(args.at(-1));assert.equal(r.account,account);assert.equal(r.used,false);r.used=true;seen.push({account,kind:r.isApprove?'approve':'sell',at:Date.now(),request:r});return {txHash:'0x'+String(++seq).padStart(64,'0')};
 }};
 const e=new Engine({rpc,bridge,data,live:true,planFn:async i=>{
  const p=fixture(ws.findIndex(w=>w.account===i.account)).plan;if(serial)p.audit.available=false;if(approval)p.steps.unshift({kind:'approve',to:token,value:'0',spender:dex.router,allowance:p.amountIn,data:ERC20.encodeFunctionData('approve',[dex.router,p.amountIn])});return p;
 }});
 e.observeContract=async(o,entry,timeout)=>{
  if(entry.step.kind==='approve'){await wait();entry.status='CONFIRMED';return;}
  if(uncertain&&o.intent.account===ws[0].account){entry.status=o.status='SUBMISSION_UNKNOWN';return;}
  if(fastReturn&&timeout===0)return;
  if(automaticReceipt)await new Promise(r=>setTimeout(r,350));else await gate.promise;await wait();if(entry.status==='CONFIRMED')return;
  const f=V2_ROUTER_ABI.parseTransaction(entry.step),x=f.args[0]*9800n/10000n,y=output(x,ri,ro);
  assert.ok(y>=f.args[1],'every original minimum must still be met');ri+=x;ro-=y;entry.status='CONFIRMED';entry.confirmedAt=Date.now();
 };
 for(let n=0;n<3;n++)await e.prepare({side:'sell',account:ws[n].account,asset:token,percent:'100',currency:'WBNB',slippageBps:300},'parallel-'+n);
 const started=Date.now();const running=Promise.all([0,1,2].map(n=>e.execute('parallel-'+n,{authorization:'synthetic test only',swapReceiptWaitMs:fastReturn?0:10000,continueAllowed:()=>ws[n].account!==cancelAccount})));
 const expected=failAccount||cancelAccount?2:3,until=Date.now()+3000;
 while(seen.filter(s=>s.kind==='sell').length<(thin?1:expected)&&Date.now()<until)await new Promise(r=>setTimeout(r,5));
 const beforeReceipt=seen.filter(s=>s.kind==='sell').length;gate.resolve();const results=await running;
 return {e,results,seen,beforeReceipt,dispatchMs:Math.max(...seen.filter(s=>s.kind==='sell').map(s=>s.at))-started,totalMs:Date.now()-started};
}
for(const options of [{},{fastReturn:true},{approval:true},{approval:true,fastReturn:true}])test('three wallets send before any sale receipt; exact original request once '+JSON.stringify(options),async t=>{
 const {e,results,seen,beforeReceipt}=await engineFixture(t,options);
 assert.equal(beforeReceipt,3,JSON.stringify(results.map(o=>o.error)));assert.ok(results.every(o=>['CONFIRMED','PENDING'].includes(o.status)));
 assert.ok(results.every(o=>o.timing.executionSteps.some(s=>s.parallelSell)));assert.ok(results.every(o=>o.plan.slippage.bps===300));
 assert.equal(seen.filter(s=>s.kind==='sell').length,3);await e.execute('parallel-1',{authorization:'same test'});assert.equal(seen.filter(s=>s.kind==='sell').length,3);
 assert.equal(e.sellCoordinator.parallel.size,0);assert.equal(e.sellCoordinator.tails.size,0);
});
test('one wallet simulation failure cannot prevent the other wallets submitting together',async t=>{
 const r=await engineFixture(t,{failAccount:ws[1].account,approval:true});assert.equal(r.beforeReceipt,2);assert.equal(r.seen.filter(s=>s.kind==='sell').length,2);
 assert.ok(r.results.filter((_,n)=>n!==1).every(o=>o.status==='CONFIRMED'));
});
test('high-impact group falls back to receipt/requote without widening slippage or duplicating',async t=>{
 const r=await engineFixture(t,{thin:true});assert.equal(r.beforeReceipt,1);assert.ok(r.results.every(o=>o.status==='CONFIRMED'),JSON.stringify(r.results.map(o=>o.error)));
 assert.ok(r.results.some(o=>o.timing.executionSteps.some(s=>s.parallelFallback)));assert.equal(r.seen.filter(s=>s.kind==='sell').length,3);
});
test('uncertain original stays tracked once while different low-impact wallets can still sell',async t=>{
 const r=await engineFixture(t,{uncertain:true,fastReturn:true});assert.equal(r.beforeReceipt,3);assert.equal(r.results[0].status,'SUBMISSION_UNKNOWN');
 assert.ok(r.results.slice(1).every(o=>o.status==='PENDING'));await r.e.execute('parallel-0',{authorization:'duplicate'});assert.equal(r.seen.filter(s=>s.kind==='sell').length,3);
});
test('cancelled wallet sends nothing and leaves no stale reservation for the others',async t=>{
 const r=await engineFixture(t,{cancelAccount:ws[1].account});assert.equal(r.beforeReceipt,2);assert.equal(r.results[1].status,'CANCELLED');assert.equal(r.e.sellCoordinator.parallel.size,0);
});
test('same simulated RPC/wallet latency: compare three-wallet serial and concurrent completion',async t=>{
 const advance=virtualLatency(t);
 const legacy=await advance(engineFixture(t,{serial:true,latency:70,automaticReceipt:true}));
 const concurrent=await advance(engineFixture(t,{latency:70,automaticReceipt:true}));
 assert.ok(legacy.results.every(o=>o.status==='CONFIRMED'));assert.ok(concurrent.results.every(o=>o.status==='CONFIRMED'));
 assert.ok(concurrent.totalMs<legacy.totalMs,JSON.stringify({legacy:legacy.totalMs,concurrent:concurrent.totalMs}));
 t.diagnostic(JSON.stringify({syntheticOnly:true,virtualClock:true,threeWallets:{serial:{allSentMs:legacy.dispatchMs,allConfirmedMs:legacy.totalMs},concurrent:{allSentMs:concurrent.dispatchMs,allConfirmedMs:concurrent.totalMs}}}));
});
