import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Interface,keccak256,toUtf8Bytes} from 'ethers';
import {sampleState,samplePlan} from '../lib/sample-mints.mjs';
import {chooseBatch} from '../lib/mint-policy.mjs';
import {wallet,same} from '../lib/common.mjs';
const abi=new Interface(JSON.parse(fs.readFileSync(new URL('./fixtures/bnbull-abi.json',import.meta.url))));
const main='0x0Cbc2C5f9c5Bdac24d98E71Bf173192692050946',pass='0x64295d2deA0acb8d0ED0D00c009C7D25eb3A0446',registry='0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F';
const meta={address:main,hash:'fe1cb472ce8a465d745bc83208bcf628ee70221026220b1c5ebf3749ed9250a5',verified:true,abi:abi.formatJson(),identity:{fingerprint:'test-only'}};
const label=a=>'testagent'+a,id=a=>BigInt(keccak256(toUtf8Bytes(label(a))));
function fixture(overrides={},options={}){
 const components=abi.getFunction('status(address,uint256)').outputs[0].components;
 const state=Object.fromEntries(components.map(c=>[c.name,c.type==='bool'?false:0n]));
 Object.assign(state,{open:true,currentBlock:1000n,startTime:1n,endTime:9999n,agentIds:1n,eligible:true,freeSupply:3000n,freeMinted:10n,paidSupply:4000n,paidLeftAll:3900n,paidLeft:20n,noIdLeft:20n,freeOpensAt:900n,freeSlotBlocks:45n,maxPaidPerTx:20n,postCap:3000n,postSold:0n},overrides);
 const ownerAbi=new Interface(['function ownerOf(uint256) view returns(address)']);
 const called=[];
 const rpc={getBlockNumber:async()=>1000,send:async()=>({timestamp:'0x64'}),call:async(tx,block)=>{
  if(same(tx.to,registry)){const [tid]=ownerAbi.decodeFunctionData('ownerOf',tx.data),a=[1,2,3].find(a=>id(a)===tid);assert.ok(a);return ownerAbi.encodeFunctionResult('ownerOf',[options.wrongOwner?wallet(a===1?2:1).address:wallet(a).address]);}
  const parsed=abi.parseTransaction({data:tx.data,value:tx.value||0n}),name=parsed.name,args=parsed.args;called.push({name,args,block});
  let values;
  if(name==='status')values=[state];
  else if(name==='agentId')values=[registry];
  else if(name==='pass')values=[pass];
  else if(name==='MAX_PAID_PER_NOID_WALLET')values=[20n];
  else if(name==='paidOfWallet')values=[options.noIdUsed||0n];
  else if(name==='TOKENS_PER_SHARE')values=[60000n*10n**18n];
  else if(name.startsWith('quote'))values=[args[0]*(name==='quotePaidNoId'||name==='quotePost'&&args[1]?14n:10n),args[0]*2n];
  else if(name.startsWith('mint'))return '0x';
  else throw Error('unexpected '+name);
  return abi.encodeFunctionResult(parsed.fragment,values);
 }};
 const bridge={call:async(a,args)=>{assert.deepEqual(args,['wallet','agent-id']);if(options.agentError)throw Error('Agent ID 查询失败');return {name:label(a).toUpperCase()+'.ai'};}};
 const intent=(scope='free',extra={})=>({account:2,asset:main,scope,quantity:'max',maxBnb:'0',referral:'account1',...extra});
 const get=async(scope='free',extra={})=>{const i=intent(scope,extra);return sampleState(rpc,bridge,i,meta,wallet(i.account));};
 return {get,rpc,bridge,intent,called};
}
const decode=q=>abi.parseTransaction({data:q.step.data,value:BigInt(q.step.value)});
test('BNB Bull 免费预览使用核验 ID 和 1 号邀请，到账为 Pass 而非代币',async()=>{
 const f=fixture(),i=f.intent(),p=await samplePlan(f.rpc,f.bridge,i,meta,0n,wallet(2));
 const tx=abi.parseTransaction({data:p.steps[0].data});assert.equal(tx.name,'mintFree');assert.deepEqual([...tx.args],[id(2),id(1)]);
 assert.equal(p.expectedAsset.kind,'Erc721');assert.equal(p.expectedAsset.token,pass);assert.equal(p.amountIn,'0');assert.equal(p.quota.freeRemaining,'1');assert.equal(p.quota.paidRemaining,'20');assert.equal(p.referral.url,'https://moomoo.cloud/bnbull/?ref=testagent1');assert.equal(p.fill.continue,false);
});
test('付费与全部选择不同方法，合并入口数量包含免费，预算可缩小批次',async()=>{
 const f=fixture();let q=await chooseBatch(await f.get('paid'),f.intent('paid'),200n);assert.equal(decode(q).name,'mintPaid');assert.deepEqual([...decode(q).args],[id(2),20n,id(1)]);assert.equal(q.out,20n);
 q=await chooseBatch(await f.get('all'),f.intent('all'),200n);assert.equal(decode(q).name,'mintPaidPlusFree');assert.equal(q.n,21n);assert.equal(q.out,21n);assert.equal(q.cost,200n);
 q=await chooseBatch(await f.get('all'),f.intent('all'),25n);assert.equal(q.n,3n);assert.equal(q.cost,20n);assert.equal(q.continue,true);
 q=await chooseBatch(await f.get('all'),f.intent('all'),0n);assert.equal(decode(q).name,'mintFree');assert.equal(q.cost,0n);
});
test('免费槽关闭必须说明开放区块，不改付费；明确全部可使用付费合并入口',async()=>{
 const f=fixture({freeOpensAt:1100n});await assert.rejects(chooseBatch(await f.get(),f.intent(),0n),e=>e.code==='MINT_SLOT_WAIT'&&/1100/.test(e.message));
 const q=await chooseBatch(await f.get('all'),f.intent('all'),200n);assert.equal(decode(q).name,'mintPaidPlusFree');
});
test('邀请免费奖励先领取，批次不超奖励和全局库存',async()=>{
 const f=fixture({refBonusLeft:3n,freeOpensAt:1100n});const s=await f.get();assert.equal(s.free,4n);let q=await chooseBatch(s,f.intent(),0n);assert.equal(decode(q).name,'mintRefBonus');assert.equal(q.n,3n);assert.equal(q.continue,true);
 const g=fixture({refBonusLeft:3n,freeSupply:12n,freeMinted:10n});q=await chooseBatch(await g.get(),g.intent(),0n);assert.equal(q.n,2n);assert.equal(q.continue,false);
});
test('没有 ID 使用明确的无 ID 付费价；查询失败或身份错误不静默回退',async()=>{
 const f=fixture({agentIds:0n,eligible:false});let s=await f.get('paid',{referral:'none'}),q=await chooseBatch(s,f.intent('paid'),280n);assert.equal(s.free,0n);assert.equal(decode(q).name,'mintPaidNoId');assert.equal(q.cost,280n);
 await assert.rejects(fixture({}, {wrongOwner:true}).get(),/所有者/);await assert.rejects(fixture({}, {agentError:true}).get(),/查询失败/);
});
test('1 号不自邀，3 号用 1 号邀请，none 不带邀请',async()=>{
 const f=fixture();for(const [account,referral,expected] of [[1,'account1',0n],[3,'account1',id(1)],[2,'none',0n]]){
  const i=f.intent('free',{account,referral}),s=await f.get('free',{account,referral}),q=await chooseBatch(s,i,0n);assert.equal(decode(q).args[1],expected);
 }
});
test('免费已领、总额度耗尽和铸造关闭返回明确状态',async()=>{
 const used=fixture({freeUsed:true});await assert.rejects(chooseBatch(await used.get(),used.intent(),0n),e=>e.code==='NO_QUOTA');
 const closed=fixture({open:false});await assert.rejects(chooseBatch(await closed.get(),closed.intent(),0n),/铸造已结束/);
 const future=fixture({open:false,startTime:200n});await assert.rejects(chooseBatch(await future.get(),future.intent(),0n),/尚未开始/);
});
test('开池后直接到账代币，ID 无总上限时拒绝打满全局库存，无 ID 保留跨阶段总限额',async()=>{
 const f=fixture({launched:true,open:false}),s=await f.get('paid');assert.equal(s.assetKind,'Erc20');assert.equal(s.token,main);assert.equal(s.referral.active,false);
 await assert.rejects(chooseBatch(s,f.intent('paid'),1000n),/没有每钱包付费上限/);
 const q=await chooseBatch(s,f.intent('paid',{quantity:2}),1000n);assert.equal(decode(q).name,'mintAfter');assert.equal(q.out,120000n*10n**18n);
 const g=fixture({launched:true,open:false,agentIds:0n,eligible:false},{noIdUsed:18n});const t=await g.get('paid',{referral:'none'});assert.equal(t.paid,2n);assert.equal(t.unboundedPaid,false);
});
test('不匹配指纹或未核验源码不能套用 BNB Bull 适配',async()=>{
 const f=fixture();assert.equal(await sampleState(f.rpc,f.bridge,f.intent(),{...meta,hash:'unknown'},wallet(2)),null);
 await assert.rejects(sampleState(f.rpc,f.bridge,f.intent(),{...meta,verified:false},wallet(2)),/源码与运行代码匹配/);
});
