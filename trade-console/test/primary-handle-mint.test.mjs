import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {Interface,ZeroAddress} from 'ethers';
import {recognizePrimaryHandleMint,primaryHandleMintState,primaryHandleMintPlan} from '../lib/primary-handle-mint.mjs';
import {recognizeMint,adaptiveQuote} from '../lib/adaptive-mint.mjs';
import {statusLabel,reviewSummary} from '../public/review-model.mjs';
import {discover} from '../lib/discovery.mjs';
import {verifyPreview} from '../lib/engine.mjs';
import {bindings} from '../lib/common.mjs';
const meta=JSON.parse(fs.readFileSync(new URL('./fixtures/primary-handle-nft-runtime.json',import.meta.url)));
const profile=recognizePrimaryHandleMint(meta),abi=new Interface(profile.abi),w=bindings()[0],registry='0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F';
const reg=new Interface(['function handleOf(address) view returns(string)','function ownerOf(uint256) view returns(address)']);
const intent={account:w.account,side:'mint',scope:'free',quantity:'max',maxBnb:'0',referral:'account1'},price=1000000000000000n;
function fixture(){
 const s={handle:'agent-example',owner:w.address,freeMinted:12n,paidMinted:100n,supply:3000n,freeCap:500n,maxPaid:10n,usedFree:false,usedPaid:0n,mismatch:false,underpay:false,txs:[],blocks:[]};
 const rpc={getBlockNumber:async()=>123,verifyChain:async()=>{},getCode:async()=>meta.runtimeCode,call:async(tx,block)=>{
  s.blocks.push(block);
  if(tx.to.toLowerCase()===registry.toLowerCase()){const f=reg.parseTransaction(tx);return reg.encodeFunctionResult(f.name,[f.name==='handleOf'?s.handle:s.owner]);}
  const f=abi.parseTransaction(tx);if(!f)throw Error('Unexpected call');
  const stock=s.supply-s.freeMinted-s.paidMinted,free=s.handle&&s.owner===w.address&&!s.usedFree&&s.freeMinted<s.freeCap&&stock>0n?1n:0n,paid=stock<s.maxPaid-s.usedPaid?stock:s.maxPaid-s.usedPaid;
  if(['mintFree','mintPaid'].includes(f.name)){
   const value=BigInt(tx.value||0);s.txs.push({method:f.name,value,args:f.args});
   const fail=data=>{throw Object.assign(Error('execution reverted: '+data),{data,executionError:true});};
   if(f.name==='mintFree'){if(value)fail('0x');if(s.freeMinted===s.freeCap)fail('0x236394f4');if(!free)fail('0xdddca41c');}
   else{if(f.args[0]>paid)fail('0xd81598b9');if(value!==f.args[0]*price&&!s.underpay)fail('0xb23bee05'+(f.args[0]*price).toString(16).padStart(64,'0'));}return '0x';
  }
  const values={REGISTRY:registry,supportsInterface:true,FREE_CAP:s.freeCap,freeMinted:s.freeMinted,paidMinted:s.paidMinted,MAX_PAID_PER_WALLET:s.maxPaid,MAX_SUPPLY:s.supply,totalSupply:s.freeMinted+s.paidMinted,PRICE:price,paidUsed:s.usedPaid,freeUsed:s.usedFree,TOKEN:ZeroAddress,ownerOf:w.address,balanceOf:0n};
  return abi.encodeFunctionResult(f.name,f.name==='eligibility'?[s.handle,s.mismatch?2n:free,paid]:[values[f.name]]);
 }};
 return {s,rpc};
}
test('主身份双入口按接口组合识别实际代码，支持别名及不同地址，不依赖域名',()=>{
 assert.equal(profile.kind,'primary-handle-dual-nft');
 const variant=profile.abi.map(s=>s.replace('mintFree()','claimFree()').replace('mintPaid(uint256)','paidMint(uint256)').replace('REGISTRY()','agentRegistry()').replace('PRICE()','PAID_PRICE()'));
 const runtimeCode='0x'+new Interface(variant).fragments.map(f=>'63'+f.selector.slice(2)+'1461000057').join('')+'00';
 const renamed=recognizePrimaryHandleMint({...meta,address:'0x'+'ab'.repeat(20),runtimeCode});assert.ok(renamed);assert.equal(renamed.methods.paid,'paidMint(uint256)');
 assert.equal(recognizePrimaryHandleMint({...meta,runtimeCode:'0xf4'+meta.runtimeCode.slice(2)}),null);
 assert.equal(recognizePrimaryHandleMint({...meta,proxy:true}),null);
 const wrong=profile.abi.map(s=>s.replace('eligibility(address) view returns(string,uint256,uint256)','eligibility(address) view returns(bytes32,uint256,uint256)'));
 assert.equal(recognizePrimaryHandleMint({...meta,verified:true,abi:wrong}),null);
});
test('陌生域名及短变量名可定位主身份 Mint 地址',async()=>{
 const {rpc}=fixture();const r=await discover('https://other-cards.example/',{rpc,sourceLoader:async()=>meta,fetchText:async url=>url==='https://other-cards.example/'?`<title>Other cards</title><script>const C="${meta.address}"</script>`:''});
 assert.equal(r.address.toLowerCase(),meta.address.toLowerCase());assert.ok(r.addresses[0].verifiedRoles.includes('mint'));assert.ok(r.addresses[0].verifiedRoles.includes('nft'));
});
test('免费零付款、付费按当前价格和钱包额度、全部先免费再重新查额度',async()=>{
 const {s,rpc}=fixture();
 const free=await primaryHandleMintPlan(rpc,intent,meta,0n,w,{});assert.equal(free.amountIn,'0');assert.equal(free.quantity,1);assert.equal(s.txs[0].method,'mintFree');assert.equal(s.txs[0].args.length,0);assert.equal(free.requireNftCredit,true);
 const paid=await primaryHandleMintPlan(rpc,{...intent,scope:'paid'},meta,10n*price,w,{});assert.equal(paid.quantity,10);assert.equal(paid.amountIn,String(10n*price));assert.equal(paid.quota.paidUsed,'0');
 const all=await primaryHandleMintPlan(rpc,{...intent,scope:'all'},meta,10n*price,w,{});assert.equal(all.quantity,1);assert.equal(all.fill.continue,true);
 s.usedFree=true;s.freeMinted++;
 const next=await primaryHandleMintPlan(rpc,{...intent,scope:'all'},meta,10n*price,w,{});assert.equal(next.quantity,10);assert.equal(next.fill.continue,false);
 assert.ok(s.blocks.every(b=>b===123));
});
test('500 个免费名额已用完：直接给出零额度与付费信息，绝不调用付费入口',async()=>{
 const {s,rpc}=fixture();s.freeMinted=500n;
 const state=await primaryHandleMintState(rpc,intent,meta,w);assert.equal(state.info.freeRemaining,'0');assert.equal(state.info.paidRemaining,'10');
 await assert.rejects(primaryHandleMintPlan(rpc,intent,meta,10n*price,w,{}),e=>e.code==='NO_QUOTA'&&/500\/500/.test(e.message)&&e.details.quota.paidPriceBnb==='0.001');assert.equal(s.txs.length,0);
 assert.equal(statusLabel({status:'BLOCKED',error:{code:'NO_QUOTA'}}),'当前无可用额度');
 assert.equal(reviewSummary([{status:'BLOCKED',error:{code:'NO_QUOTA'}}]).canConfirm,false);assert.match(reviewSummary([{status:'BLOCKED',error:{code:'NO_QUOTA'}}]).message,/没有符合本次范围的铸造额度/);
});
test('主 ID 未注册可以付费；免费必须核验持有者、未领和剩余库存',async()=>{
 const {s,rpc}=fixture();s.handle='';
 await assert.rejects(primaryHandleMintPlan(rpc,intent,meta,0n,w,{}),/没有有效主 Agent ID/);
 const paid=await primaryHandleMintPlan(rpc,{...intent,scope:'paid',quantity:1},meta,price,w,{});assert.equal(paid.quantity,1);
 s.handle='agent-example';s.owner='0x'+'44'.repeat(20);await assert.rejects(primaryHandleMintPlan(rpc,intent,meta,0n,w,{}),/没有有效主 Agent ID/);
 s.owner=w.address;s.usedFree=true;await assert.rejects(primaryHandleMintPlan(rpc,intent,meta,0n,w,{}),/已领取免费名额/);
});
test('共享库存不重复计数；只剩一个时全部只领免费；付费不会保留虚构的免费池',async()=>{
 const {s,rpc}=fixture();s.paidMinted=2987n;
 const state=await primaryHandleMintState(rpc,{scope:'all'},meta,w);assert.equal(state.info.paidRemaining,'1');assert.equal(state.free,1n);assert.equal(state.paid,0n);
 const plan=await primaryHandleMintPlan(rpc,{...intent,scope:'all'},meta,10n*price,w,{});assert.equal(plan.quantity,1);assert.equal(plan.fill.continue,false);
 const paid=await primaryHandleMintPlan(rpc,{...intent,scope:'paid'},meta,10n*price,w,{});assert.equal(paid.quantity,1);
 s.paidMinted++;await assert.rejects(primaryHandleMintPlan(rpc,intent,meta,0n,w,{}),/总库存已售罄/);
});
test('付费打满严格遵守预算和当前已用额度，零预算不升级',async()=>{
 const {s,rpc}=fixture();s.usedPaid=7n;
 const p=await primaryHandleMintPlan(rpc,{...intent,scope:'paid'},meta,2n*price,w,{});assert.equal(p.quantity,2);assert.equal(p.quota.paidRemaining,'3');
 await assert.rejects(primaryHandleMintPlan(rpc,{...intent,scope:'paid'},meta,0n,w,{}),e=>e.code==='BUDGET_LIMIT');
 await assert.rejects(primaryHandleMintPlan(rpc,{...intent,scope:'paid',quantity:4},meta,4n*price,w,{}),/超过本钱包/);
});
test('返回额度不一致、少付仍接受、邀请未核验都不构造可执行计划',async()=>{
 const {s,rpc}=fixture();s.mismatch=true;await assert.rejects(primaryHandleMintState(rpc,intent,meta,w),/核验不一致/);
 s.mismatch=false;s.underpay=true;await assert.rejects(primaryHandleMintPlan(rpc,{...intent,scope:'paid',quantity:1},meta,price,w,{}),/少付 1 wei/);
 await assert.rejects(primaryHandleMintPlan(rpc,{...intent,account:2},meta,0n,w,{referralHints:{detected:true}}),/邀请/);
});
test('通用识别器的独立免费入口失败后保留免费售罄原因，不套用 PRICE',async()=>{
 const {s,rpc}=fixture();s.freeMinted=500n;
 const recognized=recognizeMint(meta),route=recognized.routes.find(r=>r.method==='mintFree()');assert.ok(route.freeEntry);
 await assert.rejects(adaptiveQuote({...meta,abi:recognized.abi},route,w,1,{tag:'0x7b',number:123,timestamp:0},(method,p)=>{assert.equal(method,'eth_call');return rpc.call(p[0],123);}),/免费名额已领完.*未套用付费价格/);
 assert.ok(s.txs.length>0);assert.ok(s.txs.every(tx=>tx.value===0n&&tx.method==='mintFree'));
});
test('官方模拟仍须证明目标 NFT 足额到账，奖励 ERC20 不能代替 NFT',async()=>{
 const {rpc}=fixture(),p=await primaryHandleMintPlan(rpc,intent,meta,0n,w,{}),step=p.steps[0];
 const preview=changes=>({requestId:'fixture',simulationResult:{simulationCode:'000000000',balanceChanges:changes}});
 assert.throws(()=>verifyPreview(preview([{owner:w.address,contractAddress:meta.address,change:1,tokenType:'Erc20'}]),p,step),/NFT 足额/);
 assert.doesNotThrow(()=>verifyPreview(preview([{owner:w.address,contractAddress:meta.address,change:1,tokenType:'Erc721',tokenId:'123'}]),p,step));
});
