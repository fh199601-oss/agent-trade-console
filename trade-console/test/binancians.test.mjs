import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {keccak256} from 'ethers';
import {BINANCIANS,BINANCIANS_FACTORY as F,BINANCIANS_MINT as M,BinanciansClient,discoverBinancians,inspectBinancians,binanciansPlan} from '../lib/binancians.mjs';
import {Interface,ERC20,BNB,USDT,ZeroAddress} from '../lib/common.mjs';
import {binanciansInput} from '../public/binancians-input.mjs';
import {corlaBudget,refreshMintBudget} from '../public/corla-budget.mjs';
import {compactReviewGroups} from '../public/review-model.mjs';
import {verifyPreview,Engine} from '../lib/engine.mjs';
const TRANSFER=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const a=n=>'0x'+String(n).repeat(40),mint=a(2),token=a(3),w={account:1,address:a(1)},other={account:2,address:a(9)},impl=a(5),tokenImpl=a(6),factory=a(4),hub=a(7),code='0x60006001',tcode='0x60006002',clone=x=>'0x363d3d373d3d3d363d73'+x.slice(2)+'5af43d82803e903d91602b57fd5bf3';
function fixture(){
 const root={...BINANCIANS,factory,hub,mintTemplate:impl,tokenTemplate:tokenImpl,mintHash:keccak256(code),tokenHash:keccak256(tcode),factoryFingerprint:'factory',hubFingerprint:'hub'};
 const row={mint,token,pair:a(8),creator:a(8),treasury:a(8),quote:root.wrappedNative,nativePayment:true,createdAt:1n,name:'Fixture',symbol:'FIX',logoURI:'',description:''};
 const s={remaining:10n,used:0n,minted:100n,total:1000n,perTx:10n,valid:true,inviterValid:true,opened:false,paused:false,refunding:false,allowance:0n,balance:10n**20n,calls:[],simulations:0,price:10n**15n};
 const T=new Interface(['function minter() view returns(address)','function factory() view returns(address)']);
 const rpc={verifyChain:async()=>{},getBlockNumber:async()=>s.block??42,getBalance:async()=>s.nativeBalance??s.balance,send:async method=>{if(method==='eth_estimateGas')return '0x7a120';assert.equal(method,'eth_gasPrice');return '0x5f5e100';},getCode:async ca=>ca.toLowerCase()===mint?clone(impl):ca.toLowerCase()===token?clone(tokenImpl):'0x',call:async(tx,b)=>{
  const abi=tx.to.toLowerCase()===factory?F:tx.to.toLowerCase()===token?T:tx.to.toLowerCase()===USDT.toLowerCase()?ERC20:M,p=abi.parseTransaction(tx),name=p.name,args=[...p.args];s.calls.push({name,args:p.args,block:b});
  if(name==='mint'){s.simulations++;if(s.revert)throw Error('execution reverted');assert.equal(tx.from,w.address);return '0x';}
  const out={mintTemplate:[impl],tokenTemplate:[tokenImpl],registrar:[root.registrar],eventHub:[hub],hub:[hub],router:[root.router],wrappedNative:[root.wrappedNative],usdt:[root.usdt],factory:[factory],minter:[mint],isMint:[!s.unregistered],mintToToken:[s.wrongToken?ZeroAddress:token],getProject:[row],token:[token],quote:[row.quote],nativePayment:[row.nativePayment],totalMinted:[s.minted],TOTAL_SHARES:[s.total],MAX_PER_TX:[s.perTx],opened:[s.opened],paused:[s.paused],refunding:[s.refunding],agentOf:[123n,typeof args[0]==='string'&&args[0].toLowerCase()===w.address?s.inviterValid&&s.valid:s.valid],quotaOf:[s.remaining+s.used],mintedCount:[s.used],previewMint:[(typeof args[0]==='bigint'?args[0]:1n)*s.price,(typeof args[0]==='bigint'?args[0]:1n)*10n**18n],priceOf:[s.price],balanceOf:[s.balance],allowance:[s.allowance]};
  assert.ok(out[name],name);return abi.encodeFunctionResult(p.fragment,out[name]);
 }};
 const identity=async(_,ca)=>({target:ca,fingerprint:ca.toLowerCase()===factory?(s.changed?'changed':'factory'):ca.toLowerCase()===hub?'hub':ca,implementation:ca.toLowerCase()===mint?impl:ca.toLowerCase()===token?tokenImpl:null,implementationCode:ca.toLowerCase()===mint?(s.implChanged?'0x00':code):tcode});
 const client=new BinanciansClient(rpc,{root,identity}),resolved={platform:'binancians',address:mint},intent={scope:'all',quantity:'max',maxBnb:'1',maxUsdt:'1',slippageBps:100,referral:'account1'};
 const plan=(i={},wallet=w)=>binanciansPlan(rpc,{...intent,...i},wallet,resolved,{client,wallets:[w,other]});return {root,row,s,rpc,client,intent,resolved,plan};
}
test('platform domain matching and CA hints never accept a lookalike host',()=>{
 for(const v of [`https://binanciansai.meme/project/${mint}?ref=${w.address}#mint`,`www.binanciansai.meme/project/${mint}/`,`BINANCIANSAI.MEME/project/${mint}`])assert.equal(binanciansInput(v).address,mint);
 for(const v of [`https://binanciansai.meme.evil.com/project/${mint}`,`https://evilbinanciansai.meme/project/${mint}`,`https://user@binanciansai.meme/project/${mint}`])assert.equal(binanciansInput(v),null);
 assert.equal(binanciansInput(token).explicit,false);
});
test('registered Mint and token CA resolve to same project and output token',async()=>{
 const f=fixture();for(const ca of [mint,token]){const d=await discoverBinancians(f.rpc,ca,{client:f.client});assert.equal(d.address,mint);assert.equal(d.token,token);assert.equal(d.name,'Fixture · 币安人 LaunchPad');}
 assert.equal(await f.client.locate(a(8)),null);await assert.rejects(f.client.locate(a(8),{explicit:true}),{code:'BINANCIANS_NOT_FOUND'});
});
test('changed factory, altered template and mismatched registration are rejected',async()=>{
 for(const flag of ['changed','implChanged','unregistered','wrongToken']){const f=fixture();f.s[flag]=true;await assert.rejects(f.client.locate(mint,{explicit:true}),/核验|匹配|登记/);}
});
test('ten shares encode correct four-argument mint, exact max cost, positive minimum and caller',async()=>{
 const f=fixture(),p=await f.plan(),args=M.decodeFunctionData('mint',p.steps[0].data);
 assert.equal(p.quantity,10);assert.equal(p.amountIn,String(10n*f.s.price));assert.deepEqual([...args],[10n,ZeroAddress,10n*f.s.price,9900000000000000000n]);assert.equal(p.outputToken,token);assert.equal(p.fill.continue,false);assert.equal(f.s.simulations,1);assert.equal(p.requireAssetCredit,true);
});
test('agent quota and public supply bound max; explicit excess never silently changes',async()=>{
 const f=fixture();f.s.remaining=23n;let p=await f.plan();assert.equal(p.quantity,10);assert.equal(p.fill.continue,true);
 f.s.minted=998n;p=await f.plan();assert.equal(p.quantity,2);assert.equal(p.fill.continue,false);
 await assert.rejects(f.plan({quantity:3}),{code:'NO_QUOTA'});
});
test('all max budget is computed from chain quotes, including multi-batch invitation quota',async()=>{
 const f=fixture();f.s.remaining=23n;const d=await inspectBinancians(f.rpc,f.resolved,[w,other],{client:f.client}),b=corlaBudget(d,[1,2],'all','MAX');
 assert.equal(b.maxBnb,'0.0253');assert.equal(b.total,'0.046');assert.equal(b.totalLimit,'0.0506');assert.equal(b.bufferBps,1000);assert.equal(b.costs[0].lots,23);assert.equal(d.referral.status,'ready');assert.ok(d.referral.url.endsWith('?ref='+w.address));
});
test('max and explicit totals must be fully affordable; never silently shrink a fill',async()=>{
 const f=fixture();await assert.rejects(f.plan({maxBnb:'0.003'}),{code:'BUDGET_LIMIT'});assert.equal(f.s.simulations,0);assert.equal((await f.plan({quantity:3,maxBnb:'0.003'})).quantity,3);
 await assert.rejects(f.plan({maxBnb:'0'}),{code:'BUDGET_LIMIT'});f.s.remaining=23n;await assert.rejects(f.plan({quantity:23,maxBnb:'0.02'}),{code:'BUDGET_LIMIT'});
});
test('fresh automatic budget follows a price increase before review; manual caps and project identity are preserved',async()=>{
 const f=fixture();f.s.price=3000000000000000n;const project=await inspectBinancians(f.rpc,f.resolved,[w,other],{client:f.client});
 const input={project,asset:mint,accounts:[1,2],scope:'all',quantity:'MAX'};assert.equal(corlaBudget(project,[1,2],'all','max').maxBnb,'0.033');
 f.s.price=3300000000000000n;f.s.block=43;
 const inspect=()=>inspectBinancians(f.rpc,f.resolved,[w,other],{client:f.client}),updated=await refreshMintBudget(input,inspect);
 assert.equal(updated.budget.maxBnb,'0.0363');assert.equal(updated.budget.total,'0.066');
 const p=await f.plan({maxBnb:updated.budget.maxBnb});assert.equal(p.quantity,10);assert.equal(p.amountIn,'33000000000000000');assert.equal(p.steps[0].value,p.amountIn);assert.equal(p.fill.targetQuantity,10);assert.equal(p.refreshQuoteBeforeExecute,true);
 assert.equal(await refreshMintBudget({...input,manual:true},()=>assert.fail('manual cap must not refresh')),null);
 await assert.rejects(refreshMintBudget(input,async()=>({...updated.project,token:a(8)})),/入口或到账代币/);
 f.s.price=3700000000000000n;f.s.block=44;await assert.rejects(f.plan({maxBnb:updated.budget.maxBnb}),{code:'BUDGET_LIMIT'});
});
test('native Gas is separately reserved for full fill without overpaying value or overriding wallet gas limit',async()=>{
 const f=fixture();f.s.balance=10n*f.s.price;
 await assert.rejects(f.plan(),{code:'GAS_BALANCE_LOW'});assert.equal(f.s.simulations,0);
 f.s.balance+=100000000000000n;const p=await f.plan();assert.equal(p.gasReserve.raw,'100000000000000');assert.equal(p.steps[0].value,String(10n*f.s.price));assert.equal(p.steps[0].gasLimit,undefined);
 f.s.remaining=23n;await assert.rejects(f.plan(),{code:'BUDGET_LIMIT'});
 f.s.balance=23n*f.s.price+300000000000000n;const multi=await f.plan();assert.equal(multi.gasReserve.raw,'300000000000000');assert.equal(multi.fill.targetCost,String(23n*f.s.price));
});
test('USDT fill gets its own budget cushion and requires native fees for approval',async()=>{
 const f=fixture();f.row.nativePayment=false;f.row.quote=USDT;
 const d=await inspectBinancians(f.rpc,f.resolved,[w],{client:f.client}),b=corlaBudget(d,[1],'paid','max');assert.equal(b.maxUsdt,'0.011');assert.equal(b.maxBnb,'0');
 f.s.nativeBalance=0n;await assert.rejects(f.plan({maxUsdt:b.maxUsdt}),{code:'GAS_BALANCE_LOW'});
 f.s.nativeBalance=100000000000000n;const p=await f.plan({maxUsdt:b.maxUsdt});assert.equal(p.gasReserve.coverage,'approval-only');assert.equal(p.steps[1].value,'0');assert.equal(p.steps[0].allowance,'10000000000000000');
});
test('multi-batch review displays full target and exact total separately from confirmed price cap',async()=>{
 const f=fixture();f.s.remaining=23n;const p=await f.plan(),o={status:'PREPARED',intent:{side:'mint',account:1,asset:mint,maxBnb:'0.0253'},plan:p};
 const summary=compactReviewGroups([o,{...o,intent:{...o.intent,account:2}}])[0].summary;
 assert.equal(summary.perWalletQuantity,23);assert.equal(summary.perWalletAmount,'0.023');assert.equal(summary.totalAmount,'0.046');assert.equal(summary.budgetCap,'0.0253');
});
test('a failed wallet quote does not clear the valid auto budget for its peers',async()=>{
 const f=fixture(),p=await inspectBinancians(f.rpc,f.resolved,[w,other],{client:f.client});p.quotas[0]={account:1,error:'fixture RPC unavailable',errorCode:'NETWORK_ERROR'};
 const b=corlaBudget(p,[1,2],'all','max');assert.equal(b.maxBnb,'0.011');assert.deepEqual(b.unavailable.map(q=>q.account),[1]);assert.equal(b.costs[0].account,2);
});
test('no free quota, ended, paused, no Agent ID and exhausted are distinct terminal reasons',async()=>{
 await assert.rejects(fixture().plan({scope:'free',maxBnb:'0'}),{code:'NO_FREE_MINT'});
 for(const [flag,value,code] of [['refunding',true,'MINT_ENDED'],['paused',true,'MINT_PAUSED'],['valid',false,'MINT_INELIGIBLE'],['remaining',0n,'NO_QUOTA']]){const f=fixture();f.s[flag]=value;await assert.rejects(f.plan(),{code});assert.equal(f.s.simulations,0);}
});
test('opening liquidity does not end this platform Mint; fresh quote and quota still apply',async()=>{const f=fixture();f.s.opened=true;const p=await f.plan();assert.equal(p.quantity,10);assert.equal(p.quota.stateLabel,'已开盘 · 仍可 Mint');});
test('USDT exact approval, no BNB value, balances and explicit budget respected',async()=>{
 const f=fixture();f.row.nativePayment=false;f.row.quote=USDT;const p=await f.plan();assert.equal(p.steps[0].kind,'approve');assert.equal(p.steps[0].spender,mint);assert.equal(p.steps[0].allowance,p.amountIn);assert.equal(p.steps[1].value,'0');assert.equal(p.inputToken,USDT);assert.equal(f.s.simulations,0);
 await assert.rejects(f.plan({maxUsdt:'0',maxBnb:'99'}),{code:'BUDGET_LIMIT'});f.s.balance=0n;await assert.rejects(f.plan(),{code:'BUDGET_LIMIT'});
});
test('wallet 2 uses wallet 1 referral; invalid inviter blocks unless expressly disabled',async()=>{
 const f=fixture();const opts={client:f.client,wallets:[w,other],officialPreview:true};let p=await binanciansPlan(f.rpc,f.intent,other,f.resolved,opts);assert.equal(M.decodeFunctionData('mint',p.steps[0].data)[1],w.address);
 f.s.inviterValid=false;await assert.rejects(binanciansPlan(f.rpc,f.intent,other,f.resolved,opts),{code:'REFERRAL_UNAVAILABLE'});p=await binanciansPlan(f.rpc,{...f.intent,referral:'none'},other,f.resolved,opts);assert.equal(M.decodeFunctionData('mint',p.steps[0].data)[1],ZeroAddress);
});
test('official preview remains mandatory and rejects missing credit or extra spend',async()=>{
 const f=fixture(),p=await f.plan(),step=p.steps[0],preview={requestId:'synthetic',simulationResult:{simulationCode:'000000000',balanceChanges:[{owner:w.address,contractAddress:token,tokenType:'Erc20',change:p.minOutput}]}};
 assert.doesNotThrow(()=>verifyPreview(preview,p,step));assert.throws(()=>verifyPreview({...preview,simulationResult:{...preview.simulationResult,balanceChanges:[]}},p,step),/到账/);
 preview.simulationResult.balanceChanges.push({owner:w.address,contractAddress:BNB,change:'-'+(BigInt(p.amountIn)+1n)});assert.throws(()=>verifyPreview(preview,p,step),/支出/);
});
test('engine re-quotes within confirmed cap, freezes full target, resumes originals and releases partial wallets',async t=>{
 for(const scenario of ['normal','late-price','over-cap','pending','quota-race']){
  const f=fixture();f.s.remaining=23n;f.s.block=42;
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'binancians-engine-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
  const requests=new Map(),txs=new Map(),quantities=[],plans=[];let serial=0,waiting=scenario==='pending';
  const bridge={ready:async()=>{},call:async(account,args)=>{
   assert.equal(account,1);assert.equal(args[0],'contract-call');
   if(args[1]==='preview'){
    const tx={from:w.address,to:args[args.indexOf('--to')+1],input:args[args.indexOf('--inputData')+1],value:args[args.indexOf('--value')+1]},requestId=String(++serial),[n]=M.decodeFunctionData('mint',tx.input);requests.set(requestId,tx);
    return {requestId,simulationResult:{simulationCode:'000000000',balanceChanges:[{owner:w.address,contractAddress:token,tokenType:'Erc20',change:String(n*10n**18n)}]}};
   }
   assert.equal(args[1],'execute');const tx=requests.get(args[args.indexOf('--requestId')+1]),[n]=M.decodeFunctionData('mint',tx.input),h='0x'+String(++serial).padStart(64,'0');quantities.push(Number(n));
   f.s.used+=n;f.s.remaining-=n;f.s.minted+=n;f.s.block++;if(quantities.length===1)f.s.remaining=scenario==='quota-race'?0n:f.s.remaining+20n;
   txs.set(h,{tx,n});return {txHash:h};
  }};
  f.rpc.getTransaction=async h=>txs.get(h).tx;
  f.rpc.getTransactionReceipt=async h=>{const {tx,n}=txs.get(h);return waiting?null:{...tx,status:'0x1',logs:[{address:token,...TRANSFER.encodeEventLog(TRANSFER.getEvent('Transfer'),[ZeroAddress,w.address,n*10n**18n])}]};};
  const input={...f.intent,account:1,side:'mint',asset:mint,maxBnb:'0.0276'};
  // Protocol identity verification is covered above. This isolated engine test
  // uses only the synthetic bridge, receipts and in-memory state, never a wallet.
  const engine=new Engine({data,rpc:f.rpc,bridge,live:true,planFn:async i=>{plans.push(i);return {...await binanciansPlan(f.rpc,i,w,f.resolved,{client:f.client,wallets:[w,other],officialPreview:true}),identity:null,protocolIdentities:[],resolved:f.resolved};}});
  engine.observeContract=function(o,e){return Engine.prototype.observeContract.call(this,o,e,0);};
  const prepared=await engine.prepare(input,'synthetic-fill');assert.equal(prepared.status,'PREPARED');
  if(scenario==='late-price'||scenario==='over-cap'){f.s.price=scenario==='late-price'?1100000000000000n:1300000000000000n;f.s.block++;}
  let r=await engine.execute(prepared.id,{authorization:'synthetic test only',acknowledgeReview:true});
  if(scenario==='pending'){assert.equal(r.status,'PENDING');assert.deepEqual(quantities,[10]);waiting=false;r=await engine.follow(prepared.id);assert.equal(r.status,'READY_TO_CONTINUE');assert.deepEqual(quantities,[10]);r=await engine.execute(prepared.id,{authorization:'synthetic continue',acknowledgeReview:true});}
  if(scenario==='over-cap'){assert.equal(r.status,'BLOCKED');assert.equal(r.error.code,'BUDGET_LIMIT');assert.deepEqual(quantities,[]);}
  else if(scenario==='quota-race'){assert.equal(r.status,'PARTIAL');assert.equal(r.completedQuantity,10);assert.equal(r.error.code,'NO_QUOTA');assert.equal((await engine.reconcileAccount(1,'next-operation')).ready,true);}
  else{assert.equal(r.status,'CONFIRMED',JSON.stringify(r.error));assert.equal(r.targetQuantity,23);assert.equal(r.completedQuantity,23);assert.deepEqual(quantities,[10,10,3]);assert.equal(r.spent.bnb,String(23n*f.s.price));assert.deepEqual(plans.map(i=>i.quantity),['max',23,13,3]);}
  const calls=quantities.length;await engine.execute(prepared.id,{authorization:'duplicate synthetic'});assert.equal(quantities.length,calls);
 }
});
