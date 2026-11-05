import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import test from 'node:test';import assert from 'node:assert/strict';
import {Rpc} from '../lib/network.mjs';import {createServer} from '../server.mjs';
test('a saturated discovery/display RPC queue cannot queue an order chain read behind it',async(t)=>{
 let release,started;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r);
 const rpc=new Rpc('https://rpc.example',{fetchImpl:async(url,opts)=>{const batch=JSON.parse(opts.body);if(batch[0].method==='eth_call'){started();await gate;}return {ok:true,json:async()=>batch.map(q=>({id:q.id,result:q.method==='eth_chainId'?'0x38':'0x01'}))};}});
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'rpc-isolation-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 const app=createServer({rpc,bridge:{},engine:{},data});assert.notEqual(app.readRpc,rpc);assert.equal(app.readRpc.url,rpc.url);
 const scan=Promise.all(Array.from({length:32},(_,i)=>app.readRpc.send('eth_call',[i])));await began;assert.equal(app.readRpc.waitingReads.length,16);
 try{await Promise.race([app.rpc.verifyChain(),new Promise((_,reject)=>setTimeout(()=>reject(Error('order blocked by display scan')),500))]);assert.equal(app.readRpc.activeReads,16);}finally{release();await scan;}
});
