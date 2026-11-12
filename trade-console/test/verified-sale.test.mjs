import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {Interface} from 'ethers';
import {recognizeVerifiedSale,verifiedSalePlan,verifiedSaleState} from '../lib/verified-sale.mjs';import {verifyPreview} from '../lib/engine.mjs';
import {failureKind} from '../lib/diagnostics.mjs';import {statusLabel} from '../public/review-model.mjs';
const wallet={account:1,address:'0x'+'12'.repeat(20)},intent={account:1,scope:'free',quantity:'max',referral:'account1'};
function fixture(name){const meta=JSON.parse(fs.readFileSync(new URL('./fixtures/'+name+'.json',import.meta.url))),profile=recognizeVerifiedSale(meta),abi=new Interface(meta.abi),state={price:0n,used:0n,cap:5n,max:100n,minted:10n,end:200n,now:100n,open:true,closed:false,paused:false,eligible:true,finished:false,calls:[]};
 const rpc={getBlockNumber:async()=>123,send:async(m)=>{assert.equal(m,'eth_getBlockByNumber');return {timestamp:'0x'+state.now.toString(16)};},call:async(tx,block)=>{assert.equal(block,123);const f=tx.data==='0x'?null:abi.parseTransaction(tx);state.calls.push(f?.name||'receive');if(!f||f.name==='mintPublic'){assert.equal(tx.from,wallet.address);return '0x';}
  const values={supportsInterface:true,phasePrice:state.price,phaseTimes:[0n,state.end],maxPerWallet:state.cap,mintedBy:state.used,isPhaseOpen:state.open,isAgent:state.eligible,paused:state.paused,supplyClosed:state.closed,maxSupply:state.max,totalMinted:state.minted,PRESALE_BNB:10n,PRESALE_TOKEN:100n,MAX_SHARES:state.cap,TOTAL_SHARES:state.max,purchased:state.used,mintedShares:state.minted,finished:state.finished,startTime:0n,LP_TOKEN:500n,BURN_TOKEN:500n,NFT:wallet.address,balanceOf:tx.to===wallet.address?(state.eligible?1n:0n):10000n};
  assert.ok(f.name in values,f.name);return abi.encodeFunctionResult(f.fragment,f.name==='phaseTimes'?values[f.name]:[values[f.name]]);
 }};return {meta,profile,rpc,state};}
test('public-phase adapter derives enum from the verified function, not current phase or hardcoded index',()=>{
 const f=fixture('phase-public');assert.equal(f.profile.phase,2);assert.equal(f.profile.kind,'phase-public-nft');
 for(const s of Object.values(f.meta.sources))s.content=s.content.replace('None,\n        WL,\n        Public','Public,\n        WL,\n        None');assert.equal(recognizeVerifiedSale(f.meta).phase,0);
 assert.equal(recognizeVerifiedSale({...f.meta,verified:false}),null);assert.equal(recognizeVerifiedSale({...f.meta,runtimeCode:'0xf4'+f.meta.runtimeCode.slice(2)}),null);
});
test('public stage uses its own wallet quota/current price and stops at the end timestamp',async()=>{
 const f=fixture('phase-public');f.state.used=3n;let p=await verifiedSalePlan(f.rpc,intent,f.meta,0n,wallet,{});assert.equal(p.quantity,2);assert.equal(p.requireNftCredit,true);assert.equal(p.amountIn,'0');
 f.state.price=10n;await assert.rejects(verifiedSalePlan(f.rpc,intent,f.meta,100n,wallet,{}),e=>e.code==='NO_QUOTA');
 p=await verifiedSalePlan(f.rpc,{...intent,scope:'paid'},f.meta,10n,wallet,{});assert.equal(p.quantity,1);assert.equal(p.amountIn,'10');
 f.state.now=f.state.end;await assert.rejects(verifiedSalePlan(f.rpc,intent,f.meta,0n,wallet,{}),e=>e.code==='MINT_ENDED');
 f.state.end=0n;f.state.eligible=false;await assert.rejects(verifiedSalePlan(f.rpc,intent,f.meta,0n,wallet,{}),e=>e.code==='MINT_INELIGIBLE');
});
test('receive sale requires reviewed source body, exact cost, inventory after reserves, and asset credit',async()=>{
 const f=fixture('receive-sale');assert.equal(f.profile.kind,'native-receive-sale');
 await assert.rejects(verifiedSalePlan(f.rpc,intent,f.meta,0n,wallet,{}),e=>e.code==='NO_QUOTA');assert.equal(f.state.calls.includes('receive'),false);
 f.state.used=3n;const p=await verifiedSalePlan(f.rpc,{...intent,scope:'paid'},f.meta,20n,wallet,{});assert.equal(p.quantity,2);assert.equal(p.amountIn,'20');assert.equal(p.minOutput,'200');assert.equal(p.steps[0].data,'0x');
 assert.throws(()=>verifyPreview({requestId:'x',simulationResult:{simulationCode:'000000000',balanceChanges:[]}},p,p.steps[0]),/到账/);
 f.state.finished=true;assert.equal((await verifiedSaleState(f.rpc,intent,f.meta,wallet)).blockedCode,'MINT_ENDED');
 for(const s of Object.values(f.meta.sources))s.content=s.content.replace('shares * PRESALE_TOKEN','shares * 1');assert.equal(recognizeVerifiedSale(f.meta),null);
});
test('failure reasons remain separate in API and UI; generic reverts never mean ended',()=>{
 for(const [error,kind,label]of [[{code:'MINT_ENDED'},'ended','铸造已结束'],[{code:'NO_QUOTA'},'no_quota','当前无可用额度'],[{code:'BUDGET_LIMIT'},'budget','本次预算不足'],[{code:'MINT_INELIGIBLE'},'ineligible','钱包资格不足'],[{code:'MINT_UNSUPPORTED'},'adapter_needed','此类型仍需适配'],[{message:'execution reverted: 0x'},'validation','检查未通过 · 查看原因']]){assert.equal(failureKind(error),kind);assert.equal(statusLabel({status:'BLOCKED',error}),label);}
});
