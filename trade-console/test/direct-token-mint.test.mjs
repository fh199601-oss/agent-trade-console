import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Interface,keccak256,toUtf8Bytes} from 'ethers';
import {recognizeDirectTokenMint,directTokenMintState,directTokenMintPlan} from '../lib/direct-token-mint.mjs';
import {ERC20,USDT} from '../lib/common.mjs';import {Engine,verifyPreview} from '../lib/engine.mjs';import {ChainLearner,TRANSFER} from '../lib/chain-learning.mjs';
import {preflightReport} from '../lib/diagnostics.mjs';import {statusLabel} from '../public/review-model.mjs';
const meta=JSON.parse(fs.readFileSync(new URL('./fixtures/direct-token-mint.json',import.meta.url))),abi=new Interface(meta.abi);
const w={account:1,address:'0x1111111111111111111111111111111111111111'},token='0x2222222222222222222222222222222222222222',registry='0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F',reg=new Interface(['function ownerOf(uint256) view returns(address)']);
const price=10n**18n,unit=50000000n*10n**9n,intent={account:1,side:'mint',scope:'paid',quantity:'max',maxUsdt:'3',maxBnb:'0',referral:'account1'};
function fixture(){
 const s={sharesMinted:269n,cap:4440000n,paidUsed:0n,freeMinted:249n,freeUsed:0n,balance:100n*price,allowance:0n,eligible:true,owner:w.address,payment:USDT,quotes:[],mints:[],blocks:[]};
 const rpc={getBlockNumber:async()=>1234,call:async(tx,block)=>{
  s.blocks.push(block);let a=abi;if(tx.to.toLowerCase()===registry.toLowerCase())a=reg;else if([USDT,token].some(t=>t.toLowerCase()===tx.to.toLowerCase()))a=ERC20;
  const f=a.parseTransaction(tx);assert.ok(f);
  if(f.name==='ownerOf'){assert.equal(f.args[0],BigInt(keccak256(toUtf8Bytes('myAgent'))));return a.encodeFunctionResult(f.name,[s.owner]);}
  if(f.name==='quoteCost'){s.quotes.push(f.args[0]);return a.encodeFunctionResult(f.name,[f.args[0]*price]);}
  if(f.name==='isAgent'){assert.equal(f.args[0],w.address);assert.equal(f.args[1],'myAgent');}
  if(f.name==='mintDirect'){assert.equal(tx.from,w.address);assert.equal(f.args[0],'myAgent');assert.equal(tx.value,0n);s.mints.push(f.args[1]);return '0x';}
  const v={usdt:s.payment,token,registry,tokensPerShare:unit,MAX_SHARES:s.cap,sharesMinted:s.sharesMinted,PAID_CAP_PER_WALLET:12n,paidSharesByWallet:s.paidUsed,MAX_SHARES_PER_TX:12n,FREE_CAP:1000n,freeMinted:s.freeMinted,FREE_PER_AGENT_CAP:5n,freeUsedByAgent:s.freeUsed,isAgent:s.eligible,decimals:9n,balanceOf:s.balance,allowance:s.allowance};assert.ok(f.name in v,f.name);return a.encodeFunctionResult(f.name,[v[f.name]]);
 }};
 const bridge={call:async(account,args)=>{assert.equal(account,1);assert.deepEqual(args,['wallet','agent-id']);return {agentId:{domain:'myAgent.ai'}};}};return {s,rpc,bridge};
}
test('direct USDT family uses verified source structure and accepts renamed parameters and another address',()=>{
 assert.equal(recognizeDirectTokenMint(meta)?.kind,'agent-direct-erc20');
 const copy=structuredClone(meta);copy.address=token;for(const f of copy.abi)for(const p of f.inputs||[])if(p.name==='shares')p.name='quantity';copy.sources['src/DinoMint.sol'].content=copy.sources['src/DinoMint.sol'].content.replace(/\bshares\b/g,'quantity');assert.ok(recognizeDirectTokenMint(copy));
 for(const change of [{verified:false},{proxy:true},{sources:{}}])assert.equal(recognizeDirectTokenMint({...meta,...change}),null);
});
test('wrong recipient, altered payment, mutable units and helper argument mutations cannot establish this family',()=>{
 for(const [from,to]of [['return shares * FLAT_PRICE;','return shares * 2 + FLAT_PRICE;'],['public immutable tokensPerShare','public tokensPerShare'],['usdt.safeTransferFrom(payer, address(this), cost);','usdt.safeTransferFrom(payer, treasury, cost);'],['token.mint(payer, shares * tokensPerShare);','token.mint(treasury, shares * tokensPerShare);'],['uint256 cost = quoteCost(shares);','shares++; uint256 cost = quoteCost(shares);'],['function _finishMint(address payer, uint256 shares, uint256 cost, bool viaVoucher) internal {','function _finishMint(address payer, uint256 shares, uint256 cost, bool viaVoucher) internal { shares = 100;']]){
  const copy=structuredClone(meta),source=copy.sources['src/DinoMint.sol'];assert.ok(source.content.includes(from),from);source.content=source.content.replace(from,to);assert.equal(recognizeDirectTokenMint(copy),null,from);
 }
});
test('paid max is bounded by budget and exact approval; all reads share a block; approval is not mint simulation',async()=>{
 const {s,rpc,bridge}=fixture(),p=await directTokenMintPlan(rpc,bridge,intent,meta,w,{});assert.equal(p.quantity,3);assert.equal(p.amountIn,String(3n*price));assert.equal(p.minOutput,String(3n*unit));assert.deepEqual(p.steps.map(x=>x.kind),['approve','mint']);assert.equal(p.steps[0].allowance,p.amountIn);assert.equal(p.approvalFirst,true);assert.ok(s.blocks.every(b=>b===1234));assert.equal(s.mints.length,0);
 const o={intent,status:'PREPARED',plan:p,preview:{}};assert.equal(preflightReport(o).checks.mintSimulationPassed,false);assert.equal(preflightReport(o).checks.approvalOnly,true);assert.match(statusLabel(o),/Mint 待模拟/);
});
test('free upper bound is not voucher entitlement; free and all never silently switch to paid',async()=>{
 const {rpc,bridge}=fixture(),state=await directTokenMintState(rpc,bridge,intent,meta,w);assert.equal(state.info.freeRemaining,null);assert.equal(state.info.freeOnchainUpperBound,'5');assert.equal(state.info.paidRemaining,'12');
 for(const scope of ['free','all'])await assert.rejects(directTokenMintPlan(rpc,bridge,{...intent,scope},meta,w,{}),e=>e.code==='MINT_VOUCHER_REQUIRED'&&preflightReport({error:e}).needAiDeep);
});
test('another free entry cannot be ignored or declared exhausted using an unrelated free getter',async()=>{
 const {s,rpc,bridge}=fixture();s.freeMinted=1000n;const copy=structuredClone(meta);copy.abi.push({type:'function',name:'claimFree',inputs:[],outputs:[],stateMutability:'nonpayable'});
 await assert.rejects(directTokenMintPlan(rpc,bridge,{...intent,scope:'all'},copy,w,{}),e=>e.code==='MINT_VOUCHER_REQUIRED');
});
test('exhausted chain free cap permits explicit all paid, stock and wallet cap zero stop correctly',async()=>{
 const {s,rpc,bridge}=fixture();s.freeMinted=1000n;assert.equal((await directTokenMintPlan(rpc,bridge,{...intent,scope:'all'},meta,w,{})).quantity,3);
 await assert.rejects(directTokenMintPlan(rpc,bridge,{...intent,scope:'free'},meta,w,{}),e=>e.code==='NO_QUOTA');s.paidUsed=12n;await assert.rejects(directTokenMintPlan(rpc,bridge,intent,meta,w,{}),e=>e.code==='NO_QUOTA');s.paidUsed=0n;s.sharesMinted=s.cap;await assert.rejects(directTokenMintPlan(rpc,bridge,intent,meta,w,{}),e=>e.code==='NO_QUOTA');
});
test('identity, budget, payment currency, insufficient allowance and referral defaults fail without a send',async()=>{
 const {s,rpc,bridge}=fixture();s.owner=token;await assert.rejects(directTokenMintPlan(rpc,bridge,intent,meta,w,{}),/所有权/);s.owner=w.address;s.payment=token;await assert.rejects(directTokenMintPlan(rpc,bridge,intent,meta,w,{}),/只支持/);s.payment=USDT;
 s.balance=0n;await assert.rejects(directTokenMintPlan(rpc,bridge,intent,meta,w,{}),e=>e.code==='BUDGET_LIMIT');s.balance=100n*price;s.allowance=1n;await assert.rejects(directTokenMintPlan(rpc,bridge,intent,meta,w,{}),/旧授权/);s.allowance=0n;
 await assert.rejects(directTokenMintPlan(rpc,bridge,{...intent,maxUsdt:'0'},meta,w,{}),e=>e.code==='BUDGET_LIMIT');
 await assert.rejects(directTokenMintPlan(rpc,bridge,{...intent,account:2},meta,w,{referralHints:{detected:true}}),e=>e.code==='REFERRAL_NOT_VERIFIED');assert.equal(s.mints.length,0);
});
test('existing sufficient allowance gives mint simulation; exact credit and bounded debits are required',async()=>{
 const {s,rpc,bridge}=fixture();s.allowance=3n*price;const p=await directTokenMintPlan(rpc,bridge,intent,meta,w,{});assert.deepEqual(s.mints,[3n]);assert.equal(p.steps.length,1);
 const credit={owner:w.address,contractAddress:token,tokenType:'Erc20',change:p.minOutput},debit={owner:w.address,contractAddress:USDT,change:'-'+p.amountIn};const preview=changes=>({requestId:'test',simulationResult:{simulationCode:'000000000',balanceChanges:changes}});
 assert.doesNotThrow(()=>verifyPreview(preview([credit,debit]),p,p.steps[0]));assert.throws(()=>verifyPreview(preview([debit]),p,p.steps[0]),/最低/);assert.throws(()=>verifyPreview(preview([credit,{...debit,change:String(-4n*price)}]),p,p.steps[0]),/超出/);assert.throws(()=>verifyPreview(preview([{...credit,contractAddress:registry},debit]),p,p.steps[0]),/最低/);
});
test('successful on-chain records decode label/quantity without retaining another wallet label or calldata',async()=>{
 const {rpc}=fixture(),hex=n=>'0x'+BigInt(n).toString(16),word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0'),txs=new Map(),receipts=new Map();
 const erc=new Interface(['function decimals() view returns(uint8)','function totalSupply() view returns(uint256)','function balanceOf(address) view returns(uint256)','function transfer(address,uint256) returns(bool)','function allowance(address,address) view returns(uint256)']);
 const tokenCode='0x'+erc.fragments.map(f=>'63'+f.selector.slice(2)+'1461000057').join('')+'00';rpc.verifyChain=async()=>{};rpc.getBlockNumber=async()=>1234;rpc.getCode=async a=>a.toLowerCase()===meta.address.toLowerCase()?meta.runtimeCode:tokenCode;
 for(let i=0;i<2;i++){const b=1220+i,hash=word(100+i),from=i?w.address:registry,input=abi.encodeFunctionData('mintDirect',['someoneElse'+i,i+1]);const tx={hash,to:meta.address,from,input,value:'0x0',blockNumber:hex(b),blockHash:word(b+10000)};
  const log={address:token,topics:[TRANSFER,word(0),word(from)],data:word(unit*BigInt(i+1)),transactionHash:hash,blockNumber:tx.blockNumber,blockHash:tx.blockHash,logIndex:'0x0'};txs.set(hash,tx);receipts.set(hash,{transactionHash:hash,to:tx.to,from,status:'0x1',blockNumber:tx.blockNumber,blockHash:tx.blockHash,logs:[log]});}
 rpc.getTransaction=async h=>txs.get(h);rpc.getTransactionReceipt=async h=>receipts.get(h);rpc.send=async(m,p)=>m==='eth_getLogs'?[...receipts.values()].flatMap(r=>r.logs):{number:p[0],hash:word(BigInt(p[0])+10000n)};
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'direct-chain-test-'));try{const result=await new ChainLearner(rpc,{logRpc:rpc,data,scanBlocks:64}).learn([{address:token}],{sourceLoader:async()=>meta});assert.equal(result.methods.length,1);const m=result.methods[0];assert.equal(m.usable,true);assert.equal(m.construction,'agent-direct-erc20');assert.deepEqual(m.parameterRoles,['label','quantity']);assert.equal(m.output.minPerUnit,String(unit));assert.equal(result.targets[0].corroborated,true);assert.ok(!JSON.stringify(result).includes('someoneElse'));assert.ok(m.samples.every(s=>!('input' in s)));}finally{fs.rmSync(data,{recursive:true,force:true});}
});
test('after mock approval confirmation Engine obtains a new mint preview and stops if its asset credit is absent',async()=>{
 const {rpc,bridge}=fixture(),p=await directTokenMintPlan(rpc,bridge,{...intent,quantity:1},meta,w,{}),calls=[],data=fs.mkdtempSync(path.join(os.tmpdir(),'direct-steps-test-'));
 const fakeBridge={ready:async()=>{},call:async(_account,args)=>{calls.push(args[1]);if(args[1]==='preview')return {requestId:String(calls.length),simulationResult:{simulationCode:'000000000',balanceChanges:[]}};if(args[1]==='execute')return {txHash:'0x'+'ab'.repeat(32)};throw Error('Unexpected mock operation');}};
 const engine=new Engine({rpc:{},bridge:fakeBridge,planFn:async()=>({...p,identity:null,review:[]}),live:true,data});engine.observeContract=async(_o,entry)=>{entry.status='CONFIRMED';};
 try{const result=await engine.run({...intent,quantity:1,asset:meta.address},'mock-only',{execute:true,authorization:'Unit test in-memory wallet only'});assert.equal(result.status,'RECEIPT_REVIEW');assert.match(result.error.message,/最低/);assert.deepEqual(calls,['preview','execute','preview']);assert.equal(result.steps.length,1);assert.equal(result.steps[0].step.kind,'approve');}finally{fs.rmSync(data,{recursive:true,force:true});}
});
