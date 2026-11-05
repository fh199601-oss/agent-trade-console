import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Interface,keccak256} from 'ethers';
import {recognizeSourceSale,sourceSaleState,sourceSalePlan} from '../lib/source-sale.mjs';
import {ChainLearner,TRANSFER,mintReceiptSample} from '../lib/chain-learning.mjs';
import {USDT,ERC20,wallet} from '../lib/common.mjs';
const base=JSON.parse(fs.readFileSync(new URL('./fixtures/source-sale.json',import.meta.url))),abi=new Interface(base.abi),w=wallet(1),T='0x'+'2'.repeat(40),W2='0x'+'3'.repeat(40),unit=16000000n*10n**18n;
const hex=n=>'0x'+BigInt(n).toString(16),word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
function fixture(){const s={price:2n*10n**18n,used:0n,total:96n,allowance:0n,balance:100n*10n**18n,opened:false,now:1500n,eligible:true,mints:[]};const rpc={getBlockNumber:async()=>10000,send:async(m,p)=>{assert.equal(m,'eth_getBlockByNumber');return {number:p[0],hash:word(BigInt(p[0])+50000n),timestamp:hex(s.now)};},call:async(tx,block)=>{assert.equal(block,10000);const i=tx.to.toLowerCase()===base.address.toLowerCase()?abi:ERC20,f=i.parseTransaction(tx);if(f.name==='mint'){s.mints.push(f.args[0]);return '0x';}
 const values={usdt:USDT,token:T,TOKENS_PER_SHARE:unit,MAX_PER_TX:5n,TARGET_SHARES:5000n,totalMinted:s.total,paidMinted:s.used,quotaOf:5n,OPEN_AT:1000n,DEADLINE:2000n,poolOpened:s.opened,isAgent:s.eligible,decimals:18n,balanceOf:tx.to.toLowerCase()===USDT.toLowerCase()?s.balance:100000000000n*10n**18n,allowance:s.allowance,costOf:s.price*(f.args.length&&typeof f.args[0]==='bigint'?f.args[0]:1n)};assert.ok(f.name in values,f.name);return i.encodeFunctionResult(f.fragment,[values[f.name]]);}};return {s,rpc};}
const intent={account:1,scope:'paid',quantity:'max',maxUsdt:'6',maxBnb:'0',referral:'account1'};
test('tuple quote uses the source-bound output field, including nonlinear outputs, and rejects reassigned tuple values',async()=>{
 const m=structuredClone(base);for(const s of Object.values(m.sources))s.content=s.content.replace('uint256 cost = costOf(shares);','(uint256 cost, uint256 tokensOut) = quoteShares(shares);').replace('safeTransfer(msg.sender, shares * TOKENS_PER_SHARE)','mint(msg.sender, tokensOut)');
 m.abi.push(JSON.parse(new Interface(['function quoteShares(uint256 n) view returns(uint256 usdtCost,uint256 tokensOut)']).formatJson())[0]);const i=new Interface(m.abi);m.runtimeCode='0x'+i.fragments.filter(f=>f.type==='function').map(f=>'63'+f.selector.slice(2)+'14600057').join('')+'00';
 const p=recognizeSourceSale(m);assert.equal(p.output.index,1);assert.equal(p.cost.index,0);assert.equal(p.unit,null);
 const {s,rpc}=fixture(),old=rpc.call;s.allowance=10n**20n;rpc.call=(tx,b)=>tx.to.toLowerCase()===m.address.toLowerCase()&&tx.data.startsWith(i.getFunction('quoteShares').selector)?Promise.resolve(i.encodeFunctionResult('quoteShares',[i.decodeFunctionData('quoteShares',tx.data)[0]*s.price,unit*i.decodeFunctionData('quoteShares',tx.data)[0]**2n])):old(tx,b);
 const plan=await sourceSalePlan(rpc,intent,m,w,{});assert.equal(plan.quantity,3);assert.equal(plan.minOutput,String(unit*9n));assert.equal(plan.amountIn,String(s.price*3n));
 const bad=structuredClone(m);for(const v of Object.values(bad.sources))v.content=v.content.replace('IERC20(address(token)).mint(msg.sender, tokensOut)','tokensOut = 1; IERC20(address(token)).mint(msg.sender, tokensOut)');assert.equal(recognizeSourceSale(bad),null);
});
test('source data flow infers separate inventory asset, exact payment quote and wallet/global/tx limits',()=>{
 const p=recognizeSourceSale(base);assert.equal(p.kind,'source-erc20-sale');assert.equal(p.inventory,true);assert.equal(p.payment.method,'usdt()');assert.equal(p.token.method,'token()');assert.equal(p.cost.method,'costOf(uint256)');assert.deepEqual(p.caps.map(c=>c.scope),['transaction','global','wallet']);
 // Renaming every business field, function and quantity still infers the flow.
 const names=['mint','shares','usdt','token','costOf','TOKENS_PER_SHARE','MAX_PER_TX','TARGET_SHARES','paidMinted','quotaOf','totalMinted'];let text=JSON.stringify(base);names.forEach((n,i)=>{text=text.replace(new RegExp('\\b'+n+'\\b','g'),'field'+i);});const renamed=JSON.parse(text),iface=new Interface(renamed.abi);renamed.runtimeCode='0x'+iface.fragments.filter(f=>f.type==='function').map(f=>'63'+f.selector.slice(2)+'1461000057').join('')+'00';assert.equal(recognizeSourceSale(renamed).method,'field0(uint256)');
});
test('unverified/proxy, quantity mutation, third-party pull/credit, mutable token and missing wallet constraints do not match',()=>{
 assert.equal(recognizeSourceSale({...base,verified:false}),null);assert.equal(recognizeSourceSale({...base,proxy:true}),null);
 for(const [from,to]of [['uint256 cost = costOf(shares);','shares = 9; uint256 cost = costOf(shares);'],['safeTransferFrom(msg.sender, address(this), cost)','safeTransferFrom(treasury, address(this), cost)'],['safeTransfer(msg.sender, shares * TOKENS_PER_SHARE)','safeTransfer(treasury, shares * TOKENS_PER_SHARE)'],['TianmingToken public immutable token','TianmingToken public token'],['if (paidMinted[msg.sender] + shares > quotaOf(msg.sender)) revert Quota();','']]){
  const m=structuredClone(base);for(const s of Object.values(m.sources))s.content=s.content.replace(from,to);assert.equal(recognizeSourceSale(m),null,from);
 }
});
test('live state distinguishes paid-only, wallet remainder, ended, not open and ineligible',async()=>{
 const {s,rpc}=fixture();let state=await sourceSaleState(rpc,intent,base,w);assert.equal(state.info.freeRemaining,'0');assert.equal(state.info.paidRemaining,'5');assert.equal(state.info.unitPriceUsdt,'2.0');
 s.used=3n;state=await sourceSaleState(rpc,intent,base,w);assert.equal(state.info.paidRemaining,'2');
 await assert.rejects(sourceSalePlan(rpc,{...intent,scope:'free'},base,w,{}),e=>e.code==='NO_FREE_MINT');
 s.opened=true;await assert.rejects(sourceSalePlan(rpc,intent,base,w,{}),e=>e.code==='MINT_ENDED');s.opened=false;s.now=500n;assert.equal((await sourceSaleState(rpc,intent,base,w)).blockedCode,'MINT_NOT_OPEN');
 s.now=1500n;s.eligible=false;assert.equal((await sourceSaleState(rpc,intent,base,w)).blockedCode,'MINT_INELIGIBLE');s.eligible=true;s.used=5n;await assert.rejects(sourceSalePlan(rpc,intent,base,w,{}),e=>e.code==='NO_QUOTA');
});
test('bounded approval is separate from mint simulation, fresh quote and budget determine quantity',async()=>{
 const {s,rpc}=fixture();let p=await sourceSalePlan(rpc,intent,base,w,{});assert.equal(p.quantity,3);assert.equal(p.amountIn,String(6n*10n**18n));assert.deepEqual(p.steps.map(s=>s.kind),['approve','mint']);assert.equal(s.mints.length,0);assert.equal(p.steps[0].allowance,p.amountIn);assert.equal(p.freshBeforeExecute,true);
 s.price=3n*10n**18n;s.allowance=6n*10n**18n;p=await sourceSalePlan(rpc,intent,base,w,{});assert.equal(p.quantity,2);assert.deepEqual(p.steps.map(s=>s.kind),['mint']);assert.deepEqual(s.mints,[2n]);
 await assert.rejects(sourceSalePlan(rpc,{...intent,maxUsdt:'0'},base,w,{}),e=>e.code==='BUDGET_LIMIT');await assert.rejects(sourceSalePlan(rpc,{...intent,account:2},base,w,{referralHints:{detected:true}}),e=>e.code==='REFERRAL_NOT_VERIFIED');
});
test('inventory history supports a separate ERC20 only for a source-proven sale method; transfers are rejected with reason',async()=>{
 const {rpc}=fixture(),txs=new Map(),receipts=new Map(),tokenCode='0x'+new Interface([...ERC20.fragments,'function transfer(address,uint256) returns(bool)']).fragments.filter(f=>f.type==='function').map(f=>'63'+f.selector.slice(2)+'1461000057').join('')+'00';rpc.verifyChain=async()=>{};rpc.getCode=async a=>a.toLowerCase()===base.address.toLowerCase()?base.runtimeCode:tokenCode;
 for(let i=0;i<3;i++){const block=9990+i,from=i%2?W2:w.address,hash=word(700+i),tx={hash,from,to:base.address,input:abi.encodeFunctionData(i===2?'refund':'mint',i===2?[]:[i+1]),value:'0x0',blockNumber:hex(block),blockHash:word(block+50000)};const log={address:T,topics:[TRANSFER,word(base.address),word(from)],data:word(unit*BigInt(i+1)),transactionHash:hash,blockHash:tx.blockHash,blockNumber:tx.blockNumber,logIndex:'0x0'};txs.set(hash,tx);receipts.set(hash,{transactionHash:hash,from,to:base.address,status:'0x1',blockHash:tx.blockHash,blockNumber:tx.blockNumber,logs:[log]});}
 const call=rpc.call;rpc.call=async t=>call(t,10000);rpc.getTransaction=async h=>txs.get(h);rpc.getTransactionReceipt=async h=>receipts.get(h);const send=rpc.send;rpc.send=async(m,p)=>m==='eth_getLogs'?[...receipts.values()].flatMap(r=>r.logs):send(m,p);
 const meta={...base,hash:keccak256(base.runtimeCode)},data=fs.mkdtempSync(path.join(os.tmpdir(),'source-history-'));
 try{const e=await new ChainLearner(rpc,{logRpc:rpc,data,scanBlocks:64}).learn([{address:T}],{sourceLoader:async()=>meta});assert.equal(e.scan.accepted,2,JSON.stringify(e));assert.equal(e.scan.reasons.not_verified_issuance,1);assert.equal(e.methods[0].construction,'source-erc20-sale');assert.equal(e.methods[0].usable,true);assert.equal(e.targets[0].corroborated,true);assert.equal(e.methods[0].output.token,T);assert.ok(e.methods[0].samples.every(s=>!('input' in s)));}finally{fs.rmSync(data,{recursive:true,force:true});}
 const tx=[...txs.values()][0],receipt=receipts.get(tx.hash),header=await send('eth_getBlockByNumber',[tx.blockNumber]);assert.equal(mintReceiptSample(tx,receipt,header,10000),null);assert.ok(mintReceiptSample(tx,receipt,header,10000,{inventoryIssuer:base.address,inventoryToken:T}));
});
