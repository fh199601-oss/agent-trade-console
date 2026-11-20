import {openingRecoveryPlan} from '../lib/opening-recovery.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {keccak256} from 'ethers';
import {Engine} from '../lib/engine.mjs';
import {ERC20,WBNB,bindings,same,ZeroAddress,validateIntent} from '../lib/common.mjs';
import {OpeningPools,FACTORY,POOL} from '../lib/opening-pools.mjs';
import {DEXES,V2_ROUTER_ABI} from '../lib/opening-dex.mjs';
import {MULTI,MULTICALL} from '../lib/opening-read.mjs';
import {codeIdentity} from '../lib/discovery.mjs';
import {openingApprovalPlan,assertOpeningApproval,recheckOpeningApproval,PREAPPROVAL_ROUTE,verifyPrimaryTaskSale} from '../lib/opening-preapproval.mjs';
import {openingPlan} from '../lib/opening-route.mjs';
import {OpeningSell,openingConfig} from '../lib/opening-sell.mjs';
import {CorlaAutomation} from '../lib/corla-automation.mjs';
import {corlaClient} from '../lib/corla.mjs';
import {INFINITY,PERMIT2} from '../lib/infinity.mjs';
import {taskSellSettings,editOpening} from '../lib/task-edit.mjs';

const token='0x'+'12'.repeat(20),pair='0x'+'34'.repeat(20),mint='0x'+'56'.repeat(20),factory='0x'+'78'.repeat(20),code='0x60006000';
const tick=()=>new Promise(r=>setImmediate(r));
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(t,{live=false,d=DEXES[0],infinity=false}={}){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'preapproval-test-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 if(infinity)d=INFINITY;
 const state={balance:1000n,allowance:0n,permitAmount:0n,permitExpiry:0,primary:true,liquid:false,allowances:new Map(),exec:[],previews:0,claimable:800n,claimed:false,phase:1n};
 const owner=bindings()[0],requests=new Map(),txs=new Map();
 const single=tx=>{
  if(same(tx.to,token)){const f=ERC20.parseTransaction(tx);return ERC20.encodeFunctionResult(f.name,[f.name==='balanceOf'?state.balance:f.name==='decimals'?18:state.allowances.get(String(f.args[0]).toLowerCase())??state.allowance]);}
  if(same(tx.to,INFINITY.permit2)){const f=PERMIT2.parseTransaction(tx);return PERMIT2.encodeFunctionResult(f.name,[state.permitAmount,state.permitExpiry,0n]);}
  if(same(tx.to,d.router)){const f=V2_ROUTER_ABI.parseTransaction(tx);return V2_ROUTER_ABI.encodeFunctionResult(f.name,[[f.args[0],f.args[0]*2n]]);}
  if(same(tx.to,d.factory)){const f=FACTORY.parseTransaction(tx);return FACTORY.encodeFunctionResult(f.name,[pair]);}
  const f=POOL.parseTransaction(tx),values={token0:[token],token1:[WBNB],factory:[d.factory],getReserves:[state.liquid?1000000n:0n,state.liquid?1000000n:0n,1],liquidity:[state.liquid?1000000n:0n]};
  return POOL.encodeFunctionResult(f.name,values[f.name]);
 };
 const rpc={verifyChain:async()=>{},getBlockNumber:async()=>100,getCode:async a=>state.changed&&same(a,token)?'0x60016000':code,getBalance:async()=>10n**18n,
  send:async method=>{assert.equal(method,'eth_getStorageAt');return '0x'+'0'.repeat(64);},call:async tx=>{
   if(same(tx.to,MULTICALL)){const f=MULTI.parseTransaction(tx);return MULTI.encodeFunctionResult(f.name,[100,'0x'+'0'.repeat(64),f.args[1].map(c=>{try{return [true,single({to:c.target,data:c.callData})];}catch{return [false,'0x'];}})]);}return single(tx);
  },getTransaction:async hash=>txs.get(hash),getTransactionReceipt:async hash=>state.pending?null:{...txs.get(hash),transactionHash:hash,status:'0x1',blockNumber:'0x64',logs:[]}};
 const poolId=infinity?'0x'+'ab'.repeat(32):pair;
 const discovery={primary:async()=>{},known:()=>[],knownRoutes:()=>[{kind:d.kind,pool:poolId,quote:WBNB,fee:500,declaredByToken:state.primary}],discover:async()=>[],unsupported:()=>[]};
 const detector=new OpeningPools(rpc,{dexes:infinity?[]:[{...d,fees:[500]}],quotes:[WBNB],quoteDiscovery:discovery,infinity:infinity?{scan:async()=>({pools:[{pool:poolId,kind:d.kind,factory:d.factory,token0:token,token1:WBNB,quote:WBNB,liquid:state.liquid,declaredByToken:state.primary}],errors:[]})}:null});
 const bridge={ready:async()=>{},call:async(account,args)=>{
  if(args[1]==='preview'){
   const previewNumber=++state.previews;if(state.previewGate)await state.previewGate.promise;if(state.previewError||state.failAccount===account)throw state.previewError||Error('该钱包模拟失败');
   const val=k=>args[args.indexOf(k)+1],to=val('--to'),data=val('--inputData'),from=val('--from'),permit=same(to,INFINITY.permit2),decoded=(permit?PERMIT2:ERC20).decodeFunctionData('approve',data),spender=decoded[permit?1:0],amount=decoded[permit?2:1];
   const id='preview-'+previewNumber;requests.set(id,{to,data,from,spender,amount,permit,expiry:permit?decoded[3]:null});
   return {requestId:id,parsedTx:{contractAddress:to},risks:state.risks||[],simulationResult:{simulationCode:'000000000',allowanceChanges:[{owner:from,tokenAddress:token,spender,postAmount:String(amount)}],balanceChanges:[]}};
  }
  assert.equal(args[1],'execute');const request=requests.get(args[3]);assert.ok(request);state.exec.push({account,...request});
  if(state.executeError)throw state.executeError;
  if(request.permit){state.permitAmount=request.amount;state.permitExpiry=Number(request.expiry);}else state.allowances.set(request.from.toLowerCase(),request.amount);
  const hash='0x'+String(state.exec.length).padStart(64,'0');txs.set(hash,{hash,to:request.to,from:request.from,input:request.data,value:'0x0'});return {txHash:hash};
 }};
 const engine=new Engine({rpc,bridge,data,live});engine.openingScan=(...a)=>detector.scan(...a);
 engine.openingPreparation={token:async()=>({identity:await codeIdentity(rpc,token),decimals:18}),venue:async()=>({assets:[{token:d.router,codeHash:keccak256(code)},...(infinity?[{token:INFINITY.permit2,codeHash:keccak256(code)}]:[])]})};
 const source={account:owner.account,wallet:owner.address,asset:token,percent:'50',currency:'AUTO',revision:0};
 const holder={},run=(allowed=()=>true)=>engine.taskPreapprovals.run({key:'fixture-task',holder,source,allowed,persist:()=>{}});
 return {state,engine,rpc,bridge,source,holder,run,detector,data,d};
}
test('only explicit task settings enable real preapproval; public intents cannot supply approval orders',()=>{
 assert.equal(openingConfig({asset:token,accounts:[1]}).preApprove,undefined);
 assert.equal(openingConfig({asset:token,accounts:[1],preApprove:true}).preApprove,true);
 assert.throws(()=>openingConfig({asset:token,accounts:[1],preApprove:'true'}));
 assert.throws(()=>validateIntent({account:1,asset:token,side:'approval'}));
 assert.equal(taskSellSettings({percent:'100',preApprove:true}).preApprove,true);
 const intent=validateIntent({account:1,asset:token,side:'mint',scope:'free',quantity:1,maxBnb:'0',claimSell:{percent:'50',preApprove:true}});assert.equal(intent.claimSell.preApprove,true);
});
for(const d of [DEXES[0],DEXES[2],DEXES[3]])test(d.id+' builds an exact finite approval for a verified primary before liquidity',async t=>{
 const f=fixture(t,{d}),p=await openingApprovalPlan(f.engine,f.source);assert.equal(p.route,PREAPPROVAL_ROUTE);assert.equal(p.steps.length,1);assert.equal(p.opening.liquid,false);assert.equal(p.steps[0].allowance,'500');assert.equal(p.steps[0].spender,d.router);assertOpeningApproval(p);
});
test('copied snapshots, non-primary pools, changed destination and oversized allowance are rejected',async t=>{
 const f=fixture(t),p=await openingApprovalPlan(f.engine,f.source);f.state.primary=false;await assert.rejects(openingApprovalPlan(f.engine,f.source),/主池/);
 f.state.primary=true;const scan=f.engine.openingScan;f.engine.openingScan=async(...a)=>({...await scan(...a)});await assert.rejects(openingApprovalPlan(f.engine,f.source),/过期/);f.engine.openingScan=scan;
 for(const change of [x=>x.steps[0].spender=token,x=>x.steps[0].allowance='501',x=>x.steps.push({...x.steps[0],kind:'sell'}),x=>x.steps[0].value='1',x=>x.wallet=bindings()[1].address]){const q=structuredClone(p);change(q);assert.throws(()=>assertOpeningApproval(q));}
});
test('balance, quantity and main-pool changes invalidate an already prepared approval',async t=>{
 const f=fixture(t),p=await openingApprovalPlan(f.engine,f.source);f.state.balance=999n;await assert.rejects(recheckOpeningApproval(f.engine,p),/变化/);f.state.balance=1000n;f.state.primary=false;await assert.rejects(recheckOpeningApproval(f.engine,p),/主池/);
});
test('simulation uses official preview shape but never calls mocked execute, and existing allowance needs no transaction',async t=>{
 const f=fixture(t);await f.run();assert.equal(f.holder.preApproval.status,'SIMULATED');assert.equal(f.state.exec.length,0);assert.equal(f.state.previews,1);
 const ready=fixture(t);ready.state.allowance=1000n;await ready.run();assert.equal(ready.holder.preApproval.status,'READY');assert.equal(ready.state.exec.length,0);assert.equal(ready.state.previews,0);
});
test('mock live dispatch records and verifies the exact approval without ever building a sale',async t=>{
 const f=fixture(t,{live:true});await f.run();assert.equal(f.holder.preApproval.status,'CONFIRMED');assert.equal(f.state.exec.length,1);assert.equal(f.state.exec[0].amount,500n);assert.equal(f.engine.get(f.holder.preApproval.orderId).steps.length,1);
 f.holder.preApproval.checkedAt=0;await f.run();assert.equal(f.state.exec.length,1);assert.equal(f.holder.preApproval.status,'READY');
});
test('code changes and wallet risk previews do not send any approval',async t=>{
 const f=fixture(t,{live:true}),p=await openingApprovalPlan(f.engine,f.source),o=await f.engine.prepareOpeningApproval(p,'code-change');f.state.changed=true;
 const r=await f.engine.execute(o.id,{authorization:'synthetic test',rejectRisks:true});assert.equal(r.status,'BLOCKED');assert.equal(f.state.exec.length,0);
 const risk=fixture(t,{live:true});risk.state.risks=[{title:'synthetic risk'}];await risk.run();assert.equal(risk.state.exec.length,0);
});
test('pause during slow preview prevents dispatch; no hidden sale or automatic renewal',async t=>{
 const f=fixture(t,{live:true});f.state.previewGate=gate();let allowed=true;const work=f.run(()=>allowed);while(!f.state.previews)await tick();allowed=false;f.state.previewGate.resolve();await work;assert.equal(f.state.exec.length,0);
});
test('multiple wallets prepare concurrently; a failed wallet does not suppress the others',async t=>{
 const f=fixture(t,{live:true});f.state.previewGate=gate();f.state.failAccount=2;const holders=bindings().slice(0,3).map(()=>({}));
 const jobs=holders.map((holder,i)=>f.engine.taskPreapprovals.run({key:'wallet-'+i,holder,source:{...f.source,account:i+1,wallet:bindings()[i].address},allowed:()=>true,persist:()=>{}}));
 while(f.state.previews<3)await tick();assert.equal(f.engine.taskPreapprovals.busy.size,3);f.state.previewGate.resolve();await Promise.all(jobs);assert.equal(f.state.exec.length,2);assert.deepEqual(f.state.exec.map(x=>x.account).sort(),[1,3]);assert.equal(holders[1].preApproval.status,'BLOCKED');assert.equal(holders[0].preApproval.status,'CONFIRMED');assert.equal(holders[2].preApproval.status,'CONFIRMED');
});
test('unknown submission and pending receipt only follow the original, never create another execute',async t=>{
 for(const unknown of [true,false]){
  const f=fixture(t,{live:true});if(unknown)f.state.executeError=Error('synthetic network timeout');else f.state.pending=true;
  await f.run();const id=f.holder.preApproval.orderId;assert.equal(f.state.exec.length,1);
  for(let i=0;i<3;i++){f.holder.preApproval.checkedAt=0;await f.run();assert.equal(f.holder.preApproval.orderId,id);assert.equal(f.state.exec.length,1);}
 }
});
test('definite dispatch failure does not spend gas repeatedly or block other wallets',async t=>{
 const f=fixture(t,{live:true});f.state.executeError=Object.assign(Error('synthetic refusal'),{dispatched:false});await f.run();assert.equal(f.holder.preApproval.status,'FAILED');f.holder.preApproval.checkedAt=0;await f.run();assert.equal(f.state.exec.length,1);assert.equal(f.engine.running.size,0);
});
test('transient preview failure can be prepared again with the SAME id without submitting twice',async t=>{
 const f=fixture(t,{live:true});f.state.previewError=Error('temporary read error');await f.run();const id=f.holder.preApproval.orderId;assert.equal(f.state.exec.length,0);delete f.state.previewError;f.holder.preApproval.checkedAt=0;await f.run();assert.equal(f.holder.preApproval.orderId,id);assert.equal(f.state.exec.length,1);
});
test('Infinity preapproves exact token allowance then exact expiring Permit2 allowance, never unlimited',async t=>{
 const f=fixture(t,{live:true,infinity:true});await f.run();assert.equal(f.state.exec.length,1);assert.equal(f.state.exec[0].spender,INFINITY.permit2);f.holder.preApproval.checkedAt=0;await f.run();assert.equal(f.state.exec.length,2);assert.equal(f.state.exec[1].spender,INFINITY.router);assert.equal(f.state.exec[1].amount,500n);assert.ok(f.state.permitExpiry<=Math.floor(Date.now()/1000)+1800);
 f.holder.preApproval.checkedAt=0;await f.run();assert.equal(f.state.exec.length,2);
});
test('claim-linked allowance is based on verified expected credit PLUS existing balance',async t=>{
 const f=fixture(t),client=corlaClient(f.rpc),identity=await codeIdentity(f.rpc,mint),factoryIdentity=await codeIdentity(f.rpc,factory);
 client.locate=async()=>({record:{expectedToken:token}});client.verify=async()=>({identity,factoryIdentity});client.get=async(a,abi,name)=>name==='getUserInfo'?[true,f.state.claimable,0n,f.state.claimed,false]:name==='token'?[ZeroAddress]:[0n,f.state.phase];
 f.source.claim={mint,identity:identity.fingerprint,factory:factoryIdentity.fingerprint};
 const p=await openingApprovalPlan(f.engine,f.source);assert.equal(p.claimable,'800');assert.equal(p.amountIn,'900');assert.equal(p.protocolIdentities.length,2);
 f.state.claimable=0n;await assert.rejects(openingApprovalPlan(f.engine,f.source),/待领取数量/);f.state.claimable=800n;f.state.claimed=true;await assert.rejects(openingApprovalPlan(f.engine,f.source),/待领取数量/);
});
test('task manager defaults old tasks off, fans out opted-in rows, and invalidates in-flight preparation on edit/pause/restart',async t=>{
 const f=fixture(t),calls=[];f.engine.taskPreapprovals={run:async options=>calls.push(options)};
 const m=new OpeningSell({engine:f.engine,rpc:f.rpc,bridge:f.bridge,detector:f.detector,data:f.data,autoSchedule:false});t.after(()=>m.close());
 const j={id:'job',status:'ARMED',config:{asset:token,accounts:[1,2],percent:'50',currency:'AUTO'},bindings:bindings().slice(0,2),rows:[{account:1,status:'WAITING'},{account:2,status:'WAITING'}],mode:'SIMULATION',createdAt:Date.now(),expiresAt:Date.now()+100000,authorization:'synthetic'};m.jobs.set(j.id,j);
 m.prepareApprovals(j);assert.equal(calls.length,0);j.config.preApprove=true;m.prepareApprovals(j);assert.equal(calls.length,2);assert.equal(calls[0].allowed(),true);
 editOpening(m,j.id,{percent:'100'});assert.equal(calls[0].allowed(),false);m.prepareApprovals(j);assert.equal(calls[2].source.percent,'100');m.pause(j.id);assert.equal(calls[2].allowed(),false);
 j.status='ARMED';m.persist();const restarted=new OpeningSell({engine:f.engine,rpc:f.rpc,bridge:f.bridge,detector:f.detector,data:f.data,autoSchedule:false});t.after(()=>restarted.close());assert.equal(restarted.jobs.get(j.id).status,'PAUSED');
});
test('claim manager opt-in source preserves verified identity and stops authorizing as soon as opening/pausing/editing is observed',async t=>{
 const f=fixture(t),calls=[];f.engine.taskPreapprovals={run:async options=>calls.push(options)};
 const m=new CorlaAutomation({engine:f.engine,rpc:f.rpc,opening:{jobs:new Map()},data:f.data,autoSchedule:false});t.after(()=>m.close());
 const j={id:'claim-job',account:1,wallet:bindings()[0].address,mint,status:'WATCHING',policy:{expectedToken:token,sell:{percent:'50',currency:'AUTO',preApprove:true}},identity:{fingerprint:'mint-id'},protocolIdentities:[{fingerprint:'factory-id'}]};
 m.prepareApproval(j);assert.equal(calls.length,1);assert.equal(calls[0].source.claim.factory,'factory-id');assert.equal(calls[0].allowed(),true);j.openedAt=Date.now();assert.equal(calls[0].allowed(),false);delete j.openedAt;j.revision=1;assert.equal(calls[0].allowed(),false);
});

test('opening sale consumes confirmed early allowance and builds only the sale step with a fresh holding',async t=>{
 const f=fixture(t,{live:true});await f.run();f.state.liquid=true;
 const input={account:1,asset:token,side:'sell',percent:'50',currency:'AUTO',slippageBps:5000,slippageMode:'fixed',openingOnly:true};
 const plan=await openingPlan(f.rpc,{},input,{snapshot:await f.detector.scan(token),preparation:f.engine.openingPreparation});
 assert.equal(plan.steps.length,1);assert.equal(plan.steps[0].kind,'sell');assert.equal(plan.amountIn,'500');assert.equal(f.state.exec.length,1,'only mocked approval sent; no sale dispatched');
});
test('balance drift does not cause endless prepaid approvals; an explicit percentage edit permits a new exact allowance',async t=>{
 const f=fixture(t,{live:true});await f.run();f.state.balance=1100n;f.holder.preApproval.checkedAt=0;await f.run();assert.equal(f.holder.preApproval.status,'STALE');assert.equal(f.state.exec.length,1);
 f.source.percent='100';f.source.revision++;f.holder.preApproval.checkedAt=0;await f.run();assert.equal(f.state.exec.length,2);assert.equal(f.state.exec[1].amount,1100n);
});

test('strict primary task ignores early outsider liquidity without using sale attempts',async t=>{
 const f=fixture(t),m=new OpeningSell({engine:f.engine,rpc:f.rpc,bridge:f.bridge,detector:f.detector,data:f.data,autoSchedule:false});t.after(()=>m.close());
 const j={id:'main-task',status:'ARMED',config:{asset:token,accounts:[1],percent:'50',currency:'AUTO',preApprove:true},bindings:bindings().slice(0,1),rows:[{account:1,status:'WAITING',attempts:0}],expiresAt:Date.now()+100000};m.jobs.set(j.id,j);f.state.liquid=true;f.state.primary=false;
 await m.tick(j.id);assert.equal(j.status,'ARMED');assert.equal(j.rows[0].attempts,0);assert.equal(j.detectedAt,undefined);assert.equal(f.state.exec.length,0);
});
test('strict primary sale and pre-dispatch check reject a liquid outsider even when already approved',async t=>{
 const f=fixture(t);f.state.allowance=1000n;f.state.liquid=true;
 const intent={account:1,side:'sell',asset:token,percent:'50',currency:'AUTO',slippageBps:5000,openingOnly:true,primaryOnly:true};
 const plan=await openingPlan(f.rpc,{},intent,{scan:f.engine.openingScan,preparation:f.engine.openingPreparation});await verifyPrimaryTaskSale(f.engine,plan);
 f.state.primary=false;f.detector.watchRecent.clear();await assert.rejects(verifyPrimaryTaskSale(f.engine,plan),/主池/);
 await assert.rejects(openingPlan(f.rpc,{},intent,{scan:f.engine.openingScan,preparation:f.engine.openingPreparation}),/主池/);
});

test('strict main-pool recovery retains the constraint and never falls back to an opaque aggregator',async t=>{
 const f=fixture(t);f.state.allowance=1000n;f.state.liquid=true;
 const intent={account:1,side:'sell',asset:token,percent:'50',currency:'AUTO',slippageBps:5000,openingOnly:true,primaryOnly:true};
 const plan=await openingPlan(f.rpc,{},intent,{scan:f.engine.openingScan,preparation:f.engine.openingPreparation});
 const original={id:'failed-sale',intent,status:'FAILED',plan,error:{code:'TRANSACTION_REVERTED'},steps:[{status:'FAILED',step:plan.steps[0],plan,revertVerified:true,receipt:{status:'0x0'},txHash:'0x'+'99'.repeat(32)}]};
 let aggregates=0;const bridge={call:async()=>{aggregates++;throw Error('opaque route forbidden');}};
 const recovery=await openingRecoveryPlan(f.rpc,bridge,intent,original,{scan:f.engine.openingScan,preparation:f.engine.openingPreparation});assert.equal(recovery.kind,'contract');assert.equal(recovery.opening.pool,plan.opening.pool);assert.equal(aggregates,0);
 f.state.primary=false;await assert.rejects(openingRecoveryPlan(f.rpc,bridge,intent,original,{scan:f.engine.openingScan,preparation:f.engine.openingPreparation}),/主池/);assert.equal(aggregates,0);
});
