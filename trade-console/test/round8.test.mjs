import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {Interface,sha256,concat,toBeHex} from 'ethers';
import {discover} from '../lib/discovery.mjs';
import {recognizeMint,adaptiveQuote} from '../lib/adaptive-mint.mjs';
import {recognizePrefixPow,prefixPowPlan,solvePrefixNonce} from '../lib/prefix-pow.mjs';
import {recognizeChallengePow,challengePowState} from '../lib/challenge-pow.mjs';
import {mintError} from '../lib/mint-errors.mjs';
import {recognizeErc20Nft,erc20NftPlan} from '../lib/erc20-nft.mjs';
import {USDT,ERC20} from '../lib/common.mjs';
const target='0x'+'3'.repeat(40),wallet={account:1,address:'0x'+'2'.repeat(40)};
test('concurrent discovery shares reads but isolates mutable results, fetchers, failure retries and learn mode',async()=>{
 let calls=0,release;const gate=new Promise(r=>release=r),fetchText=async url=>{calls++;await gate;return url.endsWith('/')?`<title>New</title>Mint: ${target}`:'';};
 const a=discover('https://new-unseen.example/',{fetchText}),b=discover('new-unseen.example',{fetchText});await new Promise(r=>setImmediate(r));assert.equal(calls,4);release();const [x,y]=await Promise.all([a,b]);assert.notEqual(x,y);x.name='Changed';assert.equal(y.name,'New');
 await discover('https://new-unseen.example/',{fetchText});assert.equal(calls,8);
 const p=await Promise.all([discover('https://other.example/',{fetchText:async()=>'<title>A</title>'}),discover('https://other.example/',{fetchText:async()=>'<title>B</title>'})]);assert.deepEqual(p.map(x=>x.name),['A','B']);
 let fails=0;const failing=async()=>{fails++;throw Error('network down');};await Promise.all([discover('https://failure.example/',{fetchText:failing}),discover('https://failure.example/',{fetchText:failing})]);assert.equal(fails,4);await discover('https://failure.example/',{fetchText:failing});assert.equal(fails,8);
 calls=0;await Promise.all([discover('https://force.example/',{fetchText}),discover('https://force.example/',{fetchText,learn:true})]);assert.equal(calls,8);
});
test('wallet-only quote(address) supports new single-mint deployments and reprices each wallet without guessing batch price',async()=>{
 const abi=new Interface(['function mint() payable','function quote(address) view returns(uint256)','function supportsInterface(bytes4) view returns(bool)']);
 const meta={address:target,verified:false,runtimeCode:'0x'+abi.fragments.map(f=>'63'+f.selector.slice(2)+'1461000057').join('')+'00'};const recognition=recognizeMint(meta),route=recognition.routes[0];meta.abi=recognition.abi;assert.equal(route.quotes[0].method,'quote(address)');
 let cost=9n;const calls=[],rpc=async(m,p)=>{if(m==='eth_estimateGas')return '0x10000';const tx=p[0],f=abi.parseTransaction(tx);calls.push(f);if(f.name==='mint'){if(BigInt(tx.value)!==cost)throw Object.assign(Error('execution reverted'),{executionError:true});return '0x';}return abi.encodeFunctionResult(f.fragment,[f.name==='quote'?cost:true]);};
 const block={tag:'0x100',number:256,timestamp:100};assert.equal((await adaptiveQuote(meta,route,wallet,1,block,rpc)).total.raw,'9');cost=12n;assert.equal((await adaptiveQuote(meta,route,wallet,1,block,rpc)).total.raw,'12');assert.ok(calls.filter(f=>f.name==='quote').every(f=>f.args[0]===wallet.address));
 const batch=new Interface(['function mint(uint256) payable','function quote(address) view returns(uint256)']);const b={...meta,runtimeCode:'0x'+batch.fragments.map(f=>'63'+f.selector.slice(2)+'1461000057').join('')+'00'};assert.equal(recognizeMint(b).routes.length,0);
});
test('verified tuple issuance counters classify sold-out before a mint revert; ambiguous tuple pairs stay unknown',async()=>{
 const abi=new Interface(['function mint()','function ownerOf(uint256) view returns(address)','function stats() view returns(uint256 genesisMinted,uint256 genesisCap)']),meta={address:target,verified:true,abi:JSON.parse(abi.formatJson()),sources:{}},route=recognizeMint(meta).routes[0];
 let minted=10n;const rpc=async(m,p)=>{if(m==='eth_estimateGas')return '0x10000';const f=abi.parseTransaction(p[0]);if(f.name==='stats')return abi.encodeFunctionResult(f.fragment,[minted,10n]);assert.equal(f.name,'mint');return '0x';};
 await assert.rejects(adaptiveQuote(meta,route,wallet,1,{tag:'0x1',timestamp:1},rpc),e=>e.code==='NO_QUOTA');minted=9n;assert.equal((await adaptiveQuote(meta,route,wallet,1,{tag:'0x1',timestamp:1},rpc)).limits.publicRemaining,1);
});
const original=JSON.parse(fs.readFileSync(new URL('./fixtures/prefix-pow.json',import.meta.url)));
function prefixFixture(){const meta=structuredClone(original);meta.hash='fixture-'+Math.random();const abi=new Interface(meta.abi);let used=0n,proofValid=true,open=true;const values={supportsInterface:true,MAX_SUPPLY:100n,totalMinted:5n,MAX_PER_WALLET:5n,mintedBy:()=>used,FREE_PER_WALLET:2n,PAID_PRICE:7n,quote:()=>used<2n?0n:7n,DIFFICULTY:8n,mintOpen:()=>open,workPrefix:()=>concat(['0xaabbcc',wallet.address,toBeHex(used,32)]),checkProof:()=>[proofValid,8n],mint:[]};
 const rpc={getBlockNumber:async()=>100,call:async(tx,block)=>{assert.equal(block,100);const f=abi.parseTransaction(tx),value=values[f.name];assert.notEqual(value,undefined,f.name);if(f.name==='mint'&&BigInt(tx.value)!==(used<2n?0n:7n))throw Object.assign(Error('execution reverted'),{executionError:true});const v=typeof value==='function'?value():value;return abi.encodeFunctionResult(f.fragment,f.fragment.outputs.length===1?[v]:v);}};
 return {meta,rpc,setUsed:v=>used=v,setProof:v=>proofValid=v,setOpen:v=>open=v};
}
test('prefix PoW is interface-based, refreshes prefix after mint and honors free/paid scope and budget',async()=>{
 const f=prefixFixture();assert.equal(recognizeChallengePow(f.meta).kind,'sha256-current-wallet-prefix');assert.equal(recognizePrefixPow({...f.meta,proxy:true}),null);assert.equal(recognizePrefixPow({...f.meta,runtimeCode:'0x00'}),null);
 let prefixes=[];const solver=async p=>{prefixes.push(p);return {nonce:'0',next:'1',elapsedMs:1};},intent={account:1,scope:'free',quantity:'max',maxBnb:'0',referral:'none'},opts={solver};
 const s=await challengePowState(f.rpc,f.meta,wallet);assert.equal(s.info.freeRemaining,'2');let p=await prefixPowPlan(f.rpc,intent,f.meta,wallet,{},opts);assert.equal(p.amountIn,'0');assert.equal(p.fill.continue,true);assert.equal(p.requireNftCredit,true);assert.equal(p.freshBeforeExecute,true);
 f.setUsed(1n);p=await prefixPowPlan(f.rpc,intent,f.meta,wallet,{},opts);assert.equal(p.fill.continue,false);assert.notEqual(prefixes[0],prefixes[1]);
 f.setUsed(2n);await assert.rejects(prefixPowPlan(f.rpc,intent,f.meta,wallet,{},opts),e=>e.code==='NO_QUOTA');await assert.rejects(prefixPowPlan(f.rpc,{...intent,scope:'paid'},f.meta,wallet,{},opts),e=>e.code==='BUDGET_LIMIT');
 p=await prefixPowPlan(f.rpc,{...intent,scope:'paid',maxBnb:'0.01'},f.meta,wallet,{},opts);assert.equal(p.amountIn,'7');assert.equal(p.quantity,1);
 f.setProof(false);await assert.rejects(prefixPowPlan(f.rpc,{...intent,scope:'paid',maxBnb:'0.01'},f.meta,wallet,{},opts),e=>e.code==='MINT_PROOF_INVALID');f.setOpen(false);await assert.rejects(challengePowState(f.rpc,f.meta,wallet),e=>e.code==='MINT_NOT_OPEN');
});
test('prefix SHA256 CPU and portable solver agree with independent digest and varied prefix lengths',async()=>{
 for(const prefix of ['0xab','0x'+'12'.repeat(119),'0x'+'87'.repeat(1024)])for(const preferCpu of [false,true]){const p=await solvePrefixNonce(prefix,8,{preferCpu,budgetMs:3000});assert.notEqual(p.nonce,null);assert.ok(BigInt(sha256(concat([prefix,toBeHex(BigInt(p.nonce),32)])))<(1n<<248n));}
 await assert.rejects(solvePrefixNonce('0x',8));await assert.rejects(solvePrefixNonce('0xaabb',80));
});
test('exact free pool exhaustion is quota, but arbitrary free text stays a revert',()=>{
 const errors=new Interface(['error Error(string)']);for(const message of ['Free pool empty','Free quota exhausted'])assert.equal(mintError({data:errors.encodeErrorResult('Error',[message])}).code,'NO_QUOTA');assert.equal(mintError({data:errors.encodeErrorResult('Error',['free something failed'])}).code,'MINT_REVERT');
 const custom=new Interface(['error GameError(uint256 code)']),e=mintError({code:3,data:custom.encodeErrorResult('GameError',[4n])},custom.fragments);assert.equal(e.code,'MINT_REVERT');assert.match(e.message,/GameError\("4"\)/);assert.deepEqual(e.details.contractError,{name:'GameError',args:['"4"']});
});
test('ERC20 NFT inference tolerates renamed payment/free fields, rejects changed quote or credit, caps an old unlimited allowance',async()=>{
 const raw=fs.readFileSync(new URL('./fixtures/erc20-free-nft.json',import.meta.url),'utf8');
 for(const renamed of [false,true]){
  const meta=JSON.parse(renamed?raw.replaceAll('paymentToken','settlementAsset').replaceAll('freeAvailable','giftLeft').replaceAll('price','unitCharge').replaceAll('DantaV2','UnseenBrand'):raw),p=recognizeErc20Nft(meta);assert.ok(p);
  const abi=new Interface(meta.abi);let used=0n,allowance=0n,mints=0;
  const rpc={getBlockNumber:async()=>1,call:async(tx,block)=>{assert.equal(block,1);const i=tx.to.toLowerCase()===USDT.toLowerCase()?ERC20:abi,f=i.parseTransaction(tx);let v;
   if(i===ERC20)v=f.name==='balanceOf'?10000n:allowance;
   else if(f.name===p.payment.slice(0,-2))v=USDT;
   else if(f.format?.()==='')assert.fail();
   else if(f.name===abi.getFunction(p.freeMethod).name)v=used===0n?1n:0n;
   else if(f.name==='quote')v=(f.args[1]-(used===0n?1n:0n))*10n;
   else if(f.name==='mint'){mints++;return '0x';}
   else v={supportsInterface:true,mintOpen:true,MAX_SUPPLY:100n,totalSupply:5n,MAX_PER_WALLET:5n,mintedBy:used}[f.name];assert.notEqual(v,undefined,f.name);return i.encodeFunctionResult(f.fragment,[v]);}};
  const intent={account:1,scope:'free',quantity:'max',maxUsdt:'0',referral:'none'};let plan=await erc20NftPlan(rpc,intent,meta,wallet,{});assert.equal(plan.amountIn,'0');assert.deepEqual(plan.steps.map(s=>s.kind),['mint']);assert.equal(mints,1);
  used=1n;allowance=100000000n;plan=await erc20NftPlan(rpc,{...intent,scope:'paid',maxUsdt:'1'},meta,wallet,{});assert.equal(plan.amountIn,'40');assert.equal(plan.steps[0].allowance,'40');assert.equal(mints,1);assert.equal(plan.approvalFirst,true);assert.equal(plan.requireNftCredit,true);
  allowance=40n;plan=await erc20NftPlan(rpc,{...intent,scope:'paid',maxUsdt:'1'},meta,wallet,{});assert.deepEqual(plan.steps.map(s=>s.kind),['mint']);assert.equal(mints,2);
 }
 for(const [from,to]of [['return (quantity - freeAvailable(minter)) * price;','return (quantity - freeAvailable(minter)) * price + 1;'],['_safeMint(msg.sender, firstId + i)','_safeMint(owner(), firstId + i)'],['IERC20 public immutable paymentToken','IERC20 public paymentToken'],['uint256 cost = (quantity - free) * price;','uint256 cost = (quantity - free) * price; cost += 1;']]){const meta=JSON.parse(raw);for(const s of Object.values(meta.sources))s.content=s.content.replace(from,to);assert.equal(recognizeErc20Nft(meta),null,from);}
});
