import {failureKind,failureLabels} from './failure-kind.mjs';
export const statuses={SKIPPED:'无持仓 · 已跳过',PARTIAL:'部分完成 · 未打满',READY_TO_CONTINUE:'上一笔已确认 · 可继续原单',PREPARING:'准备中',PREPARED:'预览通过 · 待确认',SIMULATED:'已模拟 · 未提交',BLOCKED:'预览未通过',CONFIRMED:'链上确认',CONFIRMED_REVIEW:'已上链 · 金额待核验',FAILED:'失败 · 可重试',REJECTED:'币安未接受',PENDING:'等待上链',SUBMISSION_UNKNOWN:'提交待核对',SUBMITTING:'正在提交',APPROVAL_CONFIRMED:'授权已确认 · 后续未完成',RECEIPT_REVIEW:'回执待核对',CANCELLED:'已取消'};
export const needsRoute=o=>o.intent?.side==='mint'&&o.status==='BLOCKED'&&Array.isArray(o.error?.details?.routes)&&o.error.details.routes.length>0;
export const statusLabel=o=>o.feeReview?.blocked||o.error?.code==='SELL_FEES_UNVERIFIABLE'?'池费无法核验 · 已拦截':o.needsFeeReview?'待确认卖出费用':o.status==='CONFIRMED'&&o.plan?.route==='corla:mint'?'认购成功 · 代币需领取':needsRoute(o)?'待选择铸造方式':o.status==='PREPARED'&&o.intent?.side==='mint'&&o.plan?.steps?.[0]?.kind==='approve'?'授权预览通过 · Mint 待模拟':o.status==='BLOCKED'?failureLabels[failureKind(o.error)]:statuses[o.status]||'状态待核对';
export function totalTimeLabel(o,now=Date.now()){
 const t=o.timing||{},valid=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
 const elapsed=end=>valid(end)&&valid(o.createdAt)&&end>=o.createdAt?end-o.createdAt:undefined;
 const ongoing=['PREPARING','SUBMITTING','PENDING','SUBMISSION_UNKNOWN','RECEIPT_REVIEW'].includes(o.status);
 // These timings are cumulative from createdAt; adding them would count time twice.
 const candidates=o.status==='REJECTED'?[elapsed(t.finishedAt)]:['CONFIRMED','CONFIRMED_REVIEW'].includes(o.status)
  ?[t.toConfirmedMs,elapsed(t.confirmedAt),elapsed(o.updatedAt)]
  :ongoing?[elapsed(now),elapsed(o.updatedAt),t.toSubmitMs,t.prepareMs]
  :o.status==='PREPARED'?[t.prepareMs,elapsed(o.updatedAt)]
  :[elapsed(o.updatedAt),t.toConfirmedMs,t.toSubmitMs,t.prepareMs];
 const ms=candidates.find(valid);
 return `总耗时 ${ms===undefined?'—':(ms/1000).toFixed(2)+' 秒'}${ongoing?'（进行中）':''}`;
}
export function projectLabel(o){
 const p=o.project||o.plan?.project||o.plan?.resolved;
 if(p?.name)return p.name;
 try{return new URL(o.intent.asset).hostname;}catch{return o.intent?.asset||p?.address||'项目名称暂未获取';}
}
export function reviewSummary(rows){
 const skipped=rows.filter(o=>o.status==='SKIPPED').length;
 const waiting=rows.filter(needsRoute).length,ready=rows.filter(o=>['PREPARED','READY_TO_CONTINUE'].includes(o.status)).length,completed=rows.filter(o=>['SIMULATED','CONFIRMED'].includes(o.status)).length;
 if(rows.some(o=>['PENDING','SUBMISSION_UNKNOWN','SUBMITTING','RECEIPT_REVIEW'].includes(o.status)))return {waiting,ready,completed,skipped,canConfirm:ready>0,message:'已有原单结果待核对；不会自动重发。明确失败后可重新点击发起。'};
 if(rows.some(o=>o.status==='CONFIRMED_REVIEW'))return {waiting,ready,completed,skipped,canConfirm:ready>0,message:'原交易已成功上链，金额解析需核验；不会重发。钱包可按当前余额发起新操作。'};
 if(rows.length&&rows.every(o=>['FAILED','REJECTED'].includes(o.status)))return {waiting,ready,completed,skipped,canConfirm:false,message:'本次操作未完成，可在操作记录点击重新发起；币安 App 的要求请先在 App 查看。'};
 if(rows.length&&rows.every(o=>o.status==='BLOCKED'&&o.error?.code==='NO_QUOTA'))return {waiting,ready,completed,skipped,canConfirm:false,message:'所选钱包当前没有符合本次范围的铸造额度，没有提交交易。'};
 return {waiting,ready,completed,skipped,canConfirm:waiting===0&&ready>0,message:skipped===rows.length&&rows.length?'所选钱包均无此代币持仓，已全部跳过，没有提交交易。':waiting?'请选择铸造方式后重新预览。当前没有完成模拟，也没有提交交易。':completed===rows.length&&rows.length?'原操作已经完成，显示原结果，没有重复执行。':ready+skipped===rows.length&&ready?`有 ${ready} 个钱包可执行${skipped?'，'+skipped+' 个钱包无持仓已跳过':''}。尚未签名或广播。`:ready?`有 ${ready} 个钱包预览通过；请分别核对其余钱包的状态。`:'本次预览未通过，没有提交交易。'};
}

function units(raw,decimals){const s=raw.toString().padStart(decimals+1,'0');return decimals?(s.slice(0,-decimals)+'.'+s.slice(-decimals)).replace(/\.?0+$/,''):s;}
function mintNumbers(o){
 const p=o.plan;
 // Continuations already have spent amounts. Do not present their original
 // target as a new charge, or count a single batch as an unbounded max fill.
 if(o.status!=='PREPARED'||o.intent?.side!=='mint'||!p||o.steps?.length||['corla:claim','corla:refund'].includes(p.route))return null;
 const corla=p.route==='corla:mint',binancians=p.route==='binancians:mint';if(!corla&&!binancians&&p.fill?.continue)return null;
 const quantity=corla||binancians?p.fill?.targetQuantity:p.quantity;
 if(!Number.isSafeInteger(quantity)||quantity<=0||!/^\d+$/.test(String(p.amountIn)))return null;
 const currency=p.budgetCurrency,decimals=p.budgetDecimals??(['BNB','USDT'].includes(currency)?18:null),symbol=currency==='QUOTE'?p.quota?.currency:currency;
 if(!symbol||!Number.isInteger(decimals)||decimals<0||decimals>36)return null;
 if(binancians&&!/^\d+$/.test(String(p.fill?.targetCost)))return null;
 const cost=binancians?BigInt(p.fill.targetCost):BigInt(p.amountIn)*(corla?BigInt(quantity):1n);
 return {quantity,cost,decimals,symbol,token:p.budgetToken||p.inputToken,maximum:corla||binancians,budgetCap:binancians?(currency==='BNB'?o.intent.maxBnb:o.intent.maxUsdt):undefined,approval:p.steps?.[0]?.kind==='approve'};
}
export function compactReviewGroups(rows){
 const grouped=new Map(),seen=new Set();
 for(const o of rows){
  // Duplicate rows are retained separately, never inflated into an aggregate.
  const duplicate=seen.has(o.intent?.account);seen.add(o.intent?.account);
  const n=mintNumbers(o),error=o.intent?.side==='mint'&&!['PREPARED','READY_TO_CONTINUE'].includes(o.status)&&o.error&&!needsRoute(o);
  const key=!duplicate&&n?JSON.stringify(['mint',o.intent.asset,o.project?.address||o.plan.resolved?.address,o.plan.route,o.status,o.simulationOnly,n.quantity,String(n.cost),n.budgetCap,n.decimals,n.symbol,n.token,n.approval,o.plan.afterMint||null,o.review||[],o.preview?.risks||[]]):!duplicate&&error?JSON.stringify(['error',o.intent.asset,o.status,o.error.code,o.error.message]):Symbol();
  if(!grouped.has(key))grouped.set(key,{rows:[],numbers:n,error:!!error});grouped.get(key).rows.push(o);
 }
 return [...grouped.values()].map(g=>{const n=g.numbers;if(!n)return {...g,summary:null};const count=g.rows.length;return {...g,summary:{walletCount:count,perWalletQuantity:n.quantity,perWalletAmount:units(n.cost,n.decimals),totalQuantity:String(BigInt(n.quantity)*BigInt(count)),totalAmount:units(n.cost*BigInt(count),n.decimals),symbol:n.symbol,maximum:n.maximum,approval:n.approval,...(n.budgetCap!==undefined?{budgetCap:n.budgetCap}:{})}};});
}
