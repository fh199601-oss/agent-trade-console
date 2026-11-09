import test from 'node:test';import assert from 'node:assert/strict';
import {OpeningSources,CREATED} from '../lib/opening-sources.mjs';
import {OpeningQuotes,HINT_ABI} from '../lib/opening-quotes.mjs';
import {OpeningPools,FACTORY,POOL} from '../lib/opening-pools.mjs';
import {openingPlan,openingSettlement,refreshOpeningSell} from '../lib/opening-route.mjs';
import {OpeningPreparation} from '../lib/opening-preparation.mjs';
import {DEXES,V2_ROUTER_ABI as ROUTER} from '../lib/opening-dex.mjs';
import {MULTICALL,MULTI} from '../lib/opening-read.mjs';
import {Interface,ERC20,bindings,same,ZeroAddress,WBNB,BNB,USDT} from '../lib/common.mjs';
import {settlements} from '../lib/routes.mjs';
const T='0x'+'1'.repeat(40),Q='0x'+'2'.repeat(40),P='0x'+'3'.repeat(40),P2='0x'+'4'.repeat(40),owner='0x'+'5'.repeat(40),tax='0x'+'6'.repeat(40),d=DEXES[0];
const PAIR=new Interface([...POOL.fragments,'function fee() view returns(uint24)']);
const ev=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)','event Withdrawal(address indexed src,uint256 wad)','event Swap(address indexed sender,uint amount0In,uint amount1In,uint amount0Out,uint amount1Out,address indexed to)']);
const log=(a,m,args)=>({address:a,...ev.encodeEventLog(ev.getEvent(m),args)});
const transfer=(a,from,to,value)=>log(a,'Transfer',[from,to,value]);
function fixture({dex=d,bridge=true,forged=false,v3=false,pairQuote=Q}={}){
 let balance=1000n,calls=0;
 const pools={[P]:{token0:T,token1:pairQuote,factory:forged?T:dex.factory},[P2]:{token0:pairQuote,token1:WBNB,factory:dex.factory}};
 const single=tx=>{
  if(same(tx.to,T)&&HINT_ABI.getFunction(tx.data.slice(0,10)))throw Error('no getters');
  if(same(tx.to,dex.factory)){const f=FACTORY.parseTransaction(tx),[a,b,fee]=f.args;const p=(same(a,T)&&same(b,pairQuote)&&(!v3||fee===200n))?P:bridge&&same(a,pairQuote)&&same(b,WBNB)?P2:ZeroAddress;return FACTORY.encodeFunctionResult(f.name,[p]);}
  if(pools[tx.to]){const f=PAIR.parseTransaction(tx);const data={...pools[tx.to],fee:200,liquidity:100000n};return PAIR.encodeFunctionResult(f.name,f.name==='getReserves'?[100000n,200000n,0]:[data[f.name]]);}
  if(same(tx.to,dex.router)){const f=ROUTER.parseTransaction(tx);return ROUTER.encodeFunctionResult(f.name,f.name==='getAmountsOut'?[f.args[1].length===3?[f.args[0],2000n,3000n]:[f.args[0],2000n]]:f.name==='factory'?[dex.factory]:[WBNB]);}
  if([T,pairQuote,WBNB].some(a=>same(a,tx.to))){const f=ERC20.parseTransaction(tx);return ERC20.encodeFunctionResult(f.name,[f.name==='decimals'?18:f.name==='balanceOf'?balance:10000000n]);}
  throw Error('unexpected read');
 };
 const rpc={verifyChain:async()=>{},getCode:async()=> '0x6000',getBlockNumber:async()=>100,call:async tx=>{calls++;if(same(tx.to,MULTICALL)){const f=MULTI.parseTransaction(tx);return MULTI.encodeFunctionResult(f.name,[100,'0x'+'0'.repeat(64),f.args[1].map(c=>{try{return [true,single({to:c.target,data:c.callData})];}catch{return [false,'0x'];}})]);}return single(tx);}};
 const hints=new OpeningQuotes(rpc,{sources:{discover:async()=>[P]}}),detector=new OpeningPools(rpc,{dexes:[dex],quotes:[WBNB],quoteDiscovery:hints});
 return {rpc,hints,detector,setBalance:n=>balance=n,calls:()=>calls};
}
for(const dex of DEXES.filter(d=>d.kind==='v2'))test(dex.id+': source discovery works without any token pair getters and settlement is registered',async()=>{
 const h=fixture({dex}),s=await h.detector.scan(T);assert.equal(s.open,true);assert.equal(s.pools[0].pool,P);assert.equal(s.pools[0].quote,Q);assert.equal(settlements[dex.id+'-opening'],openingSettlement);
});
test('forged index pool cannot nominate an arbitrary spender or bypass factory verification',async()=>{const h=fixture({forged:true});assert.equal((await h.detector.scan(T)).open,false);});
test('known-factory but unregistered pair remains unusable',async()=>{
 const h=fixture();const call=h.rpc.call;h.rpc.call=async(tx,b)=>same(tx.to,d.factory)?FACTORY.encodeFunctionResult('getPair',[ZeroAddress]):call(tx,b);
 // Override factory through non-Multicall path as well.
 h.rpc.call=async(tx,b)=>{if(same(tx.to,MULTICALL))throw Error('no multicall');if(same(tx.to,d.factory))return FACTORY.encodeFunctionResult('getPair',[ZeroAddress]);return call(tx,b);};
 assert.equal((await h.detector.scan(T)).open,false);
});
test('V3 non-default fee is discovered and verified with its actual factory',async()=>{const h=fixture({dex:DEXES[2],v3:true,bridge:false});const s=await h.detector.scan(T);assert.equal(s.open,true);assert.equal(s.pools[0].fee,200);});
test('V3 newly discovered fee on an already scanned standard quote is not lost',async()=>{const h=fixture({dex:DEXES[2],v3:true,bridge:false,pairQuote:WBNB});const s=await h.detector.scan(T);assert.equal(s.open,true);assert.equal(s.pools[0].fee,200);assert.equal(s.pools[0].quote,WBNB);});
test('two-hop BNB sale uses verified intermediate pool, actual percent and exact output; AUTO stays one hop',async()=>{
 const h=fixture(),s=await h.detector.scan(T,{currency:'BNB'});assert.equal(s.open,true);assert.equal(s.pools.length,1);assert.deepEqual(s.pools[0].path,[T,Q,WBNB]);
 const w=bindings()[0],intent={account:w.account,asset:T,side:'sell',percent:'50',currency:'BNB',slippageBps:5000},preparation=new OpeningPreparation(h.rpc,{identityFor:async()=>({target:T,fingerprint:'test'})});
 const p=await openingPlan(h.rpc,{},intent,{snapshot:s,preparation});assert.equal(p.amountIn,'500');assert.equal(p.outputToken,BNB);assert.equal(p.minOutput,'1500');
 const tx=ROUTER.parseTransaction(p.steps.at(-1));assert.deepEqual([...tx.args[2]],[T,Q,WBNB]);assert.equal(tx.args[3],w.address);assert.equal(tx.args[0],500n);
 const refreshed=await refreshOpeningSell(h.rpc,p);assert.deepEqual([...ROUTER.parseTransaction(refreshed.steps.at(-1)).args[2]],[T,Q,WBNB]);
 h.setBalance(500n);await assert.rejects(refreshOpeningSell(h.rpc,p),/持仓已变化/);
 const auto=await h.detector.scan(T);assert.equal(auto.pools[0].quote,Q);assert.equal(auto.pools[0].path,undefined);
});
test('missing second pool never silently changes requested BNB into quote token',async()=>{const h=fixture({bridge:false});assert.equal((await h.detector.scan(T,{currency:'BNB'})).open,false);});
function receiptFixture({native=true,reverse=false}={}){
 const out=native?WBNB:USDT,recipient=native?d.router:owner;
 const first={kind:'v2',factory:d.factory,pool:P,token0:reverse?Q:T,token1:reverse?T:Q,quote:Q};
 const last={kind:'v2',factory:d.factory,pool:P2,token0:reverse?out:Q,token1:reverse?Q:out,quote:out};
 const state={...first,quote:out,path:[T,Q,out],legs:[first,last]};
 const step={kind:'sell',to:d.router,value:'0',data:ROUTER.encodeFunctionData(native?'swapExactTokensForETHSupportingFeeOnTransferTokens':'swapExactTokensForTokensSupportingFeeOnTransferTokens',[1000n,100n,state.path,owner,2000000000])};
 const plan={inputToken:T,outputToken:native?BNB:out,amountIn:'1000',minOutput:'100'};
 const swap=(pool,input,output,to)=>log(pool,'Swap',[d.router,...(reverse?[0,input,output,0]:[input,0,0,output]),to]);
 const logs=[transfer(T,tax,P,10000n),transfer(Q,P,tax,20000n),swap(P,10000n,20000n,tax),transfer(T,owner,tax,30n),transfer(T,owner,P,970n),transfer(Q,P,P2,1800n),transfer(Q,P,tax,200n),swap(P,970n,2000n,P2),transfer(out,P2,recipient,200n),swap(P2,1800n,200n,recipient),...(native?[log(WBNB,'Withdrawal',[d.router,200n])]:[])];
 return {receipt:{logs},token:T,state,wallet:owner,plan,step};
}
for(const native of [false,true])for(const reverse of [false,true])test(`two-hop receipt attribution: native=${native} reverse=${reverse}, taxed input/intermediate, nested tax swap`,()=>{
 assert.deepEqual(openingSettlement(receiptFixture({native,reverse})),{amountIn:1000n,amountOut:200n,poolAmountIn:970n,attribution:'wallet-funded-multihop'});
});
for(const [name,alter]of [
 ['missing second payout',f=>f.receipt.logs.splice(8,1)],['wrong factory',f=>f.state.legs[1].factory=T],['wrong amount',f=>f.plan.amountIn='999'],['wrong output',f=>f.plan.outputToken=Q],['wrong second pool',f=>f.state.legs[1].pool=P],['missing unwrap',f=>f.receipt.logs.pop()],['unrelated intermediate deposit',f=>f.receipt.logs[5]=transfer(Q,tax,P2,1800n)]
])test('multi-hop receipt rejects '+name,()=>{const f=receiptFixture();alter(f);assert.throws(()=>openingSettlement(f));});

test('factory creation logs cover both token positions and cache negative queries briefly, index uses either side',async()=>{
 let now=1000,height=1000,reads=0,indexReads=0,fail=false;const requests=[];
 const e=CREATED.encodeEventLog(CREATED.getEvent('PairCreated'),[Q,T,P,1n]);
 const rpc={getBlockNumber:async()=>height,send:async(method,[f])=>{reads++;requests.push(f);assert.equal(method,'eth_getLogs');if(fail)throw Error('RPC unavailable');return [{address:d.factory,blockNumber:'0x'+height.toString(16),...e},{address:T,blockNumber:'0x'+height.toString(16),...e}];}};
 const source=new OpeningSources(rpc,{dexes:[d],now:()=>now,fetchImpl:async(url,options)=>{indexReads++;assert.match(url,/^https:\/\/api.dexscreener.com\/token-pairs\/v1\/bsc\//);assert.equal(options.credentials,'omit');return {ok:true,json:async()=>[{chainId:'bsc',quoteToken:{address:T},baseToken:{address:Q},pairAddress:P2},{chainId:'ethereum',baseToken:{address:T},pairAddress:tax}]};}});
 assert.deepEqual(new Set(await source.discover(T)),new Set([P,P2]));assert.equal(reads,2);assert.equal(requests[0].topics[1],'0x'+T.slice(2).padStart(64,'0'));assert.equal(requests[1].topics[1],null);
 await source.discover(T);assert.equal(reads,2);assert.equal(indexReads,1);
 now+=600;height+=2;await source.discover(T);assert.equal(reads,4);assert.equal(Number(BigInt(requests[2].fromBlock)),992);
 fail=true;now+=600;height+=2;await source.discover(T);assert.equal(source.entry(T).cursor,1002);
});
test('slow index does not hold factory event hints; pending requests coalesce',async()=>{
 let release;const rpc={getBlockNumber:async()=>100,send:async()=>[]};let calls=0;
 const source=new OpeningSources(rpc,{fetchImpl:()=>{calls++;return new Promise(r=>release=r);}});
 const started=Date.now();await source.discover(T);assert.ok(Date.now()-started<800);await source.discover(T);assert.equal(calls,1);release({ok:true,json:async()=>[]});
});
test('warm two-hop path refreshes both reserves in one RPC, never caches balance or quote',async()=>{
 const h=fixture();const first=await h.detector.scan(T,{currency:'BNB'});assert.ok(first.open);const before=h.calls();
 const second=await h.detector.scan(T,{currency:'BNB'});assert.ok(second.open);assert.equal(h.calls()-before,1);assert.deepEqual(second.pools[0].path,[T,Q,WBNB]);
 assert.equal(second.pools[0].amountIn,undefined);
});
test('liquid scans do not perpetually postpone optional venue rediscovery',async()=>{
 const h=fixture();await h.detector.scan(T);const key=T.toLowerCase()+':AUTO',due=h.detector.discoveryAfter.get(key);
 await h.detector.scan(T);assert.equal(h.detector.discoveryAfter.get(key),due);
 let requests=0;h.detector.quoteDiscovery.discover=async()=>{requests++;return [];};h.detector.discoveryAfter.set(key,Date.now()-1);
 await h.detector.scan(T);assert.equal(requests,1);await h.detector.scan(T);assert.equal(requests,1);
});
test('expanded low-fee search checks intermediate paths even when a direct pool already exists',async()=>{
 const detector=new OpeningPools({verifyChain:async()=>{}},{quotes:[WBNB,Q],quoteDiscovery:null});
 let bridges=0,cached=0;detector.refreshPaths=async()=>{cached++;return null;};
 detector.inspectQuotes=async(_token,currency)=>({block:100,errors:[],pools:[{...d,pool:P,quote:WBNB,liquid:true},...(currency==='AUTO'?[{...d,pool:P2,quote:Q,liquid:true}]:[])]});
 detector.bridges=async(_t,currency,pools)=>{bridges++;assert.equal(currency,'BNB');assert.ok(pools.some(p=>p.quote===Q));return [{...d,pool:P2,quote:WBNB,liquid:true,path:[T,Q,WBNB],legs:[{pool:P2},{pool:P}]}];};
 const normal=await detector.scan(T,{currency:'BNB'});assert.equal(normal.pools.length,1);assert.equal(bridges,0);
 const expanded=await detector.scan(T,{currency:'BNB',expand:true});assert.equal(expanded.expanded,true);assert.equal(expanded.pools.length,2);assert.equal(bridges,1);assert.equal(cached,1);assert.equal(detector.paths.has(T.toLowerCase()+':BNB'),false);
});
