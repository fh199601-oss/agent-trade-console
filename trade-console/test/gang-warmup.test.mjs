import test from 'node:test';import assert from 'node:assert/strict';import {GangWarmup} from '../lib/gang-warmup.mjs';import {TradeConversions} from '../lib/trade-conversion.mjs';import {BNB,WBNB,USDT,ERC20,bindings,same} from '../lib/common.mjs';import {DEXES,V2_ROUTER_ABI} from '../lib/opening-dex.mjs';import {MULTI,MULTICALL} from '../lib/opening-read.mjs';import {POOL} from '../lib/opening-pools.mjs';
const token='0x'+'c1'.repeat(20),quote='0x'+'c2'.repeat(20),pair='0x'+'c3'.repeat(20),owner=bindings()[0].address;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('Gang preload is bounded, no wallet calls, paused by foreground and reusable after failures',async()=>{let now=1,busy=false,probes=0;const gate=deferred(),calls=[];const client={probe:async()=>{probes++;await gate.promise;return {quoteToken:quote,pad:token};},meta:async t=>calls.push(['meta',t]),identity:async()=>calls.push(['identity'])};const converter={warm:async(a,b)=>calls.push(['route',a,b])};const w=new GangWarmup({client,converter,busy:()=>busy,now:()=>now});const p=w.request(token);assert.equal(w.request(quote),null);busy=true;gate.resolve();await p;assert.equal(calls.length,0);busy=false;now+=15001;await w.request(token);assert.deepEqual(calls.filter(x=>x[0]==='route'),[['route',BNB,quote],['route',USDT,quote]]);assert.equal(probes,2);w.close();assert.equal(w.request(quote),null);});
test('conversion topology avoids factory rescans; reserves, quote and allowance remain fresh; TTL expires',async()=>{
 const dex=DEXES.find(d=>d.kind==='v2');let now=1,scans=0,quotes=0,allowances=0,reserve=2000000000000000000000000n,allowance=0n;
 const amount=1000000000000000000000n,out=()=>amount*9975n*reserve/(1000000000000000000000000n*10000n+amount*9975n);
 const pool={kind:'v2',factory:dex.factory,pool:pair,token:WBNB,quote,token0:WBNB,token1:quote,verifiedBlock:100,block:100,liquid:true,reserve0:'1000000000000000000000000',reserve1:String(reserve)};
 const rpc={getBlockNumber:async()=>100,call:async tx=>{
  if(same(tx.to,MULTICALL)){const calls=MULTI.parseTransaction(tx).args[1];return MULTI.encodeFunctionResult('tryBlockAndAggregate',[100,'0x'+'00'.repeat(32),calls.map(()=>[true,POOL.encodeFunctionResult('getReserves',[1000000000000000000000000n,reserve,1])])]);}
  if(same(tx.to,dex.router)){quotes++;return V2_ROUTER_ABI.encodeFunctionResult('getAmountsOut',[[amount,out()]]);}
  allowances++;return ERC20.encodeFunctionResult('allowance',[allowance]);
 }};
 const c=new TradeConversions(rpc,{now:()=>now,pools:{inspectQuotes:async(input,_,outputs)=>{scans++;return {block:100,errors:[],pools:same(input,WBNB)&&same(outputs[0],quote)?[{...pool,reserve1:String(reserve)}]:[]};}},prep:{venue:async()=>({assets:[]}),quote:async()=>({decimals:18})},identityFor:async()=>({})});
 await c.warm(WBNB,quote);const warmed=scans;const args={inputToken:WBNB,outputToken:quote,amount,owner,slippageBps:100};const first=await c.plan(args);assert.equal(scans,warmed);assert.equal(first.steps.length,2);
 reserve=1000000000000000000000000n;allowance=amount;const second=await c.plan(args);assert.equal(scans,warmed);assert.equal(second.steps.length,1);assert.ok(BigInt(second.minOutput)<BigInt(first.minOutput));assert.equal(quotes,2);assert.equal(allowances,2);
 const saved=JSON.stringify([...c.topologies.values()],(_,v)=>v instanceof Map?[...v]:v);assert.doesNotMatch(saved,/reserve0|reserve1|allowance|amountOut/);
 now+=30001;await c.plan(args);assert.ok(scans>warmed);
});
test('failed warmup does not cache failures or strand the background worker',async()=>{const w=new GangWarmup({client:{probe:async()=>{throw Error('fixture unavailable');}},converter:{}});await w.request(token);assert.equal(w.pending,null);assert.equal(await w.request(quote),null);});
