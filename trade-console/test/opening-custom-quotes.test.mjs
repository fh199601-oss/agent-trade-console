import test from 'node:test';
import assert from 'node:assert/strict';
import {OpeningPools,POOL,FACTORY,freshOpeningSnapshot} from '../lib/opening-pools.mjs';
import {OpeningQuotes,HINT_ABI} from '../lib/opening-quotes.mjs';
import {DEXES,V2_ROUTER_ABI as ROUTER} from '../lib/opening-dex.mjs';
import {MULTICALL,MULTI} from '../lib/opening-read.mjs';
import {openingPlan,refreshOpeningSell} from '../lib/opening-route.mjs';
import {OpeningPreparation} from '../lib/opening-preparation.mjs';
import {ERC20,bindings,same,ZeroAddress,WBNB,BNB} from '../lib/common.mjs';

const token='0x1111111111111111111111111111111111111111',quote='0x3333333333333333333333333333333333333333',pair='0x2222222222222222222222222222222222222222',d=DEXES[0];
function fixture({pairOnly=false,badFactory=false,wrongAssets=false}={}){
 let liquid=false,created=false,balance=1000n,clock=1000,calls=0,hintReads=0;
 const single=tx=>{
  if(same(tx.to,token)&&HINT_ABI.getFunction(tx.data.slice(0,10))){hintReads++;const m=HINT_ABI.parseTransaction(tx).name;
   if(!pairOnly&&m==='quoteToken')return HINT_ABI.encodeFunctionResult(m,[quote]);
   if(m==='pair')return HINT_ABI.encodeFunctionResult(m,[created?pair:ZeroAddress]);
   throw Error('unsupported hint');
  }
  if(same(tx.to,d.factory)){const f=FACTORY.parseTransaction(tx);return FACTORY.encodeFunctionResult(f.name,[created&&same(f.args[1],quote)?pair:ZeroAddress]);}
  if(same(tx.to,pair)){const f=POOL.parseTransaction(tx),v={factory:[badFactory?token:d.factory],token0:[quote],token1:[wrongAssets?WBNB:token],getReserves:[liquid?2000000n:0n,liquid?10000n:0n,1]};return POOL.encodeFunctionResult(f.name,v[f.name]);}
  if(same(tx.to,d.router)){const f=ROUTER.parseTransaction(tx),v={factory:[d.factory],WETH:[WBNB],getAmountsOut:[[500n,2000000n]]};assert.ok(!f.name.includes('swap'));return ROUTER.encodeFunctionResult(f.name,v[f.name]);}
  if(same(tx.to,token)||same(tx.to,quote)){const f=ERC20.parseTransaction(tx),v={balanceOf:[balance],decimals:[same(tx.to,quote)?6:18],allowance:[1000n]};return ERC20.encodeFunctionResult(f.name,v[f.name]);}
  throw Error('unexpected read');
 };
 const rpc={verifyChain:async()=>{},getBlockNumber:async()=>123,getCode:async()=> '0x6000',call:async tx=>{
  calls++;if(same(tx.to,MULTICALL)){const f=MULTI.parseTransaction(tx);return MULTI.encodeFunctionResult(f.name,[123,'0x'+'0'.repeat(64),f.args[1].map(c=>{try{return [true,single({to:c.target,data:c.callData})];}catch{return [false,'0x'];}})]);}
  return single(tx);
 }};
 const hints=new OpeningQuotes(rpc,{now:()=>clock}),detector=new OpeningPools(rpc,{dexes:[d],quotes:[WBNB],quoteDiscovery:hints});
 return {rpc,detector,hints,open:()=>{created=true;liquid=true;},create:()=>created=true,advance:()=>clock+=16000,setBalance:n=>balance=n,reset:()=>calls=0,calls:()=>calls,hintReads:()=>hintReads};
}
test('nonstandard quote learned before opening; new pair found immediately; warm scan remains one RPC',async()=>{
 const h=fixture();assert.equal((await h.detector.scan(token)).open,false);assert.deepEqual(h.hints.known(token),[quote]);
 h.create();assert.equal((await h.detector.scan(token)).open,false);h.open();h.reset();const s=await h.detector.scan(token);
 assert.equal(s.open,true);assert.equal(s.pools[0].quote,quote);assert.equal(s.block,123);assert.ok(freshOpeningSnapshot(s,token));assert.equal(h.calls(),1);
});
test('unknown quote can be found from a pair getter without a quote getter',async()=>{
 const h=fixture({pairOnly:true});h.open();const s=await h.detector.scan(token);assert.equal(s.open,true);assert.equal(s.pools[0].quote,quote);
});
for(const flag of ['badFactory','wrongAssets'])test('untrusted '+flag+' never becomes opening',async()=>{
 const h=fixture({[flag]:true});h.open();assert.equal((await h.detector.scan(token)).open,false);
});
test('explicit BNB output cannot silently become a nonstandard quote token',async()=>{
 const h=fixture();h.open();assert.equal((await h.detector.scan(token,{currency:'BNB'})).open,false);assert.ok(h.hintReads()>0); // Hint discovery is now needed to check a possible second hop.
});
test('nonstandard quote direct plan uses current percentage, actual quote precision and preserves native-output choice',async()=>{
 const h=fixture();h.open();const snapshot=await h.detector.scan(token),w=bindings()[0];
 const intent={account:w.account,side:'sell',asset:token,percent:'50',currency:'AUTO',slippageBps:5000};
 const preparation=new OpeningPreparation(h.rpc,{identityFor:async()=>({target:token,fingerprint:'synthetic'})});
 const p=await openingPlan(h.rpc,{},intent,{snapshot,preparation,scan:()=>assert.fail('fresh detection must be reused')});
 assert.equal(p.amountIn,'500');assert.equal(p.outputToken,quote);assert.notEqual(p.outputToken,BNB);assert.equal(p.outputDecimals,6);assert.equal(p.quote.toCoinAmount,'2.0');assert.equal(p.minOutput,'1000000');
 const sale=ROUTER.parseTransaction(p.steps[0]);assert.equal(sale.name,'swapExactTokensForTokensSupportingFeeOnTransferTokens');assert.equal(sale.args[3],w.address);assert.deepEqual([...sale.args[2]],[token,quote]);
 assert.equal((await refreshOpeningSell(h.rpc,p)).quote.toCoinAmount,'2.0');h.setBalance(500n);await assert.rejects(refreshOpeningSell(h.rpc,p),/持仓已变化/);
});
test('hint misses expire and concurrent discovery is shared',async()=>{
 const h=fixture({pairOnly:true});await Promise.all([h.hints.discover(token),h.hints.discover(token)]);const before=h.hintReads();assert.equal(before,10);
 h.open();await h.hints.discover(token);assert.equal(h.hintReads(),before);h.advance();assert.deepEqual(await h.hints.discover(token),[quote]);
});
test('an already verified liquid pool is never held up by optional quote rediscovery',async()=>{
 const h=fixture();h.open();await h.detector.scan(token);
 let release;h.detector.quoteDiscovery.discover=()=>new Promise(r=>release=r);
 const pending=h.detector.scan(token);try{assert.equal((await Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(Error('hint discovery blocked a liquid pool')),200))])).open,true);}finally{release?.([]);}
});
