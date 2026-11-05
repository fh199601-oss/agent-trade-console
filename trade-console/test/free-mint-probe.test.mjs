import test from 'node:test';import assert from 'node:assert/strict';
import {Interface,keccak256} from 'ethers';
import {mintPlan} from '../lib/mint.mjs';import {probeFreeBatch} from '../lib/free-mint-probe.mjs';
import {validateIntent,bindings} from '../lib/common.mjs';import {Engine,verifyPreview} from '../lib/engine.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const address='0x'+'1'.repeat(40),account=bindings()[0].account;
const intent={account,side:'mint',asset:address,scope:'free',quantity:'max',maxBnb:'0',referral:'none'};
function fixture({runtime=false,noArgs=false,priced=false,left=3,cap=null}={}){
 const abi=new Interface([`function mint(${noArgs?'':'uint256 quantity'})${priced?' payable':''}`,'function supportsInterface(bytes4) view returns(bool)','function mintOpen() view returns(bool)',...(priced?['function PRICE() view returns(uint256)']:[]),...(cap?['function MAX_PER_TX() view returns(uint256)']:[])]);
 const runtimeCode='0x'+abi.fragments.map(f=>'63'+f.selector.slice(2)+'14600057').join('')+'00',meta={address,runtimeCode,hash:keccak256(runtimeCode),identity:{target:address,fingerprint:'fixture'},verified:!runtime,sources:{'Fixture.sol':{content:`pragma solidity ^0.8.0; contract Fixture { function mint(${noArgs?'':'uint256 quantity'}) external ${priced?'payable':''} { ${noArgs?'':'require(quantity > 0);'} } }`}},...(runtime?{abiHints:JSON.parse(abi.formatJson())}:{abi:JSON.parse(abi.formatJson())})};
 const seen=[],getters=[],s={open:true,left,networkFailure:false};
 const rpc={getBlockNumber:async()=>123,send:async(method,args)=>{
  if(method==='eth_getBlockByNumber')return {timestamp:'0x123'};
  if(method==='eth_estimateGas')return '0x10000';assert.equal(method,'eth_call');assert.equal(args[1],'0x7b');const tx=args[0],f=abi.parseTransaction(tx);
  if(f.name==='mint'){const n=noArgs?1:Number(f.args[0]);seen.push({n,value:BigInt(tx.value)});if(s.networkFailure&&n>1)throw Object.assign(Error('RPC unavailable'),{code:'RPC_UNAVAILABLE'});if(n>s.left||BigInt(tx.value)!==0n)throw Object.assign(Error('execution reverted: quantity/payment'),{executionError:true});return '0x';}
  getters.push(f.name);return abi.encodeFunctionResult(f.name,[{supportsInterface:Array.from(f.args)[0]==='0x80ac58cd',mintOpen:s.open,PRICE:5n,MAX_PER_TX:BigInt(cap||0)}[f.name]]);
 }};rpc.call=async tx=>rpc.send('eth_call',[tx,'0x7b']);return {rpc,meta,seen,getters,s,plan:(i={})=>mintPlan(rpc,{}, {...intent,...i},address,{address,abiHints:meta.abiHints},null,{sourceLoader:async()=>meta})};
}
test('unknown free allowance descends 10 to 3 for new source and runtime contracts, with fixed-block reads reused',async()=>{
 for(const runtime of [false,true]){
  const h=fixture({runtime}),p=await h.plan();assert.equal(p.quantity,3);assert.equal(p.amountIn,'0');assert.deepEqual(p.quota.freeProbe.attempted,[10,9,8,7,6,5,4,3]);assert.equal(p.quota.limits.walletRemaining,null);assert.equal(p.quota.freeProbe.quotaKnown,false);assert.equal(p.requireNftCredit,true);assert.equal(p.fill.continue,true);
  assert.equal(h.getters.filter(x=>x==='mintOpen').length,1);assert.ok(h.seen.every(x=>x.value===0n));assert.equal(h.seen.filter(x=>x.n===1).length,1);
  assert.throws(()=>verifyPreview({requestId:'fixture',simulationResult:{simulationCode:'000000000',balanceChanges:[]}},p,p.steps[0]),/NFT/);
 }
});
test('zero-argument one-seat mint works with max without repeating ten identical calls',async()=>{
 const h=fixture({noArgs:true,left:1}),p=await h.plan();assert.equal(p.quantity,1);assert.deepEqual(p.quota.freeProbe.attempted,[1]);assert.equal(h.seen.length,1);
});
test('mixed priced entry probes zero value only, never simulates or selects a paid batch as free',async()=>{
 const h=fixture({priced:true,left:2}),p=await h.plan();assert.equal(p.quantity,2);assert.equal(p.amountIn,'0');assert.ok(h.seen.every(x=>x.value===0n));assert.equal(p.quota.paidInBatch,0);
});
test('known transaction cap bounds probing; network errors and closed mint are not interpreted as zero quota',async()=>{
 const h=fixture({cap:4,left:2}),p=await h.plan();assert.deepEqual(p.quota.freeProbe.attempted,[4,3,2]);
 h.s.open=false;await assert.rejects(h.plan(),e=>e.code==='MINT_NOT_OPEN');const bad=fixture();bad.s.networkFailure=true;await assert.rejects(bad.plan(),e=>e.code==='RPC_UNAVAILABLE');
});
test('read-only probe tries all ten before reporting no free batch and never ignores eligibility or payment',async()=>{
 const seen=[];await assert.rejects(probeFreeBatch({quote:async n=>{seen.push(n);throw Object.assign(Error('execution reverted'),{executionError:true});}}),e=>e.code==='NO_FREE_MINT');assert.deepEqual(seen,[10,9,8,7,6,5,4,3,2,1]);
 let reads=0;await assert.rejects(probeFreeBatch({quote:async()=>{reads++;throw Object.assign(Error('not eligible'),{code:'MINT_INELIGIBLE',executionError:true});}}),e=>e.code==='MINT_INELIGIBLE');assert.equal(reads,1);
 await assert.rejects(probeFreeBatch({quote:async n=>({quantity:n,cost:1n,step:{value:'1'}})}),e=>e.code==='NO_FREE_MINT');
 await assert.rejects(probeFreeBatch({quote:async n=>({quantity:n+1,cost:0n,step:{value:'0'}})}),/份数/);
});
test('MAX case and whitespace are normalized at shared API; free quantity defaults and paid numeric values remain explicit',()=>{
 for(const quantity of ['max','MAX',' Max ','mAx'])assert.equal(validateIntent({...intent,quantity}).quantity,'max');
 assert.equal(validateIntent({...intent,quantity:undefined}).quantity,'max');assert.equal(validateIntent({...intent,quantity:2}).quantity,2);
 assert.equal(validateIntent({...intent,scope:'paid',quantity:'3',maxBnb:'0.1'}).quantity,3);assert.throws(()=>validateIntent({...intent,scope:'paid',quantity:undefined}),/份数/);
});

test('unknown free max re-probes after each confirmed mock batch and never submits rejected quantities or duplicates',async()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'probe-fill-')),w=bindings()[0];let left=11,current=0,submits=0;
 const planFn=async()=>{const {quote,probe}=await probeFreeBatch({quote:async n=>{if(n>4||n>left)throw Object.assign(Error('execution reverted: remaining'),{executionError:true});return {quantity:n,cost:0n,step:{kind:'mint',to:address,value:'0',data:'0x'+n.toString(16).padStart(2,'0')},simulated:true};}});
  return {kind:'contract',route:'mock-free-probe',wallet:w.address,token:address,inputToken:address,outputToken:address,amountIn:'0',minOutput:String(quote.quantity),quantity:quote.quantity,budgetCurrency:'BNB',expectedAsset:{token:address,kind:'Erc20',amount:String(quote.quantity)},requireAssetCredit:true,metaVerified:true,review:[],fill:{continue:true,probe:true},quota:{freeProbe:probe},steps:[quote.step]};};
 const bridge={ready:async()=>({}),call:async(a,args)=>{if(args[1]==='preview'){assert.equal(args[args.indexOf('--value')+1],'0');current=Number(BigInt(args[args.indexOf('--inputData')+1]));return {requestId:'mock-'+submits,simulationResult:{simulationCode:'000000000',balanceChanges:[{owner:w.address,contractAddress:address,change:String(current),tokenType:'Erc20'}]}};}assert.equal(args[1],'execute');assert.ok(current<=left&&current<=4);submits++;return {txHash:'mock-'+submits};}};
 const engine=new Engine({data,rpc:{},bridge,live:true,planFn});engine.observeContract=async(o,e)=>{left-=current;e.status='CONFIRMED';};
 try{const r=await engine.run(intent,'stable-free-fill',{execute:true,authorization:'in-memory test only'});assert.equal(r.status,'CONFIRMED');assert.equal(r.completedQuantity,11);assert.equal(r.spent.bnb,'0');assert.equal(submits,3);assert.equal(left,0);assert.equal(r.id,'stable-free-fill');await engine.execute(r.id,{authorization:'repeat test'});assert.equal(submits,3);}finally{fs.rmSync(data,{recursive:true,force:true});}
});
