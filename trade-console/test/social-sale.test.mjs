import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {Interface,keccak256,toUtf8Bytes,ZeroAddress} from 'ethers';
import {wallet,BNB,USDT,ERC20,validateIntent} from '../lib/common.mjs';
import {recognizeSocialSale,socialSaleState,socialSalePlan} from '../lib/social-sale.mjs';
import {mintReceiptSample,TRANSFER} from '../lib/chain-learning.mjs';
const fixtures=JSON.parse(fs.readFileSync(new URL('./fixtures/social-sales.json',import.meta.url))),word=v=>'0x'+BigInt(v).toString(16).padStart(64,'0');
function fixture(kind='fanbei.fun'){
 const meta=structuredClone(fixtures[kind]),abi=new Interface(meta.abi),w=wallet(1),calls=[],writes=[];
 const registry='0x'+'8'.repeat(40),token=kind==='fanbei.fun'?meta.address:fixtures['agio-mint'].address,task=word(1),other=word(2),label='my-agent.ai',agentId=BigInt(keccak256(toUtf8Bytes(label)));
 const user={id:agentId,remaining:14n,freeClaimed:false,paidShares:0n};
 const info={name:'Renamed',symbol:'NEW',treasury:ZeroAddress,quote:ZeroAddress,native:true,pair:ZeroAddress,price:42n,maxShares:4300n,freeShares:1300n,quotaPerId:14n,tokensPerShare:1000n,liquidityBps:7000n,buyTaxBps:0n,sellTaxBps:0n,refundBps:8000n,startedAt:1n,deadline:1000n,sold:100n,freeClaimed:10n,phase:1n};
 const values={paused:false,registrar:registry,token,usdt:USDT,totalMinted:100n,TOTAL_SHARES:10000n,MAX_PER_TX:10n,USER_SHARE:1000n,FREE_MINT_REPOST_COMMENT:task,FREE_MINT_AVATAR:other,quotaOf:25n,mintedCount:0n,freeMintDone:false,paidOnce:false,usedXPost:false,usedXUsername:false};
 const registryAbi=new Interface(['function handleOf(address) view returns(string)','function ownerOf(uint256) view returns(address)']);
 const rpc={getBlockNumber:async()=>10,send:async(m,p)=>{assert.equal(m,'eth_getBlockByNumber');return {timestamp:'0x64'};},call:async tx=>{
  calls.push(tx);const i=tx.to.toLowerCase()===registry.toLowerCase()?registryAbi:tx.to.toLowerCase()===USDT.toLowerCase()?ERC20:abi,f=i.parseTransaction(tx);
  if(!['view','pure'].includes(f.fragment.stateMutability)){
   writes.push(f);if(['freeMint','claimFreeWithVoucher'].includes(f.name)&&f.args.at(-1)!=='0x1234')throw Error('BadSignature');return '0x';
  }
  let v;if(f.name==='info')v=info;else if(f.name==='userInfo')v=user;else if(f.name==='balanceOf')v=1000000000n;else if(f.name==='handleOf')v=label;else if(f.name==='ownerOf')v=w.address;else if(f.name==='allowance')v=0n;else if(f.name==='bnbQuote')v=f.args[0]*99n;else if(f.name==='costOf')v=f.args[0]*100n;else {assert.ok(f.name in values,f.name);v=values[f.name];}
  return i.encodeFunctionResult(f.fragment,[v]);
 }};
 const intent={account:1,side:'mint',asset:'https://unseen-brand.example/',scope:'paid',quantity:1,maxBnb:'0.00000000000001',maxUsdt:'0',referral:'account1'};
 const plan=patch=>socialSalePlan(rpc,{...intent,...patch},meta,w,{});
 return {meta,abi,rpc,w,values,info,user,plan,intent,calls,writes,task,agentId,token};
}
test('families survive renamed sites but require verified dispatchers and reviewed source bodies',()=>{
 for(const name of Object.keys(fixtures)){
  const f=fixture(name);assert.ok(recognizeSocialSale(f.meta));
  assert.equal(recognizeSocialSale({...f.meta,verified:false}),null);
  assert.equal(recognizeSocialSale({...f.meta,runtimeCode:'0x00'}),null);
  assert.equal(recognizeSocialSale({...f.meta,identity:{implementation:'0x'+'1'.repeat(40)}}),null);
  const changed=structuredClone(f.meta);for(const s of Object.values(changed.sources))s.content=s.content.replace(/function mint\(/g,'function changedMint(');assert.equal(recognizeSocialSale(changed),null);
 }
});
test('identity sale uses live tuple price, ID quota and exact inventory distribution; free never becomes paid',async()=>{
 const f=fixture(),plan=await f.plan({quantity:'max'});assert.equal(plan.quantity,14);assert.equal(plan.amountIn,'588');assert.equal(plan.minOutput,'14000');assert.equal(f.abi.decodeFunctionData('mint',plan.steps[0].data)[0],14n);
 f.info.price=50n;assert.equal((await f.plan()).amountIn,'50');
 await assert.rejects(f.plan({scope:'free',maxBnb:'0'}),e=>e.code==='SITE_PROOF_REQUIRED');
 f.info.freeClaimed=1300n;await assert.rejects(f.plan({scope:'free',maxBnb:'0'}),e=>e.code==='NO_QUOTA'&&/免费池/.test(e.message));
 assert.equal((await f.plan()).amountIn,'50');
 await assert.rejects(f.plan({maxBnb:'0'}),e=>e.code==='BUDGET_LIMIT');
 f.info.deadline=99n;await assert.rejects(f.plan(),e=>e.code==='MINT_ENDED');
});
test('social vouchers require own wallet, identity, unused post and unexpired proof, then contract validation',async()=>{
 const f=fixture(),p={kind:'social-voucher',wallet:f.w.address,agentId:String(f.agentId),xUsernameHash:word(7),xPostIdHash:word(8),voucherDeadline:'200',signature:'0x1234'},i={scope:'free',maxBnb:'0',siteProof:p};
 validateIntent({...f.intent,...i});const plan=await f.plan(i);assert.equal(plan.steps[0].value,'0');assert.equal(plan.quantity,1);assert.equal(f.writes.at(-1).name,'claimFreeWithVoucher');
 for(const patch of [{wallet:ZeroAddress},{agentId:'1'},{voucherDeadline:'99'}])await assert.rejects(f.plan({...i,siteProof:{...p,...patch}}),e=>e.code==='SITE_PROOF_INVALID');
 await assert.rejects(f.plan({...i,siteProof:{...p,signature:'0x5678'}}),/BadSignature/);
 f.values.usedXPost=true;await assert.rejects(f.plan(i),e=>e.code==='NO_QUOTA');
 assert.throws(()=>validateIntent({...f.intent,...i,siteProof:{...p,agentId:123}}),/凭证/);
});
test('social quota sale chooses native or bounded USDT payment and never bypasses missing task proof',async()=>{
 const f=fixture('agio-mint'),p=await f.plan({quantity:3});assert.equal(p.amountIn,'297');assert.equal(p.steps[0].value,'297');assert.equal(p.inputToken,BNB);assert.equal(p.minOutput,'3000');
 const usdt=await f.plan({maxBnb:'0',maxUsdt:'0.1'});assert.equal(usdt.inputToken,USDT);assert.equal(usdt.steps.length,2);assert.equal(usdt.steps[0].kind,'approve');assert.equal(usdt.steps[0].allowance,'100');assert.equal(usdt.steps[1].value,'0');
 await assert.rejects(f.plan({scope:'free',maxBnb:'0'}),e=>e.code==='SITE_PROOF_REQUIRED');
 await assert.rejects(f.plan({scope:'all'}),e=>e.code==='SITE_PROOF_REQUIRED');
 const proof={kind:'social-task',wallet:f.w.address,agentId:String(f.agentId),task:f.task,signature:'0x1234'};
 const free=await f.plan({scope:'free',maxBnb:'0',siteProof:proof});assert.equal(free.amountIn,'0');assert.equal(f.writes.at(-1).name,'freeMint');
 await assert.rejects(f.plan({scope:'free',quantity:'max',maxBnb:'0',siteProof:proof}),e=>e.code==='SITE_PROOF_REQUIRED');
 await assert.rejects(f.plan({scope:'free',maxBnb:'0',siteProof:{...proof,task:word(9)}}),e=>e.code==='SITE_PROOF_INVALID');
 f.values.paused=true;await assert.rejects(f.plan(),e=>e.code==='MINT_PAUSED');
});
test('only explicitly verified sale inventory can count as issuance; ordinary transfers remain rejected',()=>{
 const f=fixture(),hash=word(1),blockHash=word(2),tx={hash,from:f.w.address,to:f.meta.address,input:f.abi.encodeFunctionData('mint',[1]),value:'42',blockNumber:'0xa',blockHash};
 const log={address:f.meta.address,topics:[TRANSFER,word(f.meta.address),word(f.w.address)],data:word(1000),transactionHash:hash,blockNumber:'0xa',blockHash,logIndex:'0x0'};
 const receipt={transactionHash:hash,from:tx.from,to:tx.to,blockNumber:'0xa',blockHash,status:'0x1',logs:[log]},header={number:'0xa',hash:blockHash};
 assert.equal(mintReceiptSample(tx,receipt,header,20),null);
 const s=mintReceiptSample(tx,receipt,header,20,{inventoryIssuer:f.meta.address});assert.equal(s.assets[0].issuance,'verified-sale-inventory');assert.equal(s.assets[0].amount,'1000');
 assert.equal(mintReceiptSample(tx,{...receipt,status:'0x0'},header,20,{inventoryIssuer:f.meta.address}),null);
});
