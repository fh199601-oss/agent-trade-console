import test from 'node:test';import assert from 'node:assert/strict';
import {compactReviewGroups,reviewSummary} from '../public/review-model.mjs';
const row=(account,extra={})=>({id:'fake-'+account,intent:{account,side:'mint',asset:'0x'+'1'.repeat(40)},status:'PREPARED',steps:[],review:['routine'],plan:{route:'corla:mint',quantity:1,amountIn:'10000000000000000',budgetCurrency:'BNB',budgetDecimals:18,inputToken:'native',fill:{targetQuantity:10},steps:[{kind:'mint'}],afterMint:{autoClaim:true,sell:{percent:'50',slippageBps:5000}}},...extra});
test('same wallets aggregate target lots rather than only the first Corla transaction',()=>{
 const groups=compactReviewGroups([1,2,3,4].map(a=>row(a)));assert.equal(groups.length,1);assert.deepEqual(groups[0].summary,{walletCount:4,perWalletQuantity:10,perWalletAmount:'0.1',totalQuantity:'40',totalAmount:'0.4',symbol:'BNB',maximum:true,approval:false});
});
test('different amounts, lots, assets, risk prompts and followup settings remain separate',()=>{
 for(const modify of [o=>o.plan.fill.targetQuantity=9,o=>o.plan.amountIn='9000000000000000',o=>o.plan.inputToken='other',o=>o.review=['new risk'],o=>o.plan.afterMint.sell.percent='25',o=>o.plan.steps[0].kind='approve',o=>o.simulationOnly=true]){
  const a=row(1),b=row(2);modify(b);assert.equal(compactReviewGroups([a,b]).length,2);
 }
});
test('USDT and custom decimal currency totals retain integer precision',()=>{
 const a=row(1);Object.assign(a.plan,{budgetCurrency:'USDT',budgetDecimals:18,amountIn:'123456789012345678'});a.plan.fill.targetQuantity=3;const b=structuredClone(a);b.intent.account=2;
 assert.equal(compactReviewGroups([a,b])[0].summary.totalAmount,'0.740740734074074068');
 Object.assign(a.plan,{budgetCurrency:'QUOTE',budgetDecimals:6,amountIn:'1001',quota:{currency:'TEST6'}});a.plan.fill.targetQuantity=7;assert.equal(compactReviewGroups([a])[0].summary.totalAmount,'0.007007');assert.equal(compactReviewGroups([a])[0].summary.symbol,'TEST6');
});
test('failed wallets stay out of totals, repeated failure text is shown once',()=>{
 const err=account=>row(account,{status:'BLOCKED',error:{code:'BUDGET_LIMIT',message:'余额不足'}}),rows=[row(1),err(2),err(3)];const g=compactReviewGroups(rows);assert.equal(g.length,2);assert.equal(g[0].summary.walletCount,1);assert.equal(g[0].summary.totalAmount,'0.1');assert.equal(g[1].rows.length,2);assert.equal(g[1].summary,null);assert.equal(reviewSummary(rows).ready,1);
});
test('continuations and unknown max totals never present initial budgets as new charges',()=>{
 for(const change of [o=>o.status='READY_TO_CONTINUE',o=>o.steps=[{status:'CONFIRMED'}],o=>o.plan.fill.targetQuantity=undefined,o=>o.plan.route='corla:claim',o=>{o.plan.route='generic';o.plan.fill.continue=true;},o=>o.plan.amountIn='1e18']){const a=row(1);change(a);assert.equal(compactReviewGroups([a])[0].summary,null);}
 const a=row(1);a.plan.route='generic';a.plan.quantity=3;a.plan.fill={continue:false};assert.equal(compactReviewGroups([a])[0].summary.perWalletAmount,'0.01','generic batch amount already includes all lots');
});
