import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {Interface,toUtf8Bytes} from 'ethers';
import {walletParameterPrograms,evaluateWalletProgram} from '../lib/source-values.mjs';import {recognizeMint,adaptiveQuote} from '../lib/adaptive-mint.mjs';
const meta=JSON.parse(fs.readFileSync(new URL('./fixtures/wallet-arithmetic.json',import.meta.url))),abi=new Interface(meta.abi),w={account:1,address:'0x'+'2'.repeat(40)};
const edit=(a,b)=>{const m=structuredClone(meta);m.sources['AgenticPixels.sol'].content=m.sources['AgenticPixels.sol'].content.replace(a,b);return m;};
test('require equality, view wrapper, skipped tuple strings and UTF8 handle bytes generate current-wallet arithmetic',async()=>{
 const p=walletParameterPrograms(meta,abi.getFunction('mint'))[1];assert.ok(p);const seen=[];const answer=await evaluateWalletProgram(p,abi,w.address,async(method,args)=>{seen.push(method);assert.deepEqual(args,[w.address]);return method==='agentIdOf(address)'?['新agent']:['ignored question',11n,13n];});assert.equal(answer,143n+BigInt(toUtf8Bytes('新agent').length));assert.deepEqual(seen,['agentIdOf(address)','challengeOf(address)']);
 // Method and variable names are not deployment/domain allowlists.
 const renamed=structuredClone(meta);for(const key of ['challengeOf','agentIdOf','_answerOf']){renamed.sources['AgenticPixels.sol'].content=renamed.sources['AgenticPixels.sol'].content.replaceAll(key,'other_'+key);renamed.abi=renamed.abi.map(f=>f.name===key?{...f,name:'other_'+key}:f);}assert.ok(walletParameterPrograms(renamed,new Interface(renamed.abi).getFunction('mint'))[1]);
});
test('mutated aliases, another external target, non-view wrapper and storage writes do not produce a trusted parameter',()=>{
 for(const [a,b]of [['require(answer == _answerOf','handle = "changed"; require(answer == _answerOf'],['return registry.handleOf(wallet);','return otherRegistry.handleOf(wallet);'],['function agentIdOf(address wallet) public view','function agentIdOf(address wallet) public'],['return a * b + bytes(handle).length;','totalMinted = a; return a * b + bytes(handle).length;'],['require(answer == _answerOf','answer = 1; require(answer == _answerOf']]){const m=edit(a,b);assert.deepEqual(walletParameterPrograms(m,abi.getFunction('mint')),{},a);}
});
test('dynamic view decoding is canonical and free NFT plan keeps actual caller simulation and typed credit',async()=>{
 const r=recognizeMint(meta).routes.find(r=>r.method==='mint(uint256,uint256)');assert.ok(r);const handle='agent',answer=11n*13n+5n;let minted=false;
 const rpc=async(method,args)=>{if(method==='eth_estimateGas')return '0x10000';const f=abi.parseTransaction(args[0]);if(f.name==='mint'){assert.equal(f.args[1],answer);assert.equal(args[0].from,w.address);assert.equal(BigInt(args[0].value),0n);minted=true;return '0x';}
 const values={mintOpen:[true],mintStart:[1n],MAX_PER_WALLET:[3n],mintedBy:[0n],MAX_SUPPLY:[2000n],totalMinted:[5n],supportsInterface:[true],agentIdOf:[handle],challengeOf:['question',11n,13n],quote:[0n,3n]};assert.ok(f.name in values,f.name);return abi.encodeFunctionResult(f.fragment,values[f.name]);};
 const q=await adaptiveQuote(meta,r,w,1,{number:42,tag:'0x2a',timestamp:100},rpc);assert.equal(q.available,true);assert.equal(q.total.raw,'0');assert.equal(q.expectedAsset.kind,'Erc721');assert.equal(minted,true);
});
