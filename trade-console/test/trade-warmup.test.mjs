import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createTradeWarmup,createSellPreparationWarmup} from '../public/trade-warmup.mjs';
import {ManualSellPreparation} from '../lib/manual-sell-preparation.mjs';
import {TradePreparation} from '../lib/trade-preparation.mjs';
import {OpeningPreparation} from '../lib/opening-preparation.mjs';
import {createServer} from '../server.mjs';import {ERC20,bindings} from '../lib/common.mjs';
const token='0x'+'23'.repeat(20),other='0x'+'45'.repeat(20),wait=ms=>new Promise(r=>setTimeout(r,ms));
test('typing/paste warmup debounces to the last valid CA and cannot submit any action',async()=>{
 const calls=[];let allowed=true,now=100;const warm=createTradeWarmup({api:async(...args)=>calls.push(args),allowed:()=>allowed,now:()=>now,delayMs:5});
 warm(token);warm(other);await wait(25);assert.deepEqual(calls,[['trade-warm',{asset:other}]]);
 warm(other);await wait(25);assert.equal(calls.length,1);
 warm(token);allowed=false;await wait(25);assert.equal(calls.length,1);allowed=true;
 warm(token);warm('https://project.example');await wait(25);assert.equal(calls.length,1);
 warm('0x'+'0'.repeat(40));await wait(25);assert.equal(calls.length,1);
 now+=15001;warm(other);await wait(25);assert.equal(calls.length,2);
});
test('optional warm failure never leaks rejection or prevents next CA request',async()=>{
 let calls=0;const warm=createTradeWarmup({api:()=>{calls++;throw Error('offline');},delayMs:1});warm(token);await wait(20);warm(other);await wait(20);assert.equal(calls,2);
});
test('cached output metadata expires and never includes a wallet holding',async()=>{
 let now=100,reads=0;const prep=new OpeningPreparation({call:async tx=>{reads++;assert.equal(ERC20.parseTransaction(tx).name,'decimals');return ERC20.encodeFunctionResult('decimals',[6]);}},{now:()=>now,identityFor:async()=>({fingerprint:'test'})});
 assert.equal(prep.peekToken(token),null);await prep.token(token);assert.equal(prep.peekToken(token).decimals,6);assert.equal(reads,1);
 assert.equal(prep.peekToken(other),null);now+=15000;assert.equal(prep.peekToken(token),null);
});
test('warm HTTP entry is authenticated, read-only and bounded while trading is busy',async t=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'trade-warm-test-'));let writes=0;
 const warmer=new TradePreparation({plan:()=>assert.fail('busy prefetch must not start'),preview:()=>assert.fail('busy prefetch must not start')});
 const app=createServer({data,rpc:{},bridge:{call:()=>writes++},engine:{list:()=>[],running:new Set(['busy']),run:()=>writes++,manualSellPreparation:warmer}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>{app.server.close(r);app.server.closeAllConnections();});fs.rmSync(data,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.server.address().port,post=(payload,auth=true)=>fetch(base+'/api/trade-warm',{method:'POST',headers:{'content-type':'application/json',...(auth?{'x-console-token':app.token}:{})},body:JSON.stringify(payload)});
 // A valid import must also be served by the explicit static-file allowlist.
 const appJs=await (await fetch(base+'/app.js')).text();
 for(const [,module]of appJs.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)){
  const r=await fetch(base+'/'+module);assert.equal(r.status,200,module);assert.match(r.headers.get('content-type'),/javascript/,module);
 }
 assert.equal((await post({asset:token},false)).status,401);
 assert.equal((await post({asset:token,execute:true})).status,400);assert.equal((await post({asset:'not-ca'})).status,400);
 assert.equal((await post({asset:'0x'+'0'.repeat(40)})).status,400);
 assert.deepEqual(await (await post({asset:token})).json(),{scheduled:false});assert.equal(writes,0);
 const i={side:'sell',account:bindings()[0].account,asset:token,percent:'100',currency:'AUTO',slippageBps:5000,slippageMode:'auto'};
 const sell=(payload,auth=true)=>fetch(base+'/api/sell-warm',{method:'POST',headers:{'content-type':'application/json',...(auth?{'x-console-token':app.token}:{})},body:JSON.stringify(payload)});
 assert.equal((await sell({intents:[i]},false)).status,401);
 for(const b of [{intents:[i],execute:true},{intents:[i,{...i,execute:true}]},{intents:Array(9).fill(i)},{intents:[{...i,side:'buy'}]}])assert.equal((await sell(b)).status,400);
 assert.deepEqual(await (await sell({intents:[i]})).json(),{scheduled:0});assert.equal(writes,0);
 const buy={side:'buy',account:bindings()[0].account,asset:token,amount:'0.02',currency:'BNB',slippageBps:100};
 const prepare=(payload,auth=true)=>fetch(base+'/api/trade-prepare-warm',{method:'POST',headers:{'content-type':'application/json',...(auth?{'x-console-token':app.token}:{})},body:JSON.stringify(payload)});
 assert.equal((await prepare({intents:[buy]},false)).status,401);
 for(const b of [{intents:[buy],execute:true},{intents:[{...buy,go:true}]},{intents:Array(9).fill(buy)}])assert.equal((await prepare(b)).status,400);
 assert.deepEqual(await (await prepare({intents:[buy,i]})).json(),{scheduled:0});assert.equal(writes,0);
});
test('sell prefetch debounces current wallet/settings, throttles, yields on click/hide and cannot place an order',async()=>{
 const calls=[];let now=0,allowed=true,rows=[{percent:'100'}];const warm=createSellPreparationWarmup({api:async(...args)=>{calls.push(args);throw Error('optional offline');},intents:()=>rows,allowed:()=>allowed,now:()=>now,delayMs:1});
 warm();rows=[{percent:'50'}];warm();await wait(20);assert.deepEqual(calls,[['sell-warm',{intents:[{percent:'50'}]}]]);
 warm();await wait(20);assert.equal(calls.length,1);now=4001;warm();allowed=false;await wait(20);assert.equal(calls.length,1);
 allowed=true;warm();await wait(20);assert.equal(calls.length,2);rows=[];warm();await wait(20);assert.equal(calls.length,2);
});
