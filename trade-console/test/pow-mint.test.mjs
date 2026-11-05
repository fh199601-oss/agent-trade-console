import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {Interface,solidityPackedKeccak256} from 'ethers';
import {recognizePowMint,powMintPlan,solveWalletNonce} from '../lib/pow-mint.mjs';
const w={account:1,address:'0x'+'ab'.repeat(20)},registry='0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F';
const valid=n=>BigInt(solidityPackedKeccak256(['address','uint256'],[w.address,n]))<(1n<<248n);
test('bounded local proof solver hashes this wallet plus uint256 nonce and never needs network or signatures',async()=>{
 const r=await solveWalletNonce(w.address,8,{budgetMs:1000});assert.ok(r.nonce!==null);assert.ok(valid(r.nonce));assert.equal(valid(r.nonce),true);assert.ok(r.elapsedMs<=1100);
 assert.throws(()=>solveWalletNonce(w.address,255),/范围/);const fallback=await solveWalletNonce(w.address,8,{budgetMs:1000,preferCpu:false});assert.ok(valid(fallback.nonce));
});
test('PoW template verifies own nonce on chain, current payment, and zero free spend before requiring NFT credit',async()=>{
 const meta=JSON.parse(fs.readFileSync(new URL('./fixtures/pow-nft-runtime.json',import.meta.url)));assert.ok(recognizePowMint(meta));assert.equal(recognizePowMint({...meta,proxy:true}),null);
 const abi=new Interface(['function mint(uint256,uint256) payable','function quoteMint(uint256) view returns(uint256,uint256)','function powValid(address,uint256) view returns(bool)','function usedNonce(address,uint256) view returns(bool)','function DIFFICULTY() view returns(uint256)','function MAX_SUPPLY() view returns(uint256)','function MAX_PER_WALLET() view returns(uint256)','function mintedBy(address) view returns(uint256)','function totalSupply() view returns(uint256)','function REGISTRY() view returns(address)','function supportsInterface(bytes4) view returns(bool)']);
 let used=0n,calls=0,solverCalls=0;
 const rpc={getBlockNumber:async()=>123,call:async tx=>{if(tx.to===registry)return new Interface(['function balanceOf(address) view returns(uint256)']).encodeFunctionResult('balanceOf',[1n]);const f=abi.parseTransaction(tx);assert.equal(tx.from,w.address);if(f.name==='mint'){calls++;assert.ok(valid(f.args[1]));const due=positive(f.args[0]-(used===0n?1n:0n))*5n;if(tx.value<due)throw Object.assign(Error('execution reverted: fee'),{executionError:true});return '0x';}if(f.name==='quoteMint'){const paid=positive(f.args[0]-(used===0n?1n:0n));return abi.encodeFunctionResult(f.name,[paid,paid*5n]);}if(f.name==='powValid'){assert.equal(f.args[0].toLowerCase(),w.address);return abi.encodeFunctionResult(f.name,[valid(f.args[1])]);}const values={usedNonce:false,DIFFICULTY:8n,MAX_SUPPLY:100n,MAX_PER_WALLET:10n,mintedBy:used,totalSupply:30n,REGISTRY:registry,supportsInterface:true};return abi.encodeFunctionResult(f.name,[values[f.name]]);}};
 const i={account:1,scope:'free',quantity:'max',referral:'account1'},solver=async(...args)=>{solverCalls++;return solveWalletNonce(...args);};const profile=recognizePowMint(meta);
 const p=await powMintPlan(rpc,i,meta,0n,w,{},profile,solver);assert.equal(p.quantity,1);assert.equal(p.amountIn,'0');assert.equal(p.requireNftCredit,true);assert.equal(calls,1);assert.equal(solverCalls,1);
 await assert.rejects(powMintPlan(rpc,{...i,scope:'paid'},meta,50n,w,{},profile,solver),/自动消耗免费/);
 used=10n;await assert.rejects(powMintPlan(rpc,i,meta,0n,w,{},profile,solver),e=>e.code==='NO_QUOTA');assert.equal(solverCalls,1);
});
const positive=n=>n>0n?n:0n;
