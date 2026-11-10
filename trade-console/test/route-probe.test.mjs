import test from 'node:test';import assert from 'node:assert/strict';
import {probeRegistrations,detectRoute,tradePlan} from '../lib/routes.mjs';
import * as flap from '../support/curve-trader/adapters/flap.mjs';import * as gang from '../support/curve-trader/adapters/gang.mjs';
import {ZeroAddress,Interface} from 'ethers';
import {ERC20,bindings} from '../lib/common.mjs';
import {Engine} from '../lib/engine.mjs';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const token='0x'+'a'.repeat(40),wallet='0x'+'b'.repeat(40);
const zero=p=>p.baseType==='tuple'?p.components.map(zero):p.type==='address'?ZeroAddress:p.type==='bool'?false:p.type==='bytes32'?'0x'+'0'.repeat(64):0n;
function mock({flapStatus=0,gangCreator=ZeroAddress,fail,malformed=false}={}){const calls=[];return {calls,call:async tx=>{
 calls.push(tx);assert.equal(tx.from,undefined);const isFlap=tx.to===flap.portal,p=gang.PADS.find(p=>p.address===tx.to);const abi=isFlap?flap.portalAbi:p.kind==='soft'?gang.SOFT_ABI:p.id==='s'?gang.S_ABI:gang.V2_ABI,method=isFlap?'getTokenV8Safe':'curves';
 assert.equal(abi.parseTransaction(tx).name,method);if(fail===tx.to)throw Error('RPC timeout');const values=abi.getFunction(method).outputs.map(zero);if(isFlap)values[0][0]=flapStatus;else values[0]=gangCreator;
 return abi.encodeFunctionResult(method,values)+(malformed?'00':'');
 }};}
test('explicit registry absence skips unrelated fee, quota, supply and allowance reads',async()=>{
 const rpc=mock();assert.equal((await detectRoute(rpc,token,wallet)).route,'aggregate');assert.equal(rpc.calls.length,1+gang.PADS.length);
});
test('positive registration, RPC failure and malformed responses are not absence',async()=>{
 assert.deepEqual(await probeRegistrations(mock({flapStatus:2,gangCreator:wallet}),token),{flap:true,gang:true});
 assert.deepEqual(await probeRegistrations(mock({fail:flap.portal}),token),{flap:null,gang:false});
 assert.deepEqual(await probeRegistrations(mock({fail:gang.PADS[0].address}),token),{flap:false,gang:null});
 assert.deepEqual(await probeRegistrations(mock({malformed:true}),token),{flap:null,gang:null});
});
test('absence is re-read on the next plan, never cached across registration changes',async()=>{
 const rpc=mock();await detectRoute(rpc,token,wallet);await detectRoute(rpc,token,wallet);assert.equal(rpc.calls.length,2*(1+gang.PADS.length));
});
test('only exact official TokenNotFound for the queried token proves absence',async()=>{
 const errors=new Interface(['error TokenNotFound(address)','error FeatureDisabled()']);
 for(const [data,expected]of [[errors.encodeErrorResult('TokenNotFound',[token]),false],[errors.encodeErrorResult('TokenNotFound',[wallet]),null],[errors.encodeErrorResult('TokenNotFound',[token])+'00',null],[errors.encodeErrorResult('FeatureDisabled',[]),null]]){
  const rpc=mock(),call=rpc.call;rpc.call=tx=>tx.to===flap.portal?Promise.reject(Object.assign(Error('execution reverted'),{data,code:3})):call(tx);
  assert.equal((await probeRegistrations(rpc,token)).flap,expected);
 }
});
test('warm sell overlaps readonly quote with FRESH registration reads and recomputes remaining percentage',async()=>{
 const rpc=mock(),registryCall=rpc.call;let held=1000n,delay=false,release,quoteStarted=false,reads=0;const amounts=[];
 rpc.call=async tx=>{if(tx.to===token){const f=ERC20.parseTransaction(tx);return ERC20.encodeFunctionResult(f.fragment,[f.name==='decimals'?18n:held]);}reads++;if(delay)await new Promise(r=>{const prior=release;release=()=>{prior?.();r();};});return registryCall(tx);};
 const bridge={call:async(a,args)=>{assert.deepEqual(args.slice(0,2),['market-order','quote']);amounts.push(args[args.indexOf('--fromTokenQty')+1]);quoteStarted=true;return {toCoinAmount:'0.001'};}};
 const i={account:bindings()[0].account,side:'sell',percent:'50',currency:'BNB',slippageMode:'fixed',slippageBps:100};
 const first=await tradePlan(rpc,bridge,i,token);assert.equal(first.amountIn,'500');assert.equal(reads,6);
 held=500n;delay=true;quoteStarted=false;const next=tradePlan(rpc,bridge,i,token);await new Promise(r=>setImmediate(r));assert.equal(quoteStarted,true);assert.equal(reads,12);release();const second=await next;assert.equal(second.amountIn,'250');assert.notEqual(amounts[0],amounts[1]);
 held=0n;await assert.rejects(tradePlan(rpc,bridge,i,token),e=>e.code==='NO_HOLDINGS');assert.equal(amounts.length,2);
});
test('first sell overlaps a quote without waiting for registry; failed registry cannot trigger a write',async()=>{
 const rpc=mock(),registryCall=rpc.call;let release,quoteStarted=false;rpc.call=async tx=>{
  if(tx.to===token){const f=ERC20.parseTransaction(tx);return ERC20.encodeFunctionResult(f.fragment,[f.name==='decimals'?18n:1000n]);}
  await new Promise(r=>{const old=release;release=()=>{old?.();r();};});return registryCall(tx);
 };
 const bridge={call:async(a,args)=>{assert.deepEqual(args.slice(0,2),['market-order','quote']);quoteStarted=true;return {toCoinAmount:'1'};}};
 const p=tradePlan(rpc,bridge,{account:bindings()[0].account,side:'sell',percent:'50',currency:'BNB',slippageMode:'fixed',slippageBps:100},token);
 await new Promise(r=>setImmediate(r));assert.equal(quoteStarted,true);release();assert.equal((await p).amountIn,'500');
});
test('buy quote starts before token balance completes, but failed balance cannot produce a plan',async()=>{
 for(const failure of [false,true]){
  const rpc=mock(),registryCall=rpc.call;let release,quoted=0;
  rpc.call=async tx=>{if(tx.to!==token)return registryCall(tx);await new Promise(r=>{const old=release;release=()=>{old?.();r();};});if(failure)throw Error('balance read failed');const f=ERC20.parseTransaction(tx);return ERC20.encodeFunctionResult(f.fragment,[f.name==='decimals'?18n:0n]);};
  const bridge={call:async(a,args)=>{assert.deepEqual(args.slice(0,2),['market-order','quote']);assert.equal(args[args.indexOf('--fromTokenQty')+1],'0.01');quoted++;return {toCoinAmount:'10'};}};
  const task=tradePlan(rpc,bridge,{account:bindings()[0].account,side:'buy',amount:'0.01',currency:'BNB',slippageMode:'fixed',slippageBps:100},token);
  await new Promise(r=>setImmediate(r));assert.equal(quoted,1);release();if(failure)await assert.rejects(task,/balance read failed/);else{const plan=await task;assert.equal(plan.holdingBefore,'0');assert.equal(plan.amountIn,'10000000000000000');}assert.equal(quoted,1);
 }
});
test('cold trade preflight overlaps public reads but failed wallet or chain guards prevent official quote and plan',async()=>{
 for(const failing of [null,'wallet','chain']){
  const rpc=mock(),registryCall=rpc.call,dir=fs.mkdtempSync(path.join(os.tmpdir(),'overlap-guard-'));let release,publicReads=0,quotes=0,guardDone=false;
  const gate=new Promise(r=>release=r);rpc.verifyChain=async()=>{await gate;if(failing==='chain')throw Error('wrong chain');};rpc.call=async tx=>{publicReads++;if(tx.to.toLowerCase()!==token.toLowerCase())return registryCall(tx);const f=ERC20.parseTransaction(tx);return ERC20.encodeFunctionResult(f.fragment,[f.name==='decimals'?18n:1000n]);};
  const bridge={ready:async()=>{await gate;if(failing==='wallet')throw Error('not connected');guardDone=true;},call:async(a,args)=>{assert.equal(guardDone,true);assert.equal(args[1],'quote');quotes++;return {toCoinAmount:'1',slippage:'0.01'};}};
  try{const e=new Engine({rpc,bridge,data:dir,live:false});e.openingScan=async()=>{await gate;return {pools:[]};};e.openingPreparation={token:async()=>({decimals:18})};const p=e.prepare({account:bindings()[0].account,side:'sell',asset:token,percent:50,currency:'BNB',slippageMode:'auto'},'cold');await new Promise(r=>setImmediate(r));assert.ok(publicReads>=2);assert.equal(quotes,0);release();const result=await p;assert.equal(result.status,'BLOCKED');if(!failing)assert.equal(result.error.code,'OPENING_WAIT');assert.equal(quotes,failing?0:1);}finally{fs.rmSync(dir,{recursive:true,force:true});}
 }
});
