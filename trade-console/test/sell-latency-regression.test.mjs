import test from 'node:test';
import assert from 'node:assert/strict';
import {openingPlan} from '../lib/opening-route.mjs';
import {DEXES,QUOTER} from '../lib/opening-dex.mjs';
import {ERC20,WBNB,bindings,same} from '../lib/common.mjs';
import {Rpc} from '../lib/network.mjs';
import {OpeningPreparation} from '../lib/opening-preparation.mjs';
import {Wallets} from '../lib/wallet.mjs';

// Real planner, synthetic delayed chain only: no wallet process/signing/network.
const token='0x'+'71'.repeat(20),low='0x'+'72'.repeat(20),high='0x'+'73'.repeat(20),dex=DEXES[2];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function fixture({venueMs=0,quoteMs=0,allowanceMs=0,broken=false,timeoutMs}={}){
 let scans=0,quotes=0;
 const pools=[{...dex,pool:high,quote:WBNB,liquid:true,fee:850150,declaredByToken:true},{...dex,pool:low,quote:WBNB,liquid:true,fee:500}];
 const rpc={timeoutMs,call:async tx=>{
  if(same(tx.to,token)){const f=ERC20.parseTransaction(tx);if(f.name==='allowance')await wait(allowanceMs);return ERC20.encodeFunctionResult(f.name,[2000000n]);}
  quotes++;if(broken)throw Object.assign(Error('RPC query timed out'),{code:'TIMEOUT'});
  await wait(quoteMs);return QUOTER.encodeFunctionResult('quoteExactInputSingle',[1000000n,1n,0n,100000n]);
 }};
 const preparation={token:async()=>({decimals:6,identity:{fingerprint:'synthetic'}}),venue:async()=>{await wait(venueMs);return {assets:[]};}};
 const plan=account=>openingPlan(rpc,{}, {account,side:'sell',asset:token,percent:'10',currency:'AUTO',slippageBps:100},{preparation,scan:async()=>{scans++;return {pools,at:Date.now()};}});
 return {plan,get scans(){return scans;},get quotes(){return quotes;}};
}
test('four wallets: 1.4s venue/allowance latency cannot be misreported as a 1.2s quote timeout',async()=>{
 const f=fixture({venueMs:1400,allowanceMs:1400,quoteMs:100});
 const plans=await Promise.all(bindings().slice(0,4).map(w=>f.plan(w.account)));
 assert.equal(f.scans,4,'no recursive expanded scans');assert.equal(f.quotes,8);
 for(const p of plans){assert.equal(p.amountIn,'200000');assert.equal(p.opening.pool,low);assert.equal(p.poolFees.poolFeePpm,500);assert.equal(p.steps.length,1);}
});
test('a healthy 1.5s quote is accepted; slow low fee still wins over a high fee pool',async()=>{
 const f=fixture({quoteMs:1500});const p=await f.plan(bindings()[0].account);
 assert.equal(p.opening.pool,low);assert.equal(f.scans,1);
});
test('a quote requiring endpoint failover is not cut off before the RPC read budget',async()=>{
 const f=fixture({quoteMs:2700,timeoutMs:8000});const p=await f.plan(bindings()[0].account);
 assert.equal(p.opening.pool,low);assert.equal(f.scans,1);
});
test('transport failure does not trigger a second expanded scan or additional quote burst',async()=>{
 const f=fixture({broken:true});await assert.rejects(f.plan(bindings()[0].account),e=>e.code==='RPC_READ_FAILED');
 assert.equal(f.scans,1);assert.equal(f.quotes,2);
});
test('background queued RPCs yield before dispatch; foreground RPC remains independent',async()=>{
 let release,started;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r);let batches=0,allowed=true;
 const rpc=new Rpc('https://rpc.example',{fetchImpl:async(_url,o)=>{batches++;started();await gate;const rows=JSON.parse(o.body);return {ok:true,json:async()=>rows.map(q=>({id:q.id,result:'0x01'}))};}});
 rpc.readAllowed=()=>allowed;
 const reads=Promise.allSettled(Array.from({length:32},(_,i)=>rpc.send('eth_call',[i])));
 await began;assert.equal(rpc.waitingReads.length,16);allowed=false;release();
 const results=await reads;assert.equal(results.filter(r=>r.status==='fulfilled').length,16);assert.equal(batches,1);
 for(const r of results.filter(r=>r.status==='rejected'))assert.equal(r.reason.code,'WARM_YIELDED');
 assert.equal(rpc.activeReads,0);assert.equal(rpc.waitingReads.length,0);
 await assert.rejects(rpc.send('eth_call',['new']),{code:'WARM_YIELDED'});
});
test('completed metadata may be shared while foreground never joins unfinished background metadata',async()=>{
 let release;const gate=new Promise(r=>release=r),background=new OpeningPreparation({}),foreground=new OpeningPreparation({});
 background.entries=foreground.entries;
 const pending=background.cached('venue',60000,()=>gate);
 assert.equal(await foreground.cached('venue',60000,async()=>({verified:'foreground'})).then(v=>v.verified),'foreground');
 release({verified:'background'});await pending;assert.equal(foreground.pending.size,0);
});
test('complete readiness survives transient idle-refresh failure but never server expiry or a changed binding',async()=>{
 const w=bindings()[0],bridge=new Wallets();let calls=0;
 bridge.call=async(_a,args)=>{calls++;return args[1]==='status'?{status:'CONNECTED'}:args[1]==='address'?{addresses:[{binanceChainId:'56',address:w.address}]}:{sessionExpireTime:new Date(Date.now()+600000).toISOString(),devMode:{enabled:true,expiresAt:new Date(Date.now()+600000).toISOString()}};};
 const c=await bridge.ready(w.account,{external:true});assert.equal(calls,3);assert.ok(c.validUntil-c.checkedAt>=299999&&c.validUntil-c.checkedAt<=300001);
 c.checkedAt-=70000;
 bridge.call=async()=>{calls++;throw Error('idle timeout');};
 assert.equal(await bridge.warm(w.account),null);assert.equal(await bridge.ready(w.account,{external:true}),c);assert.equal(calls,4);
 c.validUntil=Date.now()-1;await assert.rejects(bridge.ready(w.account),/idle timeout/);
 c.validUntil=Date.now()+60000;c.address=token;await assert.rejects(bridge.ready(w.account),/idle timeout/);
});
