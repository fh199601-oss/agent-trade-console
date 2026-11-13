import {virtualLatency} from './support/virtual-latency.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {TradePreparation,exactPreparedPreview,checkPreparedCall} from '../lib/trade-preparation.mjs';
import {previewUsable} from '../lib/preview-cache.mjs';
import {OpeningPreparation} from '../lib/opening-preparation.mjs';
import {OpeningSell} from '../lib/opening-sell.mjs';
import {DEXES} from '../lib/opening-dex.mjs';
import {MULTI,MULTICALL} from '../lib/opening-read.mjs';
import {Engine,verifyPreview} from '../lib/engine.mjs';
import {bindings,ERC20,Interface,BNB,USDT,ZeroAddress,same,validateIntent} from '../lib/common.mjs';
import {GANG_ENTRY,GANG_ABI} from '../lib/gang-modern.mjs';
import * as flap from '../support/curve-trader/adapters/flap.mjs';import * as gang from '../support/curve-trader/adapters/gang.mjs';
import {createSellPreparationWarmup} from '../public/trade-warmup.mjs';
const wallets=bindings(),w=wallets[0],token='0x'+'43'.repeat(20),router='0x'+'44'.repeat(20);
const abi=new Interface(['function buy(uint256 minimum) payable','function sell(uint256 amount,uint256 minimum)','function wrap() payable']);
const intent=(side='buy',account=w.account)=>({account,side,asset:token,...(side==='buy'?{amount:'0.02'}:{percent:'50'}),currency:'BNB',slippageBps:1000});
const audit={available:true,level:1,taxes:{sellTax:'0'},items:[]};
const plan=(i=intent())=>({kind:'contract',route:'flap',account:i.account,wallet:wallets.find(w=>w.account===i.account).address,token,inputToken:i.side==='buy'?BNB:token,outputToken:i.side==='buy'?token:BNB,amountIn:i.side==='buy'?'20000000000000000':'50',holdingBefore:'100',minOutput:'90',decimals:18,outputDecimals:18,slippage:{mode:'fixed',bps:1000,capBps:1000},audit,state:{feeBps:100,sellFeeBps:100,sellTaxBps:0},review:[],steps:[{kind:i.side,to:router,value:i.side==='buy'?'20000000000000000':'0',data:abi.encodeFunctionData(i.side,i.side==='buy'?[90]:[50,90])}]});
const preview=p=>({at:Date.now(),raw:{requestId:'synthetic-preview',expiresAt:Date.now()+20000,parsedTx:{contractAddress:p.steps[0].to},simulationResult:{simulationCode:'000000000',balanceChanges:[{owner:p.wallet,contractAddress:p.outputToken,change:'100'}]}},review:{}});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('trade warm handles both directions, consumes each wallet once and never publishes an order',async()=>{
 const calls=[];const cache=new TradePreparation({plan:async i=>plan(i),preview:async p=>{calls.push(p.steps[0].kind);return preview(p);}});
 await cache.request(intent());await cache.request(intent('sell'));
 assert.deepEqual(calls,['buy','sell']);assert.equal(cache.entries.size,2);
 assert.ok(cache.take(validateIntent({...intent(),slippageMode:'fixed'})),'implicit and explicit fixed slippage match');
 assert.equal(cache.entries.size,0,'any click invalidates other prepared direction');
 assert.equal(cache.take(validateIntent(intent())),null);
 for(const change of [{execute:true},{side:'mint'},{openingOnly:true},{gasLimit:'100000'},{asset:'https://example.test'},{side:'buy',amount:0}])assert.throws(()=>cache.request({...intent(),...change}));
});
test('official expiry, including malformed or near-expiring handles, overrides local cache lifetime',()=>{
 const p=preview(plan()),now=Date.now();p.at=now;
 assert.equal(previewUsable(p,now),true);
 for(const expiry of [now-1,now+1499,'invalid',Infinity,0])assert.equal(previewUsable({...p,raw:{...p.raw,expiresAt:expiry}},now),false);
 assert.equal(previewUsable({...p,at:now+1},now),false);
 assert.equal(previewUsable({...p,at:now-15001},now),false);
});
test('fresh planning must match exact wallet, amount, target, calldata, identity and minimum',()=>{
 const p=plan(),warm={plan:p,preview:preview(p)};
 assert.ok(exactPreparedPreview(p,warm));
 for(const change of [p=>p.wallet=wallets[1].address,p=>p.holdingBefore='99',p=>p.amountIn='1',p=>p.minOutput='91',p=>p.route='gang-modern',p=>p.inputToken=token,p=>p.steps[0].to=token,p=>p.steps[0].data='0x12345678',p=>p.identity={fingerprint:'new-code'},p=>p.protocolIdentities=[{fingerprint:'new-router'}]]){
  const fresh=structuredClone(p);change(fresh);assert.equal(exactPreparedPreview(fresh,warm),null);
 }
 const stale={...warm,preview:{...warm.preview,at:Date.now()-6001}};assert.equal(exactPreparedPreview(p,stale),null);
});
test('exact call guard preserves sender and value; failed/stuck RPC drops cache within deadline',async()=>{
 const p=plan();let called;
 assert.equal(await checkPreparedCall({call:async(tx,block)=>{called={tx,block};}},p),true);
 assert.equal(called.tx.from,w.address);assert.equal(BigInt(called.tx.value),BigInt(p.steps[0].value));assert.equal(called.block,'latest');
 assert.equal(await checkPreparedCall({call:async()=>{throw Error('revert');}},p),false);
 const start=Date.now();assert.equal(await checkPreparedCall({call:()=>new Promise(()=>{})},p,20),false);assert.ok(Date.now()-start<250);
});
async function fixture(t,{side='buy',conversion=false,approve=false}={}){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'trade-prepare-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 let changed=false,callFails=false,seq=0;const seen=[],requests=new Map();
 const make=i=>{
  const p=plan(i);if(changed){p.minOutput='80';p.steps[0].data=abi.encodeFunctionData(i.side,i.side==='buy'?[80]:[50,80]);}
  if(conversion){p.route='gang-modern';p.stagedTrade=true;p.requireTradeCredit=true;p.steps.unshift({kind:'conversion',to:router,value:p.amountIn,data:abi.encodeFunctionData('wrap'),tradeLeg:{inputToken:BNB,outputToken:token,amountIn:p.amountIn,minOutput:'90',settlementRoute:'trade-conversion'}});}
  if(approve)p.steps.unshift({kind:'approve',to:token,value:'0',data:ERC20.encodeFunctionData('approve',[router,100]),spender:router,allowance:'100'});
  return p;
 };
 const bridge={ready:async()=>{},call:async(account,args,options)=>{
  seen.push({op:args[1],background:!!options?.background});assert.equal(args[0],'contract-call');
  if(args[1]==='execute'){const old=requests.get(args.at(-1));assert.ok(old);assert.equal(old.used,false);old.used=true;return {txHash:'0x'+String(++seq).padStart(64,'0')};}
  assert.equal(args[1],'preview');const to=args[args.indexOf('--to')+1],p=make({...intent(side),account}),raw=preview(p).raw;
  raw.requestId='fake-'+(++seq);raw.parsedTx.contractAddress=to;if(approve)raw.simulationResult={simulationCode:'000000000',allowanceChanges:[{owner:p.wallet,tokenAddress:token,spender:router,postAmount:'100'}]};
  requests.set(raw.requestId,{used:false});return raw;
 }};
 const rpc={verifyChain:async()=>{},call:async tx=>{if(tx.from){if(callFails)throw Error('phase closed');return '0x';}return ERC20.encodeFunctionResult('balanceOf',[100]);}};
 const engine=new Engine({data,rpc,bridge,planFn:async i=>make(i),live:true});
 // Synthetic receipt settlement only; never touches a real wallet/network.
 engine.observeContract=async(o,entry)=>entry.status='CONFIRMED';
 return {engine,seen,rpc,bridge,change:()=>changed=true,failCall:()=>callFails=true};
}
test('instant four-wallet sale starts fresh guards beside preview and submits once without serial waiting',async t=>{
 const f=await fixture(t,{side:'sell'});let release;const gate=new Promise(r=>release=r);let guarded=0,previews=0;
 const call=f.rpc.call;f.rpc.call=async tx=>{guarded++;await gate;return call(tx);};
 const walletCall=f.bridge.call;f.bridge.call=async(a,args,options)=>{if(args[1]==='preview'){previews++;await gate;}return walletCall(a,args,options);};
 const runs=wallets.slice(0,4).map((w,n)=>f.engine.run(intent('sell',w.account),'instant-'+n,{execute:true,authorization:'synthetic test'}));
 await new Promise(r=>setImmediate(r));assert.equal(guarded,4);assert.equal(previews,4);assert.equal(f.seen.length,0);release();
 const orders=await Promise.all(runs);assert.ok(orders.every(o=>o.status==='CONFIRMED'),JSON.stringify(orders.map(o=>o.error)));
 assert.equal(guarded,4,'no second balance request after the official preview');assert.ok(orders.every(o=>o.timing.executionSteps[0].guardsOverlapped));assert.equal(f.seen.filter(x=>x.op==='execute').length,4);
});
test('overlapped guard failure prevents submission; an expired overlap repeats fresh checks',async t=>{
 for(const scenario of ['balance','rpc','expired']){
  const f=await fixture(t,{side:'sell'});let now=100,reads=0;f.engine.instantGuards.now=()=>now;
  f.rpc.call=async()=>{reads++;if(scenario==='rpc')throw Error('synthetic RPC failure');return ERC20.encodeFunctionResult('balanceOf',[scenario==='balance'?99:100]);};
  const old=f.bridge.call;f.bridge.call=async(...args)=>{const r=await old(...args);if(scenario==='expired')now+=1001;return r;};
  const o=await f.engine.run(intent('sell'),'guard-'+scenario,{execute:true,authorization:'synthetic test'});
  if(scenario==='expired'){assert.equal(o.status,'CONFIRMED');assert.equal(reads,2);assert.equal(o.timing.executionSteps[0].guardsOverlapped,undefined);}
  else{assert.notEqual(o.status,'CONFIRMED');assert.equal(f.seen.filter(x=>x.op==='execute').length,0);}
 }
});
test('exact approval preview survives later quote changes, but not approval, sender or amount changes',()=>{
 const p=plan();p.steps.unshift({kind:'approve',to:token,value:'0',data:ERC20.encodeFunctionData('approve',[router,50]),spender:router,allowance:'50'});
 const warm={plan:p,preview:preview(p)},fresh=structuredClone(p);fresh.minOutput='80';fresh.steps[1].data=abi.encodeFunctionData('buy',[80]);
 assert.ok(exactPreparedPreview(fresh,warm));
 for(const change of [q=>q.steps[0].allowance='51',q=>q.wallet=wallets[1].address,q=>q.amountIn='100',q=>q.steps[0].spender=token]){const q=structuredClone(fresh);change(q);assert.equal(exactPreparedPreview(q,warm),null);}
});
test('preview completing after click but during fresh planning is consumed without another wallet request',async t=>{
 const f=await fixture(t,{approve:true});let release;const gate=new Promise(r=>release=r),old=f.bridge.call;
 f.bridge.call=async(...args)=>{await gate;return old(...args);};
 const pending=f.engine.manualSellPreparation.request(intent());await new Promise(r=>setImmediate(r));
 const make=f.engine.planFn;f.engine.planFn=async i=>{release();await pending;return make(i);};
 const o=await f.engine.prepare(intent(),'late-preview');assert.equal(o.status,'PREPARED');assert.equal(o.timing.tradePreviewReused,true);assert.equal(f.seen.filter(x=>x.op==='preview').length,1);
 assert.equal(f.engine.manualSellPreparation.entries.size,0);assert.equal(f.seen.filter(x=>x.op==='execute').length,0);
});
test('three-wallet timing comparison includes preparation and keeps normal RPC deadlines',async t=>{
 const advance=virtualLatency(t);
 const results=[];
 for(const overlap of [false,true]){
  const f=await fixture(t,{side:'sell'}),rpcCall=f.rpc.call,bridgeCall=f.bridge.call;
  f.rpc.call=async(...args)=>{await wait(160);return rpcCall(...args);};
  f.bridge.call=async(a,args,options)=>{await wait(args[1]==='preview'?260:80);return bridgeCall(a,args,options);};
  const start=Date.now(),orders=await advance(Promise.all(wallets.slice(0,3).map(async(w,n)=>{
   const i=intent('sell',w.account),id='comparison-'+n,options={execute:true,authorization:'synthetic latency test'};
   if(overlap)return f.engine.run(i,id,options);
   await f.engine.prepare(i,id);return f.engine.execute(id,options);
  })));
  assert.ok(orders.every(o=>o.status==='CONFIRMED'),JSON.stringify(orders.map(o=>o.error)));
  const dispatch=orders.map(o=>o.steps[0].submitStartedAt-start);
  results.push({overlap,allSubmittedMs:Math.max(...dispatch),dispatchSpreadMs:Math.max(...dispatch)-Math.min(...dispatch),completedMs:Date.now()-start});
 }
 assert.ok(results[1].allSubmittedMs+80<results[0].allSubmittedMs,JSON.stringify(results));
 t.diagnostic('virtual-clock simulation only: '+JSON.stringify(results));
});
test('four-wallet buy caches one unsigned preview each; click reuses then executes each exactly once',async t=>{
 const f=await fixture(t),ints=wallets.slice(0,4).map(w=>intent('buy',w.account));
 await Promise.all(ints.map(i=>f.engine.manualSellPreparation.request(i)));
 assert.equal(f.engine.list().length,0);assert.equal(f.seen.filter(x=>x.op==='execute').length,0);
 const orders=await Promise.all(ints.map((i,n)=>f.engine.prepare(i,'warm-buy-'+n)));
 assert.ok(orders.every(o=>o.status==='PREPARED'&&o.timing.tradePreviewReused),JSON.stringify(orders.map(o=>o.error)));
 const results=await Promise.all(orders.map(o=>f.engine.execute(o.id,{authorization:'synthetic test'})));
 assert.ok(results.every(o=>o.status==='CONFIRMED'));assert.equal(f.seen.filter(x=>x.op==='preview').length,4);assert.equal(f.seen.filter(x=>x.op==='execute').length,4);
 await Promise.all(orders.map(o=>f.engine.execute(o.id,{authorization:'same test'})));assert.equal(f.seen.filter(x=>x.op==='execute').length,4);
});
test('changed quote, reverted exact call and expired preview each use normal fresh official preview',async t=>{
 for(const mode of ['price','call','expiry']){
  const f=await fixture(t);await f.engine.manualSellPreparation.request(intent());
  if(mode==='price')f.change();if(mode==='call')f.failCall();if(mode==='expiry')f.engine.manualSellPreparation.entries.values().next().value.preview.raw.expiresAt=Date.now();
  const o=await f.engine.prepare(intent(),'fallback-'+mode);assert.equal(o.status,'PREPARED');assert.equal(f.seen.filter(x=>x.op==='preview').length,2);assert.equal(f.seen.filter(x=>x.op==='execute').length,0);
 }
});
test('Gang conversion first leg and exact approval can be prepared but never fund/approve before click',async t=>{
 for(const options of [{conversion:true},{approve:true}]){
  const f=await fixture(t,options);await f.engine.manualSellPreparation.request(intent());
  const o=await f.engine.prepare(intent(),'gang-'+Object.keys(options)[0]);assert.equal(o.status,'PREPARED',JSON.stringify(o.error));assert.equal(o.timing.tradePreviewReused,true);assert.equal(f.seen.length,1);assert.equal(f.seen[0].op,'preview');
 }
});
test('buy button warmup uses the same read-only endpoint and never invokes execute or run',async()=>{
 const calls=[];const warm=createSellPreparationWarmup({api:async(...a)=>calls.push(a),endpoint:'trade-prepare-warm',intents:()=>[intent()],delayMs:1});warm();await wait(20);
 assert.deepEqual(calls,[['trade-prepare-warm',{intents:[intent()]}]]);
});
test('opening allowance preparation batches venues per wallet, isolates failed wallet, keeps unknown allowances',async()=>{
 let batches=0,individual=0;
 const rpc={getBalance:async a=>{if(same(a,wallets[1].address))throw Error('RPC');return 1000n;},call:async tx=>{
  if(!same(tx.to,MULTICALL)){individual++;throw Error('not expected');}batches++;
  const f=MULTI.parseTransaction(tx);assert.equal(f.args[1].length,DEXES.length+1);
  return MULTI.encodeFunctionResult(f.name,[100,'0x'+'0'.repeat(64),f.args[1].map((r,n)=>n===2?[false,'0x']:[true,ERC20.encodeFunctionResult(n===0?'balanceOf':'allowance',[n===0?1000:0])])]);
 }};
 const p=new OpeningPreparation(rpc);p.token=async()=>({identity:{fingerprint:'synthetic'},decimals:18});p.venue=async()=>({});
 const result=await p.warm({asset:token,accounts:wallets.slice(0,4).map(w=>w.account),percent:'50'});
 assert.equal(batches,4);assert.equal(individual,0);assert.equal(result.rows.length,4);assert.equal(result.rows[1].unavailable,true);
 for(const n of [0,2,3]){assert.equal(result.rows[n].amount,'500');assert.equal(result.rows[n].routes[1].approvalNeeded,null);}
});
test('arming starts read-only approval preparation immediately and pause invalidates it',t=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'opening-arm-warm-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));let allowed,called=0;
 const engine={live:false,warmOpeningApprovals:async(c,p,s,a)=>{called++;allowed=a;}};
 const opening=new OpeningSell({engine,data,rpc:{},bridge:{},autoSchedule:false});t.after(()=>opening.close());
 const config={asset:token,accounts:[w.account],percent:'50',currency:'AUTO',slippageBps:5000};
 opening.checks.set('fake',{id:'fake',config,rows:[{account:w.account,address:w.address}],preflight:{rows:[]},snapshot:{open:false},checkedAt:Date.now(),mode:'SIMULATION'});
 opening.arm('fake',{confirmed:true});assert.equal(called,1);assert.equal(allowed(),true);opening.pause('fake');assert.equal(allowed(),false);
});
test('aggregate buy reuses only indicative quote; current payment balance, audit, registration and age gate the cache',async t=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'aggregate-prepare-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 const zero=p=>p.baseType==='tuple'?p.components.map(zero):p.type==='address'?ZeroAddress:p.type==='bool'?false:p.type==='bytes32'?'0x'+'0'.repeat(64):0n;
 let funds=1000000000000000000n,audits=0,quotes=0,registered=false,risk=false,ready=0;
 const rpc={verifyChain:async()=>{},getBalance:async()=>funds,call:async tx=>{
  if(same(tx.to,USDT))return ERC20.encodeFunctionResult('balanceOf',[funds]);
  if(same(tx.to,token)){const f=ERC20.parseTransaction(tx);return ERC20.encodeFunctionResult(f.name,[f.name==='decimals'?18:0]);}
  const pad=gang.PADS.find(p=>same(p.address,tx.to)),a=same(tx.to,GANG_ENTRY)?GANG_ABI:same(tx.to,flap.portal)?flap.portalAbi:pad?(pad.kind==='soft'?gang.SOFT_ABI:pad.id==='s'?gang.S_ABI:gang.V2_ABI):null;
  assert.ok(a);const f=a.parseTransaction(tx);if(registered&&same(tx.to,GANG_ENTRY))throw Object.assign(Error('registration changed'),{code:'GANG_IDENTITY_MISMATCH'});
  return a.encodeFunctionResult(f.name,f.fragment.outputs.map(zero));
 }};
 const bridge={ready:async()=>{ready++;},call:async(_,args)=>{assert.deepEqual(args.slice(0,2),['market-order','quote']);quotes++;return {toCoinAmount:'123'};}};
 const engine=new Engine({data,rpc,bridge,auditFn:async()=>{audits++;return risk?{available:true,level:5,items:[]}:audit;}});
 const intents=wallets.slice(0,4).map(w=>intent('buy',w.account));
 await Promise.all(intents.map(i=>engine.manualSellPreparation.request(i)));assert.equal(audits,1);assert.equal(quotes,4);
 const old=structuredClone(engine.manualSellPreparation.entries.get(w.account+':buy'));
 const orders=await Promise.all(intents.map((i,n)=>engine.prepare(i,'aggregate-hot-'+n)));
 assert.ok(orders.every(o=>o.status==='PREPARED'&&o.timing.tradePlanReused),JSON.stringify(orders.map(o=>o.error)));
 assert.equal(quotes,4,'click does not repeat cached indicative quote');assert.equal(ready,8);
 const attempt=()=>engine.consumeManualSellPreparation(validateIntent(intent()),old);
 funds=0n;assert.equal(await attempt(),null);funds=1000000000000000000n;
 registered=true;assert.equal(await attempt(),null);registered=false;
 risk=true;engine.buyAudits.clear();assert.equal(await attempt(),null);
 await assert.rejects(engine.plan(validateIntent(intent())),/风险 5 级/);
 risk=false;engine.buyAudits.clear();old.startedAt=Date.now()-3001;assert.equal(await attempt(),null);
 assert.equal(engine.list().length,4);assert.ok(engine.list().every(o=>o.steps.length===0));
});
