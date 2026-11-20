// All network, Agent submissions, trigger signatures and receipts in this suite are in-memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {getAddress,id,Interface,ZeroHash,ZeroAddress} from 'ethers';
import {MULTICALL,MULTI} from '../lib/opening-read.mjs';
import {LiveFastSale} from '../lib/delegated-sale/live.mjs';
import {personalExecutor} from '../lib/delegated-sale/personal-address.mjs';
import {TAX_BSC_SALE as template,activeDeployment,SALE,BscVenue} from '../lib/delegated-sale/bsc.mjs';
import {ERC20} from '../lib/common.mjs';
const a=n=>getAddress('0x'+n.toString(16).padStart(40,'0'));
const deploymentFor=payer=>({...template,payer,executor:personalExecutor(payer)});
const personal=deploymentFor(a(101)),other=deploymentFor(a(102));
function setup(t,deployment=personal){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fast-sale-sim-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const asset=a(19),trigger=a(20),wallets=[1,2,3,4].map(n=>({account:n,address:a(n)}));
 const amounts=[0n,400n,800n,1200n],limits=new Map(),previews=new Map(),transactions=new Map(),receipts=new Map(),plans=new Map(),calls=[];
 const venue={verified:true,token:asset,quote:deployment.wrapped,source:asset,pair:a(24),getter:id('pair()').slice(0,10),tokenHash:id('token'),sourceHash:id('token'),quoteHash:id('quote')};
 const rpc={send:async(method,[k])=>{
  if(method==='eth_gasPrice')return '0x100';
  if(method==='eth_getBalance')return '0x1000000000000000000';
  if(method==='eth_getTransactionReceipt')return receipts.get(k);
  if(method==='eth_getTransactionByHash')return transactions.get(k);
  throw Error('unexpected RPC '+method);
 },call:async({to,data})=>{
  const abi=to===asset?ERC20:SALE,{name,args}=abi.parseTransaction({data});
  if(name==='balanceOf')return abi.encodeFunctionResult(name,[amounts[Number(BigInt(args[0]))-1]]);
  if(name==='allowance')return abi.encodeFunctionResult(name,[limits.get(args[0])||0n]);
  if(name==='active')return abi.encodeFunctionResult(name,[ZeroHash]);
  if(name==='plans')return abi.encodeFunctionResult(name,plans.get(args[0]));
  throw Error('unexpected read '+name);
 }};
 const bridge={ready:async()=>{},call:async(account,args)=>{
  const address=wallets[account-1].address;
  if(args[1]==='preview'){
   const to=args[args.indexOf('--to')+1],data=args[args.indexOf('--inputData')+1],requestId=String(previews.size+1);
   previews.set(requestId,{to,data});return {requestId,parsedTx:{contractAddress:to},risks:[],simulationResult:{simulationCode:'000000000',balanceChanges:[],allowanceChanges:[]}};
  }
  const {to,data}=previews.get(args[3]),abi=to===asset?ERC20:SALE,{name,args:params}=abi.parseTransaction({data}),hash=id('simulated-'+args[3]);
  calls.push({account,name,params});const logs=[];
  if(name==='approve')limits.set(address,params[1]);else{
   const planId=id('plan-'+account),deadline=Math.floor(Date.now()/1000)+Number(params[6])*3600;
   const log=SALE.encodeEventLog('Registered',[planId,address,asset,params[1],deadline]);logs.push({...log,address:deployment.executor});
   plans.set(planId,[address,trigger,id('venue'),params[1],params[2],deadline,1,false,true]);
  }
  transactions.set(hash,{hash,input:data,value:'0x0',to,from:address});
  receipts.set(hash,{status:'0x1',transactionHash:hash,logs});return {txHash:hash};
 }};
 const service=new LiveFastSale({rpc,bridge,data:dir,managedRoot:dir,bindings:()=>wallets,deployment});
 service.adapter.verifiedVenue=async()=>venue;
 const sent=[];service.trigger={wallet:{address:trigger},warm:async()=>{},prepare:async()=>({status:'PREPARED'}),broadcast:async key=>{sent.push(key);return {status:'PENDING',hash:id(key)};}};
 return {service,asset,trigger,wallets,calls,sent,venue};
}
test('扣税版使用独立执行地址，旧有原单保留，37% 按执行时持仓计算',async t=>{
 assert.equal(activeDeployment({...personal,executorHash:id('invalid runtime')}),null);
 assert.equal(activeDeployment(personal,[{status:'PAUSED',executor:other.executor}]),null);
 assert.deepEqual(activeDeployment(personal,[{status:'COMPLETED',executor:other.executor}]),personal);
 const {service,asset,trigger,venue,wallets,calls}=setup(t,personal);
 venue.openAtVerification=true;service.adapter.transferCompatibility=()=>{throw Error('不应调用旧版足额转账检查');};
 await service.authorize({id:'taxed',asset,wallets:wallets.slice(1)});
 assert.ok(calls.every(c=>c.params[0]===personal.executor));
 const job=await service.start({id:'taxed',asset,accounts:[2,3,4],settings:{trigger,source:'opening',percent:37,expiryHours:24,minOut:'1'}});
 assert.equal(job.executor,personal.executor);assert.ok(job.rows.every(r=>r.plan));assert.equal(service.status().taxAware,true);
 assert.deepEqual(calls.slice(3).map(c=>[c.params[1],c.params[5]]),[[400n,37n],[800n,37n],[1200n,37n]]);
});

test('其他使用者执行合约的回执不会影响新计划的高税判定',async()=>{
 const venue=new BscVenue({},personal),plan=id('net-tax-plan'),owner=a(1);
 const failed=SALE.encodeEventLog('ItemFailed',[plan,id('HighTransferFee()').slice(0,10)]);
 const sold=SALE.encodeEventLog('Sold',[plan,owner,100n,80n,false]);
 const results=await venue.outcomes({logs:[{...failed,address:venue.executor},{...sold,address:other.executor}]},[plan]);
 assert.equal(results.get(plan).reason,'HIGH_TRANSFER_FEE');
 const rows=[{address:owner,plan:{id:plan,cap:'100',minOut:'75'}}];
 venue.rpc.send=async()=>[{calls:[{status:'0x1',logs:[{...sold,address:other.executor}]}]}];
 assert.deepEqual(await venue.simulateTaxBatch(a(5),rows),[]);
 venue.rpc.send=async()=>[{calls:[{status:'0x1',logs:[{...sold,address:venue.executor}]}]}];
 assert.deepEqual(await venue.simulateTaxBatch(a(5),rows),rows);
});

test('开盘前已登记的计划只需一次同区块查询，首个合格区块直接触发原批次',async t=>{
 const {service,trigger,wallets,asset,venue,calls,sent}=setup(t,personal);
 const j=await service.authorize({id:'preopen',asset,wallets:wallets.slice(1)});
 const armed=await service.start({id:j.id,asset,accounts:[2,3,4],settings:{trigger,source:'opening',percent:100,expiryHours:48,minOut:'1'}});
 assert.equal(armed.status,'ARMED');assert.equal(calls.filter(c=>c.name==='registerSale').length,3);
 assert.equal(sent.length,0);
 const pairAbi=new Interface(['function getReserves() view returns(uint112,uint112,uint32)','function pair() view returns(address)']);
 let state,reads=0;
 const adapter=new BscVenue({call:async({to,data})=>{
  assert.equal(to,MULTICALL);reads++;
  const batch=MULTI.decodeFunctionData('tryBlockAndAggregate',data)[1];
  assert.deepEqual(batch.map(c=>c.target),[personal.executor,venue.pair,personal.executor,venue.source]);
  const [packed,preparing]=SALE.decodeFunctionData('verify',batch[0].callData);
  assert.equal(packed.token,asset);assert.equal(packed.pair,venue.pair);assert.equal(preparing,false);
  assert.equal(batch[1].callData,pairAbi.encodeFunctionData('getReserves'));
  assert.deepEqual([...SALE.decodeFunctionData('openingState',batch[2].callData)],[asset,venue.source]);
  assert.equal(batch[3].callData,venue.getter);
  const rows=[state.verified?[true,SALE.encodeFunctionResult('verify',[false])]:[false,'0x'],
   [true,pairAbi.encodeFunctionResult('getReserves',[2n,state.liquidity,10])],
   [true,SALE.encodeFunctionResult('openingState',[true,state.open])],
   [true,pairAbi.encodeFunctionResult('pair',[state.pair])]];
  return MULTI.encodeFunctionResult('tryBlockAndAggregate',[state.block,ZeroHash,rows]);
 }},personal);
 adapter.venues.set(asset.toLowerCase(),venue);
 const walletCalls=calls.length;
 state={block:19,open:false,verified:false,pair:a(900),liquidity:200};
 const before=await adapter.opening(asset);assert.equal(before.open,false);assert.equal(before.changed,undefined);
 await service.notifyOpening(asset,before);
 state={block:20,open:true,verified:true,pair:venue.pair,liquidity:0};
 await service.notifyOpening(asset,await adapter.opening(asset));assert.equal(sent.length,0);
 state={...state,block:21,liquidity:100};const first=await adapter.opening(asset);
 assert.equal(first.block,21);assert.equal(first.open,true);assert.equal(reads,3);
 await Promise.all([service.notifyOpening(asset,first),service.notifyOpening(asset,first)]);
 assert.equal(sent.length,1);assert.equal(calls.length,walletCalls);
 state={...state,verified:false};
 await assert.rejects(adapter.opening(asset),/verify/);
 state.pair=ZeroAddress;await assert.rejects(adapter.opening(asset),/verify/);
 state.pair=a(900);const changed=await adapter.opening(asset);
 assert.equal(changed.open,false);assert.equal(changed.changed,true);assert.equal(adapter.venues.has(asset.toLowerCase()),false);
});

test('极速成交必须匹配原批次、持币人、金额及最低实收，成功回执不能代替逐钱包成交',async()=>{
 const adapter=new BscVenue({},personal),hash=id('original batch'),owner=a(1),trigger=a(100),planId=id('holder plan');
 const row={address:owner,plan:{id:planId,trigger,cap:'100',minOut:'20'}};
 const event=(who,amount,output)=>({...SALE.encodeEventLog('Sold',[planId,who,amount,output,true]),address:adapter.executor});
 const receipt={transactionHash:hash,status:'0x1',blockNumber:'0x50',from:trigger,to:adapter.executor,logs:[event(owner,25n,21n)]};
 const decode=async receipt=>(await adapter.outcomes(receipt,[planId],[row],hash)).get(planId);
 assert.deepEqual((await decode(receipt)).fill,{amount:'25',output:'21',nativePaid:true,block:80});
 for(const extra of [{status:'0x0'},{to:a(7)},{from:a(9)},{transactionHash:id('other')},{logs:[]},{logs:[event(a(2),25n,21n)]},
  {logs:[event(owner,101n,21n)]},{logs:[event(owner,25n,19n)]},{logs:[...receipt.logs,...receipt.logs]}]){
  assert.ok(!(await decode({...receipt,...extra}))?.sold);
 }
});

test('历史成交只读补齐明细，多次刷新同一批次只读取一次回执',async t=>{
 const {service,asset,wallets,trigger,venue,calls}=setup(t,personal);
 const hash=id('old fill'),planId=id('old plan'),owner=wallets[0].address;
 const row={account:1,address:owner,status:'SOLD',receipt:hash,batch:'b1',plan:{id:planId,trigger,cap:'100',minOut:'15'}};
 const job={asset,executor:service.adapter.executor,venue:{...venue,tokenDecimals:18},rows:[row],batches:[{id:'b1',ids:[planId],hash,status:'CONFIRMED'}]};
 service.jobs.push(job);
 let reads=0;
 service.adapter.followHash=async()=>{reads++;return {status:'CONFIRMED',receipt:{to:job.executor,from:trigger,transactionHash:hash,status:'0x1',blockNumber:'0x11',
  logs:[{...SALE.encodeEventLog('Sold',[planId,owner,20n,16n,false]),address:job.executor}]}};};
 await Promise.all([service.refreshPastFills(),service.refreshPastFills()]);await service.refreshPastFills();
 assert.equal(reads,1);assert.equal(calls.length,0);
 assert.deepEqual(row.fill,{amount:'20',output:'16',nativePaid:false,block:17});
});

test('地址评级预览逐钱包确认，仅执行已核对的精确授权与登记，重复确认不重发',async t=>{
 const {service,asset,trigger,wallets,calls}=setup(t);
 const selected=wallets.slice(1),executor=service.adapter.executor,call=service.bridge.call.bind(service.bridge);
 let warn=false,unexpected=false;
 service.bridge.call=async(account,args)=>{
  const p=await call(account,args);if(args[1]!=='preview')return p;
  const owner=wallets.find(w=>w.account===account).address,to=args[args.indexOf('--to')+1];
  const level={riskLevel:-1,riskDetails:[]};
  p.risks={riskDetails:warn?[{code:'TEST',title:'测试风险'}]:[],riskBehaviors:[],addresses:{[owner]:level,[executor]:level,[asset]:{riskLevel:1,riskDetails:[]}}};
  p.simulationResult.authorityChanges=[];
  if(to===asset){
   const [,amount]=ERC20.decodeFunctionData('approve',args.at(-1));
   p.parsedTx.spender=executor;
   p.simulationResult.allowanceChanges=[{owner,tokenAddress:asset,spender:executor,postAmount:String(unexpected?amount+1n:amount),preAmount:'0'}];
  }
  return p;
 };
 const get=()=>service.jobs.find(j=>j.id==='ratings'),payload=(field,rows)=>({id:'ratings',asset,field,reviews:rows.map(r=>({account:r.account,ticket:r.ratingReview.ticket}))});
 await service.authorize({id:'ratings',asset,wallets:selected});const j=get();
 assert.ok(j.rows.every(r=>r.status==='APPROVAL_REVIEW'));assert.equal(calls.length,0);
 await service.reconcile(j);assert.equal(j.status,'AUTHORIZING');
 const first=payload('approval',j.rows.slice(0,1));
 await assert.rejects(service.confirmRatings({...first,reviews:[{account:3,ticket:first.reviews[0].ticket}]}));
 j.rows[0].ratingReview.until=0;
 await service.confirmRatings(first);assert.equal(calls.length,0);assert.notEqual(j.rows[0].ratingReview.ticket,first.reviews[0].ticket);
 const valid=payload('approval',j.rows.slice(0,1));
 await Promise.allSettled([service.confirmRatings(valid),service.confirmRatings(valid)]);assert.equal(calls.length,1);
 await assert.rejects(service.confirmRatings(valid));assert.equal(calls.length,1);
 warn=true;await service.confirmRatings(payload('approval',j.rows.slice(1,2)));warn=false;
 assert.match(j.rows[1].message,/测试风险/);assert.equal(calls.length,1);
 unexpected=true;await service.confirmRatings(payload('approval',j.rows.slice(2)));unexpected=false;
 assert.equal(j.rows[2].status,'FAILED');assert.equal(calls.length,1);
 await service.start({id:'ratings',asset,accounts:[2],selectedOnly:true,settings:{source:'opening',trigger,percent:100,expiryHours:24,minOut:'1'}});
 assert.equal(j.rows[0].status,'REGISTRATION_REVIEW');assert.equal(calls.length,1);
 await service.confirmRatings(payload('registration',[j.rows[0]]));
 assert.equal(j.status,'ARMED');assert.deepEqual(calls.map(c=>c.name),['approve','registerSale']);
});
