import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createServer} from '../server.mjs';
const address=n=>'0x'+n.toString(16).padStart(40,'0');
test('fast-sale HTTP uses synthetic selected bindings, authenticates mutations, never enables production signer',async t=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'fast-api-'));const wallets=[{account:1,address:address(1)},{account:2,address:address(2)}];
 const engine={list:()=>[],running:new Set()},app=createServer({data,engine,rpc:{},bridge:{},walletBindings:()=>wallets,live:true});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 t.after(async()=>{app.tracker.close();app.corla.close();app.opening.close();await new Promise(r=>app.server.close(r));fs.rmSync(data,{recursive:true,force:true});});
 const boot=await fetch(base+'/api/bootstrap').then(r=>r.json());assert.deepEqual(boot.wallets,wallets);assert.equal(boot.capabilities.fastSaleSimulationOnly,true);
 const post=async(p,b,auth=true)=>fetch(base+p,{method:'POST',headers:{'content-type':'application/json',...(auth?{'x-console-token':boot.token}:{})},body:JSON.stringify(b)});
 const settings={trigger:address(3),executor:address(4),source:'opening'};
 assert.equal((await post('/api/fast-sale/settings',settings,false)).status,401);
 assert.equal((await post('/api/fast-sale/setup',{},false)).status,401);
 assert.equal((await post('/api/fast-sale/backup',{address:address(1)},false)).status,401);
 assert.equal((await post('/api/fast-sale/backup',{address:address(1)})).status,400);
 for(const action of ['generated','import-key','export-key']){
  assert.equal((await post('/api/fast-sale/'+action,{},false)).status,401);
  assert.equal((await post('/api/fast-sale/'+action,{})).status,400);
 }
 const setup=await post('/api/fast-sale/setup',{});assert.equal(setup.status,400);assert.match(JSON.stringify(await setup.json()),/主网执行合约未启用/);
 const r=await post('/api/fast-sale/settings',settings);assert.equal(r.status,200);const saved=await r.json();assert.equal(saved.enabled,false);assert.equal(saved.settings.expiryHours,48);
 const denied=await post('/api/fast-sale/authorize',{id:'a',asset:address(5),accounts:[1,2],settings});assert.equal(denied.status,400);assert.match(JSON.stringify(await denied.json()),/仅开放模拟/);
 const unknown=await post('/api/fast-sale/authorize',{id:'b',asset:address(5),accounts:[100],settings});assert.equal(unknown.status,400);
 const unsafe=await post('/api/fast-sale/settings',{...settings,privateKey:'NEVER-A-REAL-KEY'});assert.equal(unsafe.status,400);assert.ok(!fs.readFileSync(path.join(data,'fast-sale-settings.json'),'utf8').includes('NEVER-A-REAL-KEY'));
});
