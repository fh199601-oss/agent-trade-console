import {highRiskBlockText,highRiskBlockMessage} from '../public/error-message.mjs';
// A CLI command being dispatched is not proof that the provider accepted it.
// Keep the allowlist deliberately exact; generic codes/timeouts remain unknown.
const appRiskText='This token has been flagged as potentially risky. Please open the Binance app to review the risk warning and decide whether to proceed.';
const invalidParametersText='The transaction failed due to invalid parameters. Please review the parameters then submit again.';
const insufficientBnbText='The transaction failed because your BNB balance is insufficient to cover this trade. Please top up your BNB balance and retry.';
const swapRefusals=new Map([[appRiskText,'APP_RISK_REVIEW'],[invalidParametersText,'INVALID_PARAMETERS'],[insufficientBnbText,'INSUFFICIENT_BNB'],[highRiskBlockText,'HIGH_RISK_BLOCKED']]);
export function providerRefusalMessage(evidence){
 if(evidence?.kind==='HIGH_RISK_BLOCKED')return highRiskBlockMessage;
 if(evidence?.kind==='APP_RISK_REVIEW')return '币安未接受本次交易：请先在 App 查看该代币风险提示。可重新点击发起新操作，不会自动重发。';
 if(evidence?.kind==='INVALID_PARAMETERS')return '官方明确返回交易参数错误，本次未成功；可重新预览发起新操作，不会自动重发原单。';
 if(evidence?.kind==='INSUFFICIENT_BNB')return 'BNB 余额不足，币安已拒绝本次交易。钱包已解除本笔占用；请检查交易金额和 Gas 余额后重新点击。';
 return null;
}
// The official CLI preserves unknown numeric API codes from a parsed response;
// its transport/time-out codes are different. Never match the message alone.
// Scope 953401 to contract-call execute, not a generic swap/API error.
export function contractRefusal(error,{legacy=false}={}){
 const message=error?.providerMessage||error?.message;
 if(String(error?.code)!=='953401'||message!=='simulation error')return null;
 if(error.responseReceived!==true&&!(legacy&&error.responseReceived===undefined))return null;
 return {kind:'SIMULATION_REJECTED',source:'wallet-provider',operation:'contract-call execute',accepted:false,code:953401,message};
}
const noAcceptance=e=>!!e&&!e.txHash&&!e.transactionHash&&!e.orderId&&e.result==null&&e.receipt==null&&e.submittedAt==null;
export function unsubmittedContractStep(order,entry){
 if(!noAcceptance(entry)||order?.txHash||order?.orderId||order?.result!=null||order?.receipt!=null)return false;
 const outcome=entry.submissionOutcome;
 return outcome?.accepted===false&&(outcome.source==='local-wallet'||outcome.source==='wallet-provider'&&outcome.operation==='contract-call execute'&&outcome.kind==='SIMULATION_REJECTED'&&!!contractRefusal(entry.error));
}
export function applyContractRefusal(order,error,{now=Date.now(),legacy=false}={}){
 const entry=order.steps?.at(-1),evidence=contractRefusal(error,{legacy});
 if(!evidence||order.plan?.kind!=='contract'||!noAcceptance(entry)||order.txHash||order.orderId||order.result!=null||order.receipt!=null||order.steps.slice(0,-1).some(e=>e.status!=='CONFIRMED'))return null;
 const message='钱包执行前模拟未通过，本次未提交链上交易；请按当前额度或持仓重新预览。';
 entry.status='FAILED';entry.error={code:error.code,message,providerMessage:evidence.message,responseReceived:true,...(legacy?{recoveredFromProviderCode:true}:{})};
 entry.submissionOutcome={...evidence,...(legacy?{}:{at:now})};
 order.status=order.intent?.side==='mint'&&order.steps.slice(0,-1).some(e=>e.step?.kind==='mint')?'PARTIAL':'FAILED';
 order.error=entry.error;order.submissionOutcome=evidence;
 if(order.followError){order.resolvedErrors=[...(order.resolvedErrors||[]),{at:now,followError:order.followError}].slice(-10);delete order.followError;}
 // A historical repair date is not the time the transaction failed.
 if(!legacy){order.timing??={};order.timing.finishedAt=now;}
 return order;
}
function repairContractRefusal(order,now){
 const entry=order.steps?.at(-1);
 if(order.plan?.kind!=='contract'||entry?.status!=='SUBMISSION_UNKNOWN'||!entry.requestId||!Number.isFinite(entry.submitStartedAt)||!entry.preview||!entry.step||!['mint','buy','sell','approve'].includes(entry.step.kind))return null;
 // Legacy engine dropped responseReceived but retained the provider's numeric
 // code on BOTH the original and step. Require that exact recorded boundary.
 if(!contractRefusal(order.error,{legacy:true})||!contractRefusal(entry.error,{legacy:true}))return null;
 const fixed=applyContractRefusal(structuredClone(order),entry.error,{legacy:true,now});
 if(fixed)fixed.reconciliation={at:now,method:'explicit-contract-simulation-rejection',previousStatus:order.status,note:'依据原 execute 的明确模拟拒绝响应修正；保留成功步骤，未重新提交'};
 return fixed;
}
export function providerRefusal(error,{legacy=false}={}){
 const message=error?.providerMessage||error?.message;
 if(Number(error?.code)!==30003001||!swapRefusals.has(message))return null;
 if(error.responseReceived!==true&&!(legacy&&error.providerMessage===appRiskText))return null;
 return {kind:swapRefusals.get(message),message,accepted:false};
}
export function repairRejectedOrder(o,{now=Date.now()}={}){
 if(o.status==='SUBMISSION_UNKNOWN'&&o.plan?.kind==='contract')return repairContractRefusal(o,now);
 if(o.status!=='SUBMISSION_UNKNOWN'||o.plan?.kind!=='swap'||!Array.isArray(o.steps)||o.steps.length||!noAcceptance(o)||o.timing?.submittedAt!=null)return null;
 const evidence=providerRefusal(o.error,{legacy:true});if(!evidence)return null;
 const message=providerRefusalMessage(evidence);
 const fixed={...o,status:'REJECTED',error:{...o.error,message,providerMessage:evidence.message},submissionOutcome:evidence,
  reconciliation:{at:now,method:'explicit-provider-preacceptance-refusal',previousStatus:o.status,note:'依据保留的官方完整拒绝响应纠正状态，不以空历史记录推断失败，未重发'}};
 if(o.tracking)fixed.tracking={...o.tracking,state:'finished'};
 if(o.followError){fixed.resolvedErrors=[...(o.resolvedErrors||[]),{at:now,followError:o.followError}].slice(-10);delete fixed.followError;}
 return fixed;
}
