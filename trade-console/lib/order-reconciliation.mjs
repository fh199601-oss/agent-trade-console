import {same} from './common.mjs';
const decimal=s=>/^\d+(?:\.\d+)?$/.test(String(s))?String(s).replace(/^0+(?=\d)/,'').replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,''):null;
const arg=(o,name)=>{const a=o.plan?.args||[],i=a.indexOf(name);return i<0?null:a[i+1];};
export function rejectedSwapQuery(o){
 // A complete provider slippage rejection can omit orderId even though a FAILED
 // market order exists. Transport timeouts/other unknown outcomes are excluded.
 if(o.status!=='SUBMISSION_UNKNOWN'||o.plan?.kind!=='swap'||o.orderId||Number(o.error?.code)!==30003001)return null;
 const start=o.timing?.submitStartedAt??o.createdAt;if(!Number.isFinite(start)||!decimal(arg(o,'--fromTokenQty'))||!decimal(arg(o,'--slippage')))return null;
 return {start:start-1000,end:start+180000,args:['market-order','list','--binanceChainId','56','--fromToken',o.plan.inputToken,'--toToken',o.plan.outputToken,'--startTime',String(start-1000),'--endTime',String(start+180000),'--pageSize','100']};
}
export function uniqueFailedSwap(o,result,otherOrders=[]){
 const q=rejectedSwapQuery(o);if(!q||!Array.isArray(result?.list)||Number(result.total)!==result.list.length)return null;
 const matches=result.list.filter(r=>String(r.chain)==='56'&&r.orderType==='market'&&same(r.fromToken,o.plan.inputToken)&&same(r.toToken,o.plan.outputToken)&&decimal(r.fromTokenQty)===decimal(arg(o,'--fromTokenQty'))&&decimal(r.slippage)===decimal(arg(o,'--slippage'))&&Date.parse(r.bookTime)>=q.start&&Date.parse(r.bookTime)<=q.end);
 if(matches.length!==1)return null;const r=matches[0];
 if(r.status!=='FAILED'||r.txHash||!r.orderId||otherOrders.some(x=>x.id!==o.id&&String(x.orderId)===String(r.orderId)))return null;
 return r;
}
export function applyFailedSwap(o,row){
 o.orderId=String(row.orderId);o.receipt=row;o.status='FAILED';
 o.reconciliation={at:Date.now(),method:'official-failed-order-exact-fields',note:'官方原单明确失败；按链、币种、精确数量、滑点和提交时间窗口唯一匹配，未重新下单'};
 return o;
}
