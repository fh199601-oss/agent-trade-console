import {describeError,isHighRiskBlock} from './error-message.mjs';
export const isRiskBlockedOrder=o=>['FAILED','REJECTED','BLOCKED'].includes(o?.status)&&isHighRiskBlock(o.error);
export const canRetryTrade=o=>['FAILED','REJECTED','BLOCKED'].includes(o?.status)&&['buy','sell'].includes(o.intent?.side)&&!isRiskBlockedOrder(o);
const settled=new Set(['CONFIRMED','CONFIRMED_REVIEW','FAILED','REJECTED','BLOCKED','PARTIAL','CANCELLED','SKIPPED','SIMULATED']);
// The history endpoint returns summaries. Update display state only, retaining
// complete intent/preview data and rejecting out-of-order polling responses.
export function mergeTradeUpdate(current,update){
 if(!update||current.id!==update.id)return current;
 if(Number(update.updatedAt||0)<Number(current.updatedAt||0))return current;
 if(settled.has(current.status)&&!settled.has(update.status))return current;
 if(!update.summary)return {...current,...update};
 const next={...current};
 for(const key of ['status','updatedAt','timing','error','followError','tracking','orderId','txHash','needsFeeReview','feeReview','feeRouteSearch'])next[key]=update[key];
 return next;
}
export const isReady=o=>['PREPARED','READY_TO_CONTINUE'].includes(o.status);
export const canExecute=(o,ack=false)=>isReady(o)&&(ack||!o.review?.length);
export const independentOrder=o=>['buy','sell'].includes(o.intent.side)||o.intent.side==='mint'&&(o.plan?.resolved?.platform==='corla'&&['corla:mint','corla:claim','corla:refund'].includes(o.plan?.route)||o.plan?.resolved?.platform==='binancians'&&o.plan?.route==='binancians:mint'||o.plan?.resolved?.platform==='stars'&&o.plan?.route==='stars:mint');

// Receipt tracking has no submit callback, new ID, or trade construction path.
export async function followSubmittedOrder(order,follow,{onUpdate=()=>{},wait=ms=>new Promise(r=>setTimeout(r,ms)),attempts=30}={}){
 const deadline=Date.now()+30000;let current=order;if(order.status!=='PENDING'||!order.orderId&&!order.txHash&&!order.steps?.at(-1)?.txHash)return current;
 for(let n=0;n<attempts&&Date.now()<deadline&&current.status==='PENDING';n++){
  if(n>0)await wait(n<5?300:1000);
  try{const next=await follow(order.id);if(next.id!==order.id)throw Error('原单跟踪返回了不同订单');current=next;await onUpdate(current);}catch{/* A failed receipt read is not a failed trade. Never resubmit. */}
 }
 return current;
}

// One server workflow per click/wallet: a slow wallet's preparation must not
// hold up a ready wallet. The server retains simulation, risk and balance checks.
export async function runInstantTrades(rows,run,{onResult=()=>{}}={}){
 const seen=new Set();
 return Promise.all(rows.map(async o=>{
  if(!['buy','sell'].includes(o.intent.side)||seen.has(o.id))return o;
  seen.add(o.id);let result;
  try{result=await run(o);}catch(e){result={...o,status:e.details?.requestAccepted===false?'BLOCKED':'SUBMISSION_UNKNOWN',error:{message:e.message,code:e.code||'CLIENT_RESULT_UNKNOWN',details:e.details}};}
  onResult(result);return result;
 }));
}

// Independent wallets must not block each other on a pending or failed order.
export async function executeIndependent(rows,submit,{ack=false,onResult=()=>{}}={}){
 const seen=new Set();
 return Promise.all(rows.map(async o=>{
  if(!independentOrder(o)||!canExecute(o,ack)||seen.has(o.id))return o;
  seen.add(o.id);let result;
  try{result=await submit(o,ack);}catch(e){result={...o,status:e.details?.requestAccepted===false?'BLOCKED':'SUBMISSION_UNKNOWN',error:{message:e.message,code:e.code||'CLIENT_RESULT_UNKNOWN',details:e.details}};}
  onResult(result);return result;
 }));
}

export function tradeResultMessage(rows){
 const labels={CONFIRMED:'已确认成交',CONFIRMED_REVIEW:'已上链，金额待核验',PARTIAL:'部分完成，剩余未提交',PENDING:'已提交，等待确认',SUBMISSION_UNKNOWN:'提交状态待核对',SUBMITTING:'正在提交',SKIPPED:'无持仓，已跳过',PREPARED:'待确认',READY_TO_CONTINUE:'待继续确认',SIMULATED:'模拟完成，未提交',BLOCKED:'检查未通过',FAILED:'交易失败，可重新点击',REJECTED:'币安未接受，可重新发起'};
 return rows.map(o=>`${o.intent.account} 号：${isRiskBlockedOrder(o)?'币安风控拦截':o.needsFeeReview?'费用异常，未卖出（查看详情）':labels[o.status]||'需核对'}${o.error?.message&&o.status!=='SKIPPED'?'（'+describeError(o.error)+'）':''}`).join('；');
}
