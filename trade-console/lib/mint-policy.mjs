import {parseUnits} from './common.mjs';
export const min=(...v)=>v.reduce((a,b)=>a<b?a:b);
export const positive=n=>n>0n?n:0n;
export function noQuota(message,details){return Object.assign(Error(message),{code:'NO_QUOTA',details});}
// All amounts remain uint256 integers. A project calling a deposit "free" does not make it zero cost.
export async function chooseBatch(state,intent,budget){
 const {scope='free'}=intent;
 if(state.blocked)throw Object.assign(Error(state.blocked),{details:state.info});
 const free=positive(state.free),paid=positive(state.paid);
 if(scope==='paid'&&state.mixed&&free>0n)throw Error('该合约会自动消耗免费额度，不能单独执行付费额度；请先领取免费，或明确选择全部');
 const remaining=scope==='free'?free:scope==='paid'?paid:free+paid;
 if(!remaining)throw noQuota('当前所选类型可用额度为 0',{quota:state.info});
 if(intent.quantity==='max'&&state.unboundedPaid&&scope!=='free')throw Error('该项目没有每钱包付费上限，不能将全部库存当作你的额度；请填写明确份数');
 let lane=state.mixed?'mixed':scope!=='paid'&&free>0n?'free':'paid';
 let cap=state.mixed?remaining:lane==='free'?free:paid;
 cap=min(cap,BigInt(state.txCap||500),500n);
 const wanted=intent.quantity==='max'?remaining:BigInt(intent.quantity);
 if(wanted>remaining)throw Error('份数超过本钱包当前所选类型的可用额度');
 let n=min(wanted,cap),q=await state.quote(n,lane);
 const limit=scope==='free'?0n:budget;
 if(intent.quantity==='max'&&q.cost>limit){let lo=0n,hi=n;while(lo<hi){const mid=(lo+hi+1n)/2n;if((await state.quote(mid,lane)).cost<=limit)lo=mid;else hi=mid-1n;}n=lo;if(n)q=await state.quote(n,lane);}
 if(!n||q.cost>limit)throw Object.assign(Error(scope==='free'?'没有零费用的可用份额（Gas 另计）':'剩余预算不足，未追加支出'),{code:'BUDGET_LIMIT',details:state.info});
 return {...q,n,lane,remaining,continue:remaining>n&&(intent.quantity==='max'||wanted>n)};
}
export function mintBudget(i){return parseUnits(i.currency==='USDT'?i.maxUsdt||'0':i.maxBnb,18);}
