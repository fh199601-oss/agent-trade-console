import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Interface,keccak256,ZeroAddress} from 'ethers';
import {CORLA,CORLA_FACTORY as F,CORLA_MINT as M,CorlaClient,corlaInput,discoverCorla,corlaPlan,corlaReceipt,corlaRefundReceipt,corlaClient} from '../lib/corla.mjs';
import {hash,ERC20,USDT,BNB,bindings} from '../lib/common.mjs';
import {IMPL_SLOT,BEACON_SLOT,discover} from '../lib/discovery.mjs';
import {verifyIdentity} from '../lib/mint.mjs';
import {verifyPreview,Engine} from '../lib/engine.mjs';
import {corlaProgress,corlaSummary} from '../public/corla-view.mjs';
const TRANSFER=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const addr=n=>'0x'+String(n).repeat(40),w={account:1,address:addr(1)},mint=addr(2),token=addr(3),factory=addr(4),impl=addr(5),fi=addr(6),key='0x'+'1'.repeat(64);
const intent={account:1,autoClaim:false,scope:'paid',quantity:'max',maxBnb:'1',maxUsdt:'1',referral:'account1'};
function fixture(){
 const code='0x363d3d373d3d3d363d73'+impl.slice(2)+'5af43d82803e903d91602b57fd5bf3',factoryCode='0x60016000f4',implCode='0x60006001',fiCode='0x60006002';
 const root={id:'corla-mint-factory',address:factory,version:'5',mintImplementation:impl,mintImplementationHash:keccak256(implCode),fingerprint:hash([keccak256(factoryCode),fi,keccak256(fiCode)])};
 const record={mint,creator:addr(7),expectedToken:token,mintSalt:key,launchSalt:key,configurationHash:key,createdAt:1n,fundingDeadline:1000n,totalLots:10n,pricePerLot:1000000000000000n};
 const params={terms:{totalLots:10n,pricePerLot:record.pricePerLot,maxMintsPerWallet:3,whitelistEnabled:false,whitelistDurationSeconds:0,whitelist:[]},launch:{name:'Independent fixture',symbol:'FIX',meta:'',totalSupply:1000n,salt:key,quoteToken:ZeroAddress,dexId:0,poolQuote:10n,poolToken:500n,buyTaxRate:0,sellTaxRate:0,taxDuration:0,antiFarmerDuration:0,feeConfigs:[],antiSniperMode:0,exemptWindow:0,exemptAddrs:[],creatorBuyQuote:0n,extensionID:key,extensionData:'0x',commissionReceiver:ZeroAddress},distribution:{target:0,strategy:mint,amount:500n,configData:'0x'}};
 const state={params,record,status:1n,minted:1n,used:0,agentOnly:false,eligible:true,white:true,claimable:0n,refundable:0n,locked:1n,refundVersion:1n,allowance:0n,balance:10n**18n,mapped:mint,index:1n,factoryChanged:false,implChanged:false,extra:false,calls:[],simulations:0};
 const rpc={verifyChain:async()=>{},getBlockNumber:async()=>42,getBalance:async()=>state.nativeBalance??10n**18n,
  getCode:async a=>a.toLowerCase()===factory?factoryCode:a.toLowerCase()===fi?(state.factoryChanged?'0x60006003':fiCode):a.toLowerCase()===mint?(state.beacon?'0x60006000f4':code):a.toLowerCase()===impl?(state.implChanged?'0x60006004':implCode):state.beacon&&a.toLowerCase()===addr(9)?'0x6000635c60da1b00':a.toLowerCase()===addr(8)?'0x6000600500':'0x',
  send:async(method,args)=>{if(method==='eth_call'&&state.beacon&&args[0].to.toLowerCase()===addr(9))return '0x'+impl.slice(2).padStart(64,'0');assert.equal(method,'eth_getStorageAt');return args[0].toLowerCase()===factory&&args[1]===IMPL_SLOT?'0x'+fi.slice(2).padStart(64,'0'):state.beacon&&args[0].toLowerCase()===mint&&args[1]===BEACON_SLOT?'0x'+addr(9).slice(2).padStart(64,'0'):'0x'+'0'.repeat(64);},
  call:async(tx,block)=>{
   if(state.beacon&&tx.to.toLowerCase()===addr(9))return '0x'+impl.slice(2).padStart(64,'0');
   const abi=tx.to.toLowerCase()===factory?F:tx.to.toLowerCase()===state.params.launch.quoteToken.toLowerCase()?ERC20:M,parsed=abi.parseTransaction(tx),n=parsed.name;state.calls.push(n);
   if(n==='mint'||n==='mintQuote'||n==='claim'||n==='refund'){if(state.simulationError)throw state.simulationError;state.simulations++;assert.equal(tx.from,w.address);return '0x';}
   const rows={mintImplementation:[impl],deploymentCount:[1n],deploymentIndexPlusOne:[state.index],deployment:[state.deploymentRecord||record],getDeployments:[[state.deploymentRecord||record]],mintForLaunchSalt:[state.mapped],expectedToken:[state.expectedToken??token],getCreationParams:[params],getMintState:[state.minted,state.status],getUserInfo:[state.used>0,state.claimable,state.refundable,state.didClaim??false,false,state.white],walletMintCount:[state.used],getAgentStatus:[state.agentOnly,state.eligible],lockedLaunchVersion:[state.locked],refundMintVersion:[state.refundVersion],token:[state.status===3n?token:ZeroAddress],balanceOf:[state.balance],allowance:[state.allowance],quoteTokenFor:[params.launch.quoteToken],decimals:[6],symbol:['TEST6']};
   assert.ok(rows[n],n);return abi.encodeFunctionResult(parsed.fragment,rows[n]);
  }};
 const client=new CorlaClient(rpc,{factories:[root]});return {rpc,client,state,root,row:{root,record}};
}
test('Corla input is exact-origin routing, accepts CA and scheme-less deep links, rejects ambiguity',()=>{
 assert.equal(corlaInput('flap.sh/apps/corla/mint/'+token+'?lang=zh').address,token);
 assert.equal(corlaInput(mint).explicit,false);assert.equal(corlaInput('https://flap.sh/apps/corla?lang=zh').address,null);
 for(const url of ['https://flap.sh.attacker.test/apps/corla/mint/'+token,'https://flap.sh@attacker.test/apps/corla','https://flap.sh:4430/apps/corla','https://evil-flap.sh/apps/corla','https://flap.sh.attacker/apps/corla'])assert.equal(corlaInput(url),null);
 assert.throws(()=>corlaInput('https://flap.sh/apps/corla/mint/invalid'),{code:'CORLA_LINK'});
});
test('Flap hints cover bare domains, subdomains, locale prefixes, share suffixes and hash routes without trusting lookalikes',()=>{
 const urls=[`www.flap.sh/apps/corla/mint/${token}/?lang=zh&ref=abc#mint`,`//flap.sh/zh/apps/corla/mint/${token}`,`HTTP://FLAP.SH/apps/corla/mint/${token}`,`https://app.flap.sh/zh-CN/apps/corla/mint/${token}/details?utm_source=x`,`https://flap.sh/#/apps/corla/mint/${token}`,`https://flap.sh/apps/corla?ca=${token}`,`https://www.flap.sh./bnb/${token}?lang=zh`];
 for(const url of urls){assert.equal(corlaInput(url).address,token,url);assert.equal(corlaInput(url).priority,true,url);assert.match(corlaProgress(url),/快速识别/,url);}
 const suffix='0x'+'a'.repeat(36)+'7777';assert.equal(corlaInput('  '+suffix+'  ').priority,true);assert.match(corlaProgress(suffix),/快速识别/);
 assert.throws(()=>corlaInput(`https://flap.sh/apps/corla?ca=${token}&mint=${mint}`),{code:'CORLA_LINK'});
 for(const value of [`https://flap.sh.evil.test/bnb/${token}`,`https://flap.sh@evil.test/bnb/${token}`,`https://evil-flap.sh/bnb/${token}`,`https://flap.sh:8443/bnb/${token}`])assert.equal(corlaInput(value),null);
});
test('7777 CA uses current registry before bytecode and does not wait on unrelated factories',async()=>{
 const {rpc,client,state,root}=fixture(),ca='0x'+'3'.repeat(36)+'7777';state.record.expectedToken=ca;state.expectedToken=ca;let oldReads=0;
 client.factories=[root,{...root,address:addr(9)}];const get=client.get.bind(client),getCode=rpc.getCode;
 client.get=(to,...args)=>{if(to===addr(9)){oldReads++;return new Promise(()=>{});}return get(to,...args);};
 rpc.getCode=async a=>{assert.notEqual(a.toLowerCase(),ca,'predicted token need not be deployed');return getCode(a);};
 const d=await discoverCorla(rpc,ca,{client});assert.equal(d.address,mint);assert.equal(d.platform,'corla');assert.equal(oldReads,0);
 const cold=fixture();cold.state.beacon=true;cold.client.factories=[cold.root,{...cold.root,address:addr(9)}];const read=cold.client.get.bind(cold.client);let release;
 const gate=new Promise(r=>release=r);cold.client.get=(to,...args)=>to===addr(9)?gate.then(()=>[0n]):read(to,...args);
 try{const found=await Promise.race([cold.client.locate(mint),new Promise((_,reject)=>setTimeout(()=>reject(Error('unrelated legacy blocked current match')),1000))]);assert.equal(found.record.mint,mint);}finally{release();}
});
test('ordinary Flap 7777 CA is never invented as Corla, and trade discovery keeps the token address',async()=>{
 const {client,rpc}=fixture(),ca='0x'+'a'.repeat(36)+'7777';assert.equal(await discoverCorla(rpc,ca,{client}),null);
 const resolved=await discover(ca,{rpc:{getCode:()=>assert.fail('trade must not resolve mint')},corlaRouting:false});assert.equal(resolved.address.toLowerCase(),ca);
});
test('locked engine planning avoids redundant eth_call, standalone and legacy planning retain it',async()=>{
 const {rpc,client,state}=fixture();await corlaPlan(rpc,intent,w,{address:mint},{client,officialPreview:true});assert.equal(state.simulations,0);
 await corlaPlan(rpc,intent,w,{address:mint},{client});assert.equal(state.simulations,1);
 state.locked=0n;await corlaPlan(rpc,intent,w,{address:mint},{client,officialPreview:true});assert.equal(state.simulations,2);
});
test('Corla chain reads overlap wallet preflight but official preview cannot bypass a failed guard',async t=>{
 for(const guardFails of [false,true]){
  const {rpc,client,state,root}=fixture(),shared=corlaClient(rpc);Object.assign(shared,{factories:[root],records:client.records,counts:client.counts});shared.remember(root,state.record);
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'corla-overlap-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));let release,observed,previews=0;
  const gate=new Promise(r=>release=r),readStarted=new Promise(r=>observed=r),call=rpc.call;rpc.call=async(...args)=>{if(args[0].data.startsWith(M.getFunction('getUserInfo').selector))observed();return call(...args);};
  const bridge={ready:async()=>{await gate;if(guardFails)throw Error('fixture disconnected');},call:async(a,args)=>{assert.equal(args[1],'preview');previews++;return {requestId:'fake-only',simulationResult:{simulationCode:'000000000',balanceChanges:[]}};}};
  const engine=new Engine({rpc,bridge,data,live:false}),work=engine.prepare({...intent,account:bindings()[0].account,side:'mint',asset:'flap.sh/apps/corla/mint/'+mint},'fixture-overlap');
  try{await Promise.race([readStarted,new Promise((_,reject)=>setTimeout(()=>reject(Error('chain reads wait behind wallet preflight')),1000))]);assert.equal(previews,0);}finally{release();}
  const result=await work;assert.equal(result.status,guardFails?'BLOCKED':'PREPARED');assert.equal(previews,guardFails?0:1);assert.equal(state.simulations,0);
 }
});
test('claim fast path skips discovery/creation terms but still verifies registry, current credit and official simulation',async t=>{
 const {rpc,client,state,root}=fixture(),shared=corlaClient(rpc);Object.assign(shared,{factories:[root],records:client.records,counts:client.counts});shared.remember(root,state.record);
 state.status=3n;state.claimable=123n;state.used=1;
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'corla-fast-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));let previews=0;
 const owner=bindings()[0].address,bridge={ready:async()=>{},call:async(a,args)=>{assert.equal(args[1],'preview');previews++;return {requestId:'fixture-only',simulationResult:{simulationCode:'000000000',balanceChanges:[{owner,contractAddress:token,tokenType:'Erc20',change:String(state.claimable)}]}};}};
 const engine=new Engine({rpc,bridge,data,live:false});await engine.warmCorlaClaim(mint);state.calls.length=0;
 const input={account:bindings()[0].account,asset:mint,side:'mint',routeId:'corla:claim',quantity:1,maxBnb:'0',scope:'free',autoClaim:false};
 const first=await engine.prepare(input,'first-claim');assert.equal(first.status,'PREPARED');assert.equal(first.plan.minOutput,'123');assert.equal(previews,1);assert.equal(state.calls.includes('getCreationParams'),false);assert.equal(state.simulations,0);
 state.claimable=50n;const second=await engine.prepare(input,'second-preview');assert.equal(second.plan.minOutput,'50');assert.equal(previews,2);
 const before=previews;state.index=0n;shared.records.clear();shared.counts.clear();shared.latest=async()=>[];
 const unknown=await engine.prepare({...input,asset:addr(9)},'unregistered');assert.equal(unknown.status,'BLOCKED');assert.equal(previews,before);
});
test('refund is explicit, zero-value, and needs exact wallet credit plus its own settlement proof',async()=>{
 for(const quote of [ZeroAddress,USDT]){
  const {rpc,client,state}=fixture();state.params.launch.quoteToken=quote;state.status=4n;state.refundable=100n;state.used=1;
  const p=await corlaPlan(rpc,{...intent,routeId:'corla:refund'},w,{address:mint},{client});assert.equal(p.steps.length,1);assert.equal(p.steps[0].value,'0');assert.equal(p.amountIn,'0');assert.equal(p.fill,undefined);
  const change={owner:w.address,contractAddress:quote,tokenType:quote===ZeroAddress?'Native':'Erc20',change:'100'},preview={requestId:'fake',simulationResult:{simulationCode:'000000000',balanceChanges:[change]}};
  assert.doesNotThrow(()=>verifyPreview(preview,p,p.steps[0]));assert.throws(()=>verifyPreview({...preview,simulationResult:{...preview.simulationResult,balanceChanges:[{...change,change:'99'}]}},p,p.steps[0]),/到账/);
  const event={address:mint,...M.encodeEventLog(M.getEvent('Refunded'),[w.address,100n])},transfer={address:quote,...TRANSFER.encodeEventLog(TRANSFER.getEvent('Transfer'),[mint,w.address,100n])},logs=quote===ZeroAddress?[event]:[event,transfer];
  assert.equal(corlaRefundReceipt({logs},p).amount,'100');for(const invalid of [[],[event,event],[{address:mint,...M.encodeEventLog(M.getEvent('Refunded'),[addr(9),100n])}]])assert.throws(()=>corlaRefundReceipt({logs:invalid},p),{code:'CORLA_RECEIPT'});
  const e=Object.create(Engine.prototype),step=p.steps[0],entry={step,plan:p,txHash:'fake'},order={plan:p,intent,status:'PENDING'};e.rpc={getTransactionReceipt:async()=>({from:w.address,to:mint,status:1,logs}),getTransaction:async()=>({from:w.address,to:mint,input:step.data,value:'0'})};await e.observeContract(order,entry,0);assert.equal(entry.status,'CONFIRMED');assert.equal(entry.settlement.kind,'refund');
  state.refundable=0n;await assert.rejects(corlaPlan(rpc,{...intent,routeId:'corla:refund'},w,{address:mint},{client}),{code:'NO_QUOTA'});
 }
});
test('Corla dispatch never falls back to webpage crawling or history replay on RPC failure',async()=>{
 const rpc={getCode:async()=>{throw Error('fixture RPC unavailable');}};
 await assert.rejects(discover('https://flap.sh/apps/corla/mint/'+mint,{rpc,chainFallback:true,learn:true,fetchText:()=>assert.fail('must not crawl'),sourceLoader:()=>assert.fail('must not load generic ABI'),chainLearner:{learn:()=>assert.fail('must not replay history')}}),/fixture RPC unavailable/);
});
test('new projects resolve from registry as token CA or mint CA, not generic/history inference',async()=>{
 const {rpc,client,state}=fixture();const d=await discoverCorla(rpc,'https://flap.sh/apps/corla/mint/'+token,{client});assert.equal(d.address,mint);assert.equal(d.token,token);assert.equal(d.fastPath,true);assert.equal(d.discovery.historySkipped,true);assert.equal(d.platform,'corla');assert.equal(d.name,'Independent fixture · Corla');
 const before=state.calls.length;assert.equal((await discoverCorla(rpc,mint,{client})).address,mint);assert.equal(state.calls.length,before,'warm immutable discovery requires no extra reads');
 const f=fixture();assert.equal((await discoverCorla(f.rpc,mint,{client:f.client})).address,mint);assert.equal(f.state.calls.includes('getDeployments'),false,'mint CA uses direct membership index');
});
test('platform homepage lists real project choices and never chooses one automatically',async()=>{
 const {rpc,client}=fixture(),d=await discoverCorla(rpc,'https://flap.sh/apps/corla',{client});assert.equal(d.address,null);assert.equal(d.needsSelection,true);assert.equal(d.candidates[0].address,mint);assert.match(d.candidates[0].source,/apps\/corla\/mint\//);
 assert.match(corlaProgress('https://flap.sh/apps/corla'),/Corla/);assert.equal(corlaProgress('https://flap.sh.attacker.test/apps/corla'),null);assert.match(corlaSummary({platform:'corla',quotas:[]}),/领取/);
});
test('beacon-proxy mint addresses take the same direct factory path and verify the beacon implementation',async()=>{
 const {rpc,client,state}=fixture();state.beacon=true;const d=await discoverCorla(rpc,mint,{client});assert.equal(d.address,mint);assert.equal(d.platform,'corla');assert.equal(state.calls.includes('getDeployments'),false);const proof=await client.verify(await client.locate(mint));assert.equal(proof.identity.beacon,addr(9));
 state.implChanged=true;await assert.rejects(verifyIdentity(rpc,proof.identity),/变化/);
});
test('factory upgrade, forged clone membership, resolver and expected-token mismatch fail closed',async()=>{
 for(const property of ['factoryChanged','implChanged','mapped','index']){const {client,state,row}=fixture();state[property]=property==='mapped'?addr(9):property==='index'?0n:true;await assert.rejects(client.verify(row),/Corla/);}
 const {client,state,row,rpc}=fixture();const proof=await client.verify(row);state.factoryChanged=true;await assert.rejects(verifyIdentity(rpc,proof.factoryIdentity),/变化/);
});
test('independent eligibility reads share immutable metadata but refresh wallet counters',async()=>{
 const {client,state,row}=fixture();const [a,b]=await Promise.all([client.state(row,w),client.state(row,w)]);assert.equal(a.info.paidRemaining,'3');assert.equal(b.info.freeRemaining,'0');assert.equal(state.calls.filter(x=>x==='getCreationParams').length,1);
 state.used=2;assert.equal((await client.state(row,w)).info.paidRemaining,'1');state.used=3;assert.equal((await client.state(row,w)).info.errorCode,'NO_QUOTA');
 for(const [change,code] of [[{used:0,status:3n},'MINT_ENDED'],[{status:1n,agentOnly:true,eligible:false},'MINT_INELIGIBLE'],[{agentOnly:false,white:false},'MINT_INELIGIBLE']]){Object.assign(state,change);assert.equal((await client.state(row,w)).info.errorCode,code);}
});
test('native paid mint constructs one exact-value subscription, honors budgets, and never needs immediate token credit',async()=>{
 const {rpc,client,state}=fixture(),d={platform:'corla',address:mint};const p=await corlaPlan(rpc,intent,w,d,{client});assert.equal(p.steps.length,1);assert.equal(p.steps[0].to,mint);assert.equal(p.steps[0].value,String(state.record.pricePerLot));assert.equal(p.quantity,1);assert.equal(p.fill.continue,true);assert.equal(p.fill.targetQuantity,3);assert.equal(p.expectedAsset,null);assert.equal(p.protocolIdentities.length,1);assert.equal(state.simulations,1);assert.equal(p.steps[0].data,M.encodeFunctionData('mint(bytes32[])',[[]]));
 const preview={requestId:'fixture-only',simulationResult:{simulationCode:'000000000',balanceChanges:[]}};assert.doesNotThrow(()=>verifyPreview(preview,p,p.steps[0]));
 for(const [change,code] of [[{scope:'free',maxBnb:'0'},'NO_FREE_MINT'],[{maxBnb:'0'},'BUDGET_LIMIT'],[{quantity:4},'NO_QUOTA'],[{quantity:3,maxBnb:'0.002'},'BUDGET_LIMIT'],[{routeId:'unrelated'},'MINT_ROUTE_INVALID']])await assert.rejects(corlaPlan(rpc,{...intent,...change},w,d,{client}),{code});
});
test('Corla auto claim is default, can be disabled, and never attaches to redemption',async()=>{
 const {rpc,client,state}=fixture();const input={...intent};delete input.autoClaim;
 const p=await corlaPlan(rpc,input,w,{address:mint},{client});assert.equal(p.afterMint.autoClaim,true);assert.equal(p.afterMint.sell,null);assert.match(p.review.join(' '),/自动领取/);
 const disabled=await corlaPlan(rpc,intent,w,{address:mint},{client});assert.equal(disabled.afterMint,null);
 state.status=3n;state.claimable=100n;const claim=await corlaPlan(rpc,{...input,routeId:'corla:claim'},w,{address:mint},{client});assert.equal(claim.afterMint,undefined);
});
test('USDT uses registered factory spender and resolver, previews approval only until confirmed',async()=>{
 const {rpc,client,state}=fixture();state.params.launch.quoteToken=USDT;const p=await corlaPlan(rpc,intent,w,{address:mint},{client});assert.equal(p.steps.length,2);assert.equal(p.steps[0].spender,factory);assert.equal(p.steps[0].allowance,String(state.record.pricePerLot*3n));assert.equal(p.steps[1].to,factory);assert.equal(p.steps[1].value,'0');assert.equal(F.decodeFunctionData('mintQuote',p.steps[1].data)[0],key);assert.equal(state.simulations,0);assert.equal(p.budgetCurrency,'USDT');
 state.allowance=state.record.pricePerLot;const ready=await corlaPlan(rpc,intent,w,{address:mint},{client});assert.equal(ready.steps.length,1);assert.equal(state.simulations,1);
});
test('refund-open support follows explicit version and other quote currencies require a token-bound budget',async()=>{
 const {rpc,client,state,row}=fixture();state.status=5n;assert.equal((await client.state(row,w)).info.available,true);state.refundVersion=0n;assert.equal((await client.state(row,w)).info.errorCode,'MINT_ENDED');
 const other=fixture();other.state.params.launch.quoteToken=addr(8);other.state.params.terms.pricePerLot=other.state.record.pricePerLot=1000n;await assert.rejects(corlaPlan(other.rpc,intent,w,{address:mint},{client:other.client}),{code:'BUDGET_LIMIT'});
 const input={...intent,side:'mint',asset:mint,quantity:2,maxQuote:'0.002',quoteToken:addr(8)};
 const p=await corlaPlan(other.rpc,input,w,{address:mint},{client:other.client});assert.equal(p.inputToken,addr(8));assert.equal(p.amountIn,'1000');assert.equal(p.budgetDecimals,6);assert.equal(p.budgetCurrency,'QUOTE');assert.equal(p.quota.unitPrice.formatted,'0.001');assert.equal(p.fill.continue,true);
 await assert.rejects(corlaPlan(other.rpc,{...input,quoteToken:addr(9)},w,{address:mint},{client:other.client}),{code:'BUDGET_LIMIT'});
 other.state.allowance=1n;const reset=await corlaPlan(other.rpc,input,w,{address:mint},{client:other.client});assert.equal(reset.steps.length,3);assert.equal(reset.steps[0].allowance,'0');assert.equal(reset.steps[1].allowance,'2000');
});
test('claim is a separate explicit action and requires exact token credit',async()=>{
 const {rpc,client,state}=fixture();state.status=3n;state.claimable=100n;const p=await corlaPlan(rpc,{...intent,scope:'free',routeId:'corla:claim'},w,{address:mint},{client});assert.equal(p.amountIn,'0');assert.equal(p.steps[0].data,M.encodeFunctionData('claim'));assert.equal(p.expectedAsset.amount,'100');assert.equal(p.requireAssetCredit,true);assert.equal(p.subscription,undefined);
 assert.throws(()=>verifyPreview({requestId:'fake',simulationResult:{simulationCode:'000000000',balanceChanges:[]}},p,p.steps[0]),/到账/);
});
test('receipt confirms subscription by unique account-bound event, rejecting unrelated or duplicate logs',async()=>{
 const {rpc,client}=fixture();const plan=await corlaPlan(rpc,intent,w,{address:mint},{client}),event=M.encodeEventLog(M.getEvent('Minted'),[w.address,2n]);const receipt={logs:[{address:mint,...event}]};assert.deepEqual(corlaReceipt(receipt,plan),{kind:'subscription',lots:'1',globalMintedLots:'2',assetPendingClaim:true});
 for(const logs of [[],[...receipt.logs,...receipt.logs],[{...receipt.logs[0],address:token}],[{address:mint,...M.encodeEventLog(M.getEvent('Minted'),[addr(9),2n])}]])assert.throws(()=>corlaReceipt({logs},plan),{code:'CORLA_RECEIPT'});
 // Exercise the actual engine settlement branch without any wallet or disk I/O.
 const step=plan.steps[0],entry={step,plan,txHash:'0x'+'a'.repeat(64)},order={plan,intent,status:'PENDING'};
 const engine=Object.create(Engine.prototype);engine.rpc={getTransactionReceipt:async()=>({...receipt,from:w.address,to:step.to,status:'0x1'}),getTransaction:async()=>({from:w.address,to:step.to,input:step.data,value:step.value})};
 await engine.observeContract(order,entry,0);assert.equal(entry.status,'CONFIRMED');assert.equal(entry.settlement.assetPendingClaim,true);
});
test('max fill uses remaining six-decimal quote budget and resumes the original pending lot exactly once',async t=>{
 for(const {deferred,lots,rejectNext} of [{deferred:false,lots:2},{deferred:true,lots:2},{deferred:false,lots:55},{deferred:false,lots:2,rejectNext:true}]){
  const {rpc,client,state}=fixture();state.params.launch.quoteToken=addr(8);state.params.terms.pricePerLot=state.record.pricePerLot=1000n;if(lots>3){state.params.terms.totalLots=state.record.totalLots=100n;state.params.terms.maxMintsPerWallet=lots;}
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'corla-fake-engine-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
  let n=0,submits=0,mints=0,waiting=deferred;const requests=new Map(),txs=new Map(),budgets=[];
  const bridge={ready:async()=>{},call:async(account,args)=>{
   assert.equal(account,1);assert.equal(args[0],'contract-call');
   if(args[1]==='preview'){if(rejectNext&&mints>0)throw Error('fixture next-lot preview refused');const requestId=String(++n),tx={from:w.address,to:args[args.indexOf('--to')+1],input:args[args.indexOf('--inputData')+1],value:args[args.indexOf('--value')+1]};requests.set(requestId,tx);return {requestId,simulationResult:{simulationCode:'000000000',balanceChanges:[]}};}
   assert.equal(args[1],'execute');const tx=requests.get(args[args.indexOf('--requestId')+1]),h='0x'+String(++submits).padStart(64,'0');let logs=[];
   if(tx.to.toLowerCase()===addr(8)){state.allowance=ERC20.decodeFunctionData('approve',tx.input)[1];}
   else {assert.equal(F.parseTransaction({data:tx.input}).name,'mintQuote');state.used++;state.minted++;mints++;state.allowance-=1000n;state.balance-=1000n;logs=[{address:mint,...M.encodeEventLog(M.getEvent('Minted'),[w.address,state.minted])}];}
   txs.set(h,{tx,logs});return {txHash:h};
  }};
  rpc.getTransaction=async h=>txs.get(h).tx;rpc.getTransactionReceipt=async h=>{const {tx,logs}=txs.get(h);return waiting&&logs.length?null:{...tx,status:'0x1',logs};};
  const input={...intent,side:'mint',asset:mint,maxBnb:'0',maxUsdt:'0',maxQuote:(lots/1000).toFixed(3),quoteToken:addr(8)};
  const engine=new Engine({rpc,bridge,data,live:true,planFn:async i=>{budgets.push(i.maxQuote);return corlaPlan(rpc,i,w,{address:mint},{client});}});
  // Fake bridge only; the real observer runs with zero wait and synthetic receipts.
  engine.observeContract=function(o,e){return Engine.prototype.observeContract.call(this,o,e,0);};
  const p=await engine.plan(input);engine.write({id:'fixture-max',intent:input,plan:p,status:'PREPARED',createdAt:Date.now(),timing:{preparedAt:Date.now()},steps:[]});
  let r=await engine.execute('fixture-max',{authorization:'synthetic fixture',acknowledgeReview:true});
  if(deferred){assert.equal(r.status,'PENDING');assert.equal(mints,1);waiting=false;const before=submits;r=await engine.follow('fixture-max');assert.equal(r.status,'READY_TO_CONTINUE');assert.equal(submits,before);r=await engine.execute('fixture-max',{authorization:'synthetic fixture',acknowledgeReview:true});}
  if(rejectNext){assert.equal(r.status,'PARTIAL');assert.equal(r.completedQuantity,1);assert.equal(r.spent.quote,'1000');assert.equal(mints,1);assert.equal((await engine.reconcileAccount(1,'new-explicit-operation')).ready,true);const before=submits;await engine.execute('fixture-max',{authorization:'duplicate'});assert.equal(submits,before);continue;}
  assert.equal(r.status,'CONFIRMED',JSON.stringify(r.error));assert.equal(r.completedQuantity,lots);assert.equal(r.spent.quote,String(lots*1000));assert.equal(r.spent.bnb,'0');assert.equal(mints,lots);assert.equal(submits,lots+1,'one exact batch allowance, then one call per lot');assert.equal(budgets.length,lots);assert.equal(budgets[0],input.maxQuote);assert.equal(budgets.at(-1),'0.001');const before=submits;await engine.execute('fixture-max',{authorization:'duplicate'});await engine.follow('fixture-max');assert.equal(submits,before);
 }
});

test('simulation distinguishes stale quota, phase, eligibility and insufficient funds',async()=>{for(const [error,code] of [[Object.assign(Error('insufficient funds for gas * price + value'),{code:-32000}),'BUDGET_LIMIT'],...[['AlreadyMinted','NO_QUOTA'],['WrongPhase','MINT_ENDED'],['NotWhitelisted','MINT_INELIGIBLE']].map(([name,code])=>[Object.assign(Error('execution reverted'),{data:M.encodeErrorResult(name,[])}),code])]){const {rpc,client,state}=fixture();state.simulationError=error;await assert.rejects(corlaPlan(rpc,intent,w,{address:mint},{client}),{code});}});

test('max quantity respects current native balance and exact requested quantity cannot exceed it',async()=>{const {rpc,client,state}=fixture();state.nativeBalance=1500000000000000n;const p=await corlaPlan(rpc,intent,w,{address:mint},{client});assert.equal(p.fill.targetQuantity,1);assert.equal(p.fill.continue,false);await assert.rejects(corlaPlan(rpc,{...intent,quantity:2},w,{address:mint},{client}),{code:'BUDGET_LIMIT'});state.nativeBalance=0n;await assert.rejects(corlaPlan(rpc,intent,w,{address:mint},{client}),{code:'BUDGET_LIMIT'});});
test('an occupied cached launch candidate is refreshed only for a read-only simulation',async()=>{const {rpc,client,state}=fixture();let mines=0,tries=0;const alternate='0x'+'a'.repeat(64);client.salts=async()=>[++mines===1?key:alternate];const call=rpc.call;rpc.call=async(tx,block)=>{if(tx.data.startsWith(M.getFunction('mint(bytes32[])').selector)&&tries++===0)throw Object.assign(Error('revert'),{data:M.encodeErrorResult('NoAvailableLaunchSalt',[])});return call(tx,block);};const p=await corlaPlan(rpc,intent,w,{address:mint},{client});assert.equal(mines,2);assert.deepEqual([...M.decodeFunctionData('mint(bytes32[])',p.steps[0].data)[0]],[alternate]);assert.equal(state.simulations,1);});

test('legacy launch updates a zero token entry without changing factory identity or rescanning transaction history',async()=>{
 const {rpc,client,state,row,root}=fixture();state.record.expectedToken=ZeroAddress;state.expectedToken=ZeroAddress;
 const initial=await discoverCorla(rpc,mint,{client});assert.equal(initial.token,null);client.counts.set(root.address,1n);
 state.expectedToken=token;state.deploymentRecord={...state.record,expectedToken:token};state.status=3n;state.minted=10n;state.used=1;state.claimable=100n;
 const found=await client.locate(token,{explicit:true});assert.equal(found.record.mint,mint);assert.equal(found.record.expectedToken,token);
 const d=await client.describe(found);assert.equal(d.token,token);const claim=await corlaPlan(rpc,{...intent,routeId:'corla:claim'},w,d,{client});assert.equal(claim.outputToken,token);assert.equal(claim.expectedAsset.amount,'100');
 const forged=fixture();forged.state.record.expectedToken=ZeroAddress;forged.state.expectedToken=token;forged.state.deploymentRecord={...forged.state.record,expectedToken:token,pricePerLot:1n};await assert.rejects(forged.client.verify(forged.row),{code:'CORLA_NOT_VERIFIED'});
});

test('live state reads begin during immutable terms verification, but failed terms still block',async()=>{
 const {client,state,row}=fixture();let release;client.terms=()=>new Promise((_,reject)=>release=()=>reject(Error('changed terms')));
 const p=client.state(row,w);await new Promise(r=>setImmediate(r));assert.ok(state.calls.includes('getUserInfo'));release();await assert.rejects(p,/changed terms/);
});
test('claim uses three block-pinned state reads without payment or mint qualification queries',async()=>{
 const {rpc,client,state}=fixture();state.status=3n;state.claimable=100n;state.params.launch.quoteToken=addr(8);state.white=false;state.eligible=false;
 const p=await corlaPlan(rpc,{...intent,routeId:'corla:claim'},w,{address:mint},{client,officialPreview:true});
 assert.equal(p.minOutput,'100');assert.equal(state.simulations,0);for(const name of ['walletMintCount','getAgentStatus','lockedLaunchVersion','refundMintVersion','getCreationParams','balanceOf','allowance','decimals'])assert.equal(state.calls.includes(name),false,name);
 assert.throws(()=>verifyPreview({requestId:'fake',simulationResult:{simulationCode:'000000000',balanceChanges:[]}},p,p.steps[0]),/到账/);
 const change={owner:w.address,contractAddress:token,tokenType:'Erc20',change:'100'};assert.doesNotThrow(()=>verifyPreview({requestId:'fake',simulationResult:{simulationCode:'000000000',balanceChanges:[change]}},p,p.steps[0]));
 await corlaPlan(rpc,{...intent,routeId:'corla:claim'},w,{address:mint},{client});assert.equal(state.simulations,1);
 state.claimable=0n;await assert.rejects(corlaPlan(rpc,{...intent,routeId:'corla:claim'},w,{address:mint},{client,officialPreview:true}),{code:'NO_QUOTA'});
});
test('claim original-transaction and receipt reads overlap; no sale proof without exact credit',async()=>{
 const {rpc,client,state}=fixture();state.status=3n;state.claimable=100n;
 const p=await corlaPlan(rpc,{...intent,routeId:'corla:claim'},w,{address:mint},{client}),engine=Object.create(Engine.prototype),step=p.steps[0];let txRead=false,release;
 const gate=new Promise(r=>release=r);engine.rpc={getTransaction:async()=>{txRead=true;await gate;return {from:w.address,to:mint,input:step.data,value:'0'};},getTransactionReceipt:async()=>{assert.equal(txRead,true);release();return {from:w.address,to:mint,status:1,logs:[{address:token,...TRANSFER.encodeEventLog(TRANSFER.getEvent('Transfer'),[mint,w.address,100n])}]};}};
 const entry={step,txHash:'fixture-hash'},order={plan:p,intent,status:'PENDING'};await engine.observeContract(order,entry,0);assert.equal(entry.received,'100');assert.equal(entry.status,'CONFIRMED');
 engine.rpc.getTransactionReceipt=async()=>({from:w.address,to:mint,status:1,logs:[]});const bad={step,txHash:'fixture-hash'};await engine.observeContract(order,bad,0);assert.equal(bad.status,'RECEIPT_REVIEW');
});
test('claim diagnostics distinguish unopened, refund phase, already claimed and no allocation without any simulation or send',async()=>{
 for(const [patch,code,reason] of [[{status:1n},'CORLA_CLAIM_NOT_OPEN'],[{status:4n},'CORLA_REFUND_ONLY'],[{status:3n,didClaim:true},'CORLA_ALREADY_CLAIMED'],[{status:3n},'NO_QUOTA','no-allocation'],[{status:3n,used:1},'NO_QUOTA','empty']]){
  const {client,state,row}=fixture();Object.assign(state,patch);await assert.rejects(client.claimState(row,w),e=>{assert.equal(e.code,code);if(reason)assert.equal(e.details.reason,reason);return true;});assert.equal(state.simulations,0);
 }
});
