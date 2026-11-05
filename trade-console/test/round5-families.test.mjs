import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {Interface} from 'ethers';
import {recognizeSourceSale,sourceSaleState,sourceSalePlan} from '../lib/source-sale.mjs';
import {walletParameterPrograms,evaluateWalletProgram} from '../lib/source-values.mjs';
import {recognizeMint,adaptiveQuote} from '../lib/adaptive-mint.mjs';
import {recognizeProtectedSale,protectedSaleState,protectedSalePlan} from '../lib/protected-sale.mjs';
import {unavailableMintState} from '../lib/source-constraints.mjs';
import {USDT,ERC20,wallet} from '../lib/common.mjs';
import {chainSeeds} from '../lib/chain-learning.mjs';
import {assistMint} from '../lib/chain-assist.mjs';
import {recognizeSpecialMint} from '../lib/special-mint.mjs';
import {mintError} from '../lib/mint-errors.mjs';
import {failureKind} from '../public/failure-kind.mjs';
const fixtures=JSON.parse(fs.readFileSync(new URL('./fixtures/round5-families.json',import.meta.url))),w=wallet(1),T='0x'+'3'.repeat(40),R='0x'+'4'.repeat(40),unit=10000n*10n**18n;
const edit=(meta,from,to)=>{const m=structuredClone(meta);let changed=false;for(const s of Object.values(m.sources)){if(s.content.includes(from))changed=true;s.content=s.content.replace(from,to);}assert.ok(changed,from);return m;};
function rpcFor(m,values){const abi=new Interface(m.abi),calls=[];return {calls,getBlockNumber:async()=>100,send:async(method)=>{assert.equal(method,'eth_getBlockByNumber');return {timestamp:'0x3e8'};},call:async(tx,block)=>{assert.equal(block,100);calls.push(tx);const i=tx.to.toLowerCase()===m.address.toLowerCase()?abi:ERC20,f=i.parseTransaction(tx);const value=values[f.name];assert.notEqual(value,undefined,f.name);const v=typeof value==='function'?value(f.args,tx):value;return i.encodeFunctionResult(f.fragment,f.fragment.outputs.length===1?[v]:v);}};}
test('native inventory sale infers internal wrapper, arbitrary field names, quantity limits and referral variant',async()=>{
 const m=fixtures['onlyaitoken.pages.dev'],p=recognizeSourceSale(m);assert.equal(p.kind,'source-native-sale');assert.equal(p.method,'buy(uint256,address)');assert.deepEqual(p.caps.map(c=>c.scope),['wallet','global']);
 const r=rpcFor(m,{token:T,PACK_TOKENS:unit,PACK_PRICE:500n,maxPacksFor:10n,packsBoughtBy:2n,SALE_CAP:20n*unit,totalSold:17n*unit,saleOpen:true,saleClosed:false,SALE_ENDS_AT:2000n,agentIdRegistry:R,balanceOf:(a,tx)=>tx.to===R?1n:100n*unit,decimals:18n,buy:[]});
 const intent={account:1,scope:'paid',quantity:'max',maxBnb:'0.001',referral:'account1'},s=await sourceSaleState(r,intent,m,w);assert.equal(s.paid,3n);
 const plan=await sourceSalePlan(r,intent,m,w,{});assert.equal(plan.quantity,3);assert.equal(plan.amountIn,'1500');assert.equal(plan.minOutput,String(unit*3n));assert.equal(plan.requireAssetCredit,true);
 await assert.rejects(sourceSalePlan(r,{...intent,scope:'free'},m,w,{}),e=>e.code==='NO_FREE_MINT');
 let text=JSON.stringify(m);['buy','_buy','packs','PACK_PRICE','packsBoughtBy','maxPacksFor','PACK_TOKENS'].forEach((n,i)=>text=text.replace(new RegExp('\\b'+n+'\\b','g'),'item'+i));const renamed=JSON.parse(text),abi=new Interface(renamed.abi);renamed.runtimeCode='0x'+abi.fragments.filter(f=>f.type==='function').map(f=>'63'+f.selector.slice(2)+'1461000057').join('')+'00';assert.equal(recognizeSourceSale(renamed)?.kind,'source-native-sale');
 assert.equal(recognizeSourceSale(edit(m,'token.safeTransfer(msg.sender, tokens)','token.safeTransfer(treasury, tokens)')),null);
 const unresolved=edit(m,'_buy(packs, referrer);','_buy(packs, treasury);');assert.equal(recognizeSourceSale(unresolved).roles.includes('zero'),false);
 await assert.rejects(sourceSalePlan(r,{...intent,account:2},unresolved,w,{}),e=>e.code==='REFERRAL_NOT_VERIFIED');
});
test('private view wallet answer is recomputed, local bounded arithmetic cannot execute external code or mutate storage',async()=>{
 const m=fixtures['syntaxsouls.surge.sh'],abi=new Interface(m.abi),program=walletParameterPrograms(m,abi.getFunction('mint'))[0];assert.ok(program);
 let reads=0;for(const [a,b,n,mod]of [[11n,17n,7n,3n],[21n,32n,11n,4n]]){const v=await evaluateWalletProgram(program,abi,w.address,async(method,args)=>{reads++;assert.equal(method,'puzzleParams(address)');assert.equal(args[0],w.address);return [a,b,n,mod];});assert.equal(v,((n/mod)*a*2n+(n-n/mod)*b)%1000n);}assert.equal(reads,2);
 await assert.rejects(evaluateWalletProgram(program,abi,w.address,async()=>[11n,17n,1000n,3n]),/256/);
 const changed=edit(m,'r %= 1000;','_nonce = r; r %= 1000;');assert.deepEqual(walletParameterPrograms(changed,abi.getFunction('mint')),{});
 const changedParam=edit(m,'if (answer != _answer(msg.sender))','answer = 123; if (answer != _answer(msg.sender))');assert.deepEqual(walletParameterPrograms(changedParam,abi.getFunction('mint')),{});
});
test('source-derived native fee aliases work without known quote names and do not guess payment',()=>{
 const m=fixtures['syntaxsouls.surge.sh'],route=recognizeMint(m).routes[0];assert.deepEqual(route.roles,['computed:0']);assert.ok(route.units.includes('mintPriceWei()'));const renamed=JSON.parse(JSON.stringify(m).replace(/\bmintPriceWei\b/g,'entryChargeToday'));assert.ok(recognizeMint(renamed).routes[0].units.includes('entryChargeToday()'));
});
test('protected families reject reordered arguments and credit to a different token',()=>{
 for(const host of ['computeroll.com','biubiubiu.space']){const m=fixtures[host];assert.ok(recognizeProtectedSale(m));assert.equal(recognizeProtectedSale({...m,verified:false}),null);assert.equal(recognizeProtectedSale({...m,proxy:true}),null);const bad=structuredClone(m),f=bad.abi.find(f=>f.type==='function'&&f.name===(host==='computeroll.com'?'mint':'mintWithReferral'));[f.inputs[0].name,f.inputs.at(-1).name]=[f.inputs.at(-1).name,f.inputs[0].name];assert.equal(recognizeProtectedSale(bad),null);}
});
test('buyback sale splits cold boundary, sets exact payment and bounded nonzero live minimum, approval is not mint',async()=>{
 const m=fixtures['computeroll.com'];let sold=8n,allowed=true,allowance=0n;
 const values={usdt:USDT,token:T,failed:false,launched:()=>sold>=10n,startsAt:500n,endsAt:2000n,hasAgentId:true,WALLET_LIMIT:20n,mintedShares:0n,TOTAL_SHARES:100n,sold:()=>sold,COLD_SHARES:10n,TOKENS_PER_SHARE:1000n,UNIT_USDT:100n,quoteMint:a=>[100n*a[0],sold<10n?a[0]:0n,sold>=10n?a[0]:0n],buybackQuote:()=>[1000n,allowed],balanceOf:100000n,allowance:()=>allowance,mint:[]};const r=rpcFor(m,values),i={account:1,scope:'paid',quantity:'max',maxUsdt:'1',slippageBps:2000,referral:'none'};
 let s=await protectedSaleState(r,i,m,w);assert.equal(s.txCap,2n);let p=await protectedSalePlan(r,i,m,w,{});assert.equal(p.quantity,2);assert.deepEqual(p.steps.map(x=>x.kind),['approve','mint']);assert.equal(p.steps[0].allowance,'200');let args=new Interface(m.abi).parseTransaction(p.steps[1]).args;assert.deepEqual(Array.from(args),[2n,200n,0n,1090n]);assert.equal(r.calls.filter(t=>t.data.startsWith(new Interface(m.abi).getFunction('mint').selector)).length,0);
 sold=11n;allowance=100000n;p=await protectedSalePlan(r,{...i,quantity:1},m,w,{});args=new Interface(m.abi).parseTransaction(p.steps[0]).args;assert.equal(args[2],920n);assert.equal(args[1],100n);assert.equal(p.requireAssetCredit,true);
 allowed=false;await assert.rejects(protectedSalePlan(r,i,m,w,{}),e=>e.code==='MINT_STATE');
});
test('tuple sale uses current quote amounts, wallet invitation and explicit budget caps',async()=>{
 const m=fixtures['biubiubiu.space'],r=rpcFor(m,{quote:USDT,token:T,mintClosed:false,aborted:false,remainingFor:5n,MAX_BATCH:3n,MAX_SHARES:100n,soldShares:1n,previewMintFor:a=>[100n*a[1],1000n*a[1],1000n*a[1],a[1],false],balanceOf:10000n,allowance:0n}),i={account:2,scope:'paid',quantity:2,maxUsdt:'1',slippageBps:100,referral:'account1'};
 const p=await protectedSalePlan(r,i,m,w,{}),args=new Interface(m.abi).parseTransaction(p.steps.at(-1)).args;assert.deepEqual(Array.from(args),[2n,wallet(1).address,200n,1980n,1090n]);await assert.rejects(protectedSalePlan(r,{...i,maxUsdt:'0'},m,w,{}),e=>e.code==='BUDGET_LIMIT');await assert.rejects(protectedSalePlan(r,{...i,scope:'free'},m,w,{}),e=>e.code==='NO_FREE_MINT');
});
test('ended source constraints traverse view guards but cannot hide another open lane',async()=>{
 const m=fixtures['moomoo.cloud'],r=rpcFor(m,{startTime:10n,endTime:999n,genesisMinted:1n,maxSupply:10000n});const state=await unavailableMintState(r,m);assert.equal(state.code,'MINT_ENDED');assert.equal(state.details.evidence.length,2);
 const changed=edit(m,'_gate(agentTokenId);','');assert.equal(await unavailableMintState(r,changed),null);
});
test('public DEX factory and router never crowd out project contract history',()=>{const seeds=chainSeeds([{address:'0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',priority:5},{address:'0x10ED43C718714eb63d5aA57B78B54704E256024E'},{address:T}]);assert.deepEqual(seeds,[T]);});
test('wallet-bound proof only entries stop with an actionable reason; mixed entries are not all classified as proof-bound',async()=>{
 const make=methods=>{const abi=new Interface(methods);return {address:T,verified:true,abi:JSON.parse(abi.formatJson()),sources:{},runtimeCode:'0x'+abi.fragments.map(f=>'63'+f.selector.slice(2)+'1461000057').join('')+'00'};};
 let calls=0;const learner={learn:async()=>{calls++;return {targets:[],methods:[],note:'no sample'};}},rpc={};
 const p=await assistMint(rpc,make(['function mint(bytes signature)']),{},null,{learner});assert.equal(p.failure.code,'SITE_PROOF_REQUIRED');assert.equal(p.failure.details.automaticProofAcquisition,false);assert.equal(calls,0);
 const mixed=await assistMint(rpc,make(['function mint(bytes signature)','function mintSpecial((uint256 choice,bool mode) params)']),{},null,{learner});assert.notEqual(mixed.failure?.code,'SITE_PROOF_REQUIRED');assert.equal(calls,1);
});
test('identity-counter family checks parsed bodies; a comment cannot hide changed ownership or quote semantics',()=>{
 const m=fixtures['p1xo.fun'];assert.equal(recognizeSpecialMint(m)?.kind,'identity-counter-nft');
 const changed=edit(m,'function quote(', '/* function quote( */ function quote(');assert.equal(recognizeSpecialMint(changed)?.kind,'identity-counter-nft');
 const wrong=edit(m,'function quote(', 'function otherQuote(');assert.equal(recognizeSpecialMint(wrong),null);
});
test('live price and referral reverts stay contract-state failures; missing quote stays an adapter gap',()=>{
 const abi=new Interface(['error InvalidReferrer()','error PriceDeviation()']);
 for(const name of ['InvalidReferrer','PriceDeviation']){const error=mintError({data:abi.encodeErrorResult(name)},abi.fragments);assert.equal(error.code,'MINT_STATE');assert.equal(failureKind(error),'eligibility_or_state');}
 assert.equal(failureKind({code:'MINT_ADAPTER_INCOMPLETE',message:'未读取到与付款币一致的有效报价'}),'adapter_needed');
});
