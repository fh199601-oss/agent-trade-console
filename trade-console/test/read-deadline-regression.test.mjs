import test from 'node:test';
import assert from 'node:assert/strict';
import {Rpc,forkReadRpc,preemptibleReadRpc} from '../lib/network.mjs';
import {RpcEndpoints} from '../lib/rpc-endpoints.mjs';
import {openingReads} from '../lib/opening-read.mjs';
import {ERC20} from '../lib/common.mjs';
import {checkedRead} from '../lib/read-failure.mjs';
import {presentError,errorCategory} from '../public/error-message.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const query=(q)=>({id:q.id,result:q.method==='eth_chainId'?'0x38':'0x123'});
test('isolated scan/metadata clients inherit the full failover deadline, including cold chain verification',async()=>{
 const endpoints=new RpcEndpoints({primary:'https://primary.example',publicUrls:['https://backup.example'],timeoutMs:200,hedgeMs:5,fetchImpl:async(url,o)=>{
  if(url.includes('primary'))throw Error('connection reset');
  await wait(140);o.signal.throwIfAborted();const q=JSON.parse(o.body);return {ok:true,json:async()=>Array.isArray(q)?q.map(query):query(q)};
 }});
 const source=new Rpc(undefined,{timeoutMs:600,fetchImpl:endpoints.fetch});source.endpoints=endpoints;
 const scan=forkReadRpc(source),prep=forkReadRpc(source);
 assert.equal(scan.timeoutMs,600);assert.equal(prep.endpoints,endpoints);
 // Verification + query takes > 200 ms even though each request is healthy.
 assert.deepEqual(await Promise.all([scan.getBlockNumber(),prep.getBlockNumber()]),[291,291]);
 assert.equal(scan.activeReads,0);assert.equal(prep.activeReads,0);
});
test('interrupting dispatched background reads immediately frees them without aborting a foreground read',async()=>{
 let idle=true,started,interrupted=0;const began=new Promise(r=>started=r);
 const ep=new RpcEndpoints({primary:'https://node.example',publicUrls:[],timeoutMs:500,fetchImpl:async(url,o)=>{
  const q=JSON.parse(o.body),rows=Array.isArray(q)?q:[q];
  if(rows.some(r=>r.method==='eth_getLogs')){started();await new Promise((resolve,reject)=>o.signal.addEventListener('abort',()=>{interrupted++;reject(o.signal.reason);},{once:true}));}
  return {ok:true,json:async()=>Array.isArray(q)?rows.map(query):query(q)};
 }});
 const main=new Rpc(undefined,{fetchImpl:ep.fetch}),warm=preemptibleReadRpc(main,()=>idle);
 const pending=warm.send('eth_getLogs',[{}]);await began;idle=false;warm.interrupt();
 await assert.rejects(pending,e=>e.code==='WARM_YIELDED');assert.equal(interrupted,1);
 assert.equal(await main.getBlockNumber(),291);assert.equal(ep.state(ep.primary).until,0);
 idle=true;assert.equal(await warm.getBlockNumber(),291);
});
test('a network timeout in Multicall never becomes 64 extra individual reads',async()=>{
 let calls=0,blocks=0;const rpc={call:async()=>{calls++;throw new DOMException('The operation was aborted due to timeout','TimeoutError');},getBlockNumber:async()=>{blocks++;return 1;}};
 const row={to:'0x'+'11'.repeat(20),abi:ERC20,method:'decimals'};
 await assert.rejects(openingReads(rpc,Array(64).fill(row)),e=>e.name==='TimeoutError');
 assert.equal(calls,1);assert.equal(blocks,0);
});
test('network failures retain their actual Chinese stage and cannot become no liquidity',async()=>{
 let error;try{await checkedRead('sellPoolScan','卖出池子查询',async()=>{throw new DOMException('timeout','TimeoutError');});}catch(e){error=e;}
 assert.equal(error.code,'RPC_READ_TIMEOUT');assert.equal(errorCategory(error),'network');
 assert.match(presentError(error).message,/卖出池子查询超时/);assert.match(presentError(error).message,/未提交/);
});
test('background interruption and contract reverts are never reclassified as a network retry',async()=>{
 for(const code of ['WARM_YIELDED','CALL_EXCEPTION']){
  const error=Object.assign(Error('original'),{code});await assert.rejects(checkedRead('test','测试',async()=>{throw error;}),e=>e===error);
 }
});
test('prewarmed endpoint verification serves isolated clients without redundant chain probes',async()=>{
 let calls=0,now=1000;const ep=new RpcEndpoints({now:()=>now,primary:'https://node.example',publicUrls:[],fetchImpl:async(url,o)=>{
  calls++;const q=JSON.parse(o.body);return {ok:true,json:async()=>Array.isArray(q)?q.map(query):query(q)};
 }});
 await ep.warm();assert.equal(calls,1);
 const main=new Rpc(undefined,{fetchImpl:ep.fetch});main.endpoints=ep;
 await Promise.all([main.verifyChain(),forkReadRpc(main).verifyChain(),forkReadRpc(main).verifyChain()]);assert.equal(calls,1);
 await ep.warm();assert.equal(calls,1);
 now+=300001;await forkReadRpc(main).verifyChain();assert.equal(calls,2,'expired proof is reverified');
});
