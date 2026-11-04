// A CLI command being dispatched is not proof that the provider accepted it.
// Keep the allowlist deliberately exact; generic codes/timeouts remain unknown.
const appRiskText='This token has been flagged as potentially risky. Please open the Binance app to review the risk warning and decide whether to proceed.';
export function providerRefusal(error,{legacy=false}={}){
 const message=error?.providerMessage||error?.message;
 if(Number(error?.code)!==30003001||message!==appRiskText)return null;
 if(error.responseReceived!==true&&!(legacy&&error.providerMessage===appRiskText))return null;
 return {kind:'APP_RISK_REVIEW',message:appRiskText,accepted:false};
}
export function repairRejectedOrder(o,{now=Date.now()}={}){
 if(o.status!=='SUBMISSION_UNKNOWN'||o.plan?.kind!=='swap'||!Array.isArray(o.steps)||o.steps.length||o.orderId||o.txHash||o.result!=null||o.receipt!=null)return null;
 const evidence=providerRefusal(o.error,{legacy:true});if(!evidence)return null;
 return {...o,status:'REJECTED',error:{...o.error,message:'币安未接受本次交易：请先在 App 查看该代币风险提示。可重新点击发起新操作，不会自动重发。',providerMessage:evidence.message},submissionOutcome:evidence,
  reconciliation:{at:now,method:'explicit-provider-preacceptance-refusal',previousStatus:o.status,note:'依据保留的官方完整风险拦截响应纠正状态，不以空历史记录推断失败，未重发'}};
}
