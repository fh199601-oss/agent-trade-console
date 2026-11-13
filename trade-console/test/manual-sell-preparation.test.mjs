import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ManualSellPreparation} from '../lib/manual-sell-preparation.mjs';
import {Engine} from '../lib/engine.mjs';
import {bindings,ERC20,Interface,WBNB,ZeroAddress,same,formatUnits,validateIntent} from '../lib/common.mjs';
import {codeIdentity} from '../lib/discovery.mjs';
import {DEXES,V2_ROUTER_ABI} from '../lib/opening-dex.mjs';
import {POOL} from '../lib/opening-pools.mjs';
import {MULTICALL,MULTI} from '../lib/opening-read.mjs';
import {poolFeeProof} from '../lib/trade-fees.mjs';
import * as flap from '../support/curve-trader/adapters/flap.mjs';import * as gang from '../support/curve-trader/adapters/gang.mjs';
const token='0x'+'b2'.repeat(20),pair='0x'+'b3'.repeat(20),d=DEXES.find(d=>d.id==='pancake-v2'),wallets=bindings();
const tick=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const intent=(account=wallets[0].account)=>({account,side:'sell',asset:token,percent:'100',currency:'WBNB',slippageBps:2000,slippageMode:'fixed'});
const simple=()=>({manualRouteRecovery:true,kind:'contract',requireSellCredit:true,opening:{kind:'v2'},steps:[{kind:'approve'},{kind:'sell'}],audit:{available:true,taxes:{sellTax:'0'}},poolFees:{poolFeePpm:2500}});
test('read-only preparations are memory-only, single-use, exact-intent bound and expire',async()=>{
 let now=100,plans=0,previews=0;const cache=new ManualSellPreparation({now:()=>now,plan:async()=>{plans++;return simple();},preview:async()=>{previews++;return {review:{},raw:{requestId:'synthetic'}};}});
 const i=intent();await cache.request(i);assert.equal(plans,1);assert.equal(previews,1);assert.ok(cache.take(validateIntent(i)));assert.equal(cache.take(validateIntent(i)),null);
 now+=4001;await cache.request(i);assert.equal(cache.take(validateIntent({...i,percent:'50'})),null);
 now+=4001;await cache.request(i);now+=6000;assert.equal(cache.take(validateIntent(i)),null);
 now+=4001;await cache.request(i);now-=1;assert.equal(cache.take(validateIntent(i)),null);
});
test('four independent wallets warm concurrently; failed, busy, unsupported and high-fee plans never become usable',async()=>{
 const gate=deferred(),seen=[],cache=new ManualSellPreparation({plan:async i=>{seen.push(i.account);await gate.promise;if(i.account===wallets[1].account)throw Error('offline');return i.account===wallets[2].account?{...simple(),poolFees:{poolFeePpm:850150}}:simple();},preview:async()=>({review:{}})});
 const tasks=wallets.slice(0,4).map(w=>cache.request(intent(w.account)));assert.equal(cache.request(intent(wallets[4].account)),null);assert.equal(cache.request(intent()),null);
 await tick();assert.equal(seen.length,4);gate.resolve();await Promise.all(tasks);
 assert.ok(cache.take(validateIntent(intent())));assert.equal(cache.take(validateIntent(intent(wallets[1].account))),null);assert.equal(cache.take(validateIntent(intent(wallets[2].account))),null);assert.ok(cache.take(validateIntent(intent(wallets[3].account))));
 const blocked=new ManualSellPreparation({busy:()=>true,plan:()=>assert.fail(),preview:()=>assert.fail()});assert.equal(blocked.request(intent()),null);
});
test('foreground never waits for unfinished warming and its late completion cannot repopulate cache',async()=>{
 const gate=deferred();let previews=0;const cache=new ManualSellPreparation({plan:async()=>{await gate.promise;return simple();},preview:async()=>{previews++;return {review:{}};}});
 const work=cache.request(intent());await tick();assert.equal(cache.take(validateIntent(intent())),null);gate.resolve();await work;assert.equal(previews,0);assert.equal(cache.entries.size,0);
});
test('refresh leaves an unexpired matching preparation available; close and changed options invalidate it',async()=>{
 let now=0,wait=false;const gate=deferred(),cache=new ManualSellPreparation({now:()=>now,plan:async()=>{if(wait)await gate.promise;return simple();},preview:async()=>({review:{}})});
 await cache.request(intent());now=4001;wait=true;const refreshing=cache.request(intent());assert.ok(cache.take(validateIntent(intent())));gate.resolve();await refreshing;assert.equal(cache.entries.size,0);
 cache.close();assert.equal(cache.request(intent()),null);
 for(const bad of [{...intent(),execute:true},{...intent(),openingOnly:true},{...intent(),side:'buy'},{...intent(),asset:'https://example.org'},{...intent(),asset:ZeroAddress}])assert.throws(()=>cache.request(bad));
});

const zero=p=>p.baseType==='tuple'?p.components.map(zero):p.type==='address'?ZeroAddress:p.type==='bool'?false:p.type==='bytes32'?'0x'+'0'.repeat(64):0n;
async function engineFixture(t){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'manual-preparation-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 const unit=10n**18n,amount=10n*unit,holds=new Map(wallets.map(w=>[w.address.toLowerCase(),amount])),allowances=new Map(),seen=[],requests=new Map();let plans=0,seq=0,height=100,ri=10000n*unit,ro=20000n*unit,changedCode=false,curve=false;
 const output=x=>x*9975n*ro/(ri*10000n+x*9975n),pool=()=>({...d,pool:pair,token0:token,token1:WBNB,quote:WBNB,reserve0:String(ri),reserve1:String(ro),block:height});
 const encode=tx=>{
  const abi=same(tx.to,token)?ERC20:same(tx.to,pair)?POOL:same(tx.to,d.router)?V2_ROUTER_ABI:null;
  if(abi){const f=abi.parseTransaction(tx);return abi.encodeFunctionResult(f.name,f.name==='balanceOf'?[holds.get(f.args[0].toLowerCase())||0n]:f.name==='allowance'?[allowances.get(f.args[0].toLowerCase())||0n]:f.name==='decimals'?[18]:f.name==='getReserves'?[ri,ro,1]:[[f.args[0],output(f.args[0])]]);}
  const isFlap=same(tx.to,flap.portal),pad=gang.PADS.find(p=>same(p.address,tx.to)),reg=isFlap?flap.portalAbi:pad?(pad.kind==='soft'?gang.SOFT_ABI:pad.id==='s'?gang.S_ABI:gang.V2_ABI):null;
  if(!reg)throw Error('unregistered synthetic target');const f=reg.parseTransaction(tx),v=f.fragment.outputs.map(zero);if(isFlap&&curve)v[0][0]=1;
  return reg.encodeFunctionResult(f.name,v);
 };
 const rpc={verifyChain:async()=>{},getCode:async a=>same(a,token)&&changedCode?'0x6001':'0x6000',getBlockNumber:async()=>height,send:async()=> '0x'+'0'.repeat(64),call:async tx=>{
  if(same(tx.to,MULTICALL)){const f=MULTI.parseTransaction(tx);return MULTI.encodeFunctionResult(f.name,[height,'0x'+'0'.repeat(64),f.args[1].map(c=>{try{return [true,encode({to:c.target,data:c.callData})];}catch{return [false,'0x'];}})]);}return encode(tx);
 }};
 const identity=await codeIdentity(rpc,token);
 const plan=i=>{plans++;const w=wallets.find(w=>w.account===i.account),balance=holds.get(w.address.toLowerCase()),input=balance*BigInt(i.percent)/100n,p=pool(),out=output(input),min=out*80n/100n,steps=[];
  if((allowances.get(w.address.toLowerCase())||0n)<input)steps.push({kind:'approve',to:token,value:'0',data:ERC20.encodeFunctionData('approve',[d.router,input]),spender:d.router,allowance:String(input)});
  steps.push({kind:'sell',to:d.router,value:'0',data:V2_ROUTER_ABI.encodeFunctionData('swapExactTokensForTokensSupportingFeeOnTransferTokens',[input,min,[token,WBNB],w.address,Math.floor(Date.now()/1000)+120])});
  return {manualRouteRecovery:true,kind:'contract',route:d.id+'-opening',account:i.account,token,wallet:w.address,inputToken:token,outputToken:WBNB,amountIn:String(input),holdingBefore:String(balance),decimals:18,outputDecimals:18,minOutput:String(min),identity,opening:p,state:p,poolFees:poolFeeProof(p,[input,out],token,height),requireSellCredit:true,slippage:{mode:'fixed',bps:2000,capBps:2000},quote:{toCoinAmount:formatUnits(out,18)},review:[],audit:{available:true,checkedAt:Date.now(),taxes:{sellTax:'0'}},steps};
 };
 const bridge={ready:async()=>{},call:async(account,args,options={})=>{
  seen.push({account,operation:args.slice(0,2).join(' '),background:!!options.background});
  if(args[1]==='preview'){
   const to=args[args.indexOf('--to')+1],data=args[args.indexOf('--inputData')+1],w=wallets.find(w=>w.account===account),approve=same(to,token),decoded=(approve?ERC20:V2_ROUTER_ABI).parseTransaction({data});
   const raw={requestId:'fake-'+(++seq),parsedTx:{contractAddress:to},simulationResult:{simulationCode:'000000000',...(approve?{allowanceChanges:[{owner:w.address,tokenAddress:token,spender:d.router,postAmount:String(decoded.args[1])}]}:{balanceChanges:[{owner:w.address,contractAddress:WBNB,change:String(output(decoded.args[0]))}]})}};
   requests.set(raw.requestId,{to,data,account,approve,used:false});return raw;
  }
  assert.equal(args[1],'execute');assert.equal(options.background,undefined);const r=requests.get(args.at(-1));assert.equal(r.account,account);assert.equal(r.used,false);r.used=true;return {txHash:'0x'+String(seq+account).padStart(64,'0')};
 }};
 const e=new Engine({rpc,bridge,data,live:true,planFn:async i=>plan(i),auditFn:async()=>({available:true,taxes:{sellTax:'0'}})});
 e.observeContract=async(o,entry)=>{if(entry.step.kind==='approve')allowances.set(o.plan.wallet.toLowerCase(),BigInt(entry.step.allowance));else{const tx=V2_ROUTER_ABI.parseTransaction(entry.step),amount=tx.args[0],out=output(amount);assert.ok(tx.args[1]<=out);ri+=amount;ro-=out;holds.set(o.plan.wallet.toLowerCase(),BigInt(o.plan.holdingBefore)-amount);}entry.status='CONFIRMED';};
 return {e,rpc,seen,requests,holds,allowances,amount,plan,plans:()=>plans,setCode:()=>changedCode=true,setPrice:()=>ro=ro*9n/10n};
}
test('four warmed wallets reprice independently at click, reuse only exact approval previews, then execute once each',async t=>{
 const f=await engineFixture(t),ints=wallets.slice(0,4).map(w=>intent(w.account));await Promise.all(ints.map(i=>f.e.manualSellPreparation.request(i)));
 assert.equal(f.e.list().length,0);assert.equal(f.seen.filter(x=>/execute|swap/.test(x.operation)).length,0);
 f.setPrice();const orders=await Promise.all(ints.map((i,n)=>f.e.prepare(i,'prewarm-'+n)));
 assert.ok(orders.every(o=>o.status==='PREPARED'),JSON.stringify(orders.map(o=>o.error)));
 assert.ok(orders.every(o=>o.timing.sellPreparationReused));assert.equal(f.plans(),4);
 assert.equal(f.seen.filter(x=>x.operation==='contract-call preview').length,4,'approval previews are exact, not re-created at click');
 const results=await Promise.all(orders.map(o=>f.e.execute(o.id,{authorization:'synthetic fixture only'})));
 assert.ok(results.every(o=>o.status==='CONFIRMED'),JSON.stringify(results.map(o=>o.error)));
 assert.equal(f.seen.filter(x=>x.operation==='contract-call execute').length,8,'each wallet approves once and sells once');
 assert.ok(results.every(o=>BigInt(o.plan.amountIn)===f.amount));
});
test('changed holding discards preparation and recomputes percentage from the remaining balance',async t=>{
 const f=await engineFixture(t),i={...intent(),percent:'50'};await f.e.manualSellPreparation.request(i);f.holds.set(wallets[0].address.toLowerCase(),f.amount/2n);
 const o=await f.e.prepare(i,'remaining');assert.equal(o.status,'PREPARED');assert.equal(o.plan.amountIn,String(f.amount/4n));assert.equal(o.timing.sellPreparationReused,undefined);assert.equal(f.plans(),2);
});
test('allowance already sufficient drops warmed approval and obtains a proper sale preview',async t=>{
 const f=await engineFixture(t);await f.e.manualSellPreparation.request(intent());f.allowances.set(wallets[0].address.toLowerCase(),f.amount);
 const o=await f.e.prepare(intent(),'approved');assert.equal(o.status,'PREPARED');assert.deepEqual(o.plan.steps.map(s=>s.kind),['sell']);assert.equal(f.seen.length,2);
});
test('lost allowance or changed code cannot reuse a warmed transaction',async t=>{
 const f=await engineFixture(t);f.allowances.set(wallets[0].address.toLowerCase(),f.amount);await f.e.manualSellPreparation.request(intent());f.allowances.clear();
 const o=await f.e.prepare(intent(),'allowance-lost');assert.equal(o.plan.steps[0].kind,'approve');assert.equal(o.timing.sellPreparationReused,undefined);
 await f.e.manualSellPreparation.request(intent(wallets[1].account));f.setCode();const p=await f.e.prepare(intent(wallets[1].account),'code-change');assert.equal(p.timing.sellPreparationReused,undefined);
});
test('normal preparation starts immediately when optional warming is stalled',async t=>{
 const f=await engineFixture(t),original=f.e.manualSellPreparation.plan,gate=deferred();f.e.manualSellPreparation.plan=async(...args)=>{await gate.promise;return original(...args);};
 const work=f.e.manualSellPreparation.request(intent());const o=await f.e.prepare(intent(),'not-waiting');assert.equal(o.status,'PREPARED');gate.resolve();await work;assert.equal(f.e.manualSellPreparation.entries.size,0);
});
test('approval allowance prefetch is consumed only at/after the exact receipt block; stale, insufficient or stuck reads fall back',async t=>{
 for(const mode of ['fresh','stale','insufficient','stalled']){
  const f=await engineFixture(t),i=intent(),plan=f.plan(i),step=plan.steps[0],hash='0x'+'b4'.repeat(32);let direct=0;
  const original=f.rpc.call;f.rpc.call=async tx=>{if(same(tx.to,MULTICALL)){if(mode==='stalled')return new Promise(()=>{});return MULTI.encodeFunctionResult('tryBlockAndAggregate',[mode==='stale'?99:100,'0x'+'0'.repeat(64),[[true,ERC20.encodeFunctionResult('allowance',[mode==='insufficient'?0n:f.amount])]]]);}
   if(same(tx.to,token)&&ERC20.parseTransaction(tx).name==='allowance'){direct++;return ERC20.encodeFunctionResult('allowance',[f.amount]);}return original(tx);
  };
  f.rpc.getTransaction=async()=>({hash,from:plan.wallet,to:step.to,input:step.data,value:'0x0'});
  f.rpc.getTransactionReceipt=async()=>{await tick();return {status:'0x1',transactionHash:hash,blockNumber:'0x64',from:plan.wallet,to:step.to};};
  f.e.primeOpeningRefresh=()=>{};const entry={txHash:hash,plan,step,status:'PENDING'},o={id:'allowance-'+mode,intent:i,plan,steps:[entry],status:'PENDING',timing:{},createdAt:Date.now()};
  await Engine.prototype.observeContract.call(f.e,o,entry,0);assert.equal(entry.status,'CONFIRMED');assert.equal(direct,mode==='fresh'?0:1);assert.equal(!!o.timing.approvalAllowanceOverlapped,mode==='fresh');
 }
});
