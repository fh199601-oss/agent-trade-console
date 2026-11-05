import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {Interface,id} from 'ethers';
import {recognizeMint,adaptiveQuote} from '../lib/adaptive-mint.mjs';import {selectMintRoute} from '../lib/mint-selection.mjs';import {mintError} from '../lib/mint-errors.mjs';
import {mintPlan} from '../lib/mint.mjs';import {wallet as boundWallet} from '../lib/common.mjs';
const saved=JSON.parse(fs.readFileSync(new URL('./fixtures/dual-free-paid-runtime.json',import.meta.url)));
const wallet={account:1,address:'0x1111111111111111111111111111111111111111'},block={tag:'0x10',number:16,timestamp:100};
function fixture(){
 const recognized=recognizeMint(saved),meta={...saved,abi:recognized.abi},iface=new Interface(recognized.abi),calls=[];let fee=6n,underpayAllowed=false;
 const rpc=async(method,params)=>{if(method==='eth_estimateGas')return '0x186a0';assert.equal(params[1],block.tag);const tx=params[0],p=iface.parseTransaction(tx);calls.push(p.name);
  if(p.name==='freeMint')throw Object.assign(Error('execution reverted: '+id('FreeMintEnded()').slice(0,10)),{executionError:true});
  if(p.name==='paidMint'){if(BigInt(tx.value)!==fee*p.args[0]&&!(underpayAllowed&&BigInt(tx.value)>0n))throw Object.assign(Error('execution reverted: payment'),{executionError:true});return '0x';}
  const values={paused:false,paidRemaining:543n,supportsInterface:true,PAID_MINT_PRICE:fee};if(!Object.hasOwn(values,p.name))throw Error('Unexpected getter '+p.name);
  return iface.encodeFunctionResult(p.name,[values[p.name]]);
 };
 return {recognized,meta,rpc,calls,setFee:v=>fee=v,setUnderpay:()=>underpayAllowed=true};
}
test('unverified deployed runtime exposes separate paid/free methods and chooses by requested scope',()=>{
 const f=fixture();assert.equal(selectMintRoute(f.recognized,null,null,'free').method,'freeMint()');assert.equal(selectMintRoute(f.recognized,null,'auto:freeMint()','paid').method,'paidMint(uint256)');
 assert.equal(selectMintRoute(f.recognized,null,null,'all').lane,'free');
 assert.throws(()=>selectMintRoute(f.recognized,'missing',null,'paid'),e=>e.code==='MINT_ROUTE_INVALID');
});
test('ended free phase is distinct from NO_QUOTA and never attempts payment; paid lane quotes current native cost',async()=>{
 const f=fixture(),free=selectMintRoute(f.recognized,null,null,'free'),paid=selectMintRoute(f.recognized,null,null,'paid');
 await assert.rejects(adaptiveQuote(f.meta,free,wallet,1,block,f.rpc),e=>e.code==='MINT_ENDED'&&/免费铸造阶段已结束/.test(e.message));assert.ok(!f.calls.includes('paidMint'));
 const q=await adaptiveQuote(f.meta,paid,wallet,1,block,f.rpc);assert.equal(q.total.raw,'6');assert.equal(q.expectedAsset.kind,'Erc721');assert.equal(q.expectedAsset.amount,'1');assert.equal(q.freeUnits,0);assert.equal(q.available,true);assert.equal(q.limits.walletRemaining,null);
 f.setFee(8n);assert.equal((await adaptiveQuote(f.meta,paid,wallet,1,block,f.rpc)).total.raw,'8');
});
test('runtime price hint cannot pass when one wei less is also accepted',async()=>{
 const f=fixture();f.setUnderpay();await assert.rejects(adaptiveQuote(f.meta,selectMintRoute(f.recognized,null,null,'paid'),wallet,1,block,f.rpc),/少付 1 wei/);
});
test('custom errors distinguish exhausted inventory, phase closure and two-argument wrong payment',()=>{
 assert.equal(mintError(Error('execution reverted: '+id('PaidSoldOut()').slice(0,10))).code,'NO_QUOTA');
 const data=new Interface(['error WrongPayment(uint256,uint256)']).encodeErrorResult('WrongPayment',[1n,2n]);assert.match(mintError({data}).message,/付款金额/);
});
test('quantity free mint and ordinary mint with PAID_PRICE support max, separate quotas and all-lane continuation',async()=>{
 const meta=JSON.parse(fs.readFileSync(new URL('./fixtures/quantity-dual-nft-runtime.json',import.meta.url))),recognized=recognizeMint(meta),iface=new Interface(recognized.abi);let free=2n;const calls=[];
 assert.equal(recognized.routes.find(r=>r.lane==='paid').method,'mint(uint256)');
 const rpc={getBlockNumber:async()=>16,send:async(method,params)=>{
  if(method==='eth_getBlockByNumber')return {timestamp:'0x64'};if(method==='eth_estimateGas')return '0x186a0';assert.equal(method,'eth_call');const p=iface.parseTransaction(params[0]);calls.push(p.name);
  if(p.name==='freeMint'){if(p.args[0]>free||BigInt(params[0].value)!==0n)throw Object.assign(Error('execution reverted'),{executionError:true});return '0x';}
  if(p.name==='mint'){if(p.args[0]>20n||BigInt(params[0].value)!==p.args[0]*10n)throw Object.assign(Error('execution reverted'),{executionError:true});return '0x';}
  const values={freeRemaining:free,paidRemaining:20n,MAX_SUPPLY:10000n,totalMinted:20n,PAID_PRICE:10n,supportsInterface:true};assert.ok(Object.hasOwn(values,p.name),p.name);return iface.encodeFunctionResult(p.name,[values[p.name]]);
 }};
 const intent={account:boundWallet(1).account,side:'mint',scope:'all',quantity:'max',maxBnb:'0.0000000000000002',referral:'none'};
 const plan=()=>mintPlan(rpc,{},intent,meta.address,{},null,{sourceLoader:async()=>structuredClone(meta)});
 const first=await plan();assert.equal(first.quantity,2);assert.equal(first.amountIn,'0');assert.equal(first.fill.continue,true);assert.equal(first.requireNftCredit,true);
 free=0n;const next=await plan();assert.equal(next.quantity,20);assert.equal(next.amountIn,'200');assert.equal(next.fill.continue,false);assert.equal(next.expectedAsset.amount,'20');
 calls.length=0;intent.scope='free';intent.maxBnb='0';await assert.rejects(plan(),e=>e.code==='NO_QUOTA');assert.ok(!calls.includes('mint'));
});
