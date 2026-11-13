import {measure} from './diagnostics.mjs';

// Transport failures are not evidence of an absent pool or unsupported ABI.
export function transientRead(error){
 return error?.name==='TimeoutError'||error?.name==='AbortError'||
  ['RPC_UNAVAILABLE','RPC_READ_TIMEOUT','RPC_READ_FAILED','TIMEOUT','NETWORK_ERROR','WARM_YIELDED','SELL_QUOTE_TIMEOUT','SELL_ROUTE_CHECK_TIMEOUT','SELL_ROUTE_READ_FAILED'].includes(error?.code)||
  /timeout|timed out|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|network|socket|RPC HTTP (?:408|429|5\d\d)|超时|网络读取失败/i.test(error?.message||'');
}
export async function checkedRead(stage,label,fn){
 return measure(stage,async()=>{try{return await fn();}catch(error){
  if(error?.code==='WARM_YIELDED'||!transientRead(error))throw error;
  const timeout=error?.name==='TimeoutError'||/timeout|timed out|超时/i.test(error?.message||'');
  throw Object.assign(Error(label+(timeout?'超时':'失败')+'，未取得有效链上结果；本次未提交，可重新点击'),{code:timeout?'RPC_READ_TIMEOUT':'RPC_READ_FAILED',cause:error});
 }});
}
