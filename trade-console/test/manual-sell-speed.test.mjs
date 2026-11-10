import test from 'node:test';import assert from 'node:assert/strict';
import {tradePlan} from '../lib/routes.mjs';
import {manualDirectSell} from '../lib/manual-sell-recovery.mjs';
import {ManualSellWarmup} from '../lib/manual-sell-warmup.mjs';
import {openingPlan} from '../lib/opening-route.mjs';
import {ERC20,bindings,BNB,WBNB,USDT,ZeroAddress,same} from '../lib/common.mjs';
import {DEXES,V2_ROUTER_ABI} from '../lib/opening-dex.mjs';
import * as flap from '../support/curve-trader/adapters/flap.mjs';import * as gang from '../support/curve-trader/adapters/gang.mjs';
const w=bindings()[0],token='0x'+'92'.repeat(20),d=DEXES[0];
const tick=()=>new Promise(r=>setImmediate(r));
const zero=p=>p.baseType==='tuple'?p.components.map(zero):p.type==='address'?ZeroAddress:p.type==='bool'?false:p.type==='bytes32'?'0x'+'0'.repeat(64):0n;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture({mode='auto',quoteCurrency=WBNB,holding=1000n}={}){
 const seen={balance:0,quote:0,scan:0,venue:0,meta:0,registry:0},gates={};
 const intent={account:w.account,side:'sell',asset:token,percent:'50',currency:'BNB',slippageMode:mode,slippageBps:2000};
 const rpc={call:async tx=>{
  if(same(tx.to,token)){const f=ERC20.parseTransaction(tx);if(f.name==='balanceOf')seen.balance++;return ERC20.encodeFunctionResult(f.name,[f.name==='decimals'?18n:f.name==='balanceOf'?holding:1000n]);}
  if(same(tx.to,d.router)){const f=V2_ROUTER_ABI.parseTransaction(tx);return V2_ROUTER_ABI.encodeFunctionResult(f.name,[[f.args[0],997n]]);}
  seen.registry++;await gates.registry?.promise;
  const isFlap=same(tx.to,flap.portal),pad=gang.PADS.find(p=>same(p.address,tx.to)),abi=isFlap?flap.portalAbi:pad.kind==='soft'?gang.SOFT_ABI:pad.id==='s'?gang.S_ABI:gang.V2_ABI;
  const method=isFlap?'getTokenV8Safe':'curves';return abi.encodeFunctionResult(method,abi.getFunction(method).outputs.map(zero));
 }};
 const bridge={call:async(a,args)=>{assert.deepEqual(args.slice(0,2),['market-order','quote']);seen.quote++;await gates.quote?.promise;return {toCoinAmount:'0.1',slippage:gates.slippage??'0.1'};}};
 const pool={...d,pool:'0x'+'93'.repeat(20),quote:quoteCurrency,token0:token,token1:quoteCurrency,liquid:true,block:100,reserve0:'1000000',reserve1:'2000000'};
 const preparation={token:async()=>{seen.meta++;await gates.meta?.promise;return {decimals:18,identity:{fingerprint:'mock'}};},venue:async()=>{seen.venue++;return {assets:[]};}};
 const scan=async()=>{seen.scan++;await gates.scan?.promise;return {at:Date.now(),pools:[pool]};};
 const directSellPlan=(seed,slippagePromise)=>manualDirectSell(rpc,bridge,intent,seed,{scan,preparation,slippagePromise});
 return {rpc,bridge,intent,seen,gates,scan,preparation,run:()=>tradePlan(rpc,bridge,intent,token,undefined,{directSellPlan})};
}
test('first manual sell overlaps scan, metadata, fresh holdings, official policy and registration; all gates must finish',async()=>{
 const f=fixture();f.gates.quote=deferred();f.gates.registry=deferred();f.gates.scan=deferred();f.gates.meta=deferred();let done=false;
 const result=f.run().then(p=>{done=true;return p;});await tick();
 assert.equal(f.seen.quote,1);assert.equal(f.seen.scan,1);assert.equal(f.seen.meta,1);assert.equal(f.seen.balance,2);assert.equal(f.seen.registry,6);
 f.gates.scan.resolve();f.gates.meta.resolve();await tick();assert.equal(f.seen.venue,1);assert.equal(done,false);
 f.gates.quote.resolve();await tick();assert.equal(done,false);f.gates.registry.resolve();
 const p=await result;assert.equal(p.manualRouteRecovery,true);assert.equal(p.outputToken,BNB);assert.equal(p.amountIn,'500');assert.equal(p.minOutput,'897');assert.deepEqual(p.slippage,{mode:'auto',bps:1000,capBps:2000});
 const call=V2_ROUTER_ABI.parseTransaction(p.steps.at(-1));assert.equal(call.args[1],897n);assert.equal(call.args[3],w.address);
});
test('fixed-slippage direct sale omits unused aggregator quote and retains exact minimum',async()=>{
 const f=fixture({mode:'fixed'}),p=await f.run();assert.equal(f.seen.quote,0);assert.equal(p.minOutput,'797');assert.equal(p.slippage.bps,2000);assert.equal(p.steps.length,1);
});
test('auto recommendation failure or excess cap cannot produce a direct sale despite a healthy pool',async()=>{
 for(const [slippage,code]of [['0.21','SLIPPAGE_LIMIT'],['unknown','SLIPPAGE_UNKNOWN']]){const f=fixture();f.gates.slippage=slippage;await assert.rejects(f.run(),e=>e.code===code);assert.equal(f.seen.quote,1);}
});
test('zero holdings start neither a quote nor pool scan; requested output is never silently changed',async()=>{
 const empty=fixture({holding:0n});await assert.rejects(empty.run(),e=>e.code==='NO_HOLDINGS');assert.equal(empty.seen.scan+empty.seen.quote,0);
 const f=fixture();f.intent.currency='USDT';await assert.rejects(f.run(),e=>e.code==='OPENING_WAIT');
});
test('no-pool and token read failures retain handled promises and never synthesize a plan',async()=>{
 const f=fixture();await assert.rejects(openingPlan(f.rpc,f.bridge,f.intent,{scan:async()=>({pools:[]}),preparation:{token:async()=>{throw Error('metadata failed');}},slippagePromise:Promise.reject(Error('policy failed'))}),e=>e.code==='OPENING_WAIT');await tick();
});
test('opening tasks read holdings after discovery so tokens arriving during detection are not skipped',async()=>{
 const f=fixture({mode:'fixed'}),gate=deferred();let detected=false;
 const original=f.rpc.call;f.rpc.call=async tx=>{if(same(tx.to,token)&&ERC20.parseTransaction(tx).name==='balanceOf')assert.equal(detected,true);return original(tx);};
 const p=openingPlan(f.rpc,f.bridge,{...f.intent,openingOnly:true},{preparation:f.preparation,scan:async()=>{await gate.promise;detected=true;return f.scan();}});
 await tick();assert.equal(f.seen.balance,0);gate.resolve();assert.equal((await p).amountIn,'500');assert.equal(f.seen.balance,1);
});
test('warmup is read-only, bounded, coalesced, throttled and yields to foreground work',async()=>{
 let busy=false,now=1000,scans=0,meta=0,venues=0;const gate=deferred();
 const warm=new ManualSellWarmup({now:()=>now,busy:()=>busy,scan:async()=>{scans++;await gate.promise;return {pools:[{...d,liquid:true}]};},preparation:{token:async()=>{meta++;},venue:async()=>{venues++;}}});
 const first=warm.request(token);assert.equal(warm.request(token),null);await tick();assert.equal(scans,1);assert.equal(meta,1);
 busy=true;gate.resolve();await first;assert.equal(venues,0);busy=false;assert.equal(warm.request(token),null);
 now+=15001;await warm.request(token);assert.equal(venues,1);assert.equal(scans,2);busy=true;now+=15001;assert.equal(warm.request(token),null);busy=false;warm.close();assert.equal(warm.request(token),null);
});
test('warmup metadata/scan errors do not leak rejections or keep the warmup busy forever',async()=>{
 const warm=new ManualSellWarmup({scan:async()=>{throw Error('offline');},preparation:{token:async()=>{throw Error('offline');}}});await warm.request(token);assert.equal(warm.pending,null);assert.equal(warm.request('bad'),null);
});
test('a freshly registered live curve wins over an already prepared speculative external pool',async()=>{
 const f=fixture({mode:'fixed'}),original=f.rpc.call;
 f.rpc.getCode=async()=> '0x6000';f.rpc.getBalance=async()=>1000000000000000000n;f.bridge.ready=async()=>({});
 f.rpc.call=async tx=>{
  if(!same(tx.to,flap.portal))return original(tx);
  const parsed=flap.portalAbi.parseTransaction(tx),values=parsed.fragment.outputs.map(zero);
  if(parsed.name==='getTokenV8Safe')values[0][0]=1;
  if(parsed.name==='quoteExactInput')values[0]=997n;
  return flap.portalAbi.encodeFunctionResult(parsed.name,values);
 };
 const p=await f.run();assert.equal(f.seen.scan,1);assert.equal(p.route,'flap');assert.equal(p.steps.at(-1).to,flap.portal);assert.equal(f.seen.quote,0);
});
