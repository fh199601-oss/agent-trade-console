import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {parallelSellCandidate,parallelSellProof,pipelinePreparationEligible} from '../lib/parallel-sell.mjs';
import {SellCoordinator,sellLane} from '../lib/sell-coordinator.mjs';
import {Engine} from '../lib/engine.mjs';
import {bindings,ERC20,WBNB,same,formatUnits} from '../lib/common.mjs';
import {DEXES,V2_ROUTER_ABI} from '../lib/opening-dex.mjs';
import {POOL} from '../lib/opening-pools.mjs';import {MULTI,MULTICALL} from '../lib/opening-read.mjs';
import {poolFeeProof} from '../lib/trade-fees.mjs';
const token='0x'+'d2'.repeat(20),pair='0x'+'d3'.repeat(20),dex=DEXES.find(d=>d.id==='pancake-v2'),unit=10n**18n,ws=bindings().slice(0,4);
const tick=()=>new Promise(r=>setImmediate(r)),deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const output=(x,ri,ro)=>x*9975n*ro/(ri*10000n+x*9975n);
function record(n,{ri=35000000000n*unit,ro=126n*unit,amount=(n===0?2200000n:760000n)*unit,tax=200n,bps=300}={}){
 const w=ws[n],pool={...dex,pool:pair,token,token0:token,token1:WBNB,quote:WBNB,reserve0:String(ri),reserve1:String(ro),block:100};
 const gross=output(amount,ri,ro),credit=output(amount*(10000n-tax)/10000n,ri,ro),min=gross*BigInt(10000-bps)/10000n;
 const plan={kind:'contract',account:w.account,wallet:w.address,route:dex.id+'-opening',token,inputToken:token,outputToken:WBNB,amountIn:String(amount),holdingBefore:String(amount),outputDecimals:18,decimals:18,
  opening:pool,state:pool,quote:{toCoinAmount:formatUnits(gross,18)},minOutput:String(min),poolFees:poolFeeProof(pool,[amount,gross],token,100),audit:{available:true,taxes:{sellTax:'0.02'}},requireSellCredit:true,slippage:{bps,mode:'fixed',capBps:bps},review:[],
  steps:[{kind:'sell',to:dex.router,value:'0',data:V2_ROUTER_ABI.encodeFunctionData('swapExactTokensForTokensSupportingFeeOnTransferTokens',[amount,min,[token,WBNB],w.address,Math.floor(Date.now()/1000)+120])}]};
 return {id:'parallel-'+n,plan,review:{balanceChanges:[{owner:w.address,contractAddress:WBNB,change:String(credit)}]},at:Date.now()};
}
test('preparation pipeline needs actual 99% slippage and at most 10% input/reserve on the verified direct V2 route',()=>{
 const p=record(0,{ri:10000n*unit,amount:1000n*unit}).plan;p.slippage={mode:'fixed',bps:9900,capBps:9900};
 assert.equal(pipelinePreparationEligible(p),true);
 const reversed=structuredClone(p);[reversed.opening.token0,reversed.opening.token1]=[reversed.opening.token1,reversed.opening.token0];[reversed.opening.reserve0,reversed.opening.reserve1]=[reversed.opening.reserve1,reversed.opening.reserve0];assert.equal(pipelinePreparationEligible(reversed),true);
 for(const mutate of [p=>p.amountIn=String(1000n*unit+1n),p=>p.amountIn='0',p=>p.slippage.bps=9000,p=>p.slippage={mode:'auto',bps:300,capBps:9900},p=>p.opening.kind='v3',p=>p.opening.legs=[{},{}],p=>p.steps[0].to=token,p=>p.opening.reserve0='invalid',p=>p.stagedTrade=true]){const copy=structuredClone(p);mutate(copy);assert.equal(pipelinePreparationEligible(copy),false);}
});
test('preparation pipeline keeps the strictest original exposure until the occupied queue drains',async()=>{
 const c=new SellCoordinator(),plan=ri=>{const p=record(0,{ri:ri*unit,amount:1000n*unit}).plan;p.slippage.bps=9900;return p;};
 const a=await c.prepareParallel('pool',plan(10000n));assert.equal(a.pipelineEligible(),true);
 const b=await c.prepareParallel('pool',plan(2000n));assert.equal(a.pipelineEligible(),false);assert.equal(b.pipelineEligible(),false);
 b.release();const afterSells=await c.prepareParallel('pool',plan(100000n));assert.equal(afterSells.pipelineEligible(),false,'larger token reserves do not reclassify a still-active extreme batch');
 a.release();assert.equal(afterSells.pipelineEligible(),false);afterSells.release();assert.equal(c.preparations.size,0);
 const nextBatch=await c.prepareParallel('pool',plan(10000n));assert.equal(nextBatch.pipelineEligible(),true);nextBatch.release();assert.equal(c.preparations.size,0);
});
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
test('parallel wave wait drains only captured owners without reserving a serial lane',async()=>{
 const c=new SellCoordinator(),a=record(0),key=sellLane(a.plan,a.plan.steps[0]);
 assert.equal(c.waitParallelWave(key),null);
 const first=c.tryParallel(key,a),second=c.tryParallel(key,record(1));let done=false;
 const waiting=c.waitParallelWave(key).then(()=>{done=true;});assert.equal(c.tails.size,0);assert.equal(c.plans.size,0);
 const later=c.tryParallel(key,record(2));assert.ok(later);first.release();await tick();assert.equal(done,false);
 second.release();await waiting;assert.equal(done,true);assert.equal(c.parallel.get(key).size,1);
 const serial=c.enter(key);assert.equal(c.waitParallelWave(key),null);assert.equal(c.tryParallel(key,record(3)),null);
 later.release();(await serial).release();assert.equal(c.parallel.size,0);assert.equal(c.tails.size,0);
});
test('stalled parallel wave times out without releasing owners or admitting an unverified original',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const c=new SellCoordinator({idleTimeoutMs:100}),a=record(0),key=sellLane(a.plan,a.plan.steps[0]);
 const owner=c.tryParallel(key,a),waiting=assert.rejects(c.waitParallelWave(key),e=>e.code==='SELL_POOL_BUSY');
 t.mock.timers.tick(101);await waiting;assert.equal(c.parallel.get(key).size,1);assert.equal(c.tails.size,0);owner.release();
 assert.equal(c.tryParallel(key,record(1),[{...a,status:'RECEIPT_REVIEW'}]),null);assert.equal(c.parallel.size,0);
});
test('known-hash parallel wave follows originals concurrently and shares existing followers',async()=>{
 const engine=Object.create(Engine.prototype),gate=deferred(),seen=[];engine.following=new Map();
 const orders=new Map([1,2,3].map(n=>[String(n),{id:String(n),status:'PENDING',plan:{kind:'contract'},steps:[{status:'PENDING',step:{kind:'sell'},txHash:'0x'+String(n).repeat(64)}]}]));
 engine.get=id=>orders.get(id);engine.followOriginal=async(id,options)=>{seen.push(id);assert.ok(options.receiptTimeoutMs<=8000);if(id==='1')await gate.promise;const o=orders.get(id);o.status=o.steps[0].status='CONFIRMED';return o;};
 const records=[...orders.values()],first=engine.pendingParallelWave(records),second=engine.pendingParallelWave(records);await tick();
 assert.deepEqual(seen.sort(),['1','2','3']);assert.equal(orders.get('2').status,'CONFIRMED');assert.equal(orders.get('3').status,'CONFIRMED');
 gate.resolve();await Promise.all([first,second]);assert.equal(engine.following.size,0);
 const unknown=orders.get('1');unknown.status=unknown.steps[0].status='SUBMISSION_UNKNOWN';delete unknown.steps[0].txHash;
 assert.equal(engine.pendingParallelWave(records),null);assert.equal(seen.length,3);
});
test('unconfirmed parallel originals retain their hash and end the unsigned wait at the original time budget',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1000});const engine=Object.create(Engine.prototype),o={id:'pending',status:'PENDING',plan:{kind:'contract'},steps:[{status:'PENDING',step:{kind:'sell'},txHash:'0x'+'1'.repeat(64)}]};let follows=0;
 engine.get=()=>o;engine.follow=async()=>{follows++;t.mock.timers.setTime(9001);return o;};
 await assert.rejects(engine.pendingParallelWave([o]),e=>e.code==='SELL_POOL_BUSY');assert.equal(follows,1);assert.equal(o.status,'PENDING');assert.equal(o.steps[0].txHash,'0x'+'1'.repeat(64));
});
test('adaptive preparation expands only after proof and fresh reserves, while larger inputs and reserve drops shrink it',async()=>{
 const c=new SellCoordinator(),p=record(0,{ri:256000n*unit,amount:1000n*unit}),key=sellLane(p.plan,p.plan.steps[0]);
 const owners=await Promise.all(Array.from({length:8},()=>c.prepareParallel(key,p.plan))),queue=Array.from({length:92},()=>c.prepareParallel(key,p.plan));
 const group=c.preparations.get(key);assert.equal(group.active,8);assert.equal(group.limit,8);
 const bad=structuredClone(p);bad.plan.poolFees.block=999;assert.equal(c.tryParallel(key,bad),null);assert.equal(group.active,8);
 const first=c.tryParallel(key,p);assert.ok(first);assert.equal(group.limit,64);assert.equal(group.active,64);assert.equal(group.queue.length,36);first.release();
 const older=record(1,{ri:1000000n*unit,amount:1000n*unit});older.plan.opening.block=older.plan.poolFees.block=99;
 const old=c.tryParallel(key,older);assert.ok(old);old.release();assert.equal(group.reserveIn,256000n*unit);
 const smaller=record(1,{ri:64000n*unit,amount:1000n*unit}),next=c.tryParallel(key,smaller);assert.ok(next);next.release();assert.equal(group.limit,16);assert.equal(group.active,64);
 const big=c.prepareParallel(key,{amountIn:String(10000n*unit)});assert.equal(group.limit,8);assert.equal(group.active,64);
 // No cancellation of admitted owners, no handing out fresh slots above the
 // shrunken bound, and no reordering of the original FIFO queue.
 owners.forEach(o=>o.release());assert.equal(group.active,56);assert.equal(group.queue.length,37);
 for(const promise of queue)(await promise).release();(await big).release();assert.equal(c.preparations.size,0);assert.equal(c.parallel.size,0);
});
test('bad scheduling block metadata cannot leak a proven parallel reservation',async()=>{
 const c=new SellCoordinator(),p=record(0),key=sellLane(p.plan,p.plan.steps[0]),slot=await c.prepareParallel(key,p.plan);
 const admitted=c.tryParallel(key,p);assert.ok(admitted);const group=c.preparations.get(key),before={reserveIn:group.reserveIn,limit:group.limit};
 const invalid=structuredClone(p);delete invalid.plan.opening.block;assert.doesNotThrow(()=>c.observePreparation(key,invalid));
 assert.deepEqual({reserveIn:group.reserveIn,limit:group.limit},before);admitted.release();slot.release();assert.equal(c.parallel.size,0);assert.equal(c.preparations.size,0);
});
test('adaptive preparation uses the sold-token reserve and expires old scheduling snapshots',async t=>{
 t.mock.timers.enable({apis:['Date'],now:100000});
 const c=new SellCoordinator(),p=record(0,{ri:256000n*unit,amount:1000n*unit}),key=sellLane(p.plan,p.plan.steps[0]);
 const pool=p.plan.opening;[pool.token0,pool.token1]=[pool.token1,pool.token0];[pool.reserve0,pool.reserve1]=[pool.reserve1,pool.reserve0];
 const owner=await c.prepareParallel(key,p.plan),admitted=c.tryParallel(key,p);assert.ok(admitted);assert.equal(c.preparations.get(key).limit,64);admitted.release();
 t.mock.timers.setTime(115001);const next=await c.prepareParallel(key,p.plan);assert.equal(c.preparations.get(key).limit,8);
 next.release();owner.release();assert.equal(c.preparations.size,0);
});

test('preparation expansion respects the smallest actual slippage across queued wallets',async()=>{
 const c=new SellCoordinator(),p=record(0,{ri:64000n*unit,amount:1000n*unit}),key=sellLane(p.plan,p.plan.steps[0]);p.plan.slippage={mode:'fixed',bps:9900,capBps:9900};
 const owner=await c.prepareParallel(key,p.plan),admitted=c.tryParallel(key,p);assert.ok(admitted);assert.equal(c.preparations.get(key).limit,32);
 const narrow=await c.prepareParallel(key,{...p.plan,slippage:{mode:'auto',bps:9000,capBps:9900}});assert.equal(c.preparations.get(key).limit,16);
 const later=await c.prepareParallel(key,p.plan);assert.equal(c.preparations.get(key).limit,16);
 admitted.release();owner.release();narrow.release();later.release();assert.equal(c.preparations.size,0);assert.equal(c.parallel.size,0);
});

async function engineFixture(t,{fastReturn=false,failAccount=0,approval=false,thin=false,latency=0,uncertain=false,serial=false,automaticReceipt=false,cancelAccount=0,waveBlocked=0}={}){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'parallel-sell-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 let ri=(thin?30000000n:35000000000n)*unit,ro=126n*unit,seq=0;
 const seen=[],requests=new Map(),gate=deferred();const wait=()=>latency?new Promise(r=>setTimeout(r,latency)):Promise.resolve();
 const fixture=n=>record(n,{ri,ro,bps:waveBlocked?5000:300});
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
 if(waveBlocked){
  const admit=e.sellCoordinator.tryParallel.bind(e.sellCoordinator);
  e.sellCoordinator.tryParallel=(key,r,originals)=>r.plan.account===waveBlocked?null:admit(key,r,originals);
  e.sellCoordinator.waitParallelWave=()=>Promise.resolve();
 }
 e.observeContract=async(o,entry,timeout)=>{
  if(entry.step.kind==='approve'){await wait();entry.status='CONFIRMED';return;}
  if(uncertain&&o.intent.account===ws[0].account){entry.status=o.status='SUBMISSION_UNKNOWN';return;}
  if(fastReturn&&timeout===0)return;
  if(automaticReceipt)await new Promise(r=>setTimeout(r,350));else await gate.promise;await wait();if(entry.status==='CONFIRMED')return;
  const f=V2_ROUTER_ABI.parseTransaction(entry.step),x=f.args[0]*9800n/10000n,y=output(x,ri,ro);
  assert.ok(y>=f.args[1],'every original minimum must still be met');ri+=x;ro-=y;entry.status='CONFIRMED';entry.confirmedAt=Date.now();
 };
 for(let n=0;n<3;n++)await e.prepare({side:'sell',account:ws[n].account,asset:token,percent:'100',currency:'WBNB',slippageBps:waveBlocked?5000:300},'parallel-'+n);
 const started=Date.now();const running=Promise.all([0,1,2].map(n=>e.execute('parallel-'+n,{authorization:'synthetic test only',swapReceiptWaitMs:fastReturn?0:10000,continueAllowed:()=>ws[n].account!==cancelAccount})));
 const expected=failAccount||cancelAccount||waveBlocked?2:3,until=Date.now()+3000;
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
test('repeated wave admission failure is bounded to one unsigned wallet, never a permanent serial tail',async t=>{
 const r=await engineFixture(t,{waveBlocked:ws[1].account});
 assert.equal(r.beforeReceipt,2);assert.equal(r.results[1].error.code,'SELL_POOL_BUSY');
 assert.equal(r.results[1].steps.length,0);assert.equal(r.results[1].timing.executionSteps.filter(s=>s.parallelWaveRetry).length,12);
 assert.ok(r.results.every(o=>o.timing.executionSteps.every(s=>!s.parallelFallback)));
 assert.ok([r.results[0],r.results[2]].every(o=>o.status==='CONFIRMED'));
 assert.equal(r.e.sellCoordinator.tails.size,0);assert.equal(r.e.sellCoordinator.parallel.size,0);assert.equal(r.e.running.size,0);
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
 const legacy=await engineFixture(t,{serial:true,latency:70,automaticReceipt:true});
 const concurrent=await engineFixture(t,{latency:70,automaticReceipt:true});
 assert.ok(legacy.results.every(o=>o.status==='CONFIRMED'));assert.ok(concurrent.results.every(o=>o.status==='CONFIRMED'));
 assert.ok(concurrent.totalMs<legacy.totalMs,JSON.stringify({legacy:legacy.totalMs,concurrent:concurrent.totalMs}));
 t.diagnostic(JSON.stringify({syntheticOnly:true,threeWallets:{serial:{allSentMs:legacy.dispatchMs,allConfirmedMs:legacy.totalMs},concurrent:{allSentMs:concurrent.dispatchMs,allConfirmedMs:concurrent.totalMs}}}));
});
