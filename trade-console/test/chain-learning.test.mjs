import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Interface,keccak256,ZeroAddress} from 'ethers';
import {ChainLearner,mintReceiptSample,TRANSFER,chainSeeds} from '../lib/chain-learning.mjs';
import {learnedRecognition,applyChainEvidence,assistMint,adaptiveQuoteWithLearning} from '../lib/chain-assist.mjs';
import {recognizeMint,adaptiveQuote} from '../lib/adaptive-mint.mjs';
import {verifyPreview} from '../lib/engine.mjs';
import {codeIdentity,discover} from '../lib/discovery.mjs';
import {verifyIdentity,mintPlan} from '../lib/mint.mjs';
const A='0x'+'1'.repeat(40),B='0x'+'2'.repeat(40),C='0x'+'3'.repeat(40),W='0x'+'4'.repeat(40),D='0x'+'5'.repeat(40);
const hex=n=>'0x'+BigInt(n).toString(16),word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0'),temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'chain-mint-test-'));
const nft=['function supportsInterface(bytes4) view returns(bool)','function ownerOf(uint256) view returns(address)','function balanceOf(address) view returns(uint256)'];
const erc=['function decimals() view returns(uint8)','function totalSupply() view returns(uint256)','function balanceOf(address) view returns(uint256)','function transfer(address,uint256) returns(bool)','function allowance(address,address) view returns(uint256)'];
const bytecode=iface=>'0x'+iface.fragments.filter(f=>f.type==='function').map(f=>'63'+f.selector.slice(2)+'1461000057').join('')+'00';
function fixture({method='hatch()',verified=false,quantity=false,complex=false,separate=false,linked=true,sameSender=false,getter='token',quantityMethod='hatch',legacyNft=false}={}){
 const signature=complex?'hatch(bytes proof)':quantity?quantityMethod+'(uint256 quantity)':method;
 const iface=new Interface(['function '+signature+' payable',...(separate?linked?['function '+getter+'() view returns(address)']:[]:nft),...(legacyNft?['function tokenURI(uint256) view returns(string)']:[]),...(quantity?['function price() view returns(uint256)','function walletRemaining(address) view returns(uint256)']:[])]);
 const token=separate?B:A,assetInterface=separate?new Interface(erc):iface,oldCode=bytecode(legacyNft?new Interface(iface.fragments.filter(f=>f.name!=='supportsInterface')):iface),assetCode=separate?bytecode(assetInterface):oldCode;
 let currentCode=oldCode,reorg=false,fee=7n,scans=0,reject=false,archive=false;const calls=[],txs=new Map(),receipts=new Map();
 const header=b=>({number:hex(b),hash:word(b+(reorg?20000:0)),timestamp:'0x64'});
 for(let i=0;i<2;i++){
  const from=i&&!sameSender?C:W,hash=word(100+i),block=9990+i,input=iface.encodeFunctionData(signature,complex?['0x1234']:quantity?[i+1]:[]),data=separate?word(1000*(quantity?i+1:1)):'0x';
  const tx={hash,from,to:A,input,value:hex(quantity?14*(i+1):999),blockNumber:hex(block),blockHash:header(block).hash};
  const log={address:token,topics:[TRANSFER,word(0),word(from),...(separate?[]:[word(i)])],data,transactionHash:hash,blockNumber:hex(block),blockHash:tx.blockHash,logIndex:'0x0'};
  const logs=quantity&&!separate?Array.from({length:i+1},(_,n)=>({...log,topics:[TRANSFER,word(0),word(from),word(i*10+n)],logIndex:hex(n)})):[log];
  txs.set(hash,tx);receipts.set(hash,{transactionHash:hash,status:'0x1',from,to:A,blockNumber:tx.blockNumber,blockHash:tx.blockHash,logs});
 }
 const meta=()=>({address:A,hash:keccak256(currentCode),runtimeCode:currentCode,verified,abi:verified?JSON.parse(iface.formatJson()):undefined,sources:{s:{content:quantity?'contract X { function hatch(uint256 quantity) external payable { require(quantity>0); } }':'contract X { function hatch() external payable {} }'}}});
 const rpc={verifyChain:async()=>{},getBlockNumber:async()=>10000,getTransaction:async h=>txs.get(h),getTransactionReceipt:async h=>receipts.get(h),getCode:async(a,b='latest')=>{if(b!=='latest'&&archive)throw Error('missing trie node');return a.toLowerCase()===A?(b==='latest'?currentCode:oldCode):assetCode;},
  call:async(t,b='latest')=>rpc.send('eth_call',[t,b==='latest'?b:hex(b)]),send:async(m,p)=>{calls.push([m,p]);
   if(m==='eth_getStorageAt')return word(0);
   if(m==='eth_getBlockByNumber')return header(Number(BigInt(p[0])));
   if(m==='eth_getLogs'){scans++;return [...receipts.values()].flatMap(r=>r.logs).filter(l=>p[0].address.includes(l.address.toLowerCase()));}
   if(m==='eth_estimateGas')return '0x186a0';
   assert.equal(m,'eth_call','all other RPC methods forbidden');
   const ai=p[0].to.toLowerCase()===B?assetInterface:iface,f=ai.parseTransaction(p[0]);
   if(f.name==='hatch'||f.name==='mint'){if(reject||BigInt(p[0].value||0)!==(quantity?fee*f.args[0]:0n))throw Object.assign(Error('execution reverted: price or eligibility'),{executionError:true});return '0x';}
   const nftOwner=f.name==='ownerOf'?[...receipts.values()].find(r=>r.logs.some(l=>l.topics[3]===word(f.args[0])))?.from:null;
   const values={supportsInterface:!legacyNft,ownerOf:nftOwner,balanceOf:1n,[getter]:B,decimals:18n,price:fee,walletRemaining:5n};assert.ok(f.name in values,f.name);return ai.encodeFunctionResult(f.fragment,[values[f.name]]);
  }};
 const logRpc={...rpc,getCode:async(a,b)=>a.toLowerCase()===A?oldCode:assetCode};
 const learner=new ChainLearner(rpc,{logRpc,data:temp(),scanBlocks:64}),sourceLoader=async()=>meta(),seeds=[{address:token}],learn=opts=>learner.learn(seeds,{sourceLoader,...opts});
 return {rpc,learner,sourceLoader,seeds,learn,meta,iface,txs,receipts,header,calls,scans:()=>scans,setCode:v=>currentCode=v,setReorg:()=>reorg=true,setFee:v=>fee=v,setReject:()=>reject=true,setArchive:()=>archive=true};
}

test('non-ERC165 collection history reaches a usable entry only after issuance-block ownership checks',async()=>{
 const f=fixture({legacyNft:true}),e=await f.learn();assert.equal(e.scan.accepted,2);assert.equal(e.methods[0].usable,true);assert.equal(e.methods[0].participants,2);
 assert.ok(e.methods[0].samples.every(s=>s.assets[0].interfaceProof==='historical-owner-and-balance'));
 const owners=f.calls.filter(([m,p])=>m==='eth_call'&&p[0].data.startsWith(f.iface.getFunction('ownerOf').selector));assert.deepEqual(owners.map(([,p])=>p[1]).sort(),['0x2706','0x2707']);
 const meta=f.meta(),r=learnedRecognition(meta,recognizeMint(meta),e);assert.equal(r.routes.length,1);assert.equal(r.routes[0].observedAsset.kind,'Erc721');assert.equal((await f.learn()).cached,true);
});

test('recent history verifies up to 100 receipts, including mint samples beyond the former 16-record cap',async()=>{
 const f=fixture(),tx=[...f.txs.values()][0],receipt=[...f.receipts.values()][0];
 f.txs.clear();f.receipts.clear();
 for(let i=0;i<110;i++){
  const hash=word(1000+i),block=9990-Math.floor(i/10),from=i%2?C:W,blockHash=f.header(block).hash;
  f.txs.set(hash,{...tx,hash,from,blockNumber:hex(block),blockHash});
  f.receipts.set(hash,{...receipt,transactionHash:hash,from,blockNumber:hex(block),blockHash,logs:receipt.logs.map(l=>({...l,transactionHash:hash,blockNumber:hex(block),blockHash,transactionIndex:hex(9-i%10),topics:[TRANSFER,word(i<20?C:0),word(from),word(i)]}))});
 }
 const e=await f.learn({force:true});assert.equal(e.scan.limit,100);assert.equal(e.scan.checked,100);assert.equal(e.scan.found,110);assert.equal(e.scan.accepted,80);assert.equal(e.methods[0].usable,true);assert.ok(e.partial);
});

test('automatic history scan stops scheduling reads after budget and does not report no-mints',async()=>{
 const f=fixture();let now=0,scans=0;f.learner.now=()=>now;f.learner.maxElapsedMs=10;f.learner.scanBlocks=8192;
 f.learner.logRpc={verifyChain:async()=>{},getBlockNumber:async()=>10000,send:async()=>{scans++;now=20;return [];}};
 const e=await f.learn();assert.equal(e.status,'time-budget');assert.equal(e.budgetExhausted,true);assert.equal(e.partial,true);assert.ok(scans<=2);assert.match(e.note,/时间预算/);assert.equal(e.expanded,undefined);
});

test('success receipt must prove canonical zero-address issuance to the sender; transfers, failures, reorgs and duplicates are not mint proof',()=>{
 const f=fixture(),tx=[...f.txs.values()][0],receipt=[...f.receipts.values()][0],h=f.header(9990),check=r=>mintReceiptSample(tx,r,h,10000);
 assert.equal(check(receipt).assets[0].amount,'1');assert.equal(check({...receipt,status:'0x0'}),null);
 assert.equal(check({...receipt,logs:[{...receipt.logs[0],topics:[TRANSFER,word(C),word(W),word(1)]}]}),null);
 assert.equal(check({...receipt,blockHash:word(999999)}),null);
 assert.equal(check({...receipt,logs:[{...receipt.logs[0],removed:true}]}),null);
 assert.equal(check({...receipt,logs:[receipt.logs[0],receipt.logs[0]]}).assets[0].amount,'1');
 assert.equal(mintReceiptSample(tx,receipt,h,9992),null);
});
test('two participants identify raw no-argument entry; cache never stores calldata and rechecks canonical blocks',async()=>{
 const f=fixture(),e=await f.learn();assert.equal(e.status,'observed');assert.equal(e.targets[0].corroborated,true);assert.equal(e.methods[0].usable,true);assert.equal(e.methods[0].participants,2);
 const saved=JSON.parse(fs.readFileSync(path.join(f.learner.dir,fs.readdirSync(f.learner.dir)[0]),'utf8'));
 assert.equal('input' in saved.methods[0].samples[0],false);assert.equal('calldata' in saved,false);
 const scans=f.scans();assert.equal((await f.learn()).cached,true);assert.equal(f.scans(),scans);
 f.setReorg();assert.equal((await f.learn()).methods.length,0);assert.ok(f.scans()>scans);
});
test('same sender repeated, changed code and delegate proxies never become automatically reusable',async()=>{
 const one=fixture({sameSender:true});const e=await one.learn();assert.equal(e.methods[0].usable,false);assert.equal(e.targets[0].corroborated,false);
 const f=fixture();await f.learn();f.setCode(f.meta().runtimeCode+'00');assert.equal((await f.learn()).methods.length,0);
 const p=fixture();p.setCode(p.meta().runtimeCode+'f4');assert.equal((await p.learn()).methods.length,0);
});
test('pruned historical state uses the read-only log/archive RPC; provider failure is unavailable rather than no mints',async()=>{
 const f=fixture();f.setArchive();assert.equal((await f.learn()).methods.length,1);
 f.learner.logRpc={verifyChain:async()=>{},getBlockNumber:async()=>10000,send:async()=>{throw Error('HTTP 429');}};
 const result=await f.learn({force:true});assert.equal(result.status,'unavailable');assert.ok(result.errors.length);
});
test('archive fallback checks chain and repairs pruned primary plus unavailable log archive without accepting changed code',async()=>{
 const f=fixture();f.setArchive();const archive=f.learner.logRpc;let verified=0;
 f.learner.logRpc={...archive,getCode:async()=>{throw Error('RPC HTTP 403');}};
 f.learner.archiveRpc={...archive,verifyChain:async()=>{verified++;}};
 assert.equal((await f.learn({force:true})).methods.length,1);assert.ok(verified);
 f.learner.archiveRpc={...archive,verifyChain:async()=>{throw Error('Wrong chain');}};
 const bad=await f.learn({force:true});assert.equal(bad.methods.length,0);assert.equal(bad.status,'unavailable');assert.ok(bad.scan.reasons.historical_rpc_unavailable>0);
});
test('separate token discovers a linked mint contract, while an unlinked router is only a lead',async()=>{
 const f=fixture({separate:true}),e=await f.learn();assert.equal(e.targets[0].address,A);assert.equal(e.methods[0].assets[0].token,B);assert.equal(e.targets[0].corroborated,true);
 const resolved=applyChainEvidence({address:B,addresses:[{address:B,roles:['token'],verifiedRoles:['token'],evidence:[]}]},e);assert.equal(resolved.address,A);assert.equal(resolved.token,B);
 const g=fixture({separate:true,linked:false}),unlinked=await g.learn();assert.equal(unlinked.targets[0].corroborated,false);assert.equal(learnedRecognition(g.meta(),recognizeMint(g.meta()),unlinked).routes.length,0);
 const ambiguous=applyChainEvidence({address:null,addresses:[{address:D,roles:['mint'],verifiedRoles:['mint'],evidence:[]}]},e);assert.equal(ambiguous.address,null);
 const arbitraryName=fixture({separate:true,verified:true,getter:'treasureOfTheDay'});assert.equal((await arbitraryName.learn()).targets[0].corroborated,true);
});
test('raw learned call uses current wallet and zero value, not historical payment; failed simulation cannot be skipped',async()=>{
 const f=fixture(),e=await f.learn(),meta=f.meta(),recognition=learnedRecognition(meta,recognizeMint(meta),e),route=recognition.routes[0];
 assert.equal(route.id,'chain:'+f.iface.getFunction('hatch').selector);assert.equal(route.zeroOnly,true);
 const q=await adaptiveQuote({...meta,abi:recognition.abi},route,{account:1,address:D},1,{tag:'0x2710',number:10000},f.rpc.send);
 assert.equal(q.call.value,'0');assert.equal(q.call.data,f.iface.getFunction('hatch').selector);assert.equal(q.expectedAsset.token,A);assert.equal(q.limits.walletRemaining,null);
 assert.ok(f.calls.filter(([m,p])=>m==='eth_call'&&p[0].data===q.call.data).every(([,p])=>p[0].from===D&&p[0].value==='0x0'));
 f.setReject();await assert.rejects(adaptiveQuote({...meta,abi:recognition.abi},route,{account:1,address:D},1,{tag:'0x2710',number:10000},f.rpc.send),/不可执行/);
});
test('verified unfamiliar quantity method rebuilds calldata and reads current fee; signatures and unknown argument words are never replayed',async()=>{
 const f=fixture({verified:true,quantity:true}),e=await f.learn(),meta=f.meta(),r=learnedRecognition(meta,recognizeMint(meta),e);assert.equal(r.routes.length,1);assert.equal(e.methods[0].output.minPerUnit,'1');
 const q=await adaptiveQuote({...meta,abi:r.abi},r.routes[0],{account:1,address:D},2,{tag:'0x2710',number:10000},f.rpc.send);assert.equal(q.total.raw,'14');
 f.setFee(13n);const current=await adaptiveQuote({...meta,abi:r.abi},r.routes[0],{account:1,address:D},2,{tag:'0x2710',number:10000},f.rpc.send);assert.equal(current.total.raw,'26');assert.equal(f.iface.decodeFunctionData('hatch',current.call.data)[0],2n);
 for(const options of [{quantity:true},{complex:true},{complex:true,verified:true}]){const g=fixture(options),e2=await g.learn();assert.equal(e2.methods[0].usable,false);assert.equal(learnedRecognition(g.meta(),recognizeMint(g.meta()),e2).routes.length,0);}
});
test('normal supported methods bypass chain scans, including before a later eligibility failure',async()=>{
 const f=fixture({method:'mintFree()'}),resolved={};const r=await assistMint(f.rpc,f.meta(),resolved,f.sourceLoader,{learner:{learn:async()=>{throw Error('must not scan');}}});assert.equal(r.routes.length,1);assert.equal(resolved.chainLearning,undefined);
});
test('a recognized entry missing asset data learns receipts once and enriches the same selectable route',async()=>{
 const f=fixture({method:'mint()',separate:true}),resolved={addresses:f.seeds},m=f.meta(),r=recognizeMint(m),route=r.routes[0],id=route.id; m.abi=r.abi;
 const q=await adaptiveQuoteWithLearning(f.rpc,m,resolved,route,{account:1,address:D},1,{tag:'0x2710',number:10000},f.sourceLoader,{learner:f.learner});
 assert.equal(route.id,id);assert.equal(route.chainEvidence.participants,2);assert.equal(q.expectedAsset.amount,'1000');assert.equal(q.call.value,'0');assert.equal(q.available,true);
 const scans=f.scans();f.setReject();await assert.rejects(adaptiveQuoteWithLearning(f.rpc,m,resolved,route,{account:1,address:D},1,{tag:'0x2710',number:10000},f.sourceLoader,{learner:f.learner}),/不可执行/);assert.equal(f.scans(),scans);
});
test('unverified known quantity calls require two observed one-unit callers and cannot extrapolate bulk mint',async()=>{
 const f=fixture({quantity:true,quantityMethod:'mint'});const tx=[...f.txs.values()][1],rec=f.receipts.get(tx.hash);tx.input=f.iface.encodeFunctionData('mint',[1]);rec.logs=rec.logs.slice(0,1);
 const e=await f.learn();assert.equal(e.methods[0].usable,true);assert.equal(e.methods[0].maxQuantity,1);
 const meta=f.meta(),r=learnedRecognition(meta,recognizeMint(meta),e);assert.ok(r.routes[0].chainEvidence);assert.equal(r.routes[0].id,'auto:mint(uint256)');
 const q=await adaptiveQuote({...meta,abi:r.abi},r.routes[0],{account:1,address:D},2,{tag:'0x2710',number:10000},f.rpc.send);assert.equal(q.available,false);assert.equal(q.limits.max,1);
 const one=fixture({quantity:true,quantityMethod:'mint'});assert.equal((await one.learn()).methods[0].usable,false);
});
test('sparse recent history falls back to older indexed issuance instead of treating a quiet project as unsupported',async()=>{
 const f=fixture();let expanded=false;const send=f.learner.logRpc.send;
 f.learner.logRpc={...f.learner.logRpc,send:async(m,p)=>{if(m==='eth_getLogs'){if(!p[0].topics)return [];expanded=true;assert.deepEqual(p[0].topics,[TRANSFER,word(0)]);assert.ok(BigInt(p[0].toBlock)-BigInt(p[0].fromBlock)<50000n);}return send(m,p);}};
 const e=await f.learn();assert.equal(expanded,true);assert.equal(e.issuanceOnly,true);assert.equal(e.expanded,true);assert.equal(e.methods[0].usable,true);
});
test('known support addresses are excluded, while unfamiliar website role names are not decisive',()=>{
 assert.deepEqual(chainSeeds([{address:A,roles:['treasury']},{address:B,verifiedRoles:['treasury']},{address:'0x55d398326f99059ff775485246999027b3197955'}]),[A]);
});
test('official preview must prove learned asset credit, precise NFT IDs and no extra debit or permission',()=>{
 const step={kind:'mint',to:A,value:'0'},plan={wallet:D,inputToken:'0x'+'e'.repeat(40),outputToken:A,amountIn:'0',minOutput:'1',metaVerified:true,requireAssetCredit:true,requireNftCredit:true,expectedAsset:{token:A,kind:'Erc721',amount:'1'}};
 const preview=changes=>({requestId:'preview-only',parsedTx:{contractAddress:A},simulationResult:{simulationCode:'000000000',balanceChanges:changes}});
 const nftCredit={owner:D,contractAddress:A,change:'1',tokenType:'Erc721',tokenId:'5'};
 assert.doesNotThrow(()=>verifyPreview(preview([nftCredit]),plan,step));assert.throws(()=>verifyPreview(preview([]),plan,step),/NFT 足额/);
 assert.throws(()=>verifyPreview(preview([nftCredit,{owner:D,contractAddress:B,change:'-1'}]),plan,step),/支出/);
 const ercPlan={...plan,requireNftCredit:false,expectedAsset:{token:A,kind:'Erc20',amount:'1'}};
 assert.throws(()=>verifyPreview(preview([nftCredit]),ercPlan,step),/到账少于/);
 assert.throws(()=>verifyPreview(preview([{...nftCredit,change:1e30}]),ercPlan,step),/精度不足/);
 const p=preview([nftCredit]);p.simulationResult.authorityChanges=[{}];assert.throws(()=>verifyPreview(p,plan,step),/权限/);
});
test('learned asset code changes invalidate a previously prepared plan',async()=>{
 const f=fixture({separate:true}),identity=await codeIdentity(f.rpc,A);identity.learnedAssets=[{token:B,codeHash:keccak256(await f.rpc.getCode(B))}];await verifyIdentity(f.rpc,identity);
 const getCode=f.rpc.getCode;f.rpc.getCode=async(a,b)=>a===B?'0x6002':getCode(a,b);await assert.rejects(verifyIdentity(f.rpc,identity),/到账资产代码/);
});
test('website fallback resolves unusual variable name using corroborated receipts without executing page scripts',async()=>{
 const f=fixture(),e=await f.learn();let scans=0;
 const result=await discover('https://brand.example/',{rpc:f.rpc,fetchText:async()=>`<title>New Brand</title><script>const stranger="${A}";throw Error("must not execute");</script>`,sourceLoader:f.sourceLoader,chainFallback:true,chainLearner:{learn:async()=>{scans++;return e;}}});
 assert.equal(result.address,A);assert.equal(result.name,'New Brand');assert.equal(result.chainLearning.status,'observed');assert.equal(scans,1);
});
test('complete mint planner probes unknown free max while enforcing scope and paid budgets',async()=>{
 const f=fixture(),opts={sourceLoader:f.sourceLoader,chainLearner:f.learner},intent={account:1,scope:'free',maxBnb:'0',referral:'none',quantity:1};
 const p=await mintPlan(f.rpc,{},intent,A,{address:A},null,opts);assert.equal(p.steps[0].value,'0');assert.equal(p.requireNftCredit,true);assert.equal(p.chainEvidence.participants,2);
 const full=await mintPlan(f.rpc,{},{...intent,quantity:'max'},A,{address:A},null,opts);assert.equal(full.quantity,1);assert.equal(full.amountIn,'0');assert.equal(full.quota.freeProbe.quantity,1);
 await assert.rejects(mintPlan(f.rpc,{},{...intent,scope:'paid',maxBnb:'0.1'},A,{address:A},null,opts),/只消耗付费额度/);
 const g=fixture({quantity:true,verified:true}),options={sourceLoader:g.sourceLoader,chainLearner:g.learner};
 await assert.rejects(mintPlan(g.rpc,{},intent,A,{address:A},null,options),e=>e.code==='NO_FREE_MINT');
 const paid=await mintPlan(g.rpc,{},{...intent,scope:'paid',quantity:'max',maxBnb:'0.000000000000000014'},A,{address:A},null,options);assert.equal(paid.quantity,2);assert.equal(paid.amountIn,'14');
});
test('direct token CA can resolve once to its linked learned mint entry; no unrelated address substitution',async()=>{
 const f=fixture({separate:true}),tokenCode=await f.rpc.getCode(B),tokenMeta={address:B,runtimeCode:tokenCode,hash:keccak256(tokenCode),verified:false},sourceLoader=async(r,a)=>a.toLowerCase()===B?tokenMeta:f.meta();
 const resolved={address:B,source:'用户输入 CA'},plan=await mintPlan(f.rpc,{}, {account:1,scope:'free',maxBnb:'0',referral:'none',quantity:1},B,resolved,null,{sourceLoader,chainLearner:f.learner});
 assert.equal(plan.steps[0].to,A);assert.equal(plan.outputToken,B);assert.equal(resolved.address,A);assert.equal(resolved.chainRedirected,true);assert.equal(plan.requireAssetCredit,true);
});
test('concurrent scans coalesce; unavailable results have a short retry cache, explicit refresh bypasses it',async()=>{
 const f=fixture();await Promise.all([f.learn(),f.learn(),f.learn()]);assert.equal(f.scans(),1);
 const g=fixture();let attempts=0;g.learner.logRpc.send=async()=>{attempts++;throw Error('HTTP 503');};await g.learn();await g.learn();assert.equal(attempts,1);await g.learn({force:true});assert.equal(attempts,2);
 const h=fixture();h.learner.logRpc.verifyChain=async()=>{throw Error('Wrong RPC chain');};const failed=await h.learn();assert.equal(failed.status,'unavailable');assert.deepEqual(failed.seeds,[A]);
 let observed;await assistMint(f.rpc,f.meta(),{addresses:[]},f.sourceLoader,{learner:{learn:async rows=>{observed=rows;return failed;}}});assert.equal(observed[0].address,A);
});
test('a different uninspected equally strong website candidate preserves address ambiguity',async()=>{
 const f=fixture(),e=await f.learn(),r=applyChainEvidence({address:null,addresses:[{address:D,priority:3,inspected:false,roles:[],verifiedRoles:[],evidence:[]}]},e);assert.equal(r.address,null);
});
test('insufficient recent evidence widens once within the bounded window instead of declaring mint unsupported',async()=>{
 const f=fixture();
 for(const tx of f.txs.values()){tx.blockNumber='0x1388';tx.blockHash=f.header(5000).hash;}
 for(const receipt of f.receipts.values()){receipt.blockNumber='0x1388';receipt.blockHash=f.header(5000).hash;for(const log of receipt.logs){log.blockNumber=receipt.blockNumber;log.blockHash=receipt.blockHash;}}
 const rpc=f.learner.logRpc,original=rpc.send;
 rpc.send=(method,params)=>method==='eth_getLogs'?Promise.resolve([...f.receipts.values()].flatMap(r=>r.logs).filter(l=>BigInt(l.blockNumber)>=BigInt(params[0].fromBlock)&&BigInt(l.blockNumber)<=BigInt(params[0].toBlock))):original(method,params);
 const result=await f.learn();assert.equal(result.expanded,true);assert.equal(result.methods[0].usable,true);assert.ok(result.range.to-result.range.from<32768);assert.match(result.note,/500000/);
});
