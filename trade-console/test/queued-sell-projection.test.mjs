import test from 'node:test';import assert from 'node:assert/strict';
import {projectQueuedSale} from '../lib/queued-sell-projection.mjs';
import {reusableQueuedSell} from '../lib/queued-sell-preview.mjs';
import {V2_ROUTER_ABI,DEXES} from '../lib/opening-dex.mjs';
import {bindings,WBNB,formatUnits} from '../lib/common.mjs';
const wallets=bindings(),token='0x'+'81'.repeat(20),pool='0x'+'82'.repeat(20),d=DEXES.find(p=>p.id==='pancake-v2'),unit=10n**18n;
function fixture(){const x=5n*unit,ri=60n*unit,ro=1000n*unit,y=x*9975n*ro/(ri*10000n+x*9975n),min=y*97n/100n;
 return {kind:'contract',account:wallets[1].account,wallet:wallets[1].address,token,inputToken:token,outputToken:WBNB,amountIn:String(x),holdingBefore:String(x),outputDecimals:18,route:'pancake-v2-opening',requireSellCredit:true,slippage:{bps:300,capBps:300},opening:{...d,pool,token0:token,token1:WBNB,quote:WBNB,reserve0:String(ri),reserve1:String(ro)},poolFees:{poolFeePpm:2500},quote:{toCoinAmount:formatUnits(y,18)},minOutput:String(min),steps:[{kind:'sell',to:d.router,value:'0',data:V2_ROUTER_ABI.encodeFunctionData('swapExactTokensForTokensSupportingFeeOnTransferTokens',[x,min,[token,WBNB],wallets[1].address,12345678900])}]};
}
test('forecast only changes unsigned minimum, keeping exact amount, target, recipient, path and deadline',()=>{
 const p=fixture(),prior={...p,wallet:wallets[0].address},q=projectQueuedSale(p,[prior]),a=V2_ROUTER_ABI.parseTransaction(p.steps[0]),b=V2_ROUTER_ABI.parseTransaction(q.steps[0]);
 assert.ok(q.queuedProjection);assert.equal(p.minOutput,String(a.args[1]));assert.equal(q.steps[0].to,p.steps[0].to);
 for(const n of [0,3,4])assert.equal(a.args[n],b.args[n]);assert.deepEqual([...a.args[2]],[...b.args[2]]);assert.ok(b.args[1]<a.args[1]);assert.equal(q.slippage,p.slippage);
 // Predecessor has NOT mined: forecast is weaker than actual required min,
 // therefore unusable. No forecast can be taken straight to execution.
 const preview={at:1000,raw:{requestId:'unsigned'},review:{balanceChanges:[]}};
 assert.equal(reusableQueuedSell(p,{plan:q,preview},1100),null);
});
test('unknown fees, unsupported curves/multihop, zero slippage and missing reserves use normal preview',()=>{
 for(const change of [p=>p.opening.kind='v3',p=>p.opening.kind='infinity-cl',p=>p.opening.legs=[{},{}],p=>p.opening.path=[token,WBNB,token],p=>delete p.opening.reserve1,p=>p.opening.reserve0='0',p=>p.poolFees.poolFeePpm=null,p=>p.poolFees.poolFeePpm=850150,p=>p.slippage.bps=0,p=>p.steps[0].data='0x1234']){
  const p=fixture(),prior={...p,wallet:wallets[0].address};change(p);assert.equal(projectQueuedSale(p,[prior]),p);
 }
});
test('explicit minimum cannot be lowered by projection; unrelated pool/token/wallet never counted',()=>{
 const p=fixture(),prior={...p,wallet:wallets[0].address};p.authorizationMinOutput=p.minOutput;assert.equal(projectQueuedSale(p,[prior]),p);
 for(const other of [{...prior,token:WBNB},{...prior,opening:{...prior.opening,pool:token}},{...prior,wallet:p.wallet}])assert.equal(projectQueuedSale(fixture(),[other]).queuedProjection,undefined);
});
