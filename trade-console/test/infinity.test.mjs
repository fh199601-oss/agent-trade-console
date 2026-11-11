import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {AbiCoder} from 'ethers';
import {INFINITY,InfinityPools,INF_MANAGER,INF_QUOTER,INF_ROUTER,PERMIT2,POOL_KEY,infinityId,infinityFee,infinityQuote,infinitySaleData,infinityApprovals,verifyInfinityApproval,verifyInfinityAllowance,infinitySettlement} from '../lib/infinity.mjs';
import {Interface,ERC20,BNB,WBNB,USDT,ZeroAddress,same,bindings} from '../lib/common.mjs';
import {openingPlan,refreshOpeningSell} from '../lib/opening-route.mjs';
import {Engine,verifyPreview} from '../lib/engine.mjs';import {assessSellFees,compareFeeRoutes,updateFeeReview} from '../lib/trade-fees.mjs';
import {manualDirectSell} from '../lib/manual-sell-recovery.mjs';import {DEXES,V2_ROUTER_ABI} from '../lib/opening-dex.mjs';
const token='0x'+'11'.repeat(20),other='0x'+'22'.repeat(20),owner=bindings()[0],coder=AbiCoder.defaultAbiCoder();
const key=[ZeroAddress,token,ZeroAddress,INFINITY.factory,2500,'0x'+'0'.repeat(64)],id=infinityId(key);
const base={...INFINITY,pool:id,key,token,token0:key[0],token1:key[1],quote:WBNB,nativeQuote:true,liquid:true,block:10000,liquidity:'1000000',sqrtPriceX96:String(1n<<96n),fee:2500,hooks:ZeroAddress};
const intent={account:owner.account,side:'sell',asset:token,percent:'50',currency:'AUTO',slippageBps:100,slippageMode:'fixed'};
function mock({balance=1000000n,approved=0n,permit=0n,expiry=0n,output=490000n,keyValue=key}={}){
 const seen=[];const rpc={verifyChain:async()=>{},getBlockNumber:async()=>10000,call:async tx=>{
  seen.push(tx);const abi=same(tx.to,token)?ERC20:same(tx.to,INFINITY.factory)?INF_MANAGER:same(tx.to,INFINITY.quoter)?INF_QUOTER:same(tx.to,INFINITY.permit2)?PERMIT2:null;
  if(!abi)throw Error('unsupported');const f=abi.parseTransaction(tx);
  const values={balanceOf:[balance],decimals:[18],allowance:same(tx.to,INFINITY.permit2)?[permit,expiry,0n]:[approved],poolIdToPoolKey:keyValue,getSlot0:[1n<<96n,0,0,2500],getLiquidity:[1000000n],quoteExactInputSingle:[output,80000n]};
  return abi.encodeFunctionResult(f.name,values[f.name]);
 }};return {rpc,seen};
}
const prep={token:async()=>({decimals:18,identity:{fingerprint:'test'}}),quote:async()=>({decimals:18}),venue:async()=>({assets:[]})};
const opts={scan:async()=>({at:Date.now(),pools:[base]}),preparation:prep};
const ev=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)','event Deposit(address indexed dst,uint256 wad)','event Withdrawal(address indexed src,uint256 wad)']);
function log(abi,name,args,address){return {address,...abi.encodeEventLog(abi.getEvent(name),args)};}
test('singleton pool is keyed by complete key and rejects wrong token, manager, or hash',async()=>{
 const d=new InfinityPools(mock().rpc);assert.equal((await d.state(token,id,10000)).pool,id);
 assert.equal(await d.state(other,id,10000),null);assert.equal(await d.state(token,'0x'+'ff'.repeat(32),10000),null);
 assert.equal(await new InfinityPools(mock({keyValue:[...key.slice(0,3),other,...key.slice(4)]}).rpc).state(token,id,10000),null);
});
test('Infinity packed protocol fee is directional and combined with LP fee in PPM',()=>{
 assert.equal(infinityFee([0,0,5035213,2500],false),3726);assert.equal(infinityFee([0,0,5035213,2500],true),3726);
 assert.equal(infinityFee([0,0,(100<<12)+200,2500],false),2600);assert.equal(infinityFee([0,0,(100<<12)+200,2500],true),2700);
 assert.throws(()=>infinityFee([0,0,4095<<12,2500],false));
});
test('cold discovery learns recent real Vault trades, validates state, and coalesces wallets',async()=>{
 const {rpc}=mock();let queries=0,receipts=0;const txHash='0x'+'aa'.repeat(32);
 rpc.send=async(method,[filter])=>{assert.equal(method,'eth_getLogs');queries++;return same(filter.address,token)?[{...log(ev,'Transfer',[owner.address,INFINITY.vault,100n],token),transactionHash:txHash,blockNumber:'0x2710'}]:[];};
 rpc.getTransactionReceipt=async()=>{receipts++;return {status:'0x1',logs:[log(INF_MANAGER,'Swap',[id,INFINITY.router,99n,-100n,1n<<96n,1000n,0,2500,0],INFINITY.factory)]};};
 const detector=new InfinityPools(rpc);const [a,b]=await Promise.all([detector.scan(token),detector.scan(token)]);
 assert.equal(a,b);assert.equal(a.pools.length,1);assert.equal(receipts,1);assert.equal(queries,4);
 await detector.scan(token);assert.equal(queries,4);
});
test('quiet pools are discovered beyond latest 256 blocks; removed logs cannot create a route',async()=>{
 const {rpc}=mock();let oldRead=false;rpc.send=async(method,[filter])=>{
  const old=BigInt(filter.toBlock)<9745n;if(old)oldRead=true;
  return old&&same(filter.address,INFINITY.factory)?[{...log(INF_MANAGER,'Initialize',[id,key[0],token,ZeroAddress,2500,key[5],1n<<96n,0],INFINITY.factory),blockNumber:filter.toBlock}]:[];
 };rpc.getTransactionReceipt=async()=>assert.fail('no transfer receipt needed');
 const found=await new InfinityPools(rpc).scan(token);assert.equal(oldRead,true);assert.equal(found.pools.length,1);
 const send=rpc.send;rpc.send=async(...args)=>(await send(...args)).map(x=>({...x,removed:true}));
 assert.equal((await new InfinityPools(rpc).scan(token)).pools.length,0);
});
test('unknown/failing RPC logs and false receipt success never become a pool',async()=>{
 const {rpc}=mock();rpc.send=async()=>{throw Error('network');};assert.equal((await new InfinityPools(rpc).scan(token)).pools.length,0);
});
test('quote includes hidden hook loss and a failed exact-input quote reports no liquidity',async()=>{
 const {rpc}=mock({output:50000n}),q=await infinityQuote(rpc,base,token,500000n);assert.equal(q.fees.quoteLossPpm,900000);
 rpc.call=async()=>{throw {data:'0x6190b2b0'+coder.encode(['bytes'],['0x7a5ed734'+id.slice(2)]).slice(2)};};
 await assert.rejects(infinityQuote(rpc,base,token,500000n),e=>e.code==='SELL_NO_LIQUIDITY'&&/流动性不足/.test(e.message));
});
test('exact two-stage Permit2 approvals are bounded, with short expiry and no permit signature',async()=>{
 const {rpc}=mock(),steps=await infinityApprovals(rpc,token,owner.address,500000n);assert.equal(steps.length,2);
 assert.equal(ERC20.decodeFunctionData('approve',steps[0].data)[1],500000n);
 const plan={route:INFINITY.id+'-opening',inputToken:token,amountIn:'500000',wallet:owner.address};verifyInfinityApproval(steps[1],plan);
 for(const altered of [{...steps[1],allowance:'500001'},{...steps[1],spender:other},{...steps[1],token:other},{...steps[1],expiration:1}])assert.throws(()=>verifyInfinityApproval(altered,plan));
 assert.deepEqual(await infinityApprovals(mock({approved:500000n,permit:500000n,expiry:BigInt(Math.floor(Date.now()/1000)+1000)}).rpc,token,owner.address,500000n),[]);
 await assert.rejects(verifyInfinityAllowance(rpc,steps[1],plan),/额度/);
});
test('Permit2 official preview accepts only input token approval and never extra asset debit or allowance',async()=>{
 const steps=await infinityApprovals(mock().rpc,token,owner.address,500000n),step=steps[1],plan={route:INFINITY.id+'-opening',wallet:owner.address,inputToken:token,amountIn:'500000'};
 const p={requestId:'mock',simulationResult:{simulationCode:'000000000',balanceChanges:[],allowanceChanges:[{owner:owner.address,tokenAddress:token,spender:INFINITY.router,postAmount:'500000'}]}};
 assert.doesNotThrow(()=>verifyPreview(p,plan,step));
 const official={...p,parsedTx:{transactionType:'Approve',contractAddress:token,spender:INFINITY.router,amount:500000}};
 assert.doesNotThrow(()=>verifyPreview(official,plan,step));
 for(const change of [{contractAddress:other},{spender:other},{amount:500001},{transactionType:'Transfer'}])assert.throws(()=>verifyPreview({...official,parsedTx:{...official.parsedTx,...change}},plan,step));
 for(const c of [{tokenAddress:other},{spender:other},{postAmount:'500001'}])assert.throws(()=>verifyPreview({...p,simulationResult:{...p.simulationResult,allowanceChanges:[{...p.simulationResult.allowanceChanges[0],...c}]}},plan,step));
 assert.throws(()=>verifyPreview({...p,simulationResult:{...p.simulationResult,balanceChanges:[{owner:owner.address,contractAddress:token,change:'-1'}]}},plan,step));
});
test('native exact-input commands enforce min output and wallet recipient; USDT stays ERC20',()=>{
 const data=infinitySaleData(base,token,owner.address,500000n,480000n,true),tx=INF_ROUTER.decodeFunctionData('execute',data);assert.equal(tx[0],'0x100b0c');
 const [actions,params]=coder.decode(['bytes','bytes[]'],tx[1][0]);assert.equal(actions,'0x060c0e');
 const [swap]=coder.decode([`(${POOL_KEY},bool,uint128,uint128,bytes)`],params[0]);assert.equal(swap[2],500000n);assert.equal(swap[3],480000n);assert.equal(swap[1],false);
 const [recipient,min]=coder.decode(['address','uint256'],tx[1][2]);assert.equal(recipient,owner.address);assert.equal(min,480000n);
 const usdt={...base,key:[token,USDT,...key.slice(2)],nativeQuote:false,token0:token,token1:USDT,quote:USDT};usdt.pool=infinityId(usdt.key);
 assert.equal(INF_ROUTER.decodeFunctionData('execute',infinitySaleData(usdt,token,owner.address,500000n,480000n,false))[0],'0x10');
 assert.throws(()=>infinitySaleData({...base,pool:'0x'+'ff'.repeat(32)},token,owner.address,5n,4n,true));
});
test('normal and opening plans build exact approvals then fixed Infinity sale; refresh re-reads balance and fees',async()=>{
 const {rpc}=mock();const p=await openingPlan(rpc,{},intent,opts);assert.equal(p.route,INFINITY.id+'-opening');assert.equal(p.steps.length,3);assert.equal(p.steps[1].approvalType,'infinity-permit2');assert.equal(p.amountIn,'500000');assert.equal(p.minOutput,'485100');assert.equal(p.outputToken,BNB);
 const refreshed=await refreshOpeningSell(rpc,p);assert.equal(refreshed.minOutput,'485100');assert.equal(refreshed.poolFees.quoteLossPpm,20000);
 await assert.rejects(refreshOpeningSell(mock({balance:999999n}).rpc,p),/持仓/);
});
test('Infinity Hook loss over 50% is confirmed even with zero audit tax; low-fee route search excludes it',async()=>{
 const p=await openingPlan(mock({output:50000n}).rpc,{},intent,opts);p.audit={available:true,taxes:{sellTax:'0'}};
 const review=assessSellFees(p);assert.equal(review.required,true);assert.equal(review.quoteLossPpm,900000);assert.equal(review.totalFeePpm,900000);
 const o={id:'fee-test',intent,plan:p};updateFeeReview(o);const first=o.feeReview.id;p.poolFees.quoteLossPpm=910000;updateFeeReview(o);assert.notEqual(o.feeReview.id,first);
 await assert.rejects(openingPlan(mock({output:50000n}).rpc,{},intent,{...opts,lowFeeOnly:true}),/未找到/);
 assert.ok(compareFeeRoutes({pool:base,output:50000n,fees:p.poolFees},{pool:base,output:490000n,fees:{poolFeePpm:2500}})>0);
});
test('native settlement requires exact original commands, wallet funding, pool direction and wrapped receipt',()=>{
 const plan={wallet:owner.address,inputToken:token,outputToken:BNB,amountIn:'500000',minOutput:'480000'};
 const step={to:INFINITY.router,data:infinitySaleData(base,token,owner.address,500000n,480000n,true)};
 const logs=[log(INF_MANAGER,'Swap',[id,INFINITY.router,490000n,-500000n,1n<<96n,1000n,0,2500,0],INFINITY.factory),log(ev,'Transfer',[owner.address,INFINITY.vault,500000n],token),log(ev,'Deposit',[INFINITY.router,490000n],WBNB),log(ev,'Withdrawal',[INFINITY.router,490000n],WBNB)];
 const args={receipt:{logs},token,state:base,plan,step,wallet:owner.address};assert.equal(infinitySettlement(args).amountOut,490000n);
 assert.throws(()=>infinitySettlement({...args,receipt:{logs:logs.slice(0,2)}}));
 assert.throws(()=>infinitySettlement({...args,step:{...step,data:infinitySaleData(base,token,other,500000n,480000n,true)}}));
 assert.throws(()=>infinitySettlement({...args,receipt:{logs:[...logs,log(ev,'Transfer',[owner.address,other,1n],token)]}}));
});
test('AUTO preserves original quote token while explicit BNB cannot silently switch to USDT',async()=>{
 const d=DEXES[0],rpc={call:async tx=>{const a=same(tx.to,token)?ERC20:V2_ROUTER_ABI,f=a.parseTransaction(tx);return a.encodeFunctionResult(f.name,f.name==='getAmountsOut'?[[500000n,490000n]]:[1000000n]);}};
 const options={preparation:prep,scan:async()=>({pools:[{...d,pool:other,quote:USDT,liquid:true}]})};
 const aggregate={kind:'swap',wallet:owner.address,inputToken:token,outputToken:BNB,holdingBefore:'1000000',amountIn:'500000',slippage:{bps:100}};
 assert.equal((await manualDirectSell(rpc,{},intent,aggregate,options)).outputToken,USDT);
 await assert.rejects(manualDirectSell(rpc,{}, {...intent,currency:'BNB'},aggregate,options),e=>e.code==='SELL_ROUTE_UNAVAILABLE');
});

for(const expired of [false,true])test(`mock Engine Permit2 lifecycle: ${expired?'expired allowance ends review and releases wallet':'two approvals continue to one confirmed sale'}`,async t=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'infinity-engine-test-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 let erc=0n,permit=0n,expiry=0n,count=0,lastStep;const txs=new Map(),receipts=new Map(),{rpc}=mock();const call=rpc.call;
 rpc.call=async tx=>{
  if(same(tx.to,token)&&ERC20.parseTransaction(tx).name==='allowance')return ERC20.encodeFunctionResult('allowance',[erc]);
  if(same(tx.to,INFINITY.permit2))return PERMIT2.encodeFunctionResult('allowance',[permit,expiry,0n]);
  return call(tx);
 };rpc.getTransaction=async h=>txs.get(h);rpc.getTransactionReceipt=async h=>receipts.get(h);
 const plan=await openingPlan(rpc,{},intent,opts);plan.identity=null;plan.audit={available:true,taxes:{sellTax:'0'}};
 const bridge={ready:async()=>{},call:async(_account,args)=>{
  assert.equal(args[0],'contract-call');
  if(args[1]==='preview'){
   const to=args[args.indexOf('--to')+1],data=args[args.indexOf('--inputData')+1];lastStep={to,data,value:'0'};
   const sell=same(to,INFINITY.router),isPermit=same(to,INFINITY.permit2);
   return {requestId:'mock-only',simulationResult:{simulationCode:'000000000',allowanceChanges:sell?[]:[{owner:owner.address,tokenAddress:token,spender:isPermit?INFINITY.router:INFINITY.permit2,postAmount:'500000'}],balanceChanges:sell?[{owner:owner.address,contractAddress:token,change:'-500000'},{owner:owner.address,contractAddress:ZeroAddress,change:'490000'}]:[]}};
  }
  assert.equal(args[1],'execute');count++;const hash='0x'+count.toString(16).padStart(64,'0'),step=lastStep;let logs=[];
  if(same(step.to,token))erc=500000n;
  else if(same(step.to,INFINITY.permit2)){const a=PERMIT2.decodeFunctionData('approve',step.data);permit=a[2];expiry=expired?0n:a[3];}
  else logs=[log(INF_MANAGER,'Swap',[id,INFINITY.router,490000n,-500000n,1n<<96n,1000n,0,2500,0],INFINITY.factory),log(ev,'Transfer',[owner.address,INFINITY.vault,500000n],token),log(ev,'Deposit',[INFINITY.router,490000n],WBNB),log(ev,'Withdrawal',[INFINITY.router,490000n],WBNB)];
  txs.set(hash,{hash,from:owner.address,to:step.to,input:step.data,value:'0'});receipts.set(hash,{transactionHash:hash,status:'0x1',from:owner.address,to:step.to,logs});return {txHash:hash};
 }};
 const engine=new Engine({rpc,bridge,data,live:true,planFn:async()=>plan});assert.equal((await engine.prepare(intent,'mock-infinity')).status,'PREPARED');
 const result=await engine.execute('mock-infinity',{authorization:'synthetic transport test only',acknowledgeReview:true});
 assert.equal(result.status,expired?'CONFIRMED_REVIEW':'CONFIRMED');assert.equal(count,expired?2:3);
 assert.equal((await engine.reconcileAccount(owner.account)).ready,true);assert.equal(engine.running.size,0);
 await engine.execute('mock-infinity',{authorization:'duplicate mock request',acknowledgeReview:true});assert.equal(count,expired?2:3);
});
