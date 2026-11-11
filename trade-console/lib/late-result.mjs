import fs from 'node:fs';
import path from 'node:path';
import {hash,save,load} from './common.mjs';
const txHash=x=>typeof x==='string'&&/^0x[\da-f]{64}$/i.test(x)?x:null;
// Preserve only the response needed to find the original. Never store login
// responses, credentials or signed payloads in this recovery mailbox.
export function lateKey(o,entry){
 return hash([o.id,o.intent.account,o.plan.kind,entry?{requestId:entry.requestId,index:entry.index,stage:entry.stage||0,started:entry.submitStartedAt}:{started:o.timing.submitStartedAt}]);
}
export function lateFile(data,o,entry){return path.join(data,'late-results',lateKey(o,entry)+'.json');}
export function lateSink(data,o,entry){
 const key=lateKey(o,entry),file=lateFile(data,o,entry);
 return response=>{
  const r=response.data,e=response.error;
  const event={key,at:Date.now(),...(r?{data:{txHash:txHash(r.txHash||r.transactionHash),orderId:typeof r.orderId==='string'||typeof r.orderId==='number'?String(r.orderId):null}}:{error:{code:e?.code,message:String(e?.message||'钱包迟到响应无效'),responseReceived:e?.responseReceived===true,dispatched:e?.dispatched!==false}})};
  // One command has one definitive response. A duplicate frame cannot replace it.
  if(!fs.existsSync(file))save(file,event);
 };
}
export function readLate(data,o,entry){
 if(!Number.isFinite(entry?entry.submitStartedAt:o.timing?.submitStartedAt))return null;
 const event=load(lateFile(data,o,entry));return event?.key===lateKey(o,entry)?event:null;
}
