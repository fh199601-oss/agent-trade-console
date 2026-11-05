// Mock wallet transport only; no signatures, network calls or runtime state.
import test from 'node:test';import assert from 'node:assert/strict';
import {Engine} from '../lib/engine.mjs';
import {sellGasLimit,sellGasArgs} from '../lib/sell-gas.mjs';
import {openingConfig} from '../lib/opening-sell.mjs';
import {validateIntent,bindings,ERC20,BNB} from '../lib/common.mjs';
const w=bindings()[0],token='0x'+'1'.repeat(40),router='0x'+'2'.repeat(40);
const intent={account:w.account,asset:token,side:'sell',percent:'50',currency:'AUTO',slippageBps:5000,openingOnly:true};
test('no chosen gas cap means no override; only explicit integer caps are accepted',()=>{
 assert.equal(sellGasLimit(undefined),undefined);assert.deepEqual(sellGasArgs(intent,{kind:'sell'}),[]);
 for(const value of [null,'800000',0,20999,15000001,Infinity,NaN,800000.1,true])assert.throws(()=>sellGasLimit(value));
 for(const value of [21000,800000,15000000])assert.equal(sellGasLimit(value),value);
 assert.equal(validateIntent({...intent,gasLimit:800000}).gasLimit,800000);
 for(const extra of [{openingOnly:undefined},{side:'buy',amount:'1'},{side:'mint',quantity:1,maxBnb:'0'}])assert.throws(()=>validateIntent({...intent,...extra,gasLimit:800000}));
});
test('opening and Corla-linked policy preserve chosen cap, legacy tasks never gain a cap',()=>{
 const input={asset:token,accounts:[w.account],percent:'50',slippageBps:5000,currency:'AUTO'};
 assert.equal(Object.hasOwn(openingConfig(input),'gasLimit'),false);
 assert.equal(openingConfig({...input,gasLimit:800000}).gasLimit,800000);
 const mint={account:w.account,asset:token,side:'mint',quantity:'max',maxBnb:'0',scope:'free',autoClaim:true};
 const policy={percent:'50',slippageBps:5000,currency:'AUTO',gasLimit:800000};
 assert.deepEqual(validateIntent({...mint,claimSell:policy}).claimSell,policy);
 assert.throws(()=>validateIntent({...mint,claimSell:{...policy,gasLimit:'800000'}}));
 assert.equal(Object.hasOwn(validateIntent({...mint,claimSell:{percent:'50'}}).claimSell,'gasLimit'),false);
});
test('official sale preview receives exact user cap; approval retains backend estimate',async()=>{
 const calls=[],bridge={ready:async()=>{},call:async(account,args)=>{calls.push(args);assert.equal(account,w.account);assert.equal(args[1],'preview');return {requestId:'mock',simulationResult:{simulationCode:'000000000',balanceChanges:[{owner:w.address,contractAddress:BNB,change:'90'}]}};}};
 const plan={kind:'contract',wallet:w.address,token,inputToken:token,outputToken:BNB,amountIn:'500',minOutput:'80',requireSellCredit:true,steps:[{kind:'approve',to:token,value:'0',spender:router,allowance:'500',data:ERC20.encodeFunctionData('approve',[router,500])},{kind:'sell',to:router,value:'0',data:'0x12345678'}]};
 await Engine.prototype.preview.call({bridge},plan,{...intent,gasLimit:800000},0);
 await Engine.prototype.preview.call({bridge},plan,{...intent,gasLimit:800000},1);
 await Engine.prototype.preview.call({bridge},plan,intent,1);
 assert.equal(calls[0].includes('--gasLimit'),false);assert.deepEqual(calls[1].slice(-2),['--gasLimit','800000']);assert.equal(calls[2].includes('--gasLimit'),false);
});
test('higher state-dependent cost still must pass official simulation, never bypassed',async()=>{
 const bridge={ready:async()=>{},call:async(account,args)=>{assert.equal(args[1],'preview');const ix=args.indexOf('--gasLimit'),limit=ix<0?296038:Number(args[ix+1]);return {requestId:'mock',simulationResult:{simulationCode:limit>=508171?'000000000':'351805',balanceChanges:[]}};}};
 const plan={kind:'contract',wallet:w.address,steps:[{kind:'sell',to:router,value:'0',data:'0x12345678'}]};
 await assert.rejects(Engine.prototype.preview.call({bridge},plan,intent),/模拟未明确通过/);
 await assert.rejects(Engine.prototype.preview.call({bridge},plan,{...intent,gasLimit:300000}),/模拟未明确通过/);
 assert.equal((await Engine.prototype.preview.call({bridge},plan,{...intent,gasLimit:800000})).raw.requestId,'mock');
});
