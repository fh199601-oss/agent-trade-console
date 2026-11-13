import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {reusableQueuedSell} from '../lib/queued-sell-preview.mjs';
import {Engine} from '../lib/engine.mjs';
import {bindings,ERC20,WBNB,same,formatUnits} from '../lib/common.mjs';
import {DEXES,V2_ROUTER_ABI} from '../lib/opening-dex.mjs';
import {POOL} from '../lib/opening-pools.mjs';
import {MULTI,MULTICALL} from '../lib/opening-read.mjs';
import {poolFeeProof} from '../lib/trade-fees.mjs';
const token='0x'+'a2'.repeat(20),pair='0x'+'a3'.repeat(20),d=DEXES.find(d=>d.id==='pancake-v2'),w=bindings()[0];
function fixture(){
 const plan={account:w.account,wallet:w.address,token,inputToken:token,outputToken:WBNB,amountIn:'500',holdingBefore:'1000',outputDecimals:0,kind:'contract',route:'pancake-v2-opening',requireSellCredit:true,
  identity:{fingerprint:'fixture'},slippage:{bps:2000},opening:{...d,pool:pair,quote:WBNB},poolFees:{poolFeePpm:2500,pools:[{address:pair,feePpm:2500}]},
  quote:{toCoinAmount:'1000'},minOutput:'800',steps:[{kind:'sell',to:d.router,value:'0',data:'0x1234'}]};
 const preview={at:1000,raw:{requestId:'only-this-request',risks:[{title:'retain-risk'}]},review:{balanceChanges:[{owner:w.address,contractAddress:WBNB,change:'1000'}]}};
 return {plan,preview};
}
test('queued preview retains exact request, calldata and original stricter minimum after a small price drop',()=>{
 const warm=fixture(),fresh=structuredClone(warm.plan);fresh.quote.toCoinAmount='950';fresh.minOutput='760';
 const result=reusableQueuedSell(fresh,warm,2000);assert.ok(result);assert.equal(result.plan.minOutput,'800');assert.equal(result.plan.steps[0].data,'0x1234');assert.equal(result.preview,warm.preview);assert.equal(result.plan.quote.toCoinAmount,'1000');assert.equal(result.plan.latestQuote.toCoinAmount,'950');
 assert.equal(reusableQueuedSell(fresh,warm,11001),null);assert.equal(reusableQueuedSell(fresh,warm,999),null);
});
test('large movement, higher current minimum, unknown/high/increased fees, or changed trade identity discard the preview',()=>{
 const changes=[p=>p.quote.toCoinAmount='899',p=>p.minOutput='801',p=>p.poolFees.poolFeePpm=null,p=>p.poolFees.poolFeePpm=850150,p=>p.poolFees.poolFeePpm=2600,
  p=>p.account=99,p=>p.wallet=token,p=>p.token=pair,p=>p.amountIn='501',p=>p.holdingBefore='1001',p=>p.outputToken=token,p=>p.slippage.bps=5000,
  p=>p.identity.fingerprint='changed',p=>p.opening.pool=token,p=>p.steps[0].to=token,p=>p.steps[0].value='1',p=>p.opening.kind='infinity-cl',p=>p.stagedTrade=true,p=>p.audit={available:true,taxes:{sellTax:'30'}}];
 for(const change of changes){const warm=fixture(),fresh=structuredClone(warm.plan);change(fresh);assert.equal(reusableQueuedSell(fresh,warm,2000),null,String(change));}
 const warm=fixture();warm.preview.review.balanceChanges[0].change='100';assert.equal(reusableQueuedSell(warm.plan,warm,2000),null);
 assert.equal(reusableQueuedSell(fixture().plan,null),null);
});

const tick=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function queuedFixture(t,{failedWarm=false,changedHolding=false,unknown=false,stalledWarm=false,callFailed=false,fastReturn=false,callDelayed=false,callStalled=false,cancelSecond=false,reserveUnits=1000,slippageBps=2000,projection=true,externalDrop=false,latency=0}={}){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'queued-sell-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 const wallets=bindings().slice(0,4),unit=10n**18n,amount=5n*unit;
 let ri=BigInt(reserveUnits)*unit,ro=1000n*unit,seq=0,confirmed=0;const ids=new Map(),seen=[],first=deferred(),release=deferred();
 const wait=()=>latency?new Promise(r=>setTimeout(r,latency)):Promise.resolve();
 const output=(x=amount)=>x*9975n*ro/(ri*10000n+x*9975n);
 const state=()=>({...d,pool:pair,token,token0:token,token1:WBNB,quote:WBNB,reserve0:String(ri),reserve1:String(ro),block:100});
 const plan=intent=>{const wallet=wallets.find(w=>w.account===intent.account),pool=state(),quote=output(),min=quote*BigInt(10000-slippageBps)/10000n;
  return {kind:'contract',route:d.id+'-opening',account:wallet.account,wallet:wallet.address,token,inputToken:token,outputToken:WBNB,amountIn:String(amount),holdingBefore:String(amount),decimals:18,outputDecimals:18,minOutput:String(min),quote:{toCoinAmount:formatUnits(quote,18)},opening:pool,state:pool,poolFees:poolFeeProof(pool,[amount,quote],token,100),requireSellCredit:true,slippage:{mode:'fixed',bps:slippageBps,capBps:slippageBps},review:[],steps:[{kind:'sell',to:d.router,value:'0',data:V2_ROUTER_ABI.encodeFunctionData('swapExactTokensForTokensSupportingFeeOnTransferTokens',[amount,min,[token,WBNB],wallet.address,Math.floor(Date.now()/1000)+120])}]};};
 const rpc={getBlockNumber:async()=>100,call:async tx=>{
  await wait();
  if(same(tx.to,d.router)&&V2_ROUTER_ABI.parseTransaction(tx).name.startsWith('swap')){if(callStalled)return new Promise(()=>{});if(callDelayed)await new Promise(r=>setTimeout(r,25));}
  const encode=tx=>{const abi=same(tx.to,token)?ERC20:same(tx.to,pair)?POOL:V2_ROUTER_ABI,f=abi.parseTransaction(tx);
   if(f.name.startsWith('swap')){assert.ok(wallets.some(w=>same(w.address,tx.from)));assert.equal(tx.value,'0x0');seen.push({kind:'latestCall'});if(callFailed||f.args[1]>output())throw Error('latest call reverted');return '0x';}
   return abi.encodeFunctionResult(f.name,f.name==='balanceOf'?[changedHolding&&confirmed&&same(f.args[0],wallets[1].address)?amount-1n:amount]:f.name==='getReserves'?[ri,ro,1]:[[f.args[0],output(f.args[0])]]);};
  if(same(tx.to,MULTICALL)){const f=MULTI.parseTransaction(tx);return MULTI.encodeFunctionResult(f.name,[100,'0x'+'0'.repeat(64),f.args[1].map(c=>[true,encode({to:c.target,data:c.callData})])]);}return encode(tx);
 }};
 const bridge={ready:async()=>{},call:async(account,args,options={})=>{
  if(args[1]==='preview'){
   const transaction=V2_ROUTER_ABI.parseTransaction({data:args[args.indexOf('--inputData')+1]}),id='synthetic-'+(++seq),raw={requestId:id,simulationResult:{simulationCode:'000000000',balanceChanges:[{owner:wallets.find(w=>w.account===account).address,contractAddress:WBNB,change:String(output())}]}};
   seen.push({kind:'preview',account,background:!!options.background,confirmed});await wait();
   if(failedWarm&&options.background)throw Error('optional read timeout');
   ids.set(id,{account,transaction,uses:0});return raw;
  }
  const request=ids.get(args.at(-1));assert.equal(request.account,account);assert.equal(request.uses++,0,'never reuse a request for signing');assert.ok(request.transaction.args[1]<=output(),'original minimum still achievable');
  seen.push({kind:'execute',account});await wait();return {txHash:'0x'+String(seq+account).padStart(64,'0')};
 }};
 const e=new Engine({rpc,bridge,data,live:true,planFn:async i=>plan(i)});
 if(stalledWarm)e.queuedSellPreview=()=>new Promise(()=>{});
 if(!projection){const prepare=e.queuedSellPreview.bind(e);e.queuedSellPreview=(...args)=>prepare(...args.slice(0,3));}
 e.observeContract=async(o,entry,timeout)=>{if(fastReturn&&timeout===0)return;if(!confirmed){first.resolve();await release.promise;}if(unknown){entry.status=o.status='SUBMISSION_UNKNOWN';return;}await wait();const out=output();ri+=amount;ro-=out;confirmed++;if(externalDrop&&confirmed===1)ro=ro*80n/100n;entry.status='CONFIRMED';};
 // Prevent the unknown-original test from waiting for the real 8s follower.
 if(unknown)e.follow=async id=>{const o=e.get(id);o.steps.at(-1).txHash=null;return o;};
 const intents=wallets.map(w=>({side:'sell',account:w.account,asset:token,percent:'100',currency:'WBNB',slippageBps}));
 for(let n=0;n<intents.length;n++)await e.prepare(intents[n],'queued-'+n);
 seen.length=0;
 let cancelled=false;const initial=[];
 if(fastReturn){initial.push(await e.execute('queued-0',{authorization:'synthetic-only fixture',swapReceiptWaitMs:0}));assert.equal(initial[0].status,'PENDING');assert.equal(e.sellCoordinator.tails.size,0);}
 const running=Promise.all(intents.map((_,n)=>n===0&&fastReturn?initial[0]:e.execute('queued-'+n,{authorization:'synthetic-only fixture',continueAllowed:()=>!(cancelSecond&&n===1&&cancelled)})));
 await first.promise;
 for(let n=0;n<100&&!seen.filter(s=>s.background).length;n++)await tick();
 for(let n=0;n<20;n++)await tick();
 if(latency)await new Promise(r=>setTimeout(r,latency*3));
 assert.equal(seen.filter(s=>s.background&&s.confirmed===0).length,stalledWarm?0:3,'three wallets prepare while the first is settling');
 cancelled=cancelSecond;const started=Date.now();release.resolve();const results=(await running).map(o=>e.get(o.id));
 return {e,results,seen,settlementMs:Date.now()-started};
}
test('four wallets pipeline previews while queued, keep same-pool settlement ordering, and execute exactly once',async t=>{
 const {e,results,seen}=await queuedFixture(t);assert.ok(results.every(o=>o.status==='CONFIRMED'),JSON.stringify(results.map(o=>o.error)));
 assert.equal(seen.filter(s=>s.kind==='execute').length,4);assert.equal(results.filter(o=>o.timing.executionSteps.some(s=>s.queuedPreviewReused)).length,3);
 assert.equal(seen.filter(s=>s.kind==='latestCall').length,3,'reuse still checks exact calldata with its own sender against latest state');
 assert.equal(seen.filter(s=>s.kind==='preview'&&!s.background).length,0,'first wallet reuses current preparation, queued wallets reuse pipelined previews');
 await e.execute('queued-1',{authorization:'duplicate fixture'});assert.equal(seen.filter(s=>s.kind==='execute').length,4);
});
test('failed optional previews fall back to normal official simulation, not a failed order',async t=>{
 const {results,seen}=await queuedFixture(t,{failedWarm:true});assert.ok(results.every(o=>o.status==='CONFIRMED'));
 assert.equal(seen.filter(s=>s.kind==='preview'&&!s.background).length,3);assert.equal(seen.filter(s=>s.kind==='execute').length,4);
});
test('a changed holding is blocked without affecting the other wallets',async t=>{
 const {results,seen}=await queuedFixture(t,{changedHolding:true});assert.equal(results[1].status,'BLOCKED');assert.equal(seen.filter(s=>s.kind==='execute'&&s.account===bindings()[1].account).length,0);
 assert.ok(results.filter((_,n)=>n!==1).every(o=>o.status==='CONFIRMED'));
});
test('an uncertain original cannot be bypassed by a prepared queued preview',async t=>{
 const {results,seen}=await queuedFixture(t,{unknown:true});assert.equal(seen.filter(s=>s.kind==='execute').length,1);assert.ok(results.slice(1).every(o=>o.error?.code==='SELL_POOL_BUSY'));
});
test('an unfinished optional preparation never delays the next wallet when its turn arrives',async t=>{
 const {results,seen}=await queuedFixture(t,{stalledWarm:true});assert.ok(results.every(o=>o.status==='CONFIRMED'));assert.equal(seen.filter(s=>s.kind==='execute').length,4);
});
test('a failed latest exact-call check discards the queued preview and requires a fresh official one',async t=>{
 const {results,seen}=await queuedFixture(t,{callFailed:true});assert.ok(results.every(o=>o.status==='CONFIRMED'));assert.equal(seen.filter(s=>s.kind==='preview'&&!s.background).length,3);assert.ok(results.every(o=>!o.timing.executionSteps.some(s=>s.queuedPreviewReused)));
});
test('fast-return original receipt wait also warms the next wallet when the lane has already released',async t=>{
 const {results,seen}=await queuedFixture(t,{fastReturn:true});assert.ok(results.every(o=>o.status==='CONFIRMED'),JSON.stringify(results.map(o=>o.error)));
 assert.equal(seen.filter(s=>s.kind==='execute').length,4);assert.equal(results.filter(o=>o.timing.executionSteps.some(s=>s.queuedPreviewReused)).length,3);
});
test('a latest call slightly slower than the router quote reuses its exact official preview',async t=>{
 const {results,seen}=await queuedFixture(t,{callDelayed:true});assert.ok(results.every(o=>o.status==='CONFIRMED'));
 assert.equal(results.filter(o=>o.timing.executionSteps.some(s=>s.queuedPreviewReused)).length,3);assert.equal(seen.filter(s=>s.kind==='preview'&&!s.background).length,0);
});
test('stalled exact-call RPC has a bounded wait, then uses normal official simulation', {timeout:5000},async t=>{
 const {results,seen}=await queuedFixture(t,{callStalled:true});assert.ok(results.every(o=>o.status==='CONFIRMED'));
 assert.equal(seen.filter(s=>s.kind==='preview'&&!s.background).length,3);assert.equal(seen.filter(s=>s.kind==='execute').length,4);
});
test('cancelling a warmed queued wallet cannot submit it or prevent the other wallets selling',async t=>{
 const {results,seen}=await queuedFixture(t,{cancelSecond:true});assert.equal(results[1].status,'CANCELLED');
 assert.equal(seen.filter(s=>s.kind==='execute').length,3);assert.ok(results.filter((_,n)=>n!==1).every(o=>o.status==='CONFIRMED'));
});
test('four high-impact V2 sells with 3% slippage prepare post-predecessor previews, retaining fresh minimums',async t=>{
 const {results,seen}=await queuedFixture(t,{reserveUnits:60,slippageBps:300});
 assert.ok(results.every(o=>o.status==='CONFIRMED'),JSON.stringify(results.map(o=>o.error)));
 assert.equal(results.filter(o=>o.timing.executionSteps.some(s=>s.queuedProjectionReused)).length,3);
 assert.equal(seen.filter(s=>s.kind==='preview'&&!s.background).length,0);
 for(const o of results){assert.equal(o.plan.slippage.bps,300);assert.equal(o.steps.length,1);}
});
test('unpredicted external price fall discards forecast and refreshes normally without widening slippage',async t=>{
 const {results,seen}=await queuedFixture(t,{reserveUnits:60,slippageBps:300,externalDrop:true});
 assert.ok(results.every(o=>o.status==='CONFIRMED'),JSON.stringify(results.map(o=>o.error)));
 assert.equal(seen.filter(s=>s.kind==='preview'&&!s.background).length,3);
 assert.ok(results.every(o=>!o.timing.executionSteps.some(s=>s.queuedProjectionReused)));
 assert.ok(results.every(o=>o.plan.slippage.bps===300));assert.equal(seen.filter(s=>s.kind==='execute').length,4);
});
test('simulated latency comparison covers four-wallet settlement, not only preparation',async t=>{
 const legacy=await queuedFixture(t,{reserveUnits:60,slippageBps:300,latency:50,projection:false});
 const improved=await queuedFixture(t,{reserveUnits:60,slippageBps:300,latency:50});
 for(const r of [legacy,improved])assert.ok(r.results.every(o=>o.status==='CONFIRMED'));
 assert.equal(legacy.seen.filter(s=>s.kind==='preview'&&!s.background).length,3);
 assert.equal(improved.seen.filter(s=>s.kind==='preview'&&!s.background).length,0);
 t.diagnostic(JSON.stringify({syntheticOnly:true,fromFirstReceiptToAllSettledMs:{legacy:legacy.settlementMs,improved:improved.settlementMs}}));
});
