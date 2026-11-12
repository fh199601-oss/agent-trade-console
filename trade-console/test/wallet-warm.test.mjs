import test from 'node:test';import assert from 'node:assert/strict';
import {Wallets} from '../lib/wallet.mjs';import {bindings} from '../lib/common.mjs';
const w=bindings()[0],cached=()=>({...w,status:'CONNECTED',validUntil:Date.now()+30000,checkedAt:Date.now()-30000});
test('optional approval warming never starts cold readiness or waits behind foreground checks',async()=>{
 const bridge=new Wallets();bridge.call=async()=>assert.fail('no wallet call');bridge.readyInflight.set(w.account,new Promise(()=>{}));
 await assert.rejects(bridge.ready(w.account,{background:true}),{code:'WARM_YIELDED'});
 const c={...cached(),devMode:{enabled:true,expiresAt:new Date(Date.now()+60000).toISOString()}};bridge.readyCache.set(w.account,c);
 assert.equal(await bridge.ready(w.account,{external:true,background:true}),c);
 c.validUntil=Date.now()-1;await assert.rejects(bridge.ready(w.account,{external:true,background:true}),{code:'WARM_YIELDED'});
});
test('optional warm timeout preserves the original valid cache but never extends its expiry',async()=>{
 const bridge=new Wallets(),c=cached();bridge.readyCache.set(w.account,c);
 bridge.call=async(a,args,opts)=>{assert.equal(opts.readOnlyTimeoutMs,1000);assert.equal(opts.background,true);throw Error('network timeout');};
 assert.equal(await bridge.warm(w.account),null);assert.equal(bridge.readyCache.get(w.account),c);assert.equal(await bridge.ready(w.account),c);
 c.validUntil=Date.now()-1;await assert.rejects(bridge.ready(w.account),/network timeout|Cannot read/);
});
test('an explicitly disconnected wallet invalidates the cached preflight immediately',async()=>{
 const bridge=new Wallets();bridge.readyCache.set(w.account,cached());bridge.call=async()=>({status:'DISCONNECTED'});
 await assert.rejects(bridge.warm(w.account),e=>e.code==='WALLET_READINESS_INVALID');assert.equal(bridge.readyCache.has(w.account),false);
});
test('foreground preflight is not attached to optional warm work and completes full identity/settings checks',async()=>{
 const bridge=new Wallets(),calls=[];let release,started;
 const began=new Promise(r=>started=r),gate=new Promise(r=>release=r);
 const state={ready:Promise.resolve(),pending:new Map(),process:{stdin:{write(line,callback){
  const msg=JSON.parse(line),method=msg.args.slice(0,2).join(' ');calls.push({method,background:!!msg.readOnlyTimeoutMs});
  (async()=>{if(calls.length===1){started();await gate;}
   const data=method==='wallet status'?{status:'CONNECTED'}:method==='wallet address'?{addresses:[{binanceChainId:'56',address:w.address}]}:{sessionExpireTime:new Date(Date.now()+120000).toISOString()};
   const p=state.pending.get(msg.id);clearTimeout(p.timer);state.pending.delete(msg.id);p.resolve(data);callback?.();
  })();
 }}}};bridge.worker=()=>state;
 const warm=bridge.warm(w.account);await began;const ready=bridge.ready(w.account);release();
 assert.equal(await warm,null);assert.equal((await ready).address,w.address);
 assert.deepEqual(calls.map(x=>x.method),['wallet status','wallet status','wallet address','wallet settings']);assert.equal(calls.filter(x=>x.background).length,1);
 assert.ok(bridge.timings.every(t=>t.totalMs>=t.ms&&t.totalMs>=t.queueMs));assert.equal(bridge.readyInflight.size,0);
});
test('warm yields before dispatch if a foreground command is already queued',async()=>{
 const bridge=new Wallets();bridge.worker=()=>assert.fail('no worker should start');bridge.queues.set(w.account,Promise.resolve());
 assert.equal(await bridge.warm(w.account),null);await assert.rejects(bridge.call(w.account,['wallet','status'],{background:true}),e=>e.code==='WARM_YIELDED'&&e.dispatched===false);
});
test('warm refreshes identity and settings 15 seconds before cache expiry',async()=>{
 const bridge=new Wallets(),c=cached(),calls=[];c.validUntil=Date.now()+10000;bridge.readyCache.set(w.account,c);
 bridge.call=async(a,args,opts)=>{assert.equal(opts.background,true);calls.push(args.slice(0,2).join(' '));return args[1]==='status'?{status:'CONNECTED'}:args[1]==='address'?{addresses:[{binanceChainId:'56',address:w.address}]}:{sessionExpireTime:new Date(Date.now()+120000).toISOString()};};
 const refreshed=await bridge.warm(w.account);assert.notEqual(refreshed,c);assert.ok(refreshed.validUntil>c.validUntil);assert.deepEqual(calls,['wallet status','wallet address','wallet settings']);
});
