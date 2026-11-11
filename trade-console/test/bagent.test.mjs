import test from 'node:test';
import assert from 'node:assert/strict';
import {BAGENT,BAGENT_ABI as M,bagentInput,validateBagentQuote,verifyBagentReceipt} from '../lib/bagent.mjs';
import {Engine,verifyPreview} from '../lib/engine.mjs';
import {discover} from '../lib/discovery.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BNB,USDT,ZeroAddress} from '../lib/common.mjs';
const cost=50n*10n**18n,out=10000000n*10n**18n,now=1800000000n,required=70000000000000000n;
function fixture(payment='BNB'){
 const n=5n,l={maxCost:cost*101n/100n,minTokens:out*99n/100n,minQuote:1n,minBuy:0n,minLpToken:1n,minLpQuote:1n,deadline:now+300n};
 const value=payment==='BNB'?required*101n/100n:0n;
 const q={mode:'chain',paymentToken:payment,stable:USDT,cost:String(cost),tokens:String(out),bnbPricing:'chainlink',retainsExcessBNB:true,nativeEstimate:String(required),nativeValue:String(value),limits:Object.fromEntries(Object.entries(l).map(([k,v])=>[k,String(v)])),transaction:{to:BAGENT.config.mint,data:M.encodeFunctionData(payment==='BNB'?'mintWithBNB':'mint',[n,l]),value:String(value)}};
 const context={n,cost,out,nativeRequired:required,payment,now,maxUsdt:51n*10n**18n,maxBnb:required*102n/100n,slippageBps:100};return {q,context};
}
test('BAGENT routing only accepts the exact website and known contracts',()=>{
 for(const s of ['https://bagent.club/','https://bagent.club/?ref=xzz.ai',BAGENT.config.mint,BAGENT.config.token])assert.equal(bagentInput(s),true);
 for(const s of ['https://bagent.club.evil.com','https://user@bagent.club','http://bagent.club','https://bagent.club:444','https://other.club'])assert.equal(bagentInput(s),false);
});
test('BAGENT sales preserve the token address instead of selecting its Mint contract',async()=>{
 const rpc=new Proxy({},{get(){throw Error('sale address discovery must not read Mint metadata');}});
 const result=await discover(BAGENT.config.token,{rpc,corlaRouting:false});
 assert.equal(result.address.toLowerCase(),BAGENT.config.token.toLowerCase());
});
test('native and USDT quotes keep fixed issuance and clamp cost to exact quote',()=>{
 for(const payment of ['BNB','USDT']){const {q,context}=fixture(payment),r=validateBagentQuote(q,context),args=M.decodeFunctionData(payment==='BNB'?'mintWithBNB':'mint',r.data);assert.equal(args[0],5n);assert.equal(args[1].maxCost,cost);assert.equal(args[1].minTokens,out);assert.equal(r.usdDebit,payment==='BNB'?cost*101n/100n:cost);}
});
test('quote mismatches, weak bounds and expired deadlines never produce a transaction',()=>{
 const mutations=[q=>q.transaction.to=USDT,q=>q.cost='1',q=>q.tokens='1',q=>q.stable=BNB,q=>q.transaction.value=String(required*2n),q=>q.nativeEstimate='1',q=>q.retainsExcessBNB=false,q=>q.transaction.data=M.encodeFunctionData('bindReferrer',[ZeroAddress]),q=>q.limits.maxCost='1'];
 for(const mutate of mutations){const {q,context}=fixture();mutate(q);assert.throws(()=>validateBagentQuote(q,context));}
 for(const [field,value] of [['minTokens',1n],['minQuote',0n],['minLpToken',0n],['minLpQuote',0n],['maxCost',cost*2n],['deadline',now-1n],['deadline',now+10000n]]){const {q,context}=fixture();const l={...q.limits,[field]:String(value)};q.limits=l;q.transaction.data=M.encodeFunctionData('mintWithBNB',[5,l]);assert.throws(()=>validateBagentQuote(q,context));}
});
test('BNB rounding and retained buffer count toward both currency caps',()=>{
 let {q,context}=fixture();assert.throws(()=>validateBagentQuote(q,{...context,maxUsdt:cost}),{code:'BUDGET_LIMIT'});assert.throws(()=>validateBagentQuote(q,{...context,maxBnb:required}),{code:'BUDGET_LIMIT'});
 ({q,context}=fixture('USDT'));q.transaction.value='1';assert.throws(()=>validateBagentQuote(q,context));
});
test('oracle movement within slippage lowers value but never increases the site quote',()=>{
 const {q,context}=fixture(),lower=required*999n/1000n;
 const r=validateBagentQuote(q,{...context,nativeRequired:lower});
 assert.ok(r.value<BigInt(q.nativeValue));assert.ok(r.value<=(lower*101n+99n)/100n);
 assert.throws(()=>validateBagentQuote(q,{...context,nativeRequired:required*98n/100n}));
});
test('official preview rejects any binding debit or allowance and insufficient Mint credit',()=>{
 const w='0x1111111111111111111111111111111111111111',plan={wallet:w,inputToken:BNB,outputToken:BAGENT.config.token,amountIn:String(required),minOutput:String(out),metaVerified:false,requireAssetCredit:true,expectedAsset:{kind:'Erc20'}},step={kind:'referral',to:BAGENT.config.mint,value:'0'};
 const p={requestId:'test',simulationResult:{simulationCode:'000000000',balanceChanges:[],allowanceChanges:[]}};
 assert.doesNotThrow(()=>verifyPreview(p,plan,step));
 assert.throws(()=>verifyPreview({...p,simulationResult:{...p.simulationResult,balanceChanges:[{owner:w,contractAddress:BNB,change:'-1'}]}},plan,step),/邀请绑定/);
 assert.throws(()=>verifyPreview({...p,simulationResult:{...p.simulationResult,allowanceChanges:[{owner:w}]}},plan,step),/邀请绑定/);
 assert.throws(()=>verifyPreview(p,plan,{...step,kind:'mint'}),/到账/);
});
test('receipt verifies exact shares, paid cost, wallet identity and inviter',()=>{
 const w='0x1111111111111111111111111111111111111111',ref='0x2222222222222222222222222222222222222222',plan={wallet:w,quantity:5,referral:{address:ref},bagent:{agentId:'123',cost:String(cost)}};
 const receipt=(shares=5n,payer=w,inviter=ref,paid=cost)=>({logs:[{address:BAGENT.config.mint,...M.encodeEventLog(M.getEvent('Minted'),[payer,123n,shares,paid,out,inviter])}]});
 assert.equal(verifyBagentReceipt(receipt(),plan).quantity,'5');
 for(const r of [receipt(4n),receipt(5n,ref),receipt(5n,w,ZeroAddress),receipt(5n,w,ref,cost+1n)])assert.throws(()=>verifyBagentReceipt(r,plan));
});
test('same-ID preparation retry requires a blocked order with zero submitted steps',async t=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'bagent-reprepare-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 let calls=0;const engine=new Engine({data,live:false,rpc:{},bridge:{},planFn:async()=>{calls++;throw Error('synthetic read failure');}});
 const input={account:2,side:'mint',asset:BAGENT.config.mint,quantity:5,maxBnb:'0',maxUsdt:'50',scope:'paid'};
 let o=await engine.prepare(input,'test');assert.equal(o.status,'BLOCKED');
 await engine.prepare(input,'test');assert.equal(calls,1);
 o=await engine.prepare(input,'test',{retryBlocked:true});assert.equal(calls,2);assert.equal(o.preparationHistory.length,1);
 o.steps=[{status:'CONFIRMED',txHash:'original'}];engine.write(o);
 await engine.prepare(input,'test',{retryBlocked:true});assert.equal(calls,2);
 await assert.rejects(engine.prepare({...input,quantity:1},'test',{retryBlocked:true}),/同一消息/);
});
