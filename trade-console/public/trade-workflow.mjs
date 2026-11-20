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
export const independentOrder=o=>['buy','sell','mint'].includes(o.intent.side);

// Receipt tracking has no submit callback, new ID, or trade construction path.
export async function followSubmittedOrder(order,follow,{onUpdate=()=>{},wait=ms=>new Promise(r=>setTimeout(r,ms)),attempts=30}={}){
 const deadline=Date.now()+30000;let current=order;if(order.status!=='PENDING'||!order.orderId&&!order.txHash&&!order.steps?.at(-1)?.txHash)return current;
 for(let n=0;n<attempts&&Date.now()<deadline&&current.status==='PENDING';n++){
  if(n>0)await wait(n<5?300:1000);
  try{const next=await follow(order.id);if(next.id!==order.id)throw Error('原单跟踪返回了不同订单');current=next;await onUpdate(current);}catch{/* A failed receipt read is not a failed trade. Never resubmit. */}
 }
 return current;
}

// All dispatches keep their own stable ID. Transport failure only marks
// unreturned rows unknown; already streamed results are never overwritten.
async function independentRequests(rows,eligible,run,{onResult=()=>{},runMany,preparation=false}={}){
 const seen=new Set(),selected=rows.filter(o=>{if(!eligible(o)||seen.has(o.id))return false;seen.add(o.id);return true;}),results=new Map();
 const errorResult=(o,e)=>({...o,status:preparation||e.details?.requestAccepted===false?'BLOCKED':'SUBMISSION_UNKNOWN',error:{message:e.message,code:e.code||'CLIENT_RESULT_UNKNOWN',details:e.details}});
 const accept=(o,result)=>{if(results.has(o.id))return;results.set(o.id,result);onResult(result);};
 if(runMany&&selected.length>1){
  const byId=new Map(selected.map(o=>[o.id,o]));let failure;
  try{await runMany(selected,event=>{const o=byId.get(event.id);if(!o)throw Error('返回了不匹配的原单');accept(o,event.value||errorResult(o,{...event.error,details:event.details}));});}
  catch(e){failure=e;}
  for(const o of selected)if(!results.has(o.id))accept(o,errorResult(o,failure||Error('未收到本钱包结果，请核对原单')));
 }else await Promise.all(selected.map(async o=>{let result;try{result=await run(o);}catch(e){result=errorResult(o,e);}accept(o,result);}));
 return rows.map(o=>results.get(o.id)||o);
}
export function prepareIndependent(rows,prepare,options={}){return independentRequests(rows,()=>true,prepare,{...options,preparation:true});}
export function runInstantTrades(rows,run,options={}){return independentRequests(rows,o=>['buy','sell'].includes(o.intent.side),run,options);}
export function executeIndependent(rows,submit,{ack=false,...options}={}){return independentRequests(rows,o=>independentOrder(o)&&canExecute(o,ack),o=>submit(o,ack),options);}

export function tradeResultMessage(rows){
 const labels={CONFIRMED:'已确认成交',CONFIRMED_REVIEW:'已上链，金额待核验',PARTIAL:'部分完成，剩余未提交',PENDING:'已提交，等待确认',SUBMISSION_UNKNOWN:'提交状态待核对',SUBMITTING:'正在提交',SKIPPED:'无持仓，已跳过',PREPARED:'待确认',READY_TO_CONTINUE:'待继续确认',SIMULATED:'模拟完成，未提交',BLOCKED:'检查未通过',FAILED:'交易失败，可重新点击',REJECTED:'币安未接受，可重新发起'};
 return rows.map(o=>`${o.intent.account} 号：${isRiskBlockedOrder(o)?'币安风控拦截':o.needsFeeReview?'费用异常，未卖出（查看详情）':labels[o.status]||'需核对'}${o.error?.message&&o.status!=='SKIPPED'?'（'+describeError(o.error)+'）':''}`).join('；');
}
