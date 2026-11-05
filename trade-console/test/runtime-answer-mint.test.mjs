import test from 'node:test';import assert from 'node:assert/strict';import {Interface} from 'ethers';
import {publishedMintPuzzle} from '../lib/abi-hints.mjs';import {recognizeRuntimeAnswerMint,runtimeAnswerPlan} from '../lib/runtime-answer-mint.mjs';
const abi=new Interface(['function mint(uint256,uint256)','function quote(address,uint256) view returns(uint256,uint256,uint256)','function checkAnswer(address,uint256,uint256) view returns(bool)','function mintedBy(address) view returns(uint256)','function MAX_PER_WALLET() view returns(uint256)','function MAX_SUPPLY() view returns(uint256)','function totalMinted() view returns(uint256)','function mintActive() view returns(bool)','function isAgent(address) view returns(bool)','function supportsInterface(bytes4) view returns(bool)']);
const doc='H = last 4 hex characters of wallet; M = mintedBy(address); code = H + 2200 × (M + Q); checkAnswer(address,uint256,uint256)';
const resolved={mintPuzzle:publishedMintPuzzle([{text:doc}])},w={address:'0x'+'1'.repeat(36)+'a123'},meta={address:'0x'+'2'.repeat(40),verified:false,runtimeCode:'0x'+abi.fragments.map(f=>'63'+f.selector.slice(2)+'14600057').join('')+'00'};
const intent={account:1,scope:'free',quantity:'max',referral:'account1',maxBnb:'0',maxUsdt:'0'};
function fixture(){const s={used:0n,valid:true,active:true,eligible:true,nft:true,free:1n,paidCost:1n,stock:2200n,calls:[]};const rpc={getBlockNumber:async()=>42,call:async(tx,b)=>{assert.equal(b,42);assert.equal(tx.from,w.address);s.calls.push(tx);const parsed=abi.parseTransaction(tx),f={...parsed,args:Array.from(parsed.args)},n=f.args[1]??0n,free=f.name==='quote'?(n<s.free?n:s.free):0n,paid=f.name==='quote'?n-free:0n;
 if(f.name==='mint'){assert.equal(tx.value,0n);assert.equal(f.args[1],BigInt('0xa123')+2200n*(s.used+f.args[0]));return '0x';}
 const values={mintActive:[s.active],isAgent:[s.eligible],supportsInterface:[s.nft],mintedBy:[s.used],MAX_PER_WALLET:[5n],MAX_SUPPLY:[2200n],totalMinted:[2200n-s.stock],quote:[free,paid,paid*s.paidCost],checkAnswer:[s.valid&&f.args[2]===BigInt('0xa123')+2200n*(s.used+n)]};return abi.encodeFunctionResult(f.fragment,values[f.name]);}};return {s,rpc};}
test('published wallet arithmetic is bounded data with conflict and runtime dispatch rejection',()=>{
 assert.deepEqual(resolved.mintPuzzle,{kind:'wallet-counter-answer',hexDigits:4,factor:'2200'});assert.equal(publishedMintPuzzle([{text:doc},{text:doc.replace('2200','2201')}]),null);assert.equal(publishedMintPuzzle([{text:doc.replace('4 hex','41 hex')}]),null);assert.equal(publishedMintPuzzle([{text:doc.replace('2200','eval(x)')}]),null);
 assert.ok(recognizeRuntimeAnswerMint(meta,resolved));for(const change of [{runtimeCode:'0x00'},{proxy:true},{verified:true},{identity:{implementation:meta.address}},{runtimeCode:meta.runtimeCode+'f4'}])assert.equal(recognizeRuntimeAnswerMint({...meta,...change},resolved),null);
});
test('free NFT answer is recalculated for current counter and requires both chain checks and credit preview',async()=>{
 const {s,rpc}=fixture();s.used=2n;const p=await runtimeAnswerPlan(rpc,intent,meta,w,resolved);assert.equal(p.quantity,1);assert.equal(p.steps.length,1);assert.equal(p.amountIn,'0');assert.equal(p.requireNftCredit,true);assert.equal(p.metaVerified,false);assert.equal(p.freshBeforeExecute,true);assert.equal(p.expectedAsset.amount,'1');assert.equal(p.steps[0].value,'0');assert.equal(abi.decodeFunctionData('mint',p.steps[0].data)[1],BigInt('0xa123')+6600n);
 s.used=3n;const next=await runtimeAnswerPlan(rpc,intent,meta,w,resolved);assert.notEqual(next.steps[0].data,p.steps[0].data);
});
test('paid scope, stale routes, invalid answers, sold-out and uncertain referral are explicit hard stops',async()=>{
 const {s,rpc}=fixture();for(const scope of ['paid','all'])await assert.rejects(runtimeAnswerPlan(rpc,{...intent,scope},meta,w,resolved),e=>e.code==='MINT_ADAPTER_INCOMPLETE');await assert.rejects(runtimeAnswerPlan(rpc,{...intent,routeId:'other'},meta,w,resolved),e=>e.code==='MINT_ROUTE_CHANGED');await assert.rejects(runtimeAnswerPlan(rpc,{...intent,account:2},meta,w,{...resolved,referralHints:{detected:true}}),e=>e.code==='REFERRAL_NOT_VERIFIED');
 s.valid=false;await assert.rejects(runtimeAnswerPlan(rpc,intent,meta,w,resolved),/未通过/);assert.equal(s.calls.some(t=>t.data.startsWith(abi.getFunction('mint').selector)),false);s.valid=true;s.stock=0n;await assert.rejects(runtimeAnswerPlan(rpc,intent,meta,w,resolved),e=>e.code==='NO_QUOTA');s.stock=2200n;s.active=false;await assert.rejects(runtimeAnswerPlan(rpc,intent,meta,w,resolved),e=>e.code==='MINT_NOT_OPEN');
});

test('unknown arithmetic quota probes free quantities without reusing another wallet answer or paid quote',async()=>{
 const {s,rpc}=fixture();s.free=3n;s.used=2n;
 const unknown={...meta,runtimeCode:meta.runtimeCode.replace('63'+abi.getFunction('MAX_PER_WALLET').selector.slice(2)+'14600057','')};
 const p=await runtimeAnswerPlan(rpc,intent,unknown,w,resolved);assert.equal(p.quantity,3);assert.equal(p.amountIn,'0');assert.deepEqual(p.quota.freeProbe.attempted,[10,9,8,7,6,5,4,3]);assert.equal(p.fill.continue,true);assert.equal(p.quota.walletRemaining,null);
 const calls=s.calls.map(t=>abi.parseTransaction(t)).filter(x=>x.name==='mint');assert.equal(calls.length,1);assert.equal(calls[0].args[1],BigInt('0xa123')+2200n*5n);
 s.free=0n;await assert.rejects(runtimeAnswerPlan(rpc,intent,unknown,w,resolved),e=>e.code==='NO_FREE_MINT');
});
