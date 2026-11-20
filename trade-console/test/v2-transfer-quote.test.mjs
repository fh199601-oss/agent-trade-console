import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface,toBeHex,zeroPadValue} from 'ethers';
import {BNB,WBNB} from '../lib/common.mjs';
import {DEXES,V2_ROUTER_ABI} from '../lib/opening-dex.mjs';
import {withV2NetQuote,quotedTaxSide} from '../lib/v2-transfer-quote.mjs';
import {assessSellFees} from '../lib/trade-fees.mjs';
import {openingSettlement} from '../lib/opening-route.mjs';
import {settlementFixture} from './support/settlement-fixture.mjs';

const token='0x'+'1'.repeat(40),owner='0x'+'3'.repeat(40),dex=DEXES[0];
const router=new Interface([...V2_ROUTER_ABI.fragments,'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable']);
function fixture(side,{gross=1000n,net=900n,spent=100n}={}){
 const buy=side==='buy',pool={...dex,block:800,path:buy?[WBNB,token]:[token,WBNB]},fn=buy?'swapExactETHForTokensSupportingFeeOnTransferTokens':'swapExactTokensForETHSupportingFeeOnTransferTokens';
 const args=[990n,pool.path,owner,1200n];if(!buy)args.unshift(100n);
 const step={kind:side,value:buy?'100':'0',to:dex.router,data:router.encodeFunctionData(fn,args)};
 const plan={route:buy?'primary-pool':dex.id+'-opening',state:pool,opening:buy?undefined:pool,wallet:owner,amountIn:'100',slippage:{bps:100},outputDecimals:0,inputToken:buy?BNB:token,outputToken:buy?token:BNB,minOutput:'990',quote:{toCoinAmount:'1000'},poolFees:{poolFeePpm:2500},steps:[step],requireSellCredit:!buy};
 if(buy)step.tradeLeg={minOutput:'990'};
 const ok=returnData=>({status:'0x1',returnData}),bal=n=>ok(zeroPadValue(toBeHex(n),32));
 const rpc={send:async(method,[request,block])=>{
  assert.equal(method,'eth_simulateV1');assert.equal(block,'0x320');assert.equal(request.validation,false);
  const {calls}=request.blockStateCalls[0],probe=calls.at(-3);
  assert.equal(probe.from,owner);assert.equal(probe.to,dex.router);assert.equal(router.decodeFunctionData(fn,probe.data)[buy?0:1],1n);
  return [{calls:[ok(router.encodeFunctionResult('getAmountsOut',[[100n,gross]])),bal(500n),bal(122n),ok('0x'),bal(500n-spent),bal(122n+net)]}];
 }};
 return {plan,rpc,fn};
}
for(const side of ['buy','sell'])test('V2 税后报价和正式 calldata '+side,async()=>{
 const {rpc,plan,fn}=fixture(side);const p=await withV2NetQuote(rpc,plan);
 assert.equal(p.minOutput,'891');assert.equal(p.quote.toCoinAmount,'1000');assert.equal(p.quote.netCoinAmount,'900');
 assert.equal(p.transferQuote.lossPpm,100000);assert.equal(router.decodeFunctionData(fn,p.steps.at(-1).data)[side==='buy'?0:1],891n);
 assert.equal(plan.minOutput,'990');if(side==='buy')assert.equal(p.steps[0].tradeLeg.minOutput,'891');
});
test('逐钱包免税、买卖税不同、最小到账、高税与节点不支持',async()=>{
 const exempt=fixture('sell',{net:1000n});
 const p=await withV2NetQuote(exempt.rpc,exempt.plan);assert.equal(p.minOutput,'990');
 const a={audit:{available:true,taxes:{buyTax:0,sellTax:10}}};assert.equal(quotedTaxSide(a,'buy'),false);assert.equal(quotedTaxSide(a,'sell'),true);
 const buy=fixture('buy',{net:500n});await assert.rejects(withV2NetQuote(buy.rpc,buy.plan),/50%/);
 const sell=fixture('sell',{net:500n});const risky=await withV2NetQuote(sell.rpc,sell.plan);assert.equal(assessSellFees(risky).required,true);
 await assert.rejects(withV2NetQuote(sell.rpc,sell.plan,{minimumOutput:'650'}),/最低到账/);
 const extra=fixture('sell',{spent:101n});await assert.rejects(withV2NetQuote(extra.rpc,extra.plan),/扣款/);
 assert.equal(await withV2NetQuote({send:async()=>{throw Error('unsupported');}},sell.plan),sell.plan);
});
test('回执能核对先记全额再从收款方扣税的输入和输出',()=>{
 const f=settlementFixture({nested:false,native:false});
 const {transfer,swap,token,state,wallet,receipt}=f;
 const fee='0x'+'4'.repeat(40);
 receipt.logs=[transfer(token,wallet,state.pool,1000),transfer(token,state.pool,fee,30),transfer(state.quote,state.pool,wallet,200),transfer(state.quote,wallet,fee,20),swap(970,200,wallet)];
 assert.deepEqual(openingSettlement(f),{amountIn:1000n,poolAmountIn:970n,amountOut:180n,attribution:'wallet-funded-swap'});
});
