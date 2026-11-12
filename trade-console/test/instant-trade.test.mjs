import {executeReviewed,runReviewed} from './support/reviewed-execution.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {sellAmount,quotedSlippage} from '../lib/sell-policy.mjs';import {tradePlan} from '../lib/routes.mjs';
import {bindings,ERC20,BNB,validateIntent} from '../lib/common.mjs';import {Engine} from '../lib/engine.mjs';import {Batches} from '../lib/batch.mjs';
import {executeIndependent,runInstantTrades,tradeResultMessage,followSubmittedOrder} from '../public/trade-workflow.mjs';import {reviewSummary} from '../public/review-model.mjs';

test('receipt observation starts immediately after submission without an extra half-second delay',async()=>{
 const events=[];const order={id:'original',orderId:'42',status:'PENDING'};
 const done=await followSubmittedOrder(order,async id=>{events.push('read:'+id);return {...order,status:'CONFIRMED'};},{wait:async ms=>events.push('wait:'+ms)});
 assert.equal(done.status,'CONFIRMED');assert.deepEqual(events,['read:original']);
});
const token='0x'+'a'.repeat(40),wallets=bindings(),intent={account:1,side:'sell',asset:token,percent:'50',currency:'BNB',slippageBps:300,slippageMode:'auto'};
const buyIntent={...intent,side:'buy',amount:'0.01',slippageMode:'fixed'};
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'instant-trade-'));
const row=(account,status='PREPARED',review=[])=>({id:'order-'+account,intent:{...intent,account},status,review});
function fixture(balances=[10000n,0n,10000n],aggregate=false){
 const submitted=[],rpc={call:async tx=>{const a=ERC20.decodeFunctionData('balanceOf',tx.data)[0],idx=wallets.findIndex(w=>w.address.toLowerCase()===a.toLowerCase());return ERC20.encodeFunctionResult('balanceOf',[balances[idx]]);}};
 const bridge={ready:async()=>({}),call:async(account,args)=>{if(args[1]==='preview')return {requestId:String(account),simulationResult:{simulationCode:'000000000'}};if(args[1]==='swap'||args[1]==='execute'){submitted.push(account);balances[account-1]-=args[1]==='swap'?BigInt(args[args.indexOf('--fromTokenQty')+1]):balances[account-1]/2n;return args[1]==='swap'?{orderId:String(account)}:{txHash:'0x'+'ab'.repeat(32)};}if(args[1]==='list')return {list:[{orderId:String(account),status:'FINISHED'}]};throw Error('Unexpected mock command');}};
 const planFn=async i=>{const amount=sellAmount(balances[i.account-1],i.percent);return {kind:aggregate?'swap':'contract',poolFees:{version:1,poolFeePpm:3000,pools:[{address:'0x'+'18'.repeat(20),feePpm:3000}]},audit:{available:true,taxes:{sellTax:'0'}},wallet:wallets[i.account-1].address,token,inputToken:token,outputToken:BNB,amountIn:String(amount),holdingBefore:String(balances[i.account-1]),args:['--fromTokenQty',String(amount),'--slippage','3'],review:[],steps:aggregate?[]:[{kind:'sell',to:token,value:'0',data:'0x12345678'}]};};
 const engine=new Engine({data:temp(),rpc,bridge,live:true,planFn});engine.observeContract=async(o,e)=>{e.status='CONFIRMED';};
 return {balances,submitted,rpc,bridge,engine};
}
test('zero holdings skips before route probing; failed RPC is never zero',async()=>{
 const rpc={call:async tx=>{const f=ERC20.parseTransaction({data:tx.data}).name;assert.ok(['balanceOf','decimals'].includes(f));return ERC20.encodeFunctionResult(f,[f==='decimals'?18:0]);}};
 await assert.rejects(tradePlan(rpc,{call:()=>assert.fail('must not quote')},intent,token),e=>e.code==='NO_HOLDINGS');rpc.call=async()=>{throw Error('RPC down');};await assert.rejects(tradePlan(rpc,{},intent,token),/RPC down/);
 assert.throws(()=>sellAmount(1n,'50'),e=>e.code==='AMOUNT_TOO_SMALL');assert.equal(sellAmount(1n,'100'),1n);
});
test('auto suggestion pins 0.03 to 3 percent within cap; invalid/excessive suggestions block',()=>{
 assert.deepEqual(quotedSlippage(intent,{slippage:0.03}),{mode:'auto',bps:300,capBps:300});assert.throws(()=>quotedSlippage({...intent,slippageBps:100},{slippage:0.03}),e=>e.code==='SLIPPAGE_LIMIT');
 for(const s of [undefined,null,-1,3,'auto','NaN'])assert.throws(()=>quotedSlippage(intent,{slippage:s}));
 assert.equal(quotedSlippage({...intent,slippageMode:'fixed',slippageBps:100},{slippage:0.03}).bps,100);assert.throws(()=>validateIntent({...intent,slippageMode:'unknown'}));assert.throws(()=>validateIntent({...intent,side:'buy',amount:'1'}));
});
test('trade planner uses auto for quote only, numeric capped slippage for execution',async()=>{
 const rpc={getCode:async()=>'0x',getBlockNumber:async()=>1,call:async tx=>{try{const p=ERC20.parseTransaction({data:tx.data});if(p.name==='decimals')return ERC20.encodeFunctionResult(p.name,[18]);if(p.name==='balanceOf')return ERC20.encodeFunctionResult(p.name,[1000000000000000000n]);}catch{}throw Error('not registered');}};
 const calls=[],bridge={call:async(a,args)=>{calls.push(args);assert.equal(args.at(-1),'auto');return {toCoinAmount:'0.1',slippage:0.03};}};
 const p=await tradePlan(rpc,bridge,intent,token);assert.equal(p.args.at(-1),'3');assert.equal(p.slippage.capBps,300);assert.equal(p.amountIn,'500000000000000000');assert.equal(calls.length,1);
});
test('instant sell skips zero wallets and repeated 50 percent uses remaining balance',async()=>{
 const f=fixture([10000n,...wallets.slice(1).map(()=>0n)]);for(const id of ['first','second']){const rows=await Promise.all(wallets.map(w=>f.engine.prepare({...intent,account:w.account},id+w.account)));assert.deepEqual(rows.map(o=>o.status),['PREPARED',...wallets.slice(1).map(()=>'SKIPPED')]);assert.equal(reviewSummary(rows).canConfirm,true);const result=await executeIndependent(rows,o=>executeReviewed(f.engine,o.id,{authorization:'mock click'}),{ack:true});assert.equal(result[0].status,'CONFIRMED');assert.match(tradeResultMessage(result),/2 号：无持仓，已跳过/);}assert.equal(f.balances[0],2500n);assert.deepEqual(f.submitted,[1,1]);
});
test('independent wallets submit concurrently; pending/failure does not stop others',async()=>{
 const reached=[],release=[];const work=executeIndependent([row(1),row(2),row(3,'SKIPPED')],o=>new Promise(resolve=>{reached.push(o.intent.account);release.push(()=>resolve({...o,status:o.intent.account===1?'PENDING':'CONFIRMED'}));}));assert.deepEqual(reached,[1,2]);release.forEach(f=>f());assert.deepEqual((await work).map(o=>o.status),['PENDING','CONFIRMED','SKIPPED']);
 const failed=await executeIndependent([row(1),row(2)],async o=>{if(o.intent.account===1)throw Error('request timeout');return {...o,status:'CONFIRMED'};});assert.equal(failed[0].status,'SUBMISSION_UNKNOWN');assert.equal(failed[1].status,'CONFIRMED');
});
test('Binancians dashboard starts all wallets before any result; partial and pending cannot stop peers',async()=>{
 const rows=[1,2,3,4].map(account=>({...row(account),intent:{...intent,side:'mint',account},plan:{route:'binancians:mint',resolved:{platform:'binancians'}}})),seen=[],release=[];
 const work=executeIndependent(rows,o=>new Promise(resolve=>{seen.push(o.intent.account);release.push(()=>resolve({...o,status:['PARTIAL','PENDING','BLOCKED','CONFIRMED'][o.intent.account-1]}));}));
 assert.deepEqual(seen,[1,2,3,4]);release.forEach(r=>r());const results=await work;assert.deepEqual(results.map(o=>o.status),['PARTIAL','PENDING','BLOCKED','CONFIRMED']);assert.match(tradeResultMessage(results),/部分完成/);
 await executeIndependent(results,()=>assert.fail('completed/uncertain originals cannot replay'));
});
test('Binancians bot batch isolates failed first preparation and retains independent original IDs',async t=>{
 const data=temp();t.after(()=>fs.rmSync(data,{recursive:true,force:true}));const input={side:'mint',asset:token,scope:'all',quantity:'max',maxBnb:'0.0363'},seen=[],stored=new Map();
 const fake={live:true,data,prepare:async(i,id)=>{if(i.account===1)throw Error('fixture balance read failed');if(!stored.has(id))stored.set(id,{id,intent:i,status:'PREPARED',plan:{route:'binancians:mint',resolved:{platform:'binancians'}}});return stored.get(id);},run:async(i,id)=>{const o=await fake.prepare(i,id);if(o.status!=='PREPARED')return o;seen.push(i.account);o.status=i.account===2?'PARTIAL':i.account===3?'PENDING':'CONFIRMED';return o;}};
 const batch=new Batches(fake),request={id:'independent-binancians',accounts:[1,2,3,4],intent:input,execute:true,authorization:'synthetic only'},r=await batch.run(request);
 assert.deepEqual(seen,[2,3,4]);assert.deepEqual(r.orders.map(o=>o.status),['BLOCKED','PARTIAL','PENDING','CONFIRMED']);assert.equal(r.stoppedAt,undefined);assert.equal(r.orders[3].id,request.id+'-a4');await batch.run(request);assert.deepEqual(seen,[2,3,4]);
});
test('verified Corla wallets execute independently while generic mint retains its confirmation sequence',async()=>{
 const mintRow=a=>({...row(a),intent:{...intent,account:a,side:'mint'},plan:{route:'corla:mint',resolved:{platform:'corla'}}}),reached=[],release=[];
 const work=executeIndependent([mintRow(1),mintRow(2),{...mintRow(3),plan:{route:'generic:mint',resolved:{}}}],o=>new Promise(resolve=>{reached.push(o.intent.account);release.push(()=>resolve({...o,status:'PENDING'}));}));
 assert.deepEqual(reached,[1,2]);release.forEach(r=>r());const result=await work;assert.equal(result[2].status,'PREPARED');
 await executeIndependent(result,()=>assert.fail('pending original must not be resubmitted'));
});
test('Corla bot batch starts ready wallets independently and retains child IDs',async t=>{
 const data=temp();t.after(()=>fs.rmSync(data,{recursive:true,force:true}));const reached=[],release=[],stored=new Map();
 const input={side:'mint',asset:token,quantity:1,scope:'paid',maxBnb:'0.01'},fake={live:true,data,prepare:async(i,id)=>{const o=stored.get(id)||{id,intent:i,status:'PREPARED',plan:{route:'corla:mint',resolved:{platform:'corla'}}};stored.set(id,o);return o;},run:async(i,id)=>{const o=await fake.prepare(i,id);if(o.status!=='PREPARED')return o;return new Promise(resolve=>{reached.push(i.account);release.push(()=>{o.status='PENDING';resolve(o);});});}};
 const batch=new Batches(fake),work=batch.run({id:'corla-fake',intent:input,accounts:[1,2],execute:true,authorization:'fixture only'});await new Promise(r=>setImmediate(r));assert.deepEqual(reached,[1,2]);release.forEach(r=>r());const result=await work;assert.deepEqual(result.orders.map(o=>o.id),['corla-fake-a1','corla-fake-a2']);
 await batch.run({id:'corla-fake',intent:input,accounts:[1,2],execute:true,authorization:'fixture only'});assert.deepEqual(reached,[1,2]);
});
test('a verified Corla wallet with insufficient budget does not prevent other wallets from preparing',async t=>{
 const data=temp();t.after(()=>fs.rmSync(data,{recursive:true,force:true}));const seen=[],input={side:'mint',asset:token,quantity:1,maxBnb:'0.01',scope:'paid'},first={id:'corla-budget-a1',intent:{...input,account:1},project:{platform:'corla'},status:'BLOCKED',error:{code:'BUDGET_LIMIT'}};
 const engine={data,live:true,prepare:async()=>first,run:async(i,id)=>{seen.push(i.account);return i.account===1?first:{id,intent:i,status:'PREPARED'};}};
 const r=await new Batches(engine).run({id:'corla-budget',accounts:[1,2],intent:input,execute:true,authorization:'fixture only'});assert.deepEqual(seen,[1,2]);assert.equal(r.orders[1].status,'PREPARED');assert.equal(r.status,'INCOMPLETE');
});
test('instant mode retains risk review; confirming remaining rows cannot replay completed wallets',async()=>{
 const calls=[],rows=[row(1),row(2,'PREPARED',['risk'])],submit=async o=>{calls.push(o.intent.account);return {...o,status:'CONFIRMED'};};const r=await executeIndependent(rows,submit);assert.deepEqual(calls,[1]);assert.equal(r[1].status,'PREPARED');await executeIndependent(r,submit,{ack:true});assert.deepEqual(calls,[1,2]);await executeIndependent([row(1,'SUBMISSION_UNKNOWN'),row(2,'BLOCKED')],()=>assert.fail('not executable'));
});
test('duplicate rows submit once; all-zero wallets perform no execution calls',async()=>{
 let count=0;await executeIndependent([row(1),row(1)],async o=>{count++;return {...o,status:'CONFIRMED'};});assert.equal(count,1);const rows=[row(1,'SKIPPED'),row(2,'SKIPPED')];await executeIndependent(rows,()=>assert.fail('zero'));assert.equal(reviewSummary(rows).canConfirm,false);assert.match(reviewSummary(rows).message,/均无此代币持仓/);
});
test('CLI batch continues independent sells around skipped wallets and retains original IDs',async()=>{
 const f=fixture(),batch=new Batches({...f.engine,prepare:f.engine.prepare.bind(f.engine),run:(...args)=>runReviewed(f.engine,...args)});const result=await batch.run({id:'batch',accounts:[1,2,3],intent,execute:true,authorization:'mock click'});assert.equal(result.status,'CONFIRMED');assert.deepEqual(f.submitted.sort(),[1,3]);assert.equal(result.orders[1].status,'SKIPPED');await batch.run({id:'batch',accounts:[1,2,3],intent,execute:true,authorization:'mock repeat'});assert.equal(f.submitted.length,2);
});
test('receipt lookup timeout retains pending and blocks duplicate swap',async()=>{
 const f=fixture(undefined,true),original=f.bridge.call;f.bridge.call=async(a,args)=>{if(args[1]==='list')throw Error('network timeout');return original(a,args);};const r=await runReviewed(f.engine,buyIntent,'lookup-failure',{execute:true,authorization:'mock click'});assert.equal(r.status,'PENDING');assert.ok(r.orderId);assert.match(r.followError.providerMessage,/timeout/);await assert.rejects(f.engine.prepare(buyIntent,'new-order'),e=>e.code==='ORDER_UNRESOLVED'&&e.details.requestAccepted===false);assert.equal(f.submitted.length,1);
});
test('slippage rejection reconciles failed original order without retrying swap',async()=>{
 const f=fixture(undefined,true);let swaps=0;f.bridge.call=async(a,args)=>{if(args[1]==='swap'){swaps++;throw Object.assign(Error('slippage too low'),{code:30003001,dispatched:true});}assert.equal(args[1],'list');return {total:1,list:[{orderId:'failed-original',orderType:'market',chain:'56',fromToken:token,toToken:BNB,fromTokenQty:'5000',slippage:'3.0000',status:'FAILED',txHash:null,bookTime:new Date().toISOString()}]};};const r=await runReviewed(f.engine,buyIntent,'slippage-rejected',{execute:true,authorization:'mock click'});assert.equal(r.status,'FAILED');assert.equal(r.orderId,'failed-original');assert.match(r.error.message,/不会自动/);await executeReviewed(f.engine,'slippage-rejected',{authorization:'mock retry'});assert.equal(swaps,1);
});

test('one-request quick flow starts each ready wallet while another is still preparing',async()=>{
 const f=fixture(),original=f.engine.planFn;let release;const gate=new Promise(r=>release=r),plan=f.engine.plan.bind(f.engine);
 f.engine.plan=async i=>{if(i.account===2)await gate;return plan(i);};
 let finished;const fast=new Promise(r=>finished=r);const pending=runInstantTrades([row(1),row(2),row(3)],o=>runReviewed(f.engine,o.intent,o.id,{execute:true,authorization:'mock click'}),{onResult:o=>{if(o.intent.account===1)finished(o);}});
 assert.equal((await fast).status,'CONFIRMED');assert.ok(f.submitted.includes(1));assert.equal(f.engine.get('order-2')?.status==='CONFIRMED',false);release();const rows=await pending;assert.equal(rows[1].status,'SKIPPED');assert.equal(rows[2].status,'CONFIRMED');
});
test('one-request quick flow retains risk review and never retries uncertain requests',async()=>{
 const f=fixture(),plan=f.engine.plan.bind(f.engine);f.engine.plan=async i=>({...await plan(i),review:['new risk']});const rows=await runInstantTrades([row(1),row(2),row(1)],async o=>{if(o.intent.account===2)throw Error('connection lost');return runReviewed(f.engine,o.intent,o.id,{execute:true,authorization:'mock click'});});
 assert.equal(rows[0].status,'PREPARED');assert.equal(rows[0].needsReview,true);assert.equal(rows[1].status,'SUBMISSION_UNKNOWN');assert.deepEqual(f.submitted,[]);
});

test('dashboard fast return acknowledges submission without waiting for receipt and follows exactly the original order',async()=>{
 const f=fixture(undefined,true),original=f.bridge.call;let reads=0;f.bridge.call=async(a,args)=>{if(args[1]==='list')reads++;return original(a,args);};
 const o=await runReviewed(f.engine,buyIntent,'fast-return',{execute:true,authorization:'mock click',swapReceiptWaitMs:0});assert.equal(o.status,'PENDING');assert.equal(reads,0);assert.equal(f.submitted.length,1);
 const followed=await followSubmittedOrder(o,id=>f.engine.follow(id),{wait:async()=>{}});assert.equal(followed.status,'CONFIRMED');assert.equal(reads,1);assert.equal(f.submitted.length,1);
 await executeReviewed(f.engine,o.id,{authorization:'mock repeated click',swapReceiptWaitMs:0});assert.equal(f.submitted.length,1);
});
test('receipt tracker stays pending on read timeouts and never changes IDs or submits',async()=>{
 const o={id:'original',status:'PENDING',orderId:'42'},ids=[];const result=await followSubmittedOrder(o,async id=>{ids.push(id);throw Error('timeout');},{wait:async()=>{},attempts:3});assert.equal(result.status,'PENDING');assert.deepEqual(ids,['original','original','original']);
});
