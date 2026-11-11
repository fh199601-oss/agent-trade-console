import {createHash} from 'node:crypto';
import {same,native,parseUnits} from './common.mjs';

// PPM, not bps: Uniswap 850150 means 85.015%, NOT 0.85015%.
export const HIGH_FEE_PPM=500000; // User-selected 50% high-fee threshold.
export const feePercent=n=>n===null||n===undefined?'未知':`${Number((n/10000).toFixed(4))}%`;
const ppm=n=>n!==null&&n!==undefined&&n!==''&&typeof n!=='boolean'&&Number.isFinite(Number(n))&&Number(n)>=0&&Number(n)<=1000000?Math.ceil(Number(n)):null;
export function compoundFees(values){if(values.some(v=>v===null))return null;return Number(1000000n-values.reduce((n,v)=>n*BigInt(1000000-v)/1000000n,1000000n));}

// Use reserves and router amounts at the SAME block. Integer output rounding
// produces a fee interval; tiny/ambiguous samples are unknown, never zero fee.
export function v2FeePpm({reserveIn,reserveOut,amountIn,amountOut}){
 try{
  const ri=BigInt(reserveIn),ro=BigInt(reserveOut),x=BigInt(amountIn),y=BigInt(amountOut),scale=1000000n;
  if(ri<=0n||ro<=0n||x<=0n||y<=0n||y+1n>=ro)return null;
  const lower=y*ri*scale/(x*(ro-y)),upper=((y+1n)*ri*scale+x*(ro-y-1n)-1n)/(x*(ro-y-1n));
  if(lower>scale||upper<lower||upper-lower>100n)return null;
  return Number(scale-lower); // conservative upper fee bound
 }catch{return null;}
}
export function poolFeeProof(pool,amounts,token,block){
 const legs=pool.legs||[pool],path=pool.path||[token,pool.quote];
 const fees=legs.map((p,i)=>p.kind==='v3'?ppm(p.fee):
  block!==undefined&&p.block===block&&amounts?.length===legs.length+1?v2FeePpm({reserveIn:same(path[i],p.token0)?p.reserve0:p.reserve1,reserveOut:same(path[i],p.token0)?p.reserve1:p.reserve0,amountIn:amounts[i],amountOut:amounts[i+1]}):null);
 return {version:1,source:pool.kind==='v3'?'verified-v3-fee':'same-block-reserves-and-quote',poolFeePpm:compoundFees(fees),pools:legs.map((p,i)=>({address:p.pool,factory:p.factory,feePpm:fees[i]})),block};
}
export function compareFeeRoutes(a,b){
 const cost=r=>r.fees?.poolFeePpm==null?null:Math.max(r.fees.poolFeePpm,r.fees.quoteLossPpm||0);
 const af=cost(a),bf=cost(b);
 const tier=f=>f===null?2:f>=HIGH_FEE_PPM?1:0;
 if(tier(af)!==tier(bf))return tier(af)-tier(bf);
 if(!!a.failed!==!!b.failed)return a.failed?1:-1;
 // A token-declared pool is only preferred AFTER factory and fee checks. Its
 // label does not exempt it from the high-fee confirmation rule.
 if(!!a.pool.declaredByToken!==!!b.pool.declaredByToken)return a.pool.declaredByToken?-1:1;
 if(same(a.pool.quote,b.pool.quote)&&a.output!==b.output)return a.output>b.output?-1:1;
 if(af!==bf)return (af??1000001)-(bf??1000001);
 return String(a.pool.pool).localeCompare(String(b.pool.pool));
}
function percentPpm(value){if(value===null||value===undefined||value===''||!/^\d+(?:\.\d+)?$/.test(String(value)))return null;return ppm(Number(value)*10000);}
function curveFees(plan){
 const bps=value=>{const n=ppm(value);return n===null?null:ppm(n*100);};
 if(plan.route==='flap')return {poolFeePpm:bps(plan.state?.sellFeeBps),taxPpm:bps(plan.state?.sellTaxBps),source:'Flap 链上费率'};
 if(plan.route==='gang'&&plan.state?.feeBps!==undefined)return {poolFeePpm:compoundFees([bps(plan.state.feeBps),plan.poolFees?.poolFeePpm??0]),taxPpm:0,source:'Gang 链上费率'};
 if(plan.route==='gang-pool'&&plan.state?.verifiedSellTaxBps!==undefined)return {poolFeePpm:plan.poolFees?.poolFeePpm??null,taxPpm:bps(plan.state.verifiedSellTaxBps),source:'Gang 链上卖出税及固定工厂池费'};
 if(plan.route==='gang-modern'&&plan.state?.feeBps!==undefined)return {poolFeePpm:compoundFees([bps(plan.state.feeBps),plan.poolFees?.poolFeePpm??0]),taxPpm:0,source:'Gang 统一入口实时报价（含中转池费）'};
 return null;
}
function simulatedShortfall(plan,preview){
 try{
  if(!plan.requireSellCredit||plan.steps?.at(-1)?.kind!=='sell'||!preview)return null;
  const quoted=parseUnits(String(plan.quote.toCoinAmount),plan.outputDecimals??18);
  let credit=0n;for(const c of preview.balanceChanges||[]){if(!same(c.owner,plan.wallet)||!(same(c.contractAddress,plan.outputToken)||native(c.contractAddress)&&native(plan.outputToken)))continue;const n=BigInt(c.change);if(n>0n)credit+=n;}
  if(quoted<=0n||credit<=0n)return null;
  return credit>=quoted?0:Number((quoted-credit)*1000000n/quoted);
 }catch{return null;}
}
export function assessSellFees(plan,preview,{beforeSell=false}={}){
 const opaque=plan.kind==='swap',curve=opaque?null:curveFees(plan),proof=opaque?null:plan.poolFees;
 const poolFeePpm=ppm(curve?.poolFeePpm??proof?.poolFeePpm);
 const taxPpm=curve?.taxPpm??(plan.audit?.available?percentPpm(plan.audit.taxes?.sellTax):null);
 const additionalLossPpm=opaque?null:simulatedShortfall(plan,preview);
 // Preview shortfall can include the same transfer tax; use the larger
 // observed estimate instead of double-counting it. It may also be price movement.
 const effectiveTax=taxPpm===null?additionalLossPpm:Math.max(taxPpm,additionalLossPpm||0);
 // An audit vendor's missing tax field is not evidence of a high tax. For a
 // fixed, known-fee route, check the real sell's simulated net credit instead.
 // Approval previews cannot provide that evidence: defer this check, never
 // reuse an approval preview as a sale preview or infer that unknown means 0.
 let canCheckSellCredit=false;
 try{canCheckSellCredit=!opaque&&poolFeePpm!==null&&plan.requireSellCredit===true&&plan.steps?.at(-1)?.kind==='sell'&&!!plan.outputToken&&parseUnits(String(plan.quote?.toCoinAmount),plan.outputDecimals??18)>0n;}catch{}
 const pendingSellPreview=taxPpm===null&&additionalLossPpm===null&&canCheckSellCredit;
 const quoteLossPpm=ppm(proof?.quoteLossPpm);
 const totalFeePpm=compoundFees([poolFeePpm===null?null:Math.max(poolFeePpm,quoteLossPpm||0),effectiveTax]),reasons=[];
 if(opaque)reasons.push('聚合器不公开且不能固定实际池子与池费，可能再次走高费池；此路线禁止提交');
 else if(poolFeePpm===null)reasons.push('当前路线的池手续费无法可靠核验');
 if(taxPpm===null&&additionalLossPpm===null&&(!canCheckSellCredit||beforeSell))reasons.push('未取得卖出税率或本钱包的模拟净到账');
 if(quoteLossPpm!==null&&quoteLossPpm>=HIGH_FEE_PPM)reasons.push('报价相对池内现价减少 '+feePercent(quoteLossPpm)+'（包含池费、Hook 扣费和价格冲击）');
 if(poolFeePpm!==null&&poolFeePpm>=HIGH_FEE_PPM)reasons.push('池手续费高达 '+feePercent(poolFeePpm));
 if(taxPpm!==null&&taxPpm>=HIGH_FEE_PPM)reasons.push('代币卖出税高达 '+feePercent(taxPpm));
 if(totalFeePpm!==null&&totalFeePpm>=HIGH_FEE_PPM&&!reasons.length)reasons.push('池费与已检测的税费/到账差额合计约 '+feePercent(totalFeePpm));
 if(additionalLossPpm!==null&&additionalLossPpm>=HIGH_FEE_PPM)reasons.push('模拟到账比路由报价少 '+feePercent(additionalLossPpm)+'，可能包含额外扣费或价格变化');
 const blocked=opaque||poolFeePpm===null||beforeSell&&pendingSellPreview;
 return {version:3,blocked,required:reasons.length>0,opaque,poolFeePpm,quoteLossPpm,taxPpm,totalFeePpm,additionalLossPpm,pendingSellPreview,thresholdPpm:HIGH_FEE_PPM,pools:opaque?[]:proof?.pools||[],source:opaque?'未公开':curve?.source||proof?.source||'未知',reasons};
}
export function updateFeeReview(order,preview,options){
 if(order.intent?.side!=='sell'||!order.plan)return null;
 const fees=assessSellFees(order.plan,preview,options),p=order.plan;
 // Low simulated shortfall changing by a rounding unit is not a new risk.
 // High/combined fees, unknown evidence, route and amounts remain bound.
 const feeBinding={poolFeePpm:fees.poolFeePpm,quoteLossPpm:fees.quoteLossPpm>=HIGH_FEE_PPM?fees.quoteLossPpm:null,pools:fees.pools,blocked:fees.blocked,opaque:fees.opaque,taxPpm:fees.taxPpm===null&&fees.additionalLossPpm===null&&!fees.pendingSellPreview?'unknown':fees.taxPpm>=HIGH_FEE_PPM?fees.taxPpm:null,totalFeePpm:fees.totalFeePpm>=HIGH_FEE_PPM?fees.totalFeePpm:null,additionalLossPpm:fees.additionalLossPpm>=HIGH_FEE_PPM?fees.additionalLossPpm:null};
 const binding={order:order.id,account:order.intent.account,token:p.token,wallet:p.wallet,input:p.inputToken,output:p.outputToken,amount:p.amountIn,holding:p.holdingBefore,route:p.route,kind:p.kind,slippage:p.slippage,fees:feeBinding,steps:p.steps?.map(s=>({kind:s.kind,to:s.to,spender:s.spender})),...(fees.opaque?{quote:p.quote}:{} )};
 const id=createHash('sha256').update(JSON.stringify(binding)).digest('hex');
 order.feeReview={...fees,id};order.needsFeeReview=fees.required&&!fees.blocked;
 order.review=(order.review||[]).filter(s=>!s.startsWith('费用核对：'));
 if(fees.required)order.review.push('费用核对：'+fees.reasons.join('；')+(fees.blocked?'。没有可核验池费的固定路线，已拦截；普通确认不能放行。':'。滑点不限制已包含在报价中的费用，必须单独确认。'));
 return order.feeReview;
}
export function blockUnverifiableFees(order){
 if(!order.feeReview?.blocked)return false;
 order.status='BLOCKED';order.needsFeeReview=false;order.needsReview=false;
 order.error={code:'SELL_FEES_UNVERIFIABLE',message:order.feeReview.pendingSellPreview?'无法核验本钱包的卖出净到账，卖出未提交；钱包可继续其他交易。':'未找到池费可核验的固定卖出路线，已阻止提交。不会转用不透明聚合器；钱包可继续其他交易。'};
 order.message=order.error.message;order.timing??={};order.timing.finishedAt=Date.now();return true;
}
