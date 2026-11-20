// Extends the tested 100-wallet fixture with per-wallet latency and timed receipts.
// Only synthetic bindings, isolated temp files and fake wallet/RPC calls.
// Real engine/coordinator with 60 synthetic bindings, fake RPC/wallet only.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const wallets=Array.from({length:60},(_,n)=>({account:n+1,address:'0x'+(0x10000+n).toString(16).padStart(40,'0')}));
const installHome=fs.mkdtempSync(path.join(os.tmpdir(),'synthetic-bindings-'));
process.env.AGENT_TRADE_HOME=installHome;
fs.writeFileSync(path.join(installHome,'install.json'),JSON.stringify({wallets,installationId:'isolated-wallet-test'}));
process.once('exit',()=>fs.rmSync(installHome,{recursive:true,force:true}));
globalThis.fetch=async()=>{throw Error('Network forbidden in sixty-wallet simulation');};
const {Engine}=await import('../lib/engine.mjs');
const {parallelWallets}=await import('../lib/parallel-wallets.mjs');
const {ERC20,WBNB,same,formatUnits,bindings}=await import('../lib/common.mjs');
const {DEXES,V2_ROUTER_ABI}=await import('../lib/opening-dex.mjs');
const {POOL}=await import('../lib/opening-pools.mjs');const {MULTI,MULTICALL}=await import('../lib/opening-read.mjs');
const {poolFeeProof}=await import('../lib/trade-fees.mjs');
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
async function fixture(t,{count=60,thin=false,failAccount=0,unknownAccount=0,slowAccount=0,latency=0,previewDelayMs=latency*3,submitDelayMs=latency*4,journalGate=null,stateGate=null,slippageBps=300,externalFills=[],previewCrashes=0,previewCrashCalls=[],autoRun=true,revertCounts={},netPercent=98n,reserveIn=null,revertOnMin=false,pendingObservations=0,receiptDelayMs=0,amountForAccount=()=>1000n*unit,options={}}={}){
 assert.equal(bindings().length,60);const data=fs.mkdtempSync(path.join(os.tmpdir(),'sixty-wallets-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
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
   const delay=typeof previewDelayMs==='function'?previewDelayMs(account):previewDelayMs;if(delay)await wait(delay);
   if(++previewCount<=previewCrashes||previewCrashCalls.includes(previewCount))externalSell();
   if(account===failAccount)throw Object.assign(Error('模拟余额不足'),{code:'INSUFFICIENT_BALANCE'});
   const f=V2_ROUTER_ABI.parseTransaction({data:args[args.indexOf('--inputData')+1]}),id='synthetic-'+(++seq);requests.set(id,{account,f,used:false});
   return {requestId:id,simulationResult:{simulationCode:'000000000',balanceChanges:[{owner:wallets[account-1].address,contractAddress:WBNB,change:String(out(f.args[0]*netPercent/100n,ri,ro))}]}};
  }
  assert.equal(args[1],'execute');const r=requests.get(args.at(-1));assert.equal(r.account,account);assert.equal(r.used,false);r.used=true;sent.push({account,at:Date.now(),r});if(sent.length===target)allSent.resolve();
  const delay=typeof submitDelayMs==='function'?submitDelayMs(account):submitDelayMs;if(delay)await wait(delay);
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
  const availability=typeof receiptDelayMs==='function'?receiptDelayMs(o.intent.account):receiptDelayMs;
  if(availability&&Date.now()<e.submittedAt+availability)return false;
  const checks=(receiptChecks.get(e.requestId)||0)+1;receiptChecks.set(e.requestId,checks);if(checks<=pendingObservations)return false;
  const account=o.intent.account,attempt=(observed.get(account)||0)+1;observed.set(account,attempt);if(attempt<=(revertCounts[account]||0)){e.status='FAILED';e.revertVerified=true;e.receipt={status:'0x0',blockNumber:'0x'+(++block).toString(16)};o.status='FAILED';e.error=o.error={code:'TRANSACTION_REVERTED',message:'模拟外部价格变化导致链上回滚'};return;}
  if(externalFills.includes(settled.length)&&!appliedShocks.has(settled.length)){appliedShocks.add(settled.length);externalSell();}
  const f=V2_ROUTER_ABI.parseTransaction(e.step),x=f.args[0]*netPercent/100n,y=out(x,ri,ro);
  if(revertOnMin&&y<f.args[1]){e.status='FAILED';e.revertVerified=true;e.receipt={status:'0x0',blockNumber:'0x'+(++block).toString(16)};o.status='FAILED';e.error=o.error={code:'TRANSACTION_REVERTED',message:'模拟实际价格跌穿本笔最低到账'};return;}
  assert.ok(y>=f.args[1],'all real minima preserved after earlier simulated sales');
  ri+=x;ro-=y;block++;balances.set(o.plan.wallet.toLowerCase(),0n);e.status='CONFIRMED';e.confirmedAt=Date.now();e.receipt={status:'0x1',blockNumber:'0x'+block.toString(16)};settled.push({account:o.intent.account,credit:y,minimum:f.args[1]});
 };
 const start=Date.now(),running=autoRun?parallelWallets(wallets.slice(0,count),w=>engine.run({...intent(w.account),slippageBps},'hundred-'+w.account,{execute:true,authorization:'synthetic simulation only',swapReceiptWaitMs:0,...options})):null;
 return {data,engine,sent,settled,requests,start,running,allSent,receiptGate,slowGate,target,externalSales:()=>externalSales,previewCalls:()=>previewCount,preparationStats:()=>({maxPreparationActive,maxPreparationLimit})};
}

// Rounded, anonymous durations from six already-confirmed local orders.
// No addresses, hashes, request IDs, credentials or RPC endpoints are included.
const historicalSamples=[
 {preview:606,submit:1082,receipt:614},
 {preview:519,submit:677,receipt:817},
 {preview:595,submit:697,receipt:1179},
 {preview:494,submit:812,receipt:602},
 {preview:515,submit:855,receipt:641},
 {preview:522,submit:847,receipt:925}
];
const round=Number(process.env.SIMULATION_ROTATION||0);
assert.ok(Number.isSafeInteger(round)&&round>=0);
for(const [depth,reserve,shocks] of [['deep',10000000n,5],['moderate',100000n,5],['shallow',10000n,5],['extreme',2000n,10]])test(`60 wallets with historical wallet latency and receipt wait: ${depth}`,async t=>{
 const samples=account=>historicalSamples[(account-1+round*2)%historicalSamples.length];
 const f=await fixture(t,{thin:true,slippageBps:9900,autoRun:false,latency:20,previewDelayMs:a=>samples(a).preview,submitDelayMs:a=>samples(a).submit,receiptDelayMs:a=>samples(a).receipt,reserveIn:reserve*unit,revertOnMin:true,externalFills:Array.from({length:shocks},(_,n)=>n*(60/shocks))});
 const {OpeningSell}=await import('../lib/opening-sell.mjs'),m=new OpeningSell({engine:f.engine,detector:{scan:async()=>({open:true,pools:[]})},data:f.data});t.after(()=>m.close());
 const execute=f.engine.execute.bind(f.engine);f.engine.execute=async(id,options)=>{const saved=JSON.parse(fs.readFileSync(m.file,'utf8')),row=saved.flatMap(j=>j.rows).find(r=>r.orderId===id);assert.ok(row?.commitStartedAt,'durable task marker precedes submission');return execute(id,options);};
 const j={id:'sixty-'+depth,config:{asset:token,accounts:wallets.map(w=>w.account),percent:'100',slippageBps:9900,currency:'WBNB'},bindings:wallets,recoveryVersion:2,status:'ARMED',createdAt:Date.now(),expiresAt:Date.now()+60000,authorization:'synthetic simulation only',rows:wallets.map(w=>({account:w.account,status:'WAITING',attempts:0}))};m.jobs.set(j.id,j);
 const start=Date.now();m.schedule(j,0);m.scheduleFollow(j);
 const until=start+60000;while((j.status!=='COMPLETED'||m.followBusy.size||m.rowBusy.size||f.engine.running.size)&&Date.now()<until){if(['REVIEW','FAILED','STOPPED','CANCELLED','EXPIRED'].includes(j.status))break;await wait(25);}
 const orders=j.rows.map(r=>f.engine.get(r.orderId)),steps=orders.flatMap(o=>o?.steps||[]).filter(s=>s.step.kind==='sell'),queueMs=orders.map(o=>(o?.timing?.executionSteps||[]).reduce((n,s)=>n+(s.queueMs||0),0)).sort((a,b)=>a-b);
 t.diagnostic(JSON.stringify({simulationOnly:true,profile:'historical-six-sample',round,depth,wallets:60,slippageBps:9900,confirmedSales:j.rows.filter(r=>r.status==='CONFIRMED').length,submissions:f.sent.length,previewCalls:f.previewCalls(),externalSales:f.externalSales(),rpcDelayMs:20,previewDelayRangeMs:[494,606],submitIncludingIdentityRangeMs:[677,1082],receiptAvailabilityRangeMs:[602,1179],receiptPollMs:500,...f.preparationStats(),firstDispatchMs:f.sent[0]?.at-start,lastDispatchMs:f.sent.at(-1)?.at-start,firstSubmitReturnedMs:Math.min(...steps.map(s=>s.submittedAt||Infinity))-start,lastSubmitReturnedMs:Math.max(...steps.map(s=>s.submittedAt||0))-start,queueMedianMs:queueMs[30],queueMaxMs:queueMs.at(-1),allConfirmedMs:Date.now()-start}));
 assert.equal(j.status,'COMPLETED',JSON.stringify(j.rows.filter(r=>r.status!=='CONFIRMED').map(r=>{const o=f.engine.get(r.orderId);return {account:r.account,status:r.status,error:r.error,priceRefreshes:o?.priceRefreshes,fees:o?.feeReview};})));
 assert.equal(j.rows.filter(r=>r.status==='CONFIRMED').length,60);assert.equal(f.settled.length,60);assert.equal(new Set(f.settled.map(r=>r.account)).size,60);assert.equal(f.externalSales(),shocks);
 assert.ok(orders.every(o=>o.plan.opening.pool===pair&&o.plan.slippage.bps===9900));assert.ok(f.settled.every(r=>r.credit>=r.minimum));assert.ok(j.rows.every(r=>(r.recoveryAttempts||0)<=3));
 for(const r of j.rows){assert.equal(f.engine.get(r.orderId).status,'CONFIRMED');const saved=JSON.parse(fs.readFileSync(f.engine.file(r.orderId),'utf8'));assert.equal(saved.status,'CONFIRMED');}
 assert.equal(f.engine.running.size,0);assert.equal(f.engine.sellCoordinator.preparations.size,0);assert.equal(f.engine.sellCoordinator.parallel.size,0);assert.equal(f.engine.sellCoordinator.tails.size,0);assert.equal(m.rowBusy.size,0);assert.equal(m.followBusy.size,0);assert.equal(m.followRows.size,0);
 if(depth==='deep')assert.equal(f.preparationStats().maxPreparationActive,0,'deep route is not throttled by shallow preparation');
});
