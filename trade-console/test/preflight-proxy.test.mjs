import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {id,keccak256} from 'ethers';
import {hash} from '../lib/common.mjs';
import {codeIdentity,IMPL_SLOT,BEACON_SLOT,SourceCache,sourceFor} from '../lib/discovery.mjs';
import {verifyIdentity} from '../lib/mint.mjs';
const target='0x'+'1'.repeat(40),beacon='0x'+'2'.repeat(40),impl='0x'+'3'.repeat(40),zero='0x'+'0'.repeat(64),word=a=>'0x'+'0'.repeat(24)+a.slice(2);
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'mint-source-'));
test('canonical EIP-1967 beacon implementation is inspected and upgrades invalidate prior identity',async()=>{
 assert.equal(IMPL_SLOT,'0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc');assert.equal(BEACON_SLOT,'0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50');
 let implementationCode='0x6001';const rpc={getCode:async a=>a===impl?implementationCode:'0x6000',send:async(m,p)=>{if(m==='eth_getStorageAt')return p[1]===BEACON_SLOT?word(beacon):zero;assert.equal(p[0].to,beacon);assert.equal(p[0].data,id('implementation()').slice(0,10));return word(impl);}};
 const identity=await codeIdentity(rpc,target);assert.equal(identity.beacon,beacon);assert.equal(identity.implementation,impl);
 await verifyIdentity(rpc,identity);implementationCode='0x6002';await assert.rejects(verifyIdentity(rpc,identity),/已变化/);
});
test('conflicting proxy slots, malformed beacon return, or implementation with no code stop construction',async()=>{
 const rpc={getCode:async()=> '0x6000',send:async(m,p)=>m==='eth_getStorageAt'?word(p[1]===BEACON_SLOT?beacon:impl):word(impl)};
 await assert.rejects(codeIdentity(rpc,target),/同时存在/);
 rpc.send=async(m,p)=>m==='eth_getStorageAt'?(p[1]===BEACON_SLOT?word(beacon):zero):'0x01';await assert.rejects(codeIdentity(rpc,target),/格式异常/);
 rpc.send=async(m,p)=>m==='eth_getStorageAt'?(p[1]===BEACON_SLOT?word(beacon):zero):word(impl);rpc.getCode=async a=>a===impl?'0x':'0x6000';await assert.rejects(codeIdentity(rpc,target),/没有代码/);
});
test('non-beacon fingerprints stay compatible with existing pinned sample adapters',async()=>{
 const rpc={getCode:async()=> '0x6000',send:async()=>zero};const v=await codeIdentity(rpc,target);assert.equal(v.fingerprint,hash([keccak256('0x6000'),null,null]));
});
test('caller-dependent beacon cannot substitute a different implementation during inspection',async()=>{
 const rpc={getCode:async()=> '0x6000',send:async(m,p)=>m==='eth_getStorageAt'?(p[1]===BEACON_SLOT?word(beacon):zero):word(p[0].from?target:impl)};
 await assert.rejects(codeIdentity(rpc,target),/依赖调用者/);
});
test('source misses coalesce briefly, retry after TTL and never hide changed bytecode',async()=>{
 let calls=0,now=0;const cache=new SourceCache({data:temp(),now:()=>now,fetchJson:async()=>{calls++;await Promise.resolve();throw Error('not verified');}});
 await Promise.all(Array.from({length:5},()=>cache.get(target,'0x6000')));assert.equal(calls,1);
 await cache.get(target,'0x6000');assert.equal(calls,1);await cache.get(target,'0x6001');assert.equal(calls,2);
 now=30001;await cache.get(target,'0x6000');assert.equal(calls,3);
});
test('only full matching verified runtime is cached; source cache still checks live identity every request',async()=>{
 let calls=0,reads=0,code='0x6000';const cache=new SourceCache({data:temp(),fetchJson:async()=>{calls++;return {runtimeMatch:'match',runtimeBytecode:{onchainBytecode:'0x6000'},abi:[],sources:{A:{content:'contract A {}'}}};}});
 const rpc={getCode:async()=>{reads++;return code;},send:async()=>zero};assert.equal((await sourceFor(rpc,target,{cache})).verified,true);assert.equal((await sourceFor(rpc,target,{cache})).verified,true);assert.equal(calls,1);assert.equal(reads,2);
 code='0x6001';assert.equal((await sourceFor(rpc,target,{cache})).verified,false);assert.equal(calls,2);assert.equal(reads,3);
});
