import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {keccak256} from 'ethers';
import {STARS,STARS_ABI as M,STARS_TEMPLATE,STARS_PRICE,STARS_UNITS,starsPlan,starsState,discoverStars,inspectStars,verifyStarsTokenCode,starsReferral,verifyStarsPreview,verifyStarsReceipt} from '../lib/stars.mjs';
import {ERC20,ZeroAddress,parseUnits,BNB,same} from '../lib/common.mjs';
import {IMPL_SLOT,discover} from '../lib/discovery.mjs';
import {fundedMintPlan} from '../lib/mint-funding.mjs';
import {corlaBudget} from '../public/corla-budget.mjs';
const codes=JSON.parse(fs.readFileSync(new URL('./fixtures/stars-protocol-code.json',import.meta.url))),code=fs.readFileSync(new URL('./fixtures/stars-token.txt',import.meta.url),'utf8'),C=STARS.config;
const addr=n=>'0x'+n.repeat(40),token=addr('9'),w={account:2,address:addr('2')},inviter={account:1,address:addr('1')},zero='0x'+'0'.repeat(64);
const key=a=>keccak256(a),enc=(method,result)=>M.encodeFunctionResult(method,result);
function fixture(options={}){
 const state={mode:1,agentRequired:true,minted:0n,total:30000n,used:0n,invites:0n,seen:false,referrer:zero,balance:0n,allowance:0n,bnb:parseUnits('1',18),paused:false,tradingPaused:false,launched:false,gas:500000n,...options};
 const calls=[],txs=[];
 const rpc={verifyChain:async()=>{},getBlockNumber:async()=>123,getBalance:async a=>state.insolvent===a?0n:state.bnb,getCode:async a=>same(a,token)?state.tokenCode||code:codes[a.toLowerCase()]||'0x',send:async(m,p)=>{
  calls.push(m);if(m==='eth_getStorageAt')return same(p[0],C.factory)&&p[1]===IMPL_SLOT?'0x'+'0'.repeat(24)+STARS.identities.factory.implementation.slice(2):zero;
  if(m==='eth_gasPrice')return '0x5f5e100';if(m==='eth_estimateGas')return '0x'+state.gas.toString(16);throw Error('No signing/broadcast allowed: '+m);
 },call:async tx=>{
  if(same(tx.to,C.factory)){const p=M.parseTransaction(tx),a=p.args;
   if(p.name==='sales')return enc(p.name,[same(a[0],token)?addr('8'):ZeroAddress,C.marketing2,state.launched?addr('7'):ZeroAddress,state.agentRequired,state.launched,state.minted]);
   if(p.name==='mintPaused')return enc(p.name,[state.paused]);if(p.name==='tradingPaused')return enc(p.name,[state.tradingPaused]);
   if(p.name==='SHARE_PRICE')return enc(p.name,[state.price??STARS_PRICE]);if(p.name==='totalSharesOf')return enc(p.name,[state.total]);if(p.name==='tokensPerShareOf')return enc(p.name,[state.units??(state.mode===1?26660n*10n**18n:STARS_UNITS)]);if(p.name==='launchModes')return enc(p.name,[state.mode]);
   if(p.name==='identityOf'){if(same(a[1],state.ineligible)||same(a[1],state.inviterInvalid?inviter.address:ZeroAddress))throw Object.assign(Error('execution reverted'),{data:M.encodeErrorResult('InvalidIdentity',[])});return enc(p.name,[key(a[1])]);}
   if(p.name==='quotaOf')return enc(p.name,[50n+state.invites*50n]);if(p.name==='accounts')return enc(p.name,[state.used,state.invites,state.seen,state.referrer]);
   if(p.name==='mint'){txs.push(tx);if(state.referralRevert&&!same(a[2],ZeroAddress))throw Object.assign(Error('execution reverted'),{data:M.encodeErrorResult('InvalidReferral',[])});assert.equal(BigInt(tx.value),a[1]*STARS_PRICE);assert.ok(a[1]<=state.total-state.minted);assert.ok(a[1]<=50n+state.invites*50n-state.used);return '0x';}
   if(C[p.name])return enc(p.name,[state.badOwner&&p.name==='owner'?addr('6'):C[p.name]]);
   throw Error('Unmocked factory read '+p.name);
  }
  const p=ERC20.parseTransaction(tx);if(p.name==='name')return ERC20.encodeFunctionResult(p.fragment,['New project']);if(p.name==='balanceOf')return ERC20.encodeFunctionResult(p.fragment,[state.balance]);if(p.name==='allowance')return ERC20.encodeFunctionResult(p.fragment,[state.allowance]);throw Error('Unmocked read '+p.name);
 }};
 const intent={side:'mint',asset:token,account:2,currency:'BNB',quantity:'max',scope:'all',referral:'none',maxBnb:'1',maxUsdt:'0'};
 const plan=(i={})=>starsPlan(rpc,{...intent,...i},w,{resolved:{token},inviter});
 const full=(i={})=>fundedMintPlan(rpc,{...intent,...i},w,next=>starsPlan(rpc,next,w,{resolved:{token},inviter,balanceFill:true}));
 return {state,rpc,calls,txs,intent,plan,full};
}
test('new CA discovered by factory membership without any history or website request',async()=>{
 const f=fixture(),r=await discoverStars(f.rpc,token,{fetchJson:()=>{throw Error('No website on CA path');}});assert.equal(r.platform,'stars');assert.equal(r.token.toLowerCase(),token);assert.equal(r.mintContract,C.factory);
 const via=await discover(token,{rpc:f.rpc,chainFallback:true,fetchText:()=>{throw Error('No generic source scan');}});assert.equal(via.platform,'stars');
 assert.equal(await discoverStars(f.rpc,addr('6')),null);
 await assert.rejects(discoverStars(f.rpc,'https://starsagent.org/token/'+addr('6')),{code:'STARS_NOT_PROJECT'});
});
test('homepage lists projects and never selects or mints an arbitrary one',async()=>{
 const f=fixture(),r=await discoverStars(f.rpc,'starsagent.org/?ref=anything',{fetchJson:async()=>({configured:true,config:{chainId:56,factory:C.factory},items:[{address:token,name:'New',launchMode:1},{address:token,name:'Duplicate'},{address:addr('8'),name:'Ended',launched:true},{address:'invalid'}]})});assert.equal(r.address,null);assert.equal(r.needsSelection,true);assert.equal(r.candidates.length,2);assert.equal(f.txs.length,0);assert.equal(await inspectStars(f.rpc,r,[]),r);
 await assert.rejects(starsPlan(f.rpc,{...f.intent,asset:'https://starsagent.org/'},w),{code:'MINT_SELECTION_REQUIRED'});
 await assert.rejects(discoverStars(f.rpc,'starsagent.org',{fetchJson:async()=>({configured:true,config:{chainId:1,factory:C.factory},items:[]})}),/配置/);
});
for(const mode of [0,1])for(const agentRequired of [true,false])test(`mode ${mode}, agent ${agentRequired}: exact quota, BNB and token amounts`,async()=>{
 const f=fixture({mode,total:mode?30000n:300000n,agentRequired,used:7n,invites:1n}),p=await f.plan();assert.equal(p.quantity,93);assert.equal(p.amountIn,String(93n*STARS_PRICE));assert.equal(p.minOutput,String(93n*(mode?26660n*10n**18n:STARS_UNITS)));assert.equal(M.decodeFunctionData('mint',p.steps[0].data)[0].toLowerCase(),token);assert.equal(f.txs.length,1);
});
test('global remaining clips wallet quota, and final mint simulates launch instead of rejecting blindly',async()=>{
 const f=fixture({minted:29998n}),p=await f.plan();assert.equal(p.quantity,2);assert.equal(f.txs.length,1);f.state.tradingPaused=true;await assert.rejects(f.plan(),{code:'MINT_PAUSED'});
});
for(const [opts,code] of [[{launched:true},'MINT_ENDED'],[{minted:30000n},'MINT_ENDED'],[{paused:true},'MINT_PAUSED'],[{used:50n},'NO_QUOTA'],[{ineligible:w.address},'MINT_INELIGIBLE'],[{mode:2},'STARS_VERSION_CHANGED'],[{price:1n},'STARS_VERSION_CHANGED'],[{badOwner:true},'STARS_VERSION_CHANGED']])test('specific status '+code+' '+JSON.stringify(opts,(_,v)=>typeof v==='bigint'?String(v):v),async()=>{await assert.rejects(fixture(opts).plan(),{code});});
test('free never silently spends money; numeric budget remains strict; uppercase MAX works',async()=>{
 const f=fixture();await assert.rejects(f.plan({scope:'free'}),{code:'NO_FREE_MINT'});await assert.rejects(f.plan({quantity:5,maxBnb:'0.001'}),{code:'BUDGET_LIMIT'});assert.equal((await f.plan({quantity:'MAX'})).quantity,50);
});
test('full fill uses balance minus measured Gas, ignores old zero budget and never submits',async()=>{
 const f=fixture({bnb:parseUnits('0.005',18)}),p=await f.full({maxBnb:'0'});assert.equal(p.quantity,4);assert.ok(BigInt(p.amountIn)+BigInt(p.mintFunding.gasReserve)<=f.state.bnb);assert.ok(f.calls.every(m=>['eth_getStorageAt','eth_gasPrice','eth_estimateGas'].includes(m)));
});
test('large launch Gas re-estimates and reduces affordable lots',async()=>{
 const f=fixture({bnb:parseUnits('0.00505',18),gas:1500000n}),p=await f.full();assert.equal(p.quantity,4);assert.equal(p.mintFunding.gasReserve,'300000000000000');
});
test('one wallet missing identity does not hide the other wallet or its budget',async()=>{
 const f=fixture({ineligible:w.address}),r=await inspectStars(f.rpc,{platform:'stars',address:C.factory,token},[w,inviter],{fetchJson:async()=>{throw Error('site offline');}});assert.equal(r.quotas[0].errorCode,'MINT_INELIGIBLE');assert.equal(r.quotas[1].paidRemaining,'50');assert.equal(r.referral.status,'unavailable');assert.equal(corlaBudget(r,[1,2],'all','max').maxBnb,'0.05');
});
test('inviter missing Agent ID falls back to independently simulated mint',async()=>{
 const f=fixture({inviterInvalid:true}),p=await f.full({referral:'account1'});assert.equal(p.referral.fallback,true);assert.equal(M.decodeFunctionData('mint',p.steps[0].data)[2],ZeroAddress);
});
test('invalid invitation revert falls back; required wallet identity does not',async()=>{
 const f=fixture({referralRevert:true}),p=await f.full({referral:'account1'});assert.equal(p.referral.fallback,true);assert.equal(f.txs.length,2);
 await assert.rejects(fixture({ineligible:w.address}).full({referral:'account1'}),{code:'MINT_INELIGIBLE'});
});
test('any configured account may refer wallet 1; existing first-mint binding is preserved',async()=>{
 const f=fixture(),s=await starsState(f.rpc,w,token);const r=await starsReferral(f.rpc,{...w,account:9},s,{referral:'account1'},{inviter});assert.equal(r.address,inviter.address);
 assert.equal(await starsReferral(f.rpc,w,{...s,seen:true,referrer:key(addr('8'))},{referral:'account1'},{inviter}),null);
});
test('invitation links use this installation wallet identity, not an embedded username',async()=>{
 const f=fixture(),r=await inspectStars(f.rpc,{platform:'stars',address:C.factory,token},[inviter],{fetchJson:async url=>{assert.ok(url.endsWith(inviter.address));return {chainId:56,factory:C.factory,identity:{address:inviter.address,name:'example.ai'}};}});assert.equal(r.referral.url,'https://starsagent.org/token/'+token+'?ref=example.ai');
});
test('bytecode family accepts only verified immutable positions, rejects extra opcodes and wrong hub',()=>{
 const b=Buffer.from(code.slice(2),'hex');for(const pos of STARS_TEMPLATE.immutableSlots.marketing2)b.set(Buffer.from('0'.repeat(24)+addr('8').slice(2),'hex'),pos);assert.doesNotThrow(()=>verifyStarsTokenCode('0x'+b.toString('hex'),addr('8')));
 b[10]^=1;assert.throws(()=>verifyStarsTokenCode('0x'+b.toString('hex')));assert.throws(()=>verifyStarsTokenCode(code+'00'));
 const h=Buffer.from(code.slice(2),'hex');for(const pos of STARS_TEMPLATE.immutableSlots.hub)h.set(Buffer.from('0'.repeat(24)+addr('8').slice(2),'hex'),pos);assert.throws(()=>verifyStarsTokenCode('0x'+h.toString('hex')));
});
test('new-token allowance preview is exact and cannot reuse another token receipt or change mode',async()=>{
 const f=fixture(),plan=await f.plan({quantity:3}),step=plan.steps[0],p={simulationResult:{allowanceChanges:[{owner:w.address,tokenAddress:token,spender:C.factory,preAmount:'0',postAmount:String(10n**27n),tokenType:'Erc20'}]}};
 assert.doesNotThrow(()=>verifyStarsPreview(p,plan,step));for(const mutate of [x=>x.token=addr('8'),x=>x.stars.mode=0,x=>x.stars.price='1',x=>x.protocolIdentities.at(-1).code+='00',x=>x.protocolIdentities.at(-1).fingerprint='fake',x=>delete x.expectedAsset,x=>x.expectedAsset.token=addr('8'),x=>x.expectedAsset.amount='1',x=>x.requireAssetCredit=false,x=>x.metaVerified=true]){const q=structuredClone(plan);mutate(q);assert.throws(()=>verifyStarsPreview(p,q,step));}
 const log=(t)=>({address:C.factory,...M.encodeEventLog(M.getEvent('Minted'),[t,w.address,plan.stars.key,3,3])});assert.equal(verifyStarsReceipt({logs:[log(token)]},plan).quantity,'3');assert.throws(()=>verifyStarsReceipt({logs:[log(addr('8'))]},plan));
});

test('shared Mint dispatch applies Stars funding and a stale-review quantity ceiling',async()=>{
 const {mintPlan}=await import('../lib/mint.mjs');
 const f=fixture({bnb:parseUnits('0.005',18)}),resolved={platform:'stars',token,address:C.factory};
 const limited=await mintPlan(f.rpc,{}, {...f.intent,maxBnb:'0'},C.factory,resolved,null,{quantityCeiling:3});
 assert.equal(limited.quantity,3);assert.equal(limited.mintFunding.full,true);
 assert.ok(BigInt(limited.amountIn)+BigInt(limited.mintFunding.gasReserve)<=f.state.bnb);
 const numeric=await mintPlan(f.rpc,{}, {...f.intent,quantity:1,maxBnb:'0.001'},C.factory,resolved);
 assert.equal(numeric.quantity,1);assert.equal(numeric.mintFunding,undefined);
});

test('Stars UI and bot batch isolate a failed first wallet and retain stable child IDs',async t=>{
 const os=await import('node:os'),path=await import('node:path'),{Batches}=await import('../lib/batch.mjs'),{independentOrder}=await import('../public/trade-workflow.mjs');
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'stars-batch-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 const seen=[],engine={data,live:true,prepare:async(intent,id)=>({id,intent,status:intent.account===1?'BLOCKED':'PREPARED',project:{platform:'stars'},...(intent.account===1?{error:{code:'INSUFFICIENT_FUNDS'}}:{plan:{route:'stars:mint',resolved:{platform:'stars'}}})}),run:async(intent,id)=>{seen.push(intent.account);return {id,intent,status:intent.account===1?'BLOCKED':'CONFIRMED'};}};
 assert.equal(independentOrder(await engine.prepare(fixture().intent,'test')),true);
 const row=await new Batches(engine).run({id:'stars-mock',accounts:[1,2,3,4],intent:fixture().intent,execute:true});
 assert.deepEqual(seen,[1,2,3,4]);assert.deepEqual(row.orders.map(o=>o.id),[1,2,3,4].map(n=>'stars-mock-a'+n));assert.equal(row.status,'INCOMPLETE');
});
