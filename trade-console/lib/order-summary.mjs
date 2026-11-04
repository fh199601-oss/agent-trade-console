// List rows are display data only. The original complete order is fetched by
// ID before review/follow; no calldata, proofs or preview tokens are truncated
// in persistent storage or in the execution workflow.
export function orderSummary(o){
 const project=o.project||o.plan?.project||o.plan?.resolved;
 return {summary:true,id:o.id,status:o.status,createdAt:o.createdAt,updatedAt:o.updatedAt,timing:o.timing,simulationOnly:o.simulationOnly,orderId:o.orderId,txHash:o.txHash,
  intent:Object.fromEntries(['account','side','asset','percent','amount','currency','quantity','scope'].filter(k=>o.intent?.[k]!==undefined).map(k=>[k,o.intent[k]])),
  project:project?{name:project.name,address:project.address,source:project.source}:undefined,
  plan:o.plan?{slippage:o.plan.slippage,steps:o.plan.steps?.map(s=>({kind:s.kind}))}:undefined,
  error:o.error?{code:o.error.code,message:o.error.message,providerMessage:o.error.providerMessage,...(o.error.details?.routes?{details:{routes:o.error.details.routes}}:{})}:undefined};
}
