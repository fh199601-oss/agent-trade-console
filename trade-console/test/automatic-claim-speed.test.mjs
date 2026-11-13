import {virtualLatency} from './support/virtual-latency.mjs';
// Isolated in-memory wallet and RPC. No real accounts, network or signatures.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Engine} from '../lib/engine.mjs';import {codeIdentity} from '../lib/discovery.mjs';import {bindings,BNB} from '../lib/common.mjs';import {CORLA_MINT} from '../lib/corla.mjs';
const token='0x'+'32'.repeat(20),mint='0x'+'31'.repeat(20),wallets=bindings().slice(0,4),wait=ms=>new Promise(r=>setTimeout(r,ms)),tick=()=>new Promise(r=>setImmediate(r));
async function fixture(t){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'automatic-claim-speed-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 let code='0x6000',seq=0;const calls={identities:0,previews:0,submits:0},requests=new Set();
 const rpc={getCode:async()=>{calls.identities++;return code;},send:async()=> '0x'+'00'.repeat(32)},identity=await codeIdentity(rpc,mint);calls.identities=0;
 const bridge={ready:async()=>{},call:async(account,args)=>{
  if(args[1]==='preview'){calls.previews++;const requestId='synthetic-'+(++seq);requests.add(requestId);return {requestId,simulationResult:{simulationCode:'000000000',balanceChanges:[{owner:wallets.find(w=>w.account===account).address,contractAddress:token,tokenType:'Erc20',change:'100'}]}};}
  assert.equal(args[1],'execute');assert.ok(requests.delete(args.at(-1)));calls.submits++;return {txHash:'0x'+String(++seq).padStart(64,'0')};
 }};
 const engine=new Engine({data,rpc,bridge,live:true,planFn:async i=>({kind:'contract',route:'corla:claim',wallet:wallets.find(w=>w.account===i.account).address,token,inputToken:BNB,outputToken:token,amountIn:'0',minOutput:'100',quantity:1,identity,requireAssetCredit:true,expectedAsset:{token,kind:'Erc20',amount:'100'},review:[],steps:[{kind:'mint',to:mint,data:CORLA_MINT.encodeFunctionData('claim'),value:'0'}]})});
 engine.observeContract=async(o,e)=>{e.status='CONFIRMED';e.received='100';};
 const run=async(n,{overlap=true,allowed=()=>true}={})=>{const w=wallets[n],id='claim-'+n;await engine.prepare({account:w.account,side:'mint',asset:mint,routeId:'corla:claim',quantity:1,scope:'free',maxBnb:'0',maxUsdt:'0',referral:'none'},id,{instantExecution:overlap});return engine.execute(id,{authorization:'synthetic test only',acknowledgeReview:true,rejectRisks:true,swapReceiptWaitMs:0,continueAllowed:allowed});};
 return {engine,rpc,bridge,calls,run,change:()=>code='0x6001'};
}
test('four auto claims overlap identity with official preview and dispatch once per independent wallet',async t=>{
 const f=await fixture(t);let release;const gate=new Promise(r=>release=r),code=f.rpc.getCode,call=f.bridge.call;
 f.rpc.getCode=async(...a)=>{const value=await code(...a);await gate;return value;};f.bridge.call=async(...a)=>{const value=await call(...a);if(a[1][1]==='preview')await gate;return value;};
 const work=wallets.map((_,n)=>f.run(n));await tick();assert.equal(f.calls.identities,4);assert.equal(f.calls.previews,4);assert.equal(f.calls.submits,0);release();
 const results=await Promise.all(work);assert.ok(results.every(o=>o.status==='CONFIRMED'),JSON.stringify(results.map(o=>o.error)));assert.equal(f.calls.identities,4);assert.equal(f.calls.submits,4);assert.ok(results.every(o=>o.timing.executionSteps[0].guardsOverlapped));
 await f.engine.execute(results[0].id,{authorization:'duplicate'});assert.equal(f.calls.submits,4);
});
test('claim pause, changed code and stale guard do not bypass final checks',async t=>{
 for(const scenario of ['pause','changed','stale']){
  const f=await fixture(t);let now=100;f.engine.instantGuards.now=()=>now;const call=f.bridge.call;
  if(scenario==='changed')f.change();if(scenario==='stale')f.bridge.call=async(...a)=>{const v=await call(...a);if(a[1][1]==='preview')now+=1001;return v;};
  const o=await f.run(0,{allowed:()=>scenario!=='pause'});
  if(scenario==='stale'){assert.equal(o.status,'CONFIRMED');assert.ok(f.calls.identities>=2);assert.equal(o.timing.executionSteps[0].guardsOverlapped,undefined);}
  else{assert.equal(f.calls.submits,0);assert.ok(['CANCELLED','BLOCKED'].includes(o.status));}
 }
});
test('same simulated latency: three auto-claim dispatches save sequential identity wait without shorter deadlines',async t=>{
 const advance=virtualLatency(t);
 const results=[];
 for(const overlap of [false,true]){
  const f=await fixture(t),code=f.rpc.getCode,call=f.bridge.call;
  f.rpc.getCode=async(...a)=>{await wait(160);return code(...a);};f.bridge.call=async(...a)=>{await wait(a[1][1]==='preview'?260:80);return call(...a);};
  const start=Date.now(),orders=await advance(Promise.all([0,1,2].map(n=>f.run(n,{overlap}))));
  assert.ok(orders.every(o=>o.status==='CONFIRMED'),JSON.stringify(orders.map(o=>o.error)));assert.equal(f.calls.submits,3);
  const times=orders.map(o=>o.steps[0].submitStartedAt-start);results.push({overlap,allDispatchMs:Math.max(...times),spreadMs:Math.max(...times)-Math.min(...times),completionMs:Date.now()-start});
 }
 assert.ok(results[1].allDispatchMs+80<results[0].allDispatchMs,JSON.stringify(results));t.diagnostic('virtual-clock simulation only: '+JSON.stringify(results));
});
