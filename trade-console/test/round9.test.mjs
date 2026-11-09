// Isolated read/plan tests: no wallet subprocess, network or signing.
import test from 'node:test';import assert from 'node:assert/strict';
import {Interface} from 'ethers';
import {receiptNftProof} from '../lib/chain-learning.mjs';
import {observedModuleLinks} from '../lib/site-data.mjs';
import {discover} from '../lib/discovery.mjs';
import {openingPlan} from '../lib/opening-route.mjs';
import {DEXES,V2_ROUTER_ABI} from '../lib/opening-dex.mjs';
import {ERC20,WBNB,bindings,same} from '../lib/common.mjs';
import {recognizeMint,adaptiveQuote} from '../lib/adaptive-mint.mjs';
import {mintError} from '../lib/mint-errors.mjs';
import {discoveryFailure} from '../lib/site-data.mjs';
import {failureKind} from '../public/failure-kind.mjs';
const token='0x'+'12'.repeat(20),owner=bindings()[0].address,other='0x'+'34'.repeat(20);
const nft=new Interface(['function ownerOf(uint256) view returns(address)','function balanceOf(address) view returns(uint256)','function tokenURI(uint256) view returns(string)','function supportsInterface(bytes4) view returns(bool)']);
const code='0x'+nft.fragments.filter(f=>f.name!=='supportsInterface').map(f=>'63'+f.selector.slice(2)+'1461000057').join('')+'00';
test('non-ERC165 issuance requires exact historical owners, balance and bounded distinct token IDs',async()=>{
 let recipient=owner,balance=2n;const blocks=[],rpc={call:async(tx,block)=>{const f=nft.parseTransaction(tx);if(f.name==='supportsInterface')throw Error('execution reverted');blocks.push(block);return nft.encodeFunctionResult(f.fragment,[f.name==='ownerOf'?recipient:balance]);}};
 const asset={token,amount:'2',tokenIds:['7','8']},sample={from:owner,block:345};
 assert.equal(await receiptNftProof(rpc,asset,sample,code),'historical-owner-and-balance');assert.deepEqual(blocks,[345,345,345]);
 recipient=other;assert.equal(await receiptNftProof(rpc,asset,sample,code),null);recipient=owner;balance=1n;assert.equal(await receiptNftProof(rpc,asset,sample,code),null);balance=2n;
 for(const changed of [{...asset,tokenIds:['7','7']},{...asset,amount:'1'},{...asset,tokenIds:[]},{...asset,tokenIds:Array.from({length:17},(_,n)=>String(n)),amount:'17'}])assert.equal(await receiptNftProof(rpc,changed,sample,code),null);
 assert.equal(await receiptNftProof(rpc,asset,sample,code+'f4'),null);
 await assert.rejects(receiptNftProof(rpc,asset,sample,code,async()=>{throw Error('historical state unavailable');}),/historical/);
});
test('lazy dependency maps discover previously unvisited deployment chunks without executing code',async()=>{
 const root='https://brand-new.example/',calls=[],pages=new Map([[root,'<script src="/assets/entry.js"></script>'],[root+'assets/entry.js','const chunks=["./screen-mint.js","https://foreign.example/tracker.js","//foreign.example/foreign.js"];'],[root+'assets/screen-mint.js','const deps=["../deployments/current.js"]; throw new Error("MUST NOT EXECUTE");'],[root+'deployments/current.js',`export const nftContract="${token}";`]]);
 const r=await discover(root,{fetchText:async url=>{calls.push(url);return pages.get(url)||'';}});assert.equal(r.address.toLowerCase(),token);assert.ok(calls.includes(root+'deployments/current.js'));assert.ok(calls.every(u=>u.startsWith(root)));assert.equal(new Set(calls).size,calls.length);
 assert.deepEqual(observedModuleLinks([{url:root+'assets/entry.js',text:'["./vendor-a.js","/mint-${key}.js","/mint.js#ignored","./real.js?v=2"]'}],root),[root+'assets/real.js?v=2']);
});
function racingRoutes({approvedFirst=true}={}){
 const dexes=DEXES.filter(d=>d.kind==='v2').slice(0,2);assert.equal(dexes.length,2);let release,started=[];const gate=new Promise(r=>release=r);
 const rpc={call:async tx=>{if(same(tx.to,token)){const f=ERC20.parseTransaction(tx);return ERC20.encodeFunctionResult(f.fragment,[f.name==='balanceOf'?1000n:approvedFirst||same(f.args[1],dexes[0].router)?1000n:0n]);}
 const d=dexes.find(d=>same(d.router,tx.to));assert.ok(d);started.push(d.id);if(d===dexes[0])await gate;return V2_ROUTER_ABI.encodeFunctionResult('getAmountsOut',[[500n,200n]]);}};
 const pools=dexes.map((d,i)=>({...d,quote:WBNB,liquid:true,pool:'0x'+String(i+5).repeat(40),token0:token,token1:WBNB,reserve0:'1000',reserve1:'2000'}));
 const plan=()=>openingPlan(rpc,{}, {account:bindings()[0].account,asset:token,side:'sell',percent:'50',slippageBps:5000,currency:'AUTO'}, {preparation:{token:async()=>({decimals:18,identity:{fingerprint:'fake'}}),venue:async()=>({assets:[]})},scan:async()=>({at:Date.now(),pools})});
 return {plan,release,started,dexes};
}
test('unresponsive quote has a bounded comparison deadline; amount and slippage remain exact',async()=>{
 const h=racingRoutes();let timer;try{const p=await Promise.race([h.plan(),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Healthy route waited for slow pool')),1600))]);assert.equal(p.route,h.dexes[1].id+'-opening');assert.equal(p.amountIn,'500');assert.equal(p.minOutput,'100');assert.deepEqual(p.steps.map(s=>s.kind),['sell']);assert.equal(h.started.length,2);}finally{clearTimeout(timer);h.release();}
});
test('parallel fee comparison does not let quote arrival order choose the pool',async()=>{
 const h=racingRoutes({approvedFirst:false});let done=false;const task=h.plan().then(p=>{done=true;return p;});await new Promise(r=>setImmediate(r));assert.equal(done,false);assert.deepEqual(h.started,h.dexes.map(d=>d.id));h.release();const p=await task;assert.equal(p.route,h.dexes[0].id+'-opening');assert.deepEqual(p.steps.map(s=>s.kind),['sell']);
});
test('unfamiliar start/end aliases distinguish closed windows before building calls',async()=>{
 for(const [start,end]of [['MINT_START','MINT_END'],['mintStart','mintEnd'],['saleStartTime','saleEnd']]){
  const abi=new Interface(['function freeMint()',`function ${start}() view returns(uint256)`,`function ${end}() view returns(uint256)`]),meta={address:token,verified:true,abi:JSON.parse(abi.formatJson()),sources:{}},route=recognizeMint(meta).routes[0];let starts=50n,ends=100n;
  const rpc=async(m,p)=>{assert.equal(m,'eth_call');const f=abi.parseTransaction(p[0]);assert.ok([start,end].includes(f.name));return abi.encodeFunctionResult(f.fragment,[f.name===start?starts:ends]);};
  await assert.rejects(adaptiveQuote(meta,route,{address:owner},1,{tag:'0x1',timestamp:100},rpc),e=>e.code==='MINT_ENDED');starts=200n;ends=300n;
  await assert.rejects(adaptiveQuote(meta,route,{address:owner},1,{tag:'0x1',timestamp:100},rpc),e=>e.code==='MINT_NOT_OPEN');
 }
});
test('decoded quota errors and incomplete history are not reported as unsupported mint',()=>{
 const abi=new Interface(['error Error(string)']);assert.equal(mintError({data:abi.encodeErrorResult('Error',['Free already claimed'])}).code,'NO_QUOTA');assert.equal(mintError({message:'RPC Free already claimed'}).code,undefined);
 for(const status of ['unavailable','time-budget']){const e=discoveryFailure({addresses:[{address:token}],candidates:[],chainLearning:{status}});assert.equal(e.code,'CHAIN_HISTORY_INCOMPLETE');assert.equal(failureKind(e),'network');}
 assert.equal(discoveryFailure({addresses:[{}],candidates:[],chainLearning:{status:'no-samples'}}).code,'MINT_NOT_VERIFIED');assert.equal(failureKind({code:'WEBSITE_UNAVAILABLE'}),'network');
});
