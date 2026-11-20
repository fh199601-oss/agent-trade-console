// Real engine/coordinator with 100 synthetic bindings, fake RPC/wallet only.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const wallets=Array.from({length:100},(_,n)=>({account:n+1,address:'0x'+(0x10000+n).toString(16).padStart(40,'0')}));
const installHome=fs.mkdtempSync(path.join(os.tmpdir(),'synthetic-bindings-'));
process.env.AGENT_TRADE_HOME=installHome;
fs.writeFileSync(path.join(installHome,'install.json'),JSON.stringify({wallets,installationId:'isolated-wallet-test'}));
process.once('exit',()=>fs.rmSync(installHome,{recursive:true,force:true}));
globalThis.fetch=async()=>{throw Error('Network forbidden in hundred-wallet simulation');};
const {Engine}=await import('../lib/engine.mjs');
const {parallelWallets}=await import('../lib/parallel-wallets.mjs');
const {ERC20,WBNB,same,formatUnits,bindings}=await import('../lib/common.mjs');
const {DEXES,V2_ROUTER_ABI}=await import('../lib/opening-dex.mjs');
const {POOL}=await import('../lib/opening-pools.mjs');const {MULTI,MULTICALL}=await import('../lib/opening-read.mjs');
const {poolFeeProof}=await import('../lib/trade-fees.mjs');
const {TradePreparation}=await import('../lib/trade-preparation.mjs');
const {parallelSellProof}=await import('../lib/parallel-sell.mjs');
const token='0x'+'d2'.repeat(20),pair='0x'+'d3'.repeat(20),dex=DEXES.find(d=>d.id==='pancake-v2'),unit=10n**18n;
const tick=()=>new Promise(r=>setImmediate(r)),wait=ms=>new Promise(r=>setTimeout(r,ms));
const bounded=async(p,ms)=>{let timer;try{return await Promise.race([p,new Promise(r=>timer=setTimeout(r,ms))]);}finally{clearTimeout(timer);}};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const out=(x,ri,ro)=>x*9975n*ro/(ri*10000n+x*9975n);
const intent=account=>({account,side:'sell',asset:token,percent:'100',currency:'WBNB',slippageBps:300});
function record(account,ri=10000000000n*unit,ro=100n*unit,amount=1000n*unit,bps=300){
 const w=wallets[account-1],pool={...dex,pool:pair,token,token0:token,token1:WBNB,quote:WBNB,reserve0:String(ri),reserve1:String(ro),block:100};
 const gross=out(amount,ri,ro),credit=out(amount*98n/100n,ri,ro),min=gross*BigInt(10000-bps)/10000n;
 const plan={kind:'contract',account,wallet:w.address,route:dex.id+'-opening',token,inputToken:token,outputToken:WBNB,amountIn:String(amount),holdingBefore:String(amount),outputDecimals:18,decimals:18,
  opening:pool,state:pool,quote:{toCoinAmount:formatUnits(gross,18)},minOutput:String(min),poolFees:poolFeeProof(pool,[amount,gross],token,100),audit:{available:true,taxes:{sellTax:'0.02'}},requireSellCredit:true,slippage:{bps,mode:'fixed',capBps:bps},review:[],
  steps:[{kind:'sell',to:dex.router,value:'0',data:V2_ROUTER_ABI.encodeFunctionData('swapExactTokensForTokensSupportingFeeOnTransferTokens',[amount,min,[token,WBNB],w.address,Math.floor(Date.now()/1000)+120])}]};
 return {id:'hundred-'+account,plan,review:{balanceChanges:[{owner:w.address,contractAddress:WBNB,change:String(credit)}]},at:Date.now()};
}
async function fixture(t,{count=100,thin=false,failAccount=0,unknownAccount=0,slowAccount=0,latency=0,previewDelayMs=latency*3,submitDelayMs=latency*4,journalGate=null,stateGate=null,slippageBps=300,externalFills=[],previewCrashes=0,previewCrashCalls=[],autoRun=true,revertCounts={},netPercent=98n,reserveIn=null,revertOnMin=false,pendingObservations=0,amountForAccount=()=>1000n*unit,options={}}={}){
 assert.equal(bindings().length,100);const data=fs.mkdtempSync(path.join(os.tmpdir(),'hundred-wallets-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 let previewCount=0,externalSales=0;
 let ri=reserveIn??(thin?1000000n:10000000000n)*unit,ro=100n*unit,seq=0,block=100;
 const sent=[],requests=new Map(),receiptGate=deferred(),slowGate=deferred(),allSent=deferred(),target=count-(failAccount?1:0),balances=new Map(wallets.map(w=>[w.address.toLowerCase(),amountForAccount(w.account)]));
 const externalSell=()=>{const x=ri*414214n/1000000n,y=out(x,ri,ro);ri+=x;ro-=y;block++;externalSales++;};
 const rpc={getBlockNumber:async()=>block,call:async tx=>{
  if(latency)await wait(latency);
  const encode=tx=>{const abi=same(tx.to,token)?ERC20:same(tx.to,pair)?POOL:V2_ROUTER_ABI,f=abi.parseTransaction(tx);
   if(f.name.startsWith('swap')){if(out(f.args[0]*netPercent/100n,ri,ro)<f.args[1])throw Error('simulated eth_call: insufficient output');return '0x';}
   return abi.encodeFunctionResult(f.name,f.name==='balanceOf'?[balances.get(String(f.args[0]).toLowerCase())]:f.name==='allowance'?[1000000n*unit]:f.name==='getReserves'?[ri,ro,1]:[[f.args[0],out(f.args[0],ri,ro)]]);
  };
  if(same(tx.to,MULTICALL)){const f=MULTI.parseTransaction(tx);return MULTI.encodeFunctionResult(f.name,[block,'0x'+'0'.repeat(64),f.args[1].map(c=>[true,encode({to:c.target,data:c.callData})])]);}return encode(tx);
 }};
 const bridge={ready:async()=>{},call:async(account,args)=>{
  if(args[1]==='preview'){
   if(account===slowAccount)await slowGate.promise;
   if(previewDelayMs)await wait(previewDelayMs);
   if(++previewCount<=previewCrashes||previewCrashCalls.includes(previewCount))externalSell();
   if(account===failAccount)throw Object.assign(Error('模拟余额不足'),{code:'INSUFFICIENT_BALANCE'});
   const f=V2_ROUTER_ABI.parseTransaction({data:args[args.indexOf('--inputData')+1]}),id='synthetic-'+(++seq);requests.set(id,{account,f,used:false});
   return {requestId:id,simulationResult:{simulationCode:'000000000',balanceChanges:[{owner:wallets[account-1].address,contractAddress:WBNB,change:String(out(f.args[0]*netPercent/100n,ri,ro))}]}};
  }
  assert.equal(args[1],'execute');const r=requests.get(args.at(-1));assert.equal(r.account,account);assert.equal(r.used,false);r.used=true;sent.push({account,at:Date.now(),r});if(sent.length===target)allSent.resolve();
  if(submitDelayMs)await wait(submitDelayMs);
  if(account===unknownAccount)throw Object.assign(Error('模拟提交后连接中断'),{dispatched:true});
  return {txHash:'0x'+String(++seq).padStart(64,'0')};
 }};
 const engine=new Engine({data,rpc,bridge,live:true,planFn:async i=>record(i.account,ri,ro,amountForAccount(i.account),slippageBps).plan});
 const prepareParallel=engine.sellCoordinator.prepareParallel.bind(engine.sellCoordinator);let maxPreparationActive=0,maxPreparationLimit=0;
 engine.sellCoordinator.prepareParallel=async(...args)=>{const ticket=await prepareParallel(...args),group=engine.sellCoordinator.preparations.get(args[0]);maxPreparationActive=Math.max(maxPreparationActive,group?.active||0);maxPreparationLimit=Math.max(maxPreparationLimit,group?.limit||8);return ticket;};
 if(journalGate){const write=engine.writeAsync.bind(engine);engine.writeAsync=async o=>{const result=await write(o);if(o.status==='SUBMITTING'&&o.intent.account===1)await journalGate();return result;};}
 if(stateGate){const write=engine.writeAsync.bind(engine);engine.writeAsync=async o=>{await stateGate(o);return write(o);};}
 const observed=new Map(),receiptChecks=new Map(),appliedShocks=new Set(),settled=[];engine.observeContract=async(o,e)=>{
  if(!thin)await receiptGate.promise;
  if(e.status==='CONFIRMED')return;
  const checks=(receiptChecks.get(e.requestId)||0)+1;receiptChecks.set(e.requestId,checks);if(checks<=pendingObservations)return false;
  const account=o.intent.account,attempt=(observed.get(account)||0)+1;observed.set(account,attempt);if(attempt<=(revertCounts[account]||0)){e.status='FAILED';e.revertVerified=true;e.receipt={status:'0x0',blockNumber:'0x'+(++block).toString(16)};o.status='FAILED';e.error=o.error={code:'TRANSACTION_REVERTED',message:'模拟外部价格变化导致链上回滚'};return;}
  if(externalFills.includes(settled.length)&&!appliedShocks.has(settled.length)){appliedShocks.add(settled.length);externalSell();}
  const f=V2_ROUTER_ABI.parseTransaction(e.step),x=f.args[0]*netPercent/100n,y=out(x,ri,ro);
  if(revertOnMin&&y<f.args[1]){e.status='FAILED';e.revertVerified=true;e.receipt={status:'0x0',blockNumber:'0x'+(++block).toString(16)};o.status='FAILED';e.error=o.error={code:'TRANSACTION_REVERTED',message:'模拟实际价格跌穿本笔最低到账'};return;}
  assert.ok(y>=f.args[1],'all real minima preserved after earlier simulated sales');
  ri+=x;ro-=y;block++;balances.set(o.plan.wallet.toLowerCase(),0n);e.status='CONFIRMED';e.confirmedAt=Date.now();e.receipt={status:'0x1',blockNumber:'0x'+block.toString(16)};settled.push({account:o.intent.account,credit:y,minimum:f.args[1]});
 };
 const start=Date.now(),running=autoRun?parallelWallets(wallets.slice(0,count),w=>engine.run({...intent(w.account),slippageBps},'hundred-'+w.account,{execute:true,authorization:'synthetic simulation only',swapReceiptWaitMs:0,...options})):null;
 return {data,engine,sent,settled,requests,start,running,allSent,receiptGate,slowGate,target,externalSales:()=>externalSales,preparationStats:()=>({maxPreparationActive,maxPreparationLimit})};
}
test('100 wallets: whole-group impact proof preserves every minimum across shuffled fill orders',()=>{
 const rows=wallets.map(w=>record(w.account));assert.ok(parallelSellProof(rows));
 for(let trial=0;trial<10;trial++){
  const order=[...rows];let seed=trial+1;for(let i=order.length-1;i>0;i--){seed=(seed*1664525+1013904223)>>>0;const j=seed%(i+1);[order[i],order[j]]=[order[j],order[i]];}
  let ri=BigInt(rows[0].plan.opening.reserve0),ro=BigInt(rows[0].plan.opening.reserve1);
  for(const {plan:p}of order){const x=BigInt(p.amountIn)*98n/100n,y=out(x,ri,ro);assert.ok(y>=BigInt(p.minOutput));ri+=x;ro-=y;}
 }
 assert.equal(parallelSellProof(wallets.map(w=>record(w.account,1000000n*unit))),null);
});
test('100-wallet engine dispatches before any receipt; one failed and one unknown wallet do not hold peers',async t=>{
 const f=await fixture(t,{failAccount:27,unknownAccount:62});
 await bounded(f.allSent.promise,12000);const before=f.sent.length;f.receiptGate.resolve();const results=await f.running;
 assert.equal(before,99,JSON.stringify(results.filter(o=>!['CONFIRMED','SUBMISSION_UNKNOWN'].includes(o.status)).map(o=>({a:o.intent.account,e:o.error}))));
 assert.equal(results[26].status,'BLOCKED');assert.equal(results[61].status,'SUBMISSION_UNKNOWN');assert.equal(results.filter(o=>o.status==='CONFIRMED').length,98);
 assert.ok(results.filter(o=>o.status==='CONFIRMED').every(o=>o.plan.slippage.bps===300));
 await f.engine.execute('hundred-62',{authorization:'duplicate'});assert.equal(f.sent.filter(x=>x.account===62).length,1);
 assert.equal(f.engine.running.size,0);assert.equal(f.engine.sellCoordinator.parallel.size,0);assert.equal(f.engine.sellCoordinator.tails.size,0);
 t.diagnostic(JSON.stringify({simulationOnly:true,wallets:100,submitted:before,firstDispatchMs:f.sent[0].at-f.start,lastDispatchMs:f.sent.at(-1).at-f.start,confirmed:98,failedBeforeSubmit:1,originalUnknown:1}));
});
test('100-wallet thin pool re-quotes after changing prices, never widens slippage or strands a lane',async t=>{
 const f=await fixture(t,{thin:true});const results=await f.running;
 assert.equal(results.filter(o=>o.status==='CONFIRMED').length,100,JSON.stringify(results.filter(o=>o.status!=='CONFIRMED').map(o=>({a:o.intent.account,e:o.error}))));
 assert.equal(f.sent.length,100);assert.equal(new Set(f.sent.map(x=>x.account)).size,100);assert.ok(f.settled.at(-1).credit<f.settled[0].credit);
 assert.ok(results.every(o=>o.plan.slippage.bps===300&&o.plan.opening.pool===pair));assert.equal(f.engine.sellCoordinator.tails.size,0);assert.equal(f.engine.running.size,0);
 t.diagnostic(JSON.stringify({simulationOnly:true,thinPoolWallets:100,allConfirmedMs:Date.now()-f.start,firstCredit:String(f.settled[0].credit),lastCredit:String(f.settled.at(-1).credit)}));
});
test('one slow preview does not prevent the other 99 wallets from dispatching',async t=>{
 const f=await fixture(t,{slowAccount:1});const until=Date.now()+12000;while(f.sent.length<99&&Date.now()<until)await tick();
 const before=f.sent.length;f.slowGate.resolve();await bounded(f.allSent.promise,12000);f.receiptGate.resolve();const results=await f.running;
 assert.equal(before,99);assert.equal(results.filter(o=>o.status==='CONFIRMED').length,100,JSON.stringify(results.filter(o=>o.status!=='CONFIRMED').map(o=>[o.intent.account,o.status,o.error])));assert.equal(f.sent.length,100);
});
test('100-wallet warmup is bounded and fair; foreground consumption cancels queued work',async()=>{
 const seen=[],gates=new Map(),cache=new TradePreparation({plan:async i=>{seen.push(i.account);const gate=deferred();gates.set(i.account,gate);await gate.promise;return record(i.account).plan;},preview:async()=>({raw:{requestId:'unsigned-only'},at:Date.now()})});
 assert.equal(cache.requestMany(wallets.map(w=>intent(w.account))),100);await tick();assert.equal(seen.length,4);
 cache.take(intent(77));
 while(cache.pending.size||cache.queued.size){for(const gate of gates.values())gate.resolve();await tick();assert.ok(cache.pending.size<=4);}
 assert.equal(seen.length,99);assert.equal(seen.includes(77),false);assert.equal(new Set(seen).size,99);cache.close();
 const stopped=new TradePreparation({plan:async i=>record(i.account).plan,preview:async()=>({})});let allowed=true;stopped.requestMany(wallets.map(w=>intent(w.account)),()=>allowed);allowed=false;await tick();assert.equal(stopped.pending.size,0);assert.equal(stopped.queued.size,0);assert.equal(stopped.entries.size,0);
});
test('100 opening wallets: transient retry runs while another wallet preview is still pending',async t=>{
 const {OpeningSell}=await import('../lib/opening-sell.mjs'),data=fs.mkdtempSync(path.join(os.tmpdir(),'hundred-opening-')),gate=deferred(),retried=deferred(),orders=new Map(),submissions=new Map(),prepares=new Map();
 const engine={live:true,prepare:async(i,id)=>{prepares.set(i.account,(prepares.get(i.account)||0)+1);if(i.account===1)await gate.promise;const o={id,intent:i,status:'PREPARED',review:[],steps:[]};orders.set(id,o);return o;},execute:async id=>{const o=orders.get(id),a=o.intent.account;submissions.set(a,(submissions.get(a)||0)+1);if(a===2&&submissions.get(a)===1)return {...o,status:'BLOCKED',error:{code:'SELL_POOL_BUSY',message:'synthetic pre-submit queue failure'}};if(a===3)return {...o,status:'SUBMISSION_UNKNOWN'};if(a===2)retried.resolve();return {...o,status:'CONFIRMED'};}};
 const m=new OpeningSell({engine,rpc:{},bridge:{},detector:{},data,autoSchedule:true});
 const j={id:'hundred-opening',config:{asset:token,accounts:wallets.map(w=>w.account),percent:'100',slippageBps:300,currency:'WBNB'},status:'FIRING',expiresAt:Date.now()+60000,detectedAt:Date.now(),authorization:'synthetic only',rows:wallets.map(w=>({account:w.account,status:'WAITING',attempts:0}))};m.jobs.set(j.id,j);
 t.after(()=>{gate.resolve();m.close();fs.rmSync(data,{recursive:true,force:true});});
 const running=Promise.all(j.rows.map(r=>m.fire(j,r)));await bounded(retried.promise,3000);
 assert.equal(submissions.get(2),2);assert.equal(submissions.get(1),undefined);assert.equal(submissions.get(3),1);assert.equal(j.rows[2].status,'REVIEW');assert.equal(submissions.size,99);gate.resolve();await running;m.close();assert.equal(j.rows.filter(r=>r.status==='CONFIRMED').length,99);assert.equal(m.rowBusy.size,0);assert.equal(m.retryTimers.size,0);
});
test('cached 100-wallet proof cannot survive changed calldata, fee evidence, age or unknown status',()=>{
 const rows=wallets.map(w=>record(w.account)),cache=new Map(),now=Date.now();assert.ok(parallelSellProof(rows,now,cache));assert.ok(cache.size===100);
 for(const change of [r=>r.plan.steps[0].to=token,r=>r.plan.minOutput='1',r=>r.plan.poolFees.block=999,r=>r.status='FAILED',r=>r.at=now-16000]){const copy=structuredClone(rows);change(copy[40]);assert.equal(parallelSellProof(copy,now,cache),null);}
});
test('independent opening retries stop on pause or changed wallet binding',async t=>{
 const {OpeningSell}=await import('../lib/opening-sell.mjs'),data=fs.mkdtempSync(path.join(os.tmpdir(),'hundred-pause-'));let calls=0;
 const m=new OpeningSell({engine:{prepare:async()=>{calls++;assert.fail('no dispatch');}},rpc:{},bridge:{},detector:{},data});t.after(()=>{m.close();fs.rmSync(data,{recursive:true,force:true});});
 const j={id:'pause-test',status:'ARMED',expiresAt:Date.now()+60000,config:{},rows:[{account:1,status:'WAITING',attempts:0,retryAt:Date.now()+25}],bindings:[{account:1,address:wallets[0].address}]};m.jobs.set(j.id,j);m.scheduleRetry(j,j.rows[0]);j.status='PAUSED';await wait(60);assert.equal(calls,0);assert.equal(m.retryTimers.size,0);
 j.status='ARMED';j.bindings[0].address=token;await m.fire(j,j.rows[0]);assert.equal(j.status,'PAUSED');assert.equal(calls,0);
});
test('real wallet bridge keeps 100 queues independent and isolates a failed wallet',async()=>{
 const {Wallets}=await import('../lib/wallet.mjs'),bridge=new Wallets(),states=new Map(),sent=[];
 bridge.worker=a=>{if(!states.has(a))states.set(a,{ready:Promise.resolve(),pending:new Map(),process:{stdin:{write(line,cb){sent.push({account:a,...JSON.parse(line)});cb?.();}}}});return states.get(a);};
 const pending=wallets.map(w=>bridge.call(w.account,['contract-call','execute','--requestId','synthetic-'+w.account]).then(value=>({value}),error=>({error})));
 await tick();assert.equal(sent.length,100);assert.equal(new Set(sent.map(r=>r.account)).size,100);
 for(const row of sent)if(row.account!==1)bridge.receive(states.get(row.account),{id:row.id,result:row.account===27?{success:false,error:{message:'模拟钱包拒绝',commandDispatched:false}}:{success:true,data:{synthetic:true}}});
 const peers=await Promise.all(pending.slice(1));assert.equal(peers.filter(r=>r.value).length,98);assert.equal(peers.filter(r=>r.error).length,1);assert.equal(bridge.queues.size,1);
 bridge.receive(states.get(1),{id:sent[0].id,result:{success:true,data:{synthetic:true}}});await pending[0];assert.equal(bridge.queues.size,0);assert.equal([...states.values()].reduce((n,s)=>n+s.pending.size,0),0);
});
test('100 wallets: one slow journal cannot stall peers or let its own order submit early',async t=>{
 const gate=deferred(),f=await fixture(t,{journalGate:()=>gate.promise});t.after(()=>{gate.resolve();f.receiptGate.resolve();});
 const until=Date.now()+12000;while(f.sent.length<99&&Date.now()<until)await tick();assert.equal(f.sent.length,99);assert.equal(f.sent.some(r=>r.account===1),false);assert.equal(f.engine.get('hundred-1').status,'SUBMITTING');
 const original=await f.engine.execute('hundred-1',{authorization:'duplicate click'});assert.equal(original.duplicateSuppressed,true);assert.equal(f.sent.length,99);
 gate.resolve();await bounded(f.allSent.promise,12000);f.receiptGate.resolve();const results=await f.running;assert.equal(results.filter(o=>o.status==='CONFIRMED').length,100);assert.equal(f.sent.length,100);
});
test('pause during commit durability wait cancels the unsent sale',async t=>{
 const gate=deferred();let allowed=true;const f=await fixture(t,{count:1,journalGate:()=>gate.promise,options:{continueAllowed:()=>allowed}});t.after(()=>{gate.resolve();f.receiptGate.resolve();});
 const until=Date.now()+3000;while(f.engine.get('hundred-1')?.status!=='SUBMITTING'&&Date.now()<until)await tick();assert.equal(f.engine.get('hundred-1').status,'SUBMITTING');allowed=false;gate.resolve();f.receiptGate.resolve();const [o]=await f.running;
 assert.equal(o.status,'CANCELLED');assert.equal(f.sent.length,0);assert.equal(o.steps.length,0);assert.equal(f.engine.running.size,0);assert.equal(f.engine.sellCoordinator.parallel.size,0);
});
test('commit durability failure never calls the wallet submit handler',async t=>{
 const f=await fixture(t,{count:1,journalGate:()=>{throw Object.assign(Error('synthetic durability error'),{code:'EIO'});}});f.receiptGate.resolve();const [o]=await f.running;
 assert.equal(f.sent.length,0);assert.equal(o.status,'BLOCKED');assert.equal(o.error.code,'EIO');assert.equal(f.engine.running.size,0);
});
test('100-wallet deep pool completes with bounded fake RPC and wallet latency',async t=>{
 const f=await fixture(t,{latency:5});t.after(()=>f.receiptGate.resolve());await bounded(f.allSent.promise,12000);const sent=f.sent.length;f.receiptGate.resolve();const rows=await f.running;
 assert.equal(sent,100);assert.equal(rows.filter(o=>o.status==='CONFIRMED').length,100);assert.equal(new Set(f.sent.map(x=>x.account)).size,100);assert.equal(f.engine.running.size,0);assert.equal(f.engine.sellCoordinator.parallel.size,0);
 t.diagnostic(JSON.stringify({simulationOnly:true,deepPoolWallets:100,firstDispatchMs:f.sent[0].at-f.start,lastDispatchMs:f.sent.at(-1).at-f.start,allConfirmedMs:Date.now()-f.start,rpcDelayMs:5,previewDelayMs:15,submitDelayMs:20}));
});
test('restart view of a published commit reservation suppresses a second submission',async t=>{
 const gate=deferred(),f=await fixture(t,{count:1,journalGate:()=>gate.promise});t.after(()=>{gate.resolve();f.receiptGate.resolve();});
 const until=Date.now()+3000;while(f.engine.get('hundred-1')?.status!=='SUBMITTING'&&Date.now()<until)await tick();assert.equal(f.engine.get('hundred-1').status,'SUBMITTING');
 const restored=new Engine({data:f.engine.data,rpc:f.engine.rpc,bridge:f.engine.bridge,live:true,planFn:f.engine.planFn});assert.equal(restored.get('hundred-1').status,'SUBMISSION_UNKNOWN');const original=await restored.execute('hundred-1',{authorization:'same synthetic order'});assert.equal(original.duplicateSuppressed,true);assert.equal(f.sent.length,0);
 gate.resolve();await bounded(f.allSent.promise,3000);f.receiptGate.resolve();await f.running;assert.equal(f.sent.length,1);
});
test('a thin-pool successor waits for the durable confirmation, without polling a stale pending original',async t=>{
 const gate=deferred(),started=deferred();let held=null,follows=0;
 const f=await fixture(t,{count:2,thin:true,stateGate:async o=>{if(o.status==='CONFIRMED'&&held===null){held=o.id;started.resolve();await gate.promise;}}});t.after(()=>gate.resolve());
 const follow=f.engine.follow.bind(f.engine);f.engine.follow=(...args)=>{follows++;return follow(...args);};
 await bounded(started.promise,3000);assert.ok(held);await tick();await tick();assert.equal(f.sent.length,1);assert.equal(follows,0);
 assert.equal(f.engine.get(held).status,'PENDING');gate.resolve();const rows=await f.running;
 assert.equal(rows.filter(o=>o.status==='CONFIRMED').length,2);assert.ok(rows.every(o=>o.nextStep===o.plan.steps.length));assert.equal(follows,0);assert.equal(f.engine.running.size,0);assert.equal(f.engine.sellCoordinator.parallel.size,0);assert.equal(f.engine.sellCoordinator.tails.size,0);
});
async function openingJournal(t,count=100){
 const {OpeningSell}=await import('../lib/opening-sell.mjs'),data=fs.mkdtempSync(path.join(os.tmpdir(),'hundred-opening-journal-')),orders=new Map(),sent=[];
 const j={id:'synthetic-journal',config:{asset:token,accounts:wallets.slice(0,count).map(w=>w.account),percent:'100',slippageBps:300,currency:'WBNB'},status:'FIRING',createdAt:Date.now(),detectedAt:Date.now(),expiresAt:Date.now()+60000,authorization:'synthetic only',rows:wallets.slice(0,count).map(w=>({account:w.account,status:'WAITING',attempts:0}))};
 let prepares=0,saves=0;
 const engine={live:true,get:id=>orders.get(id),prepare:async(i,id)=>{prepares++;const o={id,intent:i,status:'PREPARED',steps:[],review:[]};orders.set(id,o);return o;},execute:async(id,options)=>{
  const o=orders.get(id),saved=JSON.parse(fs.readFileSync(path.join(data,'opening-sell.json')))[0],row=saved.rows.find(r=>r.orderId===id);
  assert.ok(row.commitStartedAt);assert.equal(row.submittedPercent,'100');assert.equal(row.status,'TRACKING');
  if(!options.continueAllowed())return {...o,status:'CANCELLED'};
  sent.push({account:o.intent.account,at:Date.now()});return {...o,status:'CONFIRMED'};
 }};
 const m=new OpeningSell({engine,rpc:{},bridge:{},detector:{},data,autoSchedule:false});m.jobs.set(j.id,j);const persist=m.persist.bind(m);m.persist=()=>{saves++;persist();};
 t.after(()=>{m.close();fs.rmSync(data,{recursive:true,force:true});});return {m,j,sent,stats:()=>({prepares,saves})};
}
test('100 opening wallets share durable snapshots before submission, without 300 per-row flushes',async t=>{
 const {m,j,sent,stats}=await openingJournal(t),start=Date.now();await parallelWallets(j.rows,r=>m.fire(j,r));
 assert.equal(sent.length,100);assert.equal(new Set(sent.map(r=>r.account)).size,100);assert.equal(j.rows.filter(r=>r.status==='CONFIRMED').length,100);
 assert.equal(JSON.parse(fs.readFileSync(m.file))[0].rows.filter(r=>r.status==='CONFIRMED').length,100);assert.ok(stats().saves<150,JSON.stringify(stats()));assert.equal(m.rowBusy.size,0);
 t.diagnostic(JSON.stringify({simulationOnly:true,openingWallets:100,allConfirmedMs:Date.now()-start,firstDispatchMs:sent[0].at-start,lastDispatchMs:sent.at(-1).at-start,durableSnapshots:stats().saves}));
});
test('a failed opening commit flush prevents every affected submit and releases row guards',async t=>{
 const {m,j,sent}=await openingJournal(t,2),persist=m.persist.bind(m);let failed=false;
 m.persist=()=>{if(!failed&&j.rows.some(r=>r.commitStartedAt)){failed=true;throw Object.assign(Error('synthetic disk failure'),{code:'EIO'});}persist();};
 await Promise.all(j.rows.map(r=>m.fire(j,r)));assert.ok(failed);assert.equal(sent.length,0);assert.ok(j.rows.every(r=>r.status==='REVIEW'&&r.error.code==='EIO'));assert.equal(m.rowBusy.size,0);assert.equal(m.retryTimers.size,0);
});
test('pause while opening persistence is queued is retained and prevents submission',async t=>{
 const {m,j,sent,stats}=await openingJournal(t,2),pending=Promise.all(j.rows.map(r=>m.fire(j,r)));m.pause(j.id);await pending;
 assert.equal(stats().prepares,2);assert.equal(sent.length,0);assert.equal(j.status,'PAUSED');assert.equal(JSON.parse(fs.readFileSync(m.file))[0].status,'PAUSED');assert.equal(m.rowBusy.size,0);assert.equal(m.retryTimers.size,0);
});

test('100 shallow-pool wallets at fixed 99% survive five external price halvings without a receipt queue',async t=>{
 const f=await fixture(t,{thin:true,slippageBps:9900,latency:5,externalFills:[0,20,40,60,80]});
 const rows=await f.running;
 assert.equal(rows.filter(o=>o.status==='CONFIRMED').length,100,JSON.stringify(rows.filter(o=>o.status!=='CONFIRMED').map(o=>({a:o.intent.account,s:o.status,e:o.error,fee:o.feeReview,refresh:o.priceRefreshes}))));
 assert.equal(f.externalSales(),5);assert.equal(f.sent.length,100);assert.equal(new Set(f.sent.map(x=>x.account)).size,100);
 assert.ok(rows.every(o=>o.plan.slippage.bps===9900&&o.plan.opening.pool===pair));assert.ok(f.settled.at(-1).credit*10n<f.settled[0].credit);
 assert.equal(f.engine.running.size,0);assert.equal(f.engine.sellCoordinator.tails.size,0);assert.equal(f.engine.sellCoordinator.parallel.size,0);
 t.diagnostic(JSON.stringify({simulationOnly:true,wallets:100,externalPriceHalvings:5,slippagePercent:99,firstDispatchMs:f.sent[0].at-f.start,lastDispatchMs:f.sent.at(-1).at-f.start,allConfirmedMs:Date.now()-f.start}));
});
test('100 shallow-pool wallets at fixed 90% survive three external price halvings; one failure does not stop peers',async t=>{
 const f=await fixture(t,{thin:true,slippageBps:9000,failAccount:27,externalFills:[0,35,70]});const rows=await f.running;
 assert.equal(rows.filter(o=>o.status==='CONFIRMED').length,99);assert.equal(rows[26].status,'BLOCKED');assert.equal(f.sent.length,99);assert.equal(f.externalSales(),3);
 assert.ok(rows.filter(o=>o.status==='CONFIRMED').every(o=>o.plan.slippage.bps===9000));assert.equal(f.engine.sellCoordinator.tails.size,0);
});
test('wide-slippage proof models all 100 peer sales, rejects unsafe minima and never treats an auto cap as actual slippage',()=>{
 const rows=wallets.map(w=>record(w.account,1000000n*unit,100n*unit,1000n*unit,9000));
 const proof=parallelSellProof(rows);assert.equal(proof.version,2);assert.equal(proof.wallets,100);assert.equal(proof.externalQuoteDropPpm,250000);
 const unsafe=wallets.map(w=>record(w.account,10000n*unit,100n*unit,1000n*unit,5000));assert.equal(parallelSellProof(unsafe),null);
 const auto=wallets.map(w=>record(w.account,1000000n*unit));auto.forEach(r=>r.plan.slippage={mode:'auto',bps:300,capBps:9900});assert.equal(parallelSellProof(auto),null);
 for(const change of [r=>r.plan.steps[0].to=token,r=>r.plan.poolFees.block=999,r=>r.review.balanceChanges[0].change='0']){const copy=structuredClone(rows);change(copy[50]);assert.equal(parallelSellProof(copy),null);}
});
test('unsigned stale preview refreshes the same pool under original slippage; persistent failure stops without dispatch',async t=>{
 const f=await fixture(t,{count:1,thin:true,slippageBps:300,previewCrashes:1});const [o]=await f.running;
 assert.equal(o.status,'CONFIRMED',JSON.stringify(o.error));assert.equal(f.sent.length,1);assert.equal(o.priceRefreshes.length,1);assert.equal(o.plan.opening.pool,pair);assert.equal(o.plan.slippage.bps,300);
 const g=await fixture(t,{count:1,thin:true,slippageBps:300,previewCrashes:100});const [blocked]=await g.running;
 assert.equal(blocked.status,'BLOCKED');assert.equal(g.sent.length,0);assert.equal(blocked.priceRefreshes.length,3);assert.equal(g.engine.running.size,0);assert.equal(g.engine.sellCoordinator.tails.size,0);
});

test('100 opening wallets: proven price reverts retry independently and all holdings sell once',async t=>{
 const revertCounts=Object.fromEntries(wallets.slice(0,50).map(w=>[w.account,w.account<=25?1:2]));
 const f=await fixture(t,{thin:true,slippageBps:9000,autoRun:false,revertCounts,latency:2});
 const {OpeningSell}=await import('../lib/opening-sell.mjs');
 const m=new OpeningSell({engine:f.engine,rpc:{},bridge:{},detector:{scan:async()=>({open:true,pools:[]})},data:f.data,autoSchedule:false});t.after(()=>m.close());
 const j={id:'shallow-revert-100',config:{asset:token,accounts:wallets.map(w=>w.account),percent:'100',slippageBps:9000,currency:'WBNB'},bindings:wallets,recoveryVersion:2,status:'ARMED',mode:'LIVE',createdAt:Date.now(),expiresAt:Date.now()+60000,authorization:'synthetic only',rows:wallets.map(w=>({account:w.account,status:'WAITING',attempts:0}))};m.jobs.set(j.id,j);
 for(let n=0;n<4;n++)await m.tick(j.id);
 assert.equal(j.rows.filter(r=>r.status==='CONFIRMED').length,100,JSON.stringify(j.rows.filter(r=>r.status!=='CONFIRMED').map(r=>({a:r.account,s:r.status,e:r.error}))));
 assert.equal(f.settled.length,100);assert.equal(new Set(f.settled.map(x=>x.account)).size,100);assert.equal(f.sent.length,175);
 for(const r of j.rows){assert.equal(r.recoveryAttempts||0,revertCounts[r.account]||0);for(const old of r.previousOrders||[])assert.equal(f.engine.get(old.id).status,'FAILED');}
 assert.equal(f.engine.running.size,0);assert.equal(m.rowBusy.size,0);assert.equal(f.engine.sellCoordinator.tails.size,0);
 t.diagnostic(JSON.stringify({simulationOnly:true,wallets:100,verifiedReverts:75,confirmedSales:100,allConfirmedMs:Date.now()-f.start}));
});

test('99% slippage never bypasses genuine high tax after fresh same-pool comparisons',async t=>{
 const f=await fixture(t,{count:1,thin:true,slippageBps:9900,netPercent:10n});const [o]=await f.running;
 assert.equal(f.sent.length,0);assert.equal(o.needsFeeReview,true);assert.ok(o.feeReview.additionalLossPpm>800000);assert.ok(o.priceRefreshes.length<=6);assert.equal(f.engine.running.size,0);
});
test('combined impact and sub-50% stale-quote loss refresh, while persistent combined fees still stop',async t=>{
 const f=await fixture(t,{count:1,thin:true,slippageBps:9900,reserveIn:10000n*unit,previewCrashes:1});const [o]=await f.running;
 assert.equal(o.status,'CONFIRMED',JSON.stringify(o.feeReview));assert.equal(f.sent.length,1);assert.equal(o.priceRefreshes.length,1);assert.equal(o.plan.opening.pool,pair);assert.equal(o.plan.slippage.bps,9900);
 const g=await fixture(t,{count:1,thin:true,slippageBps:9900,reserveIn:10000n*unit,netPercent:50n});const [blocked]=await g.running;
 assert.equal(g.sent.length,0);assert.equal(blocked.needsFeeReview,true);assert.ok(blocked.feeReview.additionalLossPpm<500000);assert.ok(blocked.feeReview.totalFeePpm>=500000);assert.equal(blocked.priceRefreshes.length,6);assert.equal(g.engine.running.size,0);
});

test('a later unsigned execution preview has its own bounded refresh budget after preparation price moves',async t=>{
 const f=await fixture(t,{count:1,thin:true,autoRun:false,slippageBps:9900,reserveIn:10000n*unit,previewCrashCalls:[1,2,3,4,5,6,8]});
 const o=await f.engine.prepare({...intent(1),slippageBps:9900},'fresh-phase-budget');
 assert.equal(o.status,'PREPARED');assert.equal(o.needsFeeReview,false);assert.equal(o.priceRefreshes.length,6);
 o.previewAt=Date.now()-1100;await f.engine.writeAsync(o);f.engine.previews.delete(o.id);
 const done=await f.engine.execute(o.id,{authorization:'synthetic only',swapReceiptWaitMs:0});
 assert.equal(done.status,'CONFIRMED',JSON.stringify(done.feeReview));assert.equal(f.sent.length,1);assert.equal(done.priceRefreshes.length,7);
 assert.equal(done.plan.opening.pool,pair);assert.equal(done.plan.slippage.bps,9900);assert.equal(f.engine.running.size,0);
});

test('new high fees after a resolved price episode stay blocked with a bounded budget across repeated execution',async t=>{
 const f=await fixture(t,{count:1,thin:true,autoRun:false,slippageBps:9900,reserveIn:10000n*unit,previewCrashCalls:[1,2,3,4,5,6]});
 const o=await f.engine.prepare({...intent(1),slippageBps:9900},'high-fees-after-refresh');
 assert.equal(o.needsFeeReview,false);assert.equal(o.priceRefreshes.length,6);
 const call=f.engine.bridge.call;f.engine.bridge.call=async(account,args)=>{const result=await call(account,args);if(args[1]==='preview')for(const change of result.simulationResult.balanceChanges)change.change=String(BigInt(change.change)/10n);return result;};
 o.previewAt=Date.now()-1100;await f.engine.writeAsync(o);f.engine.previews.delete(o.id);
 for(let i=0;i<2;i++){
  const blocked=await f.engine.execute(o.id,{authorization:'synthetic only',swapReceiptWaitMs:0});
  assert.equal(blocked.needsFeeReview,true);assert.ok(blocked.feeReview.totalFeePpm>=500000);assert.equal(blocked.priceRefreshes.length,12);assert.equal(blocked.priceRefreshCheckpoint,6);
  assert.equal(f.sent.length,0);assert.equal(f.engine.running.size,0);
 }
});

test('execution-time stale preview binds refreshed calldata to the new wallet request and journal',async t=>{
 const f=await fixture(t,{count:1,thin:true,autoRun:false,previewCrashCalls:[2]});
 const o=await f.engine.prepare(intent(1),'refresh-at-execute');assert.equal(o.status,'PREPARED');const initial=o.plan.minOutput;
 o.previewAt=Date.now()-1100;await f.engine.writeAsync(o);f.engine.previews.delete(o.id);
 const done=await f.engine.execute(o.id,{authorization:'synthetic only',swapReceiptWaitMs:0});
 assert.equal(done.status,'CONFIRMED',JSON.stringify(done.error));assert.equal(f.sent.length,1);assert.equal(done.priceRefreshes.length,1);assert.ok(BigInt(done.plan.minOutput)<BigInt(initial));
 const entry=done.steps.at(-1),request=f.requests.get(entry.requestId);assert.equal(entry.step.data,V2_ROUTER_ABI.encodeFunctionData(request.f.fragment,request.f.args));assert.equal(request.f.args[1],BigInt(entry.plan.minOutput));
});

test('100 opening wallets in a very shallow pool recover actual minimum-output reverts while outsiders dump',async t=>{
 const f=await fixture(t,{thin:true,slippageBps:9900,autoRun:false,reserveIn:10000n*unit,revertOnMin:true,externalFills:[0,20,40,60,80],latency:2});
 const {OpeningSell}=await import('../lib/opening-sell.mjs');const m=new OpeningSell({engine:f.engine,rpc:{},bridge:{},detector:{scan:async()=>({open:true,pools:[]})},data:f.data,autoSchedule:false});t.after(()=>m.close());
 const j={id:'very-shallow-100',config:{asset:token,accounts:wallets.map(w=>w.account),percent:'100',slippageBps:9900,currency:'WBNB'},bindings:wallets,recoveryVersion:2,status:'ARMED',mode:'LIVE',createdAt:Date.now(),expiresAt:Date.now()+60000,authorization:'synthetic only',rows:wallets.map(w=>({account:w.account,status:'WAITING',attempts:0}))};m.jobs.set(j.id,j);
 for(let n=0;n<20&&['ARMED','FIRING','TRACKING'].includes(j.status);n++){await m.tick(j.id);if(j.rows.some(r=>r.status==='WAITING'&&r.retryAt>Date.now()))await wait(510);}
 t.diagnostic(JSON.stringify({simulationOnly:true,confirmedSales:j.rows.filter(r=>r.status==='CONFIRMED').length,veryShallowWallets:100,inputVsInitialReserve:10,externalSales:f.externalSales(),submissions:f.sent.length,firstDispatchMs:f.sent[0].at-f.start,lastDispatchMs:f.sent.at(-1).at-f.start,allConfirmedMs:Date.now()-f.start}));
 assert.equal(j.rows.filter(r=>r.status==='CONFIRMED').length,100,JSON.stringify(j.rows.filter(r=>r.status!=='CONFIRMED').map(r=>({a:r.account,s:r.status,e:r.error}))));
 assert.equal(f.settled.length,100);assert.equal(new Set(f.settled.map(x=>x.account)).size,100);assert.ok(j.rows.every(r=>(r.recoveryAttempts||0)<=3));assert.equal(f.engine.sellCoordinator.tails.size,0);assert.equal(f.engine.running.size,0);
});

for(const [bps,reserve,shocks,burst=false,mixed=false] of [[5000,10000,5],[9000,2000,8],[9900,2000,10],[9900,2000,10,true],[9900,10000,10,false,true]])test(`100 opening wallets under extreme dump: ${bps/100}% slippage, reserve ${reserve}, ${shocks} outside sells${burst?' in burst':''}${mixed?' with larger later wallets':''}`,async t=>{
 const f=await fixture(t,{thin:true,slippageBps:bps,autoRun:false,reserveIn:BigInt(reserve)*unit,revertOnMin:true,externalFills:Array.from({length:shocks},(_,n)=>burst?n:n*Math.floor(100/shocks)),latency:2,...(mixed?{amountForAccount:n=>(n<=80?1000n:3000n)*unit}:{})});
 const {OpeningSell}=await import('../lib/opening-sell.mjs'),m=new OpeningSell({engine:f.engine,rpc:{},bridge:{},detector:{scan:async()=>({open:true,pools:[]})},data:f.data,autoSchedule:false});t.after(()=>m.close());
 const j={id:'extreme-'+bps,config:{asset:token,accounts:wallets.map(w=>w.account),percent:'100',slippageBps:bps,currency:'WBNB'},bindings:wallets,recoveryVersion:2,status:'ARMED',mode:'LIVE',createdAt:Date.now(),expiresAt:Date.now()+60000,authorization:'synthetic only',rows:wallets.map(w=>({account:w.account,status:'WAITING',attempts:0}))};m.jobs.set(j.id,j);
 for(let n=0;n<20&&['ARMED','FIRING','TRACKING'].includes(j.status);n++){await m.tick(j.id);if(j.rows.some(r=>r.status==='WAITING'&&r.retryAt>Date.now()))await wait(510);}
 const orders=f.engine.list(500),steps=orders.flatMap(o=>o.timing.executionSteps||[]);
 t.diagnostic(JSON.stringify({simulationOnly:true,confirmedSales:j.rows.filter(r=>r.status==='CONFIRMED').length,extremeWallets:100,slippagePercent:bps/100,inputVsInitialReserve:(mixed?140000:100000)/reserve,externalSales:shocks,burst,mixed,submissions:f.sent.length,waveRetries:steps.filter(s=>s.parallelWaveRetry).length,serialFallbacks:steps.filter(s=>s.parallelFallback).length,firstDispatchMs:f.sent[0].at-f.start,lastDispatchMs:f.sent.at(-1).at-f.start,allConfirmedMs:Date.now()-f.start}));
 assert.equal(j.rows.filter(r=>r.status==='CONFIRMED').length,100,JSON.stringify(j.rows.filter(r=>r.status!=='CONFIRMED').slice(0,3).map(r=>({a:r.account,s:r.status,e:r.error}))));
 assert.equal(new Set(f.settled.map(r=>r.account)).size,100);assert.equal(f.settled.length,100);assert.equal(f.externalSales(),shocks);
 assert.ok(orders.every(o=>o.plan.slippage.bps===bps&&o.plan.opening.pool===pair));assert.ok(j.rows.every(r=>(r.recoveryAttempts||0)<=3));
 assert.equal(f.engine.sellCoordinator.tails.size,0);assert.equal(f.engine.sellCoordinator.parallel.size,0);assert.equal(f.engine.running.size,0);assert.equal(m.rowBusy.size,0);
});
test('extreme self-impact above the fee-review threshold does not silently bypass user protection',async t=>{
 const f=await fixture(t,{count:4,thin:true,slippageBps:9900,reserveIn:1000n*unit});const rows=await f.running;
 assert.equal(f.sent.length,0);assert.ok(rows.every(o=>o.needsFeeReview&&o.feeReview.required));assert.equal(f.engine.running.size,0);assert.equal(f.engine.sellCoordinator.parallel.size,0);
});
test('preparation pipeline releases only its read slot after journal commit; execution exposure and wallet lock survive',async t=>{
 for(const [reserveIn,bps,pipelined] of [[10000n*unit,9900,true],[2000n*unit,9900,false],[10000n*unit,9000,false]]){
  const f=await fixture(t,{count:1,thin:true,autoRun:false,slippageBps:bps,reserveIn});
  const call=f.engine.bridge.call;let checked=false;
  f.engine.bridge.call=async(account,args)=>{
   if(args[1]==='execute'){
    checked=true;const o=f.engine.get('pipeline-slot'),saved=JSON.parse(fs.readFileSync(f.engine.file(o.id),'utf8'));
    assert.equal(saved.status,'SUBMITTING');assert.equal(saved.steps.length,1);assert.equal(f.engine.running.has(account),true);
    assert.equal(f.engine.sellCoordinator.parallel.size,1,'pending sale remains in the admission proof');
    assert.equal(f.engine.sellCoordinator.preparations.size,pipelined?0:1,'only eligible unsigned slot is released');
    const duplicate=await f.engine.execute(o.id,{authorization:'duplicate synthetic click'});assert.equal(duplicate.duplicateSuppressed,true);
   }
   return call(account,args);
  };
  const done=await f.engine.run({...intent(1),slippageBps:bps},'pipeline-slot',{execute:true,authorization:'synthetic only',swapReceiptWaitMs:0});
  assert.equal(checked,true);assert.equal(done.status,'CONFIRMED');assert.equal(f.sent.length,1);assert.equal(f.engine.running.size,0);assert.equal(f.engine.sellCoordinator.parallel.size,0);assert.equal(f.engine.sellCoordinator.preparations.size,0);
 }
});

test('pipelined shallow preparation isolates failed previews and never resends an unknown original',async t=>{
 const f=await fixture(t,{count:12,thin:true,slippageBps:9900,reserveIn:10000n*unit,failAccount:2,unknownAccount:1,submitDelayMs:30});
 const rows=await f.running;
 assert.equal(rows[0].status,'SUBMISSION_UNKNOWN');assert.equal(rows[1].status,'BLOCKED');assert.equal(rows.filter(o=>o.status==='CONFIRMED').length,10);
 assert.equal(f.sent.length,11);assert.equal(new Set(f.sent.map(x=>x.account)).size,11);
 await f.engine.execute('hundred-1',{authorization:'duplicate synthetic click'});assert.equal(f.sent.filter(x=>x.account===1).length,1);
 assert.equal(f.engine.get('hundred-1').status,'SUBMISSION_UNKNOWN');assert.ok(rows.every(o=>o.plan?.slippage.bps===9900&&o.plan.opening.pool===pair));
 assert.equal(f.engine.running.size,0);assert.equal(f.engine.sellCoordinator.preparations.size,0);assert.equal(f.engine.sellCoordinator.parallel.size,0);assert.equal(f.engine.sellCoordinator.tails.size,0);
});

test('pause drains shallow preparation and wave waiters without any wallet submission',async t=>{
 const gate=deferred();let allowed=true;
 const f=await fixture(t,{count:16,thin:true,slippageBps:9000,reserveIn:2000n*unit,stateGate:async o=>{if(o.status==='SUBMITTING')await gate.promise;},options:{continueAllowed:()=>allowed}});t.after(()=>gate.resolve());
 const until=Date.now()+5000;while(![...f.engine.sellCoordinator.preparations.values()].some(g=>g.queue.length)&&Date.now()<until)await tick();
 assert.ok([...f.engine.sellCoordinator.preparations.values()].some(g=>g.queue.length));allowed=false;gate.resolve();
 const rows=await f.running;assert.equal(f.sent.length,0);assert.ok(rows.every(o=>o.status==='CANCELLED'));assert.equal(f.engine.running.size,0);
 assert.equal(f.engine.sellCoordinator.parallel.size,0);assert.equal(f.engine.sellCoordinator.preparations.size,0);assert.equal(f.engine.sellCoordinator.tails.size,0);
});

test('100 opening originals: one stalled follow cannot hold 99 next checks or a proven recovery',async t=>{
 const {OpeningSell}=await import('../lib/opening-sell.mjs');
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'hundred-follow-')),gate=deferred(),counts=new Map(),orders=new Map();let now=10000,sends=0;
 const failed=id=>{const w=wallets[1],plan={...record(2).plan,requireSellCredit:true};return {id,intent:intent(2),status:'FAILED',error:{code:'TRANSACTION_REVERTED'},plan,steps:[{status:'FAILED',step:plan.steps[0],plan,revertVerified:true,receipt:{status:'0x0'},txHash:'0x'+'1'.repeat(64)}]};};
 const engine={live:true,get:id=>orders.get(id),follow:async id=>{const a=Number(id.split('-').at(-1)),n=(counts.get(a)||0)+1;counts.set(a,n);if(a===1)await gate.promise;if(a===2)return failed(id);return {id,status:a===1||n>1?'CONFIRMED':'PENDING'};},prepare:async(i,id)=>{const o={id,intent:i,status:'PREPARED',review:[]};orders.set(id,o);return o;},execute:async id=>{sends++;return {...orders.get(id),status:'CONFIRMED'};}};
 const m=new OpeningSell({data,engine,autoSchedule:true,now:()=>now}),j={id:'follow-isolation',status:'TRACKING',recoveryVersion:2,bindings:wallets,config:{asset:token,accounts:wallets.map(w=>w.account),percent:'100',slippageBps:300,currency:'WBNB'},expiresAt:now+60000,rows:wallets.map(w=>({account:w.account,status:'TRACKING',attempts:1,orderId:'original-'+w.account,commitStartedAt:1}))};m.jobs.set(j.id,j);
 t.after(()=>{gate.resolve();m.close();fs.rmSync(data,{recursive:true,force:true});});
 const first=m.followPending(j);const until=Date.now()+3000;while(counts.size<100&&Date.now()<until)await tick();assert.equal(counts.size,100);
 await wait(70);now+=600;await m.followPending(j);
 assert.equal(j.rows.filter(r=>r.status==='CONFIRMED').length,99,'99 wallets advance without waiting for the hung original');
 assert.equal(sends,1,'only the proven failed sale is retried');assert.equal(counts.get(1),1,'same original never polled concurrently');assert.equal(j.rows[0].status,'TRACKING');assert.equal(m.followBusy.has(j.id),true);
 gate.resolve();await first;assert.equal(j.rows.filter(r=>r.status==='CONFIRMED').length,100);assert.equal(m.followRows.size,0);assert.equal(m.followBusy.size,0);
});

test('100 opening wallets complete via independent pending-receipt follow with real durable engine',async t=>{
 const f=await fixture(t,{thin:true,slippageBps:9000,autoRun:false,pendingObservations:1,latency:5});
 const {OpeningSell}=await import('../lib/opening-sell.mjs'),m=new OpeningSell({engine:f.engine,detector:{scan:async()=>({open:true,pools:[]})},data:f.data,autoSchedule:false});t.after(()=>m.close());
 const j={id:'pending-hundred',config:{asset:token,accounts:wallets.map(w=>w.account),percent:'100',slippageBps:9000,currency:'WBNB'},bindings:wallets,recoveryVersion:2,status:'ARMED',createdAt:Date.now(),expiresAt:Date.now()+60000,authorization:'synthetic only',rows:wallets.map(w=>({account:w.account,status:'WAITING',attempts:0}))};m.jobs.set(j.id,j);
 await m.tick(j.id);assert.equal(f.sent.length,100);assert.equal(f.settled.length,0);const followStart=Date.now();await m.followPending(j);
 assert.equal(j.rows.filter(r=>r.status==='CONFIRMED').length,100);assert.equal(f.settled.length,100);assert.equal(new Set(f.settled.map(r=>r.account)).size,100);assert.equal(f.engine.running.size,0);assert.equal(m.followBusy.size,0);
 for(const r of j.rows)assert.equal(f.engine.get(r.orderId).status,'CONFIRMED');
 t.diagnostic(JSON.stringify({simulationOnly:true,openingPendingWallets:100,rpcDelayMs:5,previewDelayMs:15,submitDelayMs:20,firstDispatchMs:f.sent[0].at-f.start,lastDispatchMs:f.sent.at(-1).at-f.start,followAllMs:Date.now()-followStart,allConfirmedMs:Date.now()-f.start}));
});

test('original receipt flush is awaited without blocking another wallet or releasing its own lock early',async t=>{
 const gate=deferred(),f=await fixture(t,{count:2,thin:true,slippageBps:9000,pendingObservations:1,stateGate:async o=>{if(o.intent.account===1&&o.status==='CONFIRMED')await gate.promise;}});t.after(()=>gate.resolve());const initial=await f.running;
 assert.ok(initial.every(o=>o.status==='PENDING'));const first=f.engine.follow(initial[0].id);await tick();const second=await f.engine.follow(initial[1].id);
 assert.equal(second.status,'CONFIRMED');assert.equal(f.engine.get(initial[0].id).status,'PENDING');assert.equal(f.engine.running.has(1),true);assert.equal(f.engine.running.has(2),false);
 gate.resolve();assert.equal((await first).status,'CONFIRMED');assert.equal(f.engine.running.size,0);assert.equal(f.sent.length,2);
});

test('empty first receipt check does not rewrite the durable original, but review changes still persist',async t=>{
 for(const changed of [false,true]){
  const f=await fixture(t,{count:1,thin:true,autoRun:false,pendingObservations:1});
  const writes=[],write=f.engine.writeAsync.bind(f.engine);f.engine.writeAsync=async(o,options)=>{writes.push(o.status);return write(o,options);};
  if(changed)f.engine.observeContract=async(o,e)=>{o.status=e.status='RECEIPT_REVIEW';o.error={code:'ORIGINAL_MISMATCH',message:'模拟原单不匹配'};};
  const o=await f.engine.run(intent(1),'pending-once',{execute:true,authorization:'synthetic only',swapReceiptWaitMs:0});
  assert.equal(writes.filter(s=>s==='PENDING').length,1);assert.equal(f.sent.length,1);assert.equal(f.engine.get(o.id).status,changed?'RECEIPT_REVIEW':'PENDING');
  if(changed)assert.equal(f.engine.get(o.id).error.code,'ORIGINAL_MISMATCH');
  await f.engine.execute(o.id,{authorization:'duplicate'});assert.equal(f.sent.length,1);assert.equal(f.engine.running.size,0);
  assert.equal(fs.readdirSync(f.engine.ordersDir).some(f=>f.endsWith('.tmp')),false);
 }
});

for(const mode of [false,true,'slow-wallet'])test(mode==='slow-wallet'?'100 shallow opening wallets with slow wallet responses':'100 opening wallets use real scheduled detection and receipt polling to completion'+(mode?' in extreme shallow pool':''),async t=>{
 const extreme=!!mode,slow=mode==='slow-wallet',bps=extreme?9900:9000,rpcDelayMs=slow?20:5,previewDelayMs=slow?300:15,submitDelayMs=slow?600:20;
 const f=await fixture(t,{thin:true,slippageBps:bps,autoRun:false,pendingObservations:1,latency:rpcDelayMs,previewDelayMs,submitDelayMs,...(extreme?{reserveIn:2000n*unit,revertOnMin:true,externalFills:[0,10,20,30,40,50,60,70,80,90]}:{})});
 const {OpeningSell}=await import('../lib/opening-sell.mjs'),m=new OpeningSell({engine:f.engine,detector:{scan:async()=>({open:true,pools:[]})},data:f.data});t.after(()=>m.close());
 const execute=f.engine.execute.bind(f.engine);f.engine.execute=async(id,options)=>{const saved=JSON.parse(fs.readFileSync(m.file,'utf8')),row=saved.flatMap(j=>j.rows).find(r=>r.orderId===id);assert.ok(row?.commitStartedAt,'own durable task commit marker precedes each submit');return execute(id,options);};
 let snapshots=0,snapshotMs=0;const save=m.persist.bind(m);m.persist=(...args)=>{const start=performance.now();try{snapshots++;return save(...args);}finally{snapshotMs+=performance.now()-start;}};
 const j={id:'scheduled-hundred',config:{asset:token,accounts:wallets.map(w=>w.account),percent:'100',slippageBps:bps,currency:'WBNB'},bindings:wallets,recoveryVersion:2,status:'ARMED',createdAt:Date.now(),expiresAt:Date.now()+60000,authorization:'synthetic only',rows:wallets.map(w=>({account:w.account,status:'WAITING',attempts:0}))};m.jobs.set(j.id,j);m.schedule(j,0);m.scheduleFollow(j);
 // Include receipt/task persistence in both baseline and new measurements.
 const until=Date.now()+(slow?60000:20000);while((j.status!=='COMPLETED'||m.followBusy.size||m.rowBusy.size||f.engine.running.size)&&Date.now()<until)await wait(25);
 const orders=j.rows.map(r=>f.engine.get(r.orderId)),median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)],queueMs=orders.map(o=>(o?.timing?.executionSteps||[]).reduce((n,s)=>n+(s.queueMs||0),0));
 t.diagnostic(JSON.stringify({simulationOnly:true,confirmedSales:j.rows.filter(r=>r.status==='CONFIRMED').length,scheduledOpeningWallets:100,extreme,slow,submissions:f.sent.length,taskSnapshots:snapshots,taskSnapshotMs:Math.round(snapshotMs),rpcDelayMs,previewDelayMs,submitDelayMs,receiptPollMs:500,...f.preparationStats(),queueMedianMs:median(queueMs),queueMaxMs:Math.max(...queueMs),firstDispatchMs:f.sent[0].at-f.start,lastDispatchMs:f.sent.at(-1).at-f.start,allConfirmedMs:Date.now()-f.start}));
 assert.equal(j.status,'COMPLETED');assert.equal(j.rows.filter(r=>r.status==='CONFIRMED').length,100);if(!extreme)assert.equal(f.sent.length,100);assert.equal(f.settled.length,100);assert.equal(new Set(f.settled.map(r=>r.account)).size,100);assert.equal(f.engine.running.size,0);assert.equal(m.followBusy.size,0);assert.equal(f.engine.sellCoordinator.preparations?.size||0,0);
 for(const r of j.rows)assert.equal(f.engine.get(r.orderId).status,'CONFIRMED');
});

for(const [depth,reserve] of [['deep',10000000n],['moderate',100000n],['shallow',10000n]])test(`100-wallet depth sweep with slow wallet responses: ${depth}`,async t=>{
 const f=await fixture(t,{thin:true,slippageBps:9900,autoRun:false,pendingObservations:1,latency:20,previewDelayMs:300,submitDelayMs:600,reserveIn:reserve*unit,revertOnMin:true,externalFills:[0,20,40,60,80]});
 const {OpeningSell}=await import('../lib/opening-sell.mjs'),m=new OpeningSell({engine:f.engine,detector:{scan:async()=>({open:true,pools:[]})},data:f.data});t.after(()=>m.close());
 const j={id:'depth-'+depth,config:{asset:token,accounts:wallets.map(w=>w.account),percent:'100',slippageBps:9900,currency:'WBNB'},bindings:wallets,recoveryVersion:2,status:'ARMED',createdAt:Date.now(),expiresAt:Date.now()+60000,authorization:'synthetic only',rows:wallets.map(w=>({account:w.account,status:'WAITING',attempts:0}))};m.jobs.set(j.id,j);m.schedule(j,0);m.scheduleFollow(j);
 const until=Date.now()+60000;while((j.status!=='COMPLETED'||m.followBusy.size||m.rowBusy.size||f.engine.running.size)&&Date.now()<until)await wait(25);
 t.diagnostic(JSON.stringify({simulationOnly:true,depth,confirmedSales:j.rows.filter(r=>r.status==='CONFIRMED').length,wallets:100,singleInputReservePercent:100000/Number(reserve),batchInputReservePercent:10000000/Number(reserve),externalSales:f.externalSales(),submissions:f.sent.length,rpcDelayMs:20,previewDelayMs:300,submitDelayMs:600,receiptPollMs:500,...f.preparationStats(),firstDispatchMs:f.sent[0].at-f.start,lastDispatchMs:f.sent.at(-1).at-f.start,allConfirmedMs:Date.now()-f.start}));
 assert.equal(j.status,'COMPLETED');assert.equal(j.rows.filter(r=>r.status==='CONFIRMED').length,100,JSON.stringify(j.rows.filter(r=>r.status!=='CONFIRMED').map(r=>({a:r.account,s:r.status,e:r.error}))));assert.equal(f.settled.length,100);assert.equal(new Set(f.settled.map(r=>r.account)).size,100);assert.equal(f.engine.running.size,0);assert.equal(f.engine.sellCoordinator.preparations.size,0);assert.equal(f.engine.sellCoordinator.parallel.size,0);assert.equal(f.engine.sellCoordinator.tails.size,0);
 if(depth==='deep')assert.equal(f.preparationStats().maxPreparationActive,0,'deep pools never enter shallow preparation throttling');
});

test('task completion waits for concurrent receipt persistence and publishes immediately after the final row drains',async t=>{
 const {OpeningSell}=await import('../lib/opening-sell.mjs'),data=fs.mkdtempSync(path.join(os.tmpdir(),'opening-completion-')),gate=deferred();let saving=0;
 const m=new OpeningSell({engine:{follow:async id=>({id,status:'CONFIRMED'})},data,autoSchedule:false});t.after(()=>{gate.resolve();m.close();fs.rmSync(data,{recursive:true,force:true});});
 const j={id:'finishing',config:{},bindings:wallets.slice(0,2),status:'TRACKING',expiresAt:Date.now()+60000,rows:wallets.slice(0,2).map(w=>({account:w.account,status:'TRACKING',orderId:'original-'+w.account,commitStartedAt:1}))};m.jobs.set(j.id,j);
 const save=m.persistFollowResults.bind(m);m.persistFollowResults=async()=>{saving++;await gate.promise;return save();};
 const following=m.followPending(j);while(saving<2)await tick();
 await m.tick(j.id);assert.equal(j.status,'TRACKING');assert.equal(m.followBusy.size,1);assert.equal(j.rows.filter(r=>r.status==='CONFIRMED').length,2);
 gate.resolve();await following;assert.equal(j.status,'COMPLETED');assert.equal(m.followBusy.size,0);assert.equal(m.followRows.size,0);
 assert.equal(JSON.parse(fs.readFileSync(m.file))[0].status,'COMPLETED');
});
