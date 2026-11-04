import {percentOf,parseUnits} from './common.mjs';

export function sellAmount(balance,percent){
 if(BigInt(balance)===0n)throw Object.assign(Error('当前钱包无此代币持仓，已跳过；其他有持仓钱包继续执行'),{code:'NO_HOLDINGS',details:{holdingRaw:'0',percent:String(percent)}});
 const amount=percentOf(balance,percent);
 if(amount===0n)throw Object.assign(Error('此比例不足 1 个代币最小单位，请提高比例或选择 100%'),{code:'AMOUNT_TOO_SMALL'});
 return amount;
}

// The official quote uses a fractional value: 0.03 means 3%, not 0.03%.
// Pin that recommendation into the execution arguments so it cannot float
// past the user's cap when the provider builds the actual swap.
export function quotedSlippage(intent,quote){
 if(intent.slippageMode!=='auto')return {mode:'fixed',bps:intent.slippageBps,capBps:intent.slippageBps};
 let fraction;
 try{if(!/^(?:0|1)(?:\.\d{1,18})?$/.test(String(quote.slippage)))throw Error();fraction=parseUnits(String(quote.slippage),18);}catch{throw Object.assign(Error('官方报价没有返回可核验的自动滑点，请切换固定滑点后重新预览'),{code:'SLIPPAGE_UNKNOWN'});}
 const bps=Number((fraction*10000n+10n**18n-1n)/10n**18n);
 if(bps>intent.slippageBps)throw Object.assign(Error(`官方建议卖出滑点 ${bps/100}%，超过你设置的 ${intent.slippageBps/100}% 上限；未提交，可调整卖出滑点后重新点击`),{code:'SLIPPAGE_LIMIT',details:{recommendedBps:bps,capBps:intent.slippageBps}});
 return {mode:'auto',bps,capBps:intent.slippageBps};
}

export function tradeError(e){
 if(Number(e?.code)===30003001){
  const raw=String(e.providerMessage||e.message||'未知原因');
  const message=/potentially risky|risk warning|风险提示/i.test(raw)?'币安要求在 App 查看该代币的风险提示；不会自动重试或提高滑点。':/slippage|滑点/i.test(raw)?'官方返回滑点条件未满足；本次不会自动放宽滑点或重新下单。':'官方返回错误：'+raw;
  return {message,code:e.code,providerMessage:raw};
 }
 return {message:e.message,code:e.code||'ERROR'};
}
