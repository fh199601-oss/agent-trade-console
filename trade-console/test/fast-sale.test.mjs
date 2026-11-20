import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ethers} from 'ethers';
import {FastSaleService,DisabledFastSale,validateFastSettings} from '../lib/delegated-sale/service.mjs';
import {FastTrigger,PrivateJournal} from '../lib/delegated-sale/trigger.mjs';
import {FastSaleRuntime} from '../lib/delegated-sale/runtime.mjs';
const a=n=>ethers.getAddress('0x'+BigInt(n).toString(16).padStart(40,'0'));
const memory=()=>{let data=[];return {load:()=>structuredClone(data),save:x=>data=structuredClone(x)};};
function fixture(){
 let now=Date.now(),called=0,sold=new Set();const store=memory(),records=new Map();
 const adapter={chainId:31337,simulationOnly:true,executor:a(999),verifiedVenue:async token=>({verified:true,token,pair:a(888)}),
  authorize:async p=>{called++;if(p.owner===a(13))throw Error('授权准备失败');return {id:ethers.id(p.owner),owner:p.owner,token:p.asset,trigger:p.trigger,cap:'100',minOut:'1',deadline:Math.floor(now/1000)+172800};},
  matchesPrimary:(v,s)=>s.open&&s.pair===v.pair,opening:async()=>({open:true,pair:a(888)}),verifyClaim:async c=>c.hash==='confirmed',
  outcomes:async(r,ids)=>new Map(ids.map(id=>[id,{sold:sold.has(id),message:'已到账'}]))};
 const trigger={wallet:{address:a(777)},warm:async()=>{},prepare:async(id,ids)=>{const r={id,ids,status:'PREPARED'};records.set(id,r);return r;},broadcast:async id=>{const r=records.get(id);for(const x of r.ids)sold.add(x);return {...r,status:'PENDING',hash:ethers.id(id)};},follow:async id=>({...records.get(id),status:'CONFIRMED',hash:ethers.id(id),receipt:{status:'0x1'}})};
 const service=new FastSaleService({adapter,trigger,store,now:()=>now});
 const input={id:'job',asset:a(222),wallets:Array.from({length:100},(_,i)=>({account:i+1,address:a(i+1)})),settings:{trigger:a(777),executor:a(999),source:'opening'}};
 return {adapter,trigger,store,service,input,records,calls:()=>called,advance:ms=>now+=ms};
}
test('100 wallet authorization failures isolated, duplicate clicks reused, prebuilding is not submitting',async()=>{
 const f=fixture();const [j,k]=await Promise.all([f.service.authorize(f.input),f.service.authorize(f.input)]);
 assert.deepEqual(j,k);assert.equal(f.calls(),100);assert.equal(j.rows.filter(r=>r.status==='FAILED').length,1);assert.equal(j.rows.filter(r=>r.status==='READY').length,99);assert.equal(j.batches.length,2);
 assert.ok([...f.records.values()].every(r=>r.status==='PREPARED'));await f.service.notifyOpening(f.input.asset,{open:true,pair:a(889)});assert.equal(f.service.jobs[0].rows.filter(r=>r.status==='PENDING').length,0);
 const runtime=new FastSaleRuntime(f.service);await runtime.tick();await runtime.tick();runtime.close();assert.equal(f.service.jobs[0].rows.filter(r=>r.status==='SOLD').length,99);
});
test('restart requires explicit resume, preserves expiry and original batch identity',async()=>{
 const f=fixture();await f.service.authorize(f.input);const saved=f.service.jobs[0].rows[0].plan.deadline;
 const s=new FastSaleService({adapter:f.adapter,trigger:f.trigger,store:f.store,now:()=>Date.now()});assert.equal(s.jobs[0].status,'PAUSED');
 await s.notifyOpening(f.input.asset,{open:true,pair:a(888)});assert.equal(s.jobs[0].rows[0].status,'READY');await s.control('job','resume');assert.equal(s.jobs[0].rows[0].plan.deadline,saved);
});
test('claim policy rejects unconfirmed and wrong-wallet evidence; independent claimed rows can go first',async()=>{
 const f=fixture();f.input.settings.source='after-claim';f.input.wallets=f.input.wallets.slice(0,3);await f.service.authorize(f.input);
 await assert.rejects(f.service.afterClaim({owner:a(1),token:f.input.asset,hash:'pending'}),/未核验/);
 await f.service.afterClaim({owner:a(1),token:f.input.asset,hash:'confirmed'});await f.service.follow('job');
 assert.equal(f.service.jobs[0].rows[0].status,'SOLD');assert.equal(f.service.jobs[0].rows[1].status,'WAIT_CLAIM');
 await f.service.afterClaim({owner:a(1),token:f.input.asset,hash:'confirmed'});assert.equal(f.service.jobs[0].batches.length,1);
});
test('normal claim pipeline only hands off orders with confirmed transfer evidence',async()=>{
 const f=fixture();f.input.settings.source='after-claim';f.input.wallets=f.input.wallets.slice(0,1);await f.service.authorize(f.input);
 const base={status:'CONFIRMED',plan:{wallet:a(1),outputToken:f.input.asset,route:'corla:claim'}};
 await assert.rejects(f.service.onClaimOrder({...base,steps:[]}),/到账凭据/);
 assert.equal(await f.service.onClaimOrder({...base,steps:[{status:'CONFIRMED',received:'100',txHash:'confirmed'}]}),true);
});
test('deployed mode cannot be enabled by API settings and minimum/expiry cannot be overridden',async()=>{
 assert.equal(new DisabledFastSale().status().enabled,false);assert.throws(()=>new FastSaleService({adapter:{chainId:56,simulationOnly:true}}),/本地模拟/);
 for(const extra of [{live:true},{minOut:'0'},{expiryHours:72},{privateKey:'do-not-read'}])assert.throws(()=>validateFastSettings({trigger:a(1),executor:a(2),source:'opening',...extra}),/无效/);
});
test('nonce not reserved for unopened project; concurrent trigger signing uses contiguous distinct nonces',async()=>{
 const wallet=ethers.Wallet.createRandom(),journalRows=new Map(),sent=[];
 const journal={all:()=>[...journalRows.values()],get:id=>journalRows.get(id)&&structuredClone(journalRows.get(id)),put:r=>journalRows.set(r.id,structuredClone(r))};
 const rpc=async(method,params)=>{if(method==='eth_chainId')return '0x7a69';if(method==='eth_getCode')return '0x00';if(method==='eth_getTransactionCount')return '0x0';if(method==='eth_gasPrice')return '0x1';if(method==='eth_sendRawTransaction'){sent.push(ethers.Transaction.from(params[0]));return ethers.keccak256(params[0]);}throw Error('unexpected RPC');};
 const trigger=new FastTrigger({wallet,journal,rpc,executor:a(2),executorHash:ethers.keccak256('0x00')});await trigger.warm();
 await trigger.prepare('unopened',[ethers.id('unopened')]);await trigger.prepare('ready1',[ethers.id('1')]);await trigger.prepare('ready2',[ethers.id('2')]);
 await Promise.all([trigger.broadcast('ready1'),trigger.broadcast('ready2')]);assert.deepEqual(sent.map(s=>s.nonce),[0,1]);assert.ok(sent.every(s=>s.chainId===31337n&&s.value===0n));assert.equal(journal.get('unopened').nonce,undefined);
});
test('private journal uses restrictive files and does not overwrite an existing active writer',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fast-private-'));try{const journal=new PrivateJournal(dir);journal.put({id:'test',nonce:0});assert.equal(fs.statSync(path.join(dir,'originals.json')).mode&0o777,0o600);assert.throws(()=>new PrivateJournal(dir),/占用/);journal.close();const reopened=new PrivateJournal(dir);assert.equal(reopened.get('test').nonce,0);reopened.close();}finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('claim confirmation during pause is retained and prepared only on explicit resume',async()=>{
 const f=fixture();f.input.settings.source='after-claim';f.input.wallets=f.input.wallets.slice(0,1);await f.service.authorize(f.input);await f.service.control('job','pause');
 await f.service.afterClaim({owner:a(1),token:f.input.asset,hash:'confirmed'});assert.equal(f.service.jobs[0].rows[0].claimHash,'confirmed');assert.equal(f.service.jobs[0].batches.length,0);
 await f.service.control('job','resume');assert.equal(f.service.jobs[0].batches.length,1);assert.equal(f.service.jobs[0].rows[0].status,'READY');
});
test('RPC refresh in background cannot block local signing with an already fresh nonce and gas price',async()=>{
 let block=false,release;const gate=new Promise(r=>release=r),sent=[];const wallet=ethers.Wallet.createRandom(),rows=new Map();
 const journal={all:()=>[...rows.values()],get:id=>rows.get(id),put:r=>rows.set(r.id,r)};
 const rpc=async(method,p)=>{if(block&&method==='eth_getCode')await gate;if(method==='eth_chainId')return '0x7a69';if(method==='eth_getCode')return '0x00';if(method==='eth_getTransactionCount')return '0x0';if(method==='eth_gasPrice')return '0x1';if(method==='eth_sendRawTransaction'){sent.push(p[0]);return ethers.keccak256(p[0]);}throw Error('unexpected');};
 const trigger=new FastTrigger({wallet,rpc,journal,executor:a(2),executorHash:ethers.keccak256('0x00')});await trigger.warm();await trigger.prepare('ready',[ethers.id('plan')]);block=true;const warming=trigger.warm();
 await trigger.broadcast('ready');assert.equal(sent.length,1);release();await warming;
});

test('one slow project scan does not prevent another project from submitting and settling',async()=>{
 const f=fixture();f.input.wallets=f.input.wallets.slice(0,1);await f.service.authorize(f.input);
 await f.service.authorize({...f.input,id:'other',asset:a(223),wallets:[{account:2,address:a(2)}]});
 let release;const gate=new Promise(r=>release=r);f.adapter.opening=async asset=>{if(asset===a(222))await gate;return {open:true,pair:a(888)};};
 const runtime=new FastSaleRuntime(f.service),slow=runtime.tick();await new Promise(r=>setImmediate(r));await runtime.tick();
 assert.equal(f.service.jobs.find(j=>j.id==='other').rows[0].status,'SOLD');release();await slow;runtime.close();
});
test('并发领取回执和开盘检查对同一计划只编组一次',async()=>{
 const f=fixture(),service=f.service;
 const rows=Array.from({length:100},(_,i)=>({status:'READY',plan:{id:ethers.id(String(i))}}));
 const j={id:'overlapping',rows,batches:[]};service.jobs.push(j);service.adapter.batchSize=20;
 service.trigger.prepare=async()=>{await new Promise(resolve=>setTimeout(resolve,2));return {status:'PREPARED'};};
 await Promise.all([service.prepareReady(j),service.prepareReady(j),service.prepareReady(j)]);
 assert.equal(j.batches.length,5);assert.equal(new Set(j.batches.flatMap(b=>b.ids)).size,100);
 assert.equal(j.batches.flatMap(b=>b.ids).length,100);
});

test('已确认的高税回滚等待逐钱包模拟，暂停或原主池被替换时不触发',async()=>{
 const f=fixture(),rows=f.input.wallets.slice(0,3);
 f.adapter.taxAware=true;
 const j=f.service.jobs;
 await f.service.authorize({...f.input,wallets:rows});
 const blocked=j[0].rows[0];
 f.adapter.outcomes=async(r,ids)=>new Map(ids.map(id=>[id,id===blocked.plan.id?{failed:true,reason:'HIGH_TRANSFER_FEE',message:'高税'}:{sold:true}]));
 f.adapter.simulateTaxBatch=async()=>[];
 await f.service.notifyOpening(f.input.asset,await f.adapter.opening());await f.service.follow('job');
 assert.deepEqual(j[0].rows.map(r=>r.status),['WAIT_TAX','SOLD','SOLD']);
 await f.service.recheckTax(j[0]);assert.equal(j[0].batches.length,1);
 f.advance(4000);f.adapter.simulateTaxBatch=async(_,rs)=>rs;
 await f.service.recheckTax(j[0]);assert.equal(j[0].batches.length,2);assert.equal(blocked.status,'READY');
 await f.service.notifyOpening(f.input.asset,{token:f.input.asset,open:true,pair:a(891)});
 assert.equal(j[0].status,'PAUSED');assert.equal(j[0].batches[1].status,'PREPARED');
});
