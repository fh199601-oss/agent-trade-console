// All wallets, pools and RPC responses below are synthetic. No submission.
import test from 'node:test';import assert from 'node:assert/strict';
import {Interface,ERC20,BNB,WBNB,USDT,same,bindings} from '../lib/common.mjs';
import {DEXES,V2_ROUTER_ABI,QUOTER} from '../lib/opening-dex.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Engine} from '../lib/engine.mjs';
import {GANG_ENTRY,GANG_ABI} from '../lib/gang-modern.mjs';
import * as flap from '../support/curve-trader/adapters/flap.mjs';import * as gang from '../support/curve-trader/adapters/gang.mjs';
import {ZeroAddress} from 'ethers';
import {TradeConversions,conversions} from '../lib/trade-conversion.mjs';
import {primaryBuyPlan,reverseBuyPool} from '../lib/primary-buy.mjs';
import {tradeLegPlan} from '../lib/trade-leg.mjs';
import {OpeningPools} from '../lib/opening-pools.mjs';
import {quotedPoolFees,adequatePrimaryRoute} from '../lib/trade-fees.mjs';
const w=bindings()[0],token='0x'+'c3'.repeat(20),main='0x'+'a1'.repeat(20),other='0x'+'a2'.repeat(20),bridge='0x'+'a3'.repeat(20),one=10n**18n,amount=one/100n;
const NATIVE=new Interface(['function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable']);
function pool(quote=WBNB,extra={}){return {...DEXES[0],pool:main,token,quote,token0:token,token1:quote,reserve0:String(one*1000000n),reserve1:String(one*1000n),block:101,liquid:true,declaredByToken:true,...extra};}
function fixture(pools){
 const reads=[];let release,slow=false;const gate=new Promise(r=>release=r);
 const rpc={call:async(tx,block)=>{
  reads.push(tx.to);
  const d=DEXES.find(d=>same(d.router,tx.to));
  if(d){const f=V2_ROUTER_ABI.parseTransaction(tx);assert.equal(f.name,'getAmountsOut');assert.equal(block,101);if(slow&&d.id===DEXES[1].id)await gate;
   const [n,path]=f.args,values=[n];for(let i=0;i<path.length-1;i++){
    const legs=pools.flatMap(p=>p.legs||[p]),p=legs.find(p=>same(p.factory,d.factory)&&[p.token0,p.token1].some(t=>same(t,path[i]))&&[p.token0,p.token1].some(t=>same(t,path[i+1])));assert.ok(p);
    const ri=BigInt(same(path[i],p.token0)?p.reserve0:p.reserve1),ro=BigInt(same(path[i],p.token0)?p.reserve1:p.reserve0),x=values.at(-1)*9975n;values.push(x*ro/(ri*10000n+x));
   }return V2_ROUTER_ABI.encodeFunctionResult(f.name,[values]);
  }
  const f=ERC20.parseTransaction(tx);assert.equal(f.name,'allowance');return ERC20.encodeFunctionResult(f.name,[0n]);
 }};
 const prep={venue:async()=>({assets:[]}),token:async()=>({identity:{fingerprint:'mock'}}),quote:async()=>({decimals:18})};
 const converter=new TradeConversions(rpc,{prep,identityFor:async()=>({fingerprint:'mock'})});
 return {rpc,converter,prep,scan:async()=>({pools,at:Date.now()}),slow:()=>slow=true,release,reads};
}
function intent(currency='BNB'){return {account:w.account,side:'buy',asset:token,currency,amount:'0.01',slippageBps:100,slippageMode:'fixed'};}
const seed=i=>({wallet:w.address,token,inputToken:i.currency==='BNB'?BNB:i.currency==='USDT'?USDT:WBNB,outputToken:token,amountIn:String(amount),holdingBefore:'0',decimals:18,slippage:{bps:100,capBps:100,mode:'fixed'}});
for(const currency of ['BNB','WBNB','USDT'])test(currency+' buy pins deep primary, even if secondary offers slightly more output',async()=>{
 const q=currency==='USDT'?USDT:WBNB,p=pool(q),alt=pool(q,{...DEXES[1],pool:other,declaredByToken:false,reserve0:String(one*1001000n)}),f=fixture([alt,p]),i=intent(currency);
 const r=await primaryBuyPlan(f.rpc,i,seed(i),f);assert.equal(r.kind,'contract');assert.equal(r.primaryPool,main);assert.equal(r.primarySelected,true);assert.equal(r.steps.at(-1).to,DEXES[0].router);assert.ok(r.poolFees.quoteLossPpm<50000);
 const call=(currency==='BNB'?NATIVE:V2_ROUTER_ABI).parseTransaction(r.steps.at(-1)),path=call.args[currency==='BNB'?1:2];assert.deepEqual([...path].map(x=>x.toLowerCase()),[q,token].map(x=>x.toLowerCase()));
 assert.equal(tradeLegPlan(r,r.steps.at(-1)).amountIn,String(amount));assert.equal(r.steps.at(-1).value,currency==='BNB'?String(amount):'0');
 assert.equal(r.steps.length,currency==='BNB'?1:2);if(currency!=='BNB')assert.equal(r.steps[0].allowance,String(amount));
});
test('buy does not wait for a slow secondary once the primary quote and venue pass',async()=>{
 const p=pool(),alt=pool(WBNB,{...DEXES[1],pool:other,declaredByToken:false}),f=fixture([alt,p]);f.slow();let timer;
 try{const r=await Promise.race([primaryBuyPlan(f.rpc,intent(),seed(intent()),f),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('optional quote blocked primary')),700))]);assert.equal(r.primaryPool,main);}finally{clearTimeout(timer);f.release();}
});
test('thin primary cannot win on its label and an all-high-loss pool set cannot use an opaque fallback',async()=>{
 const thin=pool(WBNB,{reserve1:String(amount/100n)}),alt=pool(WBNB,{...DEXES[1],pool:other,declaredByToken:false}),f=fixture([thin,alt]);
 assert.equal((await primaryBuyPlan(f.rpc,intent(),seed(intent()),f)).primaryPool,other);
 const bad=fixture([thin]);await assert.rejects(primaryBuyPlan(bad.rpc,intent(),seed(intent()),bad),e=>e.code==='QUOTE_CONVERSION_UNAVAILABLE');
});
test('BNB buy reverses every verified bridge leg and still executes through the USDT primary',async()=>{
 const a=pool(USDT),b=pool(WBNB,{pool:bridge,token:USDT,token0:USDT,token1:WBNB,reserve0:String(one*600000n),reserve1:String(one*1000n),declaredByToken:false});
 const route={...a,quote:WBNB,path:[token,USDT,WBNB],legs:[a,b]},f=fixture([route]),r=await primaryBuyPlan(f.rpc,intent(),seed(intent()),f);
 assert.equal(r.primaryPool,main);assert.deepEqual(NATIVE.parseTransaction(r.steps.at(-1)).args[1].map(x=>x.toLowerCase()),[WBNB,USDT,token].map(x=>x.toLowerCase()));assert.equal(r.poolFees.pools.length,2);
 assert.deepEqual(reverseBuyPool(route,token).legs.map(p=>p.pool),[bridge,main]);
});
test('requested BNB route includes a USDT main bridge even beside an existing BNB direct pool',async()=>{
 const primary=pool(USDT),secondary=pool(WBNB,{pool:other,declaredByToken:false}),mid=pool(WBNB,{pool:bridge,token:USDT,token0:USDT,token1:WBNB});
 const hints={primary:async()=>[],known:()=>[USDT],knownRoutes:()=>[{pool:main,quote:USDT,declaredByToken:true}],discover:async()=>[],unsupported:()=>[]};
 const detector=new OpeningPools({verifyChain:async()=>{}},{quoteDiscovery:hints,infinity:null});
 detector.inspectQuotes=async t=>({block:101,pools:same(t,token)?[primary,secondary]:[mid],errors:[]});
 const s=await detector.scan(token,{currency:'BNB'});assert.equal(s.pools.length,2);assert.ok(s.pools.some(p=>p.legs&&p.pool===main&&p.declaredByToken));
});
test('V3 primary adequacy uses the same-block spot and full-size quote, not just fee tier',async()=>{
 const p={...pool(),...DEXES[2],fee:2500},abi=new Interface(['function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint32,bool)']);
 const rpc={call:async(tx,block)=>{assert.equal(tx.to,main);assert.equal(block,101);return abi.encodeFunctionResult('slot0',[1n<<96n,0,0,0,0,0,true]);}};
 const fees=await quotedPoolFees(rpc,p,[one,one*9975n/10000n],token,101);assert.equal(fees.quoteLossPpm,2500);assert.equal(adequatePrimaryRoute({pool:p,fees}),true);
 const bad=await quotedPoolFees(rpc,p,[one,one/100n],token,101);assert.equal(adequatePrimaryRoute({pool:p,fees:bad}),false);
});

test('same-block V3 price work is shared across wallets, never across blocks or latest',async()=>{
 const p={...pool(),...DEXES[2],fee:2500},abi=new Interface(['function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint32,bool)']);let reads=0;
 const rpc={call:async()=>{reads++;return abi.encodeFunctionResult('slot0',[1n<<96n,0,0,0,0,0,true]);}};
 const fees=await Promise.all([1,2,3,4].map(()=>quotedPoolFees(rpc,p,[one,one*9975n/10000n],token,101)));assert.equal(reads,1);assert.ok(fees.every(f=>f.quoteLossPpm===2500));
 await quotedPoolFees(rpc,p,[one,one/2n],token,102);assert.equal(reads,2);
 assert.equal((await quotedPoolFees(rpc,p,[one,one/2n],token,'latest')).quoteLossPpm,undefined);assert.equal(reads,2);
});
test('Engine buy preview fixes the pool for every wallet and isolates one failed wallet',async t=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'primary-buy-engine-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 const p=pool(),alt=pool(WBNB,{...DEXES[1],pool:other,declaredByToken:false}),f=fixture([alt,p]),chainCall=f.rpc.call;
 const zero=p=>p.baseType==='tuple'?p.components.map(zero):p.type==='address'?ZeroAddress:p.type==='bool'?false:p.type==='bytes32'?'0x'+'00'.repeat(32):0n;
 f.rpc.verifyChain=async()=>{};
 f.rpc.call=async (tx,block)=>{
  if(same(tx.to,token)){const fn=ERC20.parseTransaction(tx);if(fn.name==='decimals')return ERC20.encodeFunctionResult(fn.name,[18]);if(fn.name==='balanceOf')return ERC20.encodeFunctionResult(fn.name,[0]);}
  if(same(tx.to,GANG_ENTRY))return GANG_ABI.encodeFunctionResult('getTokenInfo',[0,ZeroAddress,ZeroAddress,0,0]);
  const pad=gang.PADS.find(p=>same(p.address,tx.to)),fl=same(tx.to,flap.portal);
  if(pad||fl){const abi=fl?flap.portalAbi:pad.kind==='soft'?gang.SOFT_ABI:pad.id==='s'?gang.S_ABI:gang.V2_ABI,fn=abi.parseTransaction(tx);return abi.encodeFunctionResult(fn.name,fn.fragment.outputs.map(zero));}
  return chainCall(tx,block);
 };
 conversions(f.rpc).prep=f.prep;
 const wallets=bindings().slice(0,4);let previews=0;
 const bridge={ready:async()=>{},call:async(account,args)=>{
  assert.deepEqual(args.slice(0,2),['contract-call','preview'],'never market-order or execute');previews++;
  assert.ok(same(args[args.indexOf('--to')+1],DEXES[0].router));
  if(account===wallets[1].account)throw Error('本钱包模拟余额不足');
  const tx=NATIVE.parseTransaction({data:args[args.indexOf('--inputData')+1]}),owner=wallets.find(w=>w.account===account).address;
  assert.ok(same(tx.args[2],owner));assert.deepEqual([...tx.args[1]].map(x=>x.toLowerCase()),[WBNB,token].map(x=>x.toLowerCase()));
  return {requestId:'simulation-'+account,simulationResult:{simulationCode:'000000000',balanceChanges:[{owner,contractAddress:BNB,change:'-'+amount},{owner,contractAddress:token,change:String(tx.args[0])}]}};
 }};
 const engine=new Engine({rpc:f.rpc,bridge,data,live:false,auditFn:async()=>({available:true,level:1,items:[]})});engine.openingScan=f.scan;
 const orders=await Promise.all(wallets.map((w,n)=>engine.prepare({...intent(),account:w.account},'primary-buy-'+n)));
 assert.equal(previews,4,JSON.stringify(orders.map(o=>o.error)));assert.equal(orders[1].status,'BLOCKED');assert.match(orders[1].error.message,/余额不足/);
 for(const [n,o]of orders.entries())if(n!==1){assert.equal(o.status,'PREPARED',o.error?.message);assert.equal(o.plan.primaryPool,main);assert.equal(o.plan.primarySelected,true);assert.equal(o.plan.route,'primary-pool');assert.equal(o.simulationOnly,true);}
 assert.equal(engine.running.size,0);assert.ok(orders.every(o=>!o.txHash&&!o.orderId));
});
