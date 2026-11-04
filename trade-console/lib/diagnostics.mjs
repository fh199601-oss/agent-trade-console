import {failureKind} from '../public/failure-kind.mjs';
export {failureKind} from '../public/failure-kind.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {performance} from 'node:perf_hooks';

const local=new AsyncLocalStorage();
const ms=n=>Math.round(n*100)/100;
export function count(name,n=1){const s=local.getStore();if(s)s.counters[name]=(s.counters[name]||0)+n;}
export async function measure(name,fn){
 const s=local.getStore();if(!s)return fn();const start=performance.now();let ok=false;
 try{const value=await fn();ok=true;return value;}finally{
  const stage=s.stages[name]??={calls:0,failed:0,totalMs:0,maxMs:0};const elapsed=performance.now()-start;
  stage.calls++;if(!ok)stage.failed++;stage.totalMs+=elapsed;stage.maxMs=Math.max(stage.maxMs,elapsed);
 }
}
export function snapshot(){
 const s=local.getStore();if(!s)return null;
 return {operation:s.operation,totalMs:ms(performance.now()-s.start),stages:Object.fromEntries(Object.entries(s.stages).map(([k,v])=>[k,{...v,totalMs:ms(v.totalMs),maxMs:ms(v.maxMs)}])),counters:{...s.counters},note:'各阶段可能并行或嵌套，不能相加作为总耗时；不包含签名、广播和链上确认'};
}
export function profiled(operation,fn){return local.run({operation,start:performance.now(),stages:{},counters:{}},fn);}

export function preflightReport(o){
 const p=o.plan,error=o.error,kind=error?failureKind(error):null;
 const approvalOnly=o.intent?.side==='mint'&&p?.steps?.[0]?.kind==='approve';
 return {readOnly:true,passed:o.status==='PREPARED',needAiDeep:kind==='adapter_needed',failureKind:kind,
  checks:{targetIdentified:!!(p?.identity||o.mintContext?.identity),officialPreviewPassed:!!o.preview,mintSimulationPassed:o.intent?.side==='mint'?!!o.preview&&!approvalOnly:null,approvalOnly:!!approvalOnly,sourceVerified:p?.metaVerified??o.mintContext?.sourceVerified??null},
  warnings:[...new Set([...(o.review||[]),...(p?.review||[])])],
  note:approvalOnly?'当前仅授权步骤通过官方预览；Mint 需要授权确认后另行模拟，尚未证明 Mint 可执行。':'预检和模拟不等于安全审计或成交；失败经验不会跳过本次链上核验'};
}
