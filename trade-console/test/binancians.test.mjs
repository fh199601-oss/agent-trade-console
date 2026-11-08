import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256} from 'ethers';
import {BINANCIANS,BINANCIANS_FACTORY as F,BINANCIANS_MINT as M,BinanciansClient,discoverBinancians,inspectBinancians,binanciansPlan} from '../lib/binancians.mjs';
import {Interface,ERC20,BNB,USDT,ZeroAddress} from '../lib/common.mjs';
import {binanciansInput} from '../public/binancians-input.mjs';
import {corlaBudget} from '../public/corla-budget.mjs';
import {verifyPreview} from '../lib/engine.mjs';
const a=n=>'0x'+String(n).repeat(40),mint=a(2),token=a(3),w={account:1,address:a(1)},other={account:2,address:a(9)},impl=a(5),tokenImpl=a(6),factory=a(4),hub=a(7),code='0x60006001',tcode='0x60006002',clone=x=>'0x363d3d373d3d3d363d73'+x.slice(2)+'5af43d82803e903d91602b57fd5bf3';
function fixture(){
 const root={...BINANCIANS,factory,hub,mintTemplate:impl,tokenTemplate:tokenImpl,mintHash:keccak256(code),tokenHash:keccak256(tcode),factoryFingerprint:'factory',hubFingerprint:'hub'};
 const row={mint,token,pair:a(8),creator:a(8),treasury:a(8),quote:root.wrappedNative,nativePayment:true,createdAt:1n,name:'Fixture',symbol:'FIX',logoURI:'',description:''};
 const s={remaining:10n,used:0n,minted:100n,total:1000n,perTx:10n,valid:true,inviterValid:true,opened:false,paused:false,refunding:false,allowance:0n,balance:10n**20n,calls:[],simulations:0,price:10n**15n};
 const T=new Interface(['function minter() view returns(address)','function factory() view returns(address)']);
 const rpc={verifyChain:async()=>{},getBlockNumber:async()=>42,getBalance:async()=>s.balance,getCode:async ca=>ca.toLowerCase()===mint?clone(impl):ca.toLowerCase()===token?clone(tokenImpl):'0x',call:async(tx,b)=>{
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
 assert.equal(b.maxBnb,'0.023');assert.equal(b.total,'0.046');assert.equal(b.costs[0].lots,23);assert.equal(d.referral.status,'ready');assert.ok(d.referral.url.endsWith('?ref='+w.address));
});
test('BNB budget caps current batch; explicit totals must be fully affordable',async()=>{
 const f=fixture();assert.equal((await f.plan({maxBnb:'0.003'})).quantity,3);assert.equal((await f.plan({maxBnb:'0.003'})).fill.continue,false);
 await assert.rejects(f.plan({maxBnb:'0'}),{code:'BUDGET_LIMIT'});f.s.remaining=23n;await assert.rejects(f.plan({quantity:23,maxBnb:'0.02'}),{code:'BUDGET_LIMIT'});
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
