// Shared with the backend; no credentials, URLs or request payloads in summaries.
export const safeErrorText=value=>String(value??'').replace(/https?:\/\/[^\s"'<>]+/gi,'[节点或接口地址已隐藏]').replace(/\b(Bearer\s+)[\w.\-]+/gi,'$1[已隐藏]').replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)[^\s,;]+/gi,'$1[已隐藏]').slice(0,1000);
export const highRiskBlockText='This transaction was blocked due to significant high risk, it is not allowed to approve transactions like this because the risk impact is too high.';
// A shared numeric error code is not a diagnosis. Match the complete reason;
// settlement additionally requires an actual parsed provider response.
export const isHighRiskBlock=error=>String(error?.code)==='30003001'&&(error?.providerMessage||error?.message)===highRiskBlockText;
export const highRiskBlockMessage='币安风控已拦截本次交易：风险过高，官方不允许执行。调整滑点或重复点击无法解除当前限制。';
function source(error){
 const d=error?.details,s=d?.simulationErrorDetail??error?.simulationErrorDetail;
 const strings=[];const take=(v,depth=0)=>{if(depth>3)return;if(Array.isArray(v)){for(const x of v)take(x,depth+1);return;}if(typeof v==='string')strings.push(v);else if(v&&typeof v==='object')for(const key of ['message','reason','error','errorMessage','revertReason','detail','simulationErrorDetail'])take(v[key],depth+1);};
 take(s);take(error?.providerMessage);take(error?.message??error);return strings.join(' · ');
}
export function errorCategory(error){
 if(isHighRiskBlock(error))return 'risk_blocked';
 const s=source(error),code=String(error?.code||'');
 if(code==='GAS_BALANCE_LOW'||/insufficient funds for gas|gas.*(?:insufficient|不足)|(?:BNB|原生币).*不足.*(?:gas|手续费)/i.test(s))return 'gas_balance';
 if(/out of gas|gas required exceeds|intrinsic gas too low/i.test(s))return 'gas_limit';
 if(code==='INSUFFICIENT_BALANCE'||/insufficient.*(?:balance|funds)|balance.*(?:insufficient|too low)|exceeds balance|余额不足/i.test(s))return 'balance';
 if(/insufficient allowance|exceeds allowance|allowance.*(?:insufficient|too low)|授权额度不足/i.test(s))return 'allowance';
 if(code==='SLIPPAGE_LIMIT'||/Too little received|INSUFFICIENT_OUTPUT_AMOUNT|InsufficientOutputAmount|TooLittleReceived|PriceLimit|slippage|最低到账|滑点条件/i.test(s))return 'slippage';
 if(/QUOTE_CONVERSION_UNAVAILABLE|SELL_ROUTE_UNAVAILABLE|SELL_QUOTE_UNAVAILABLE/.test(code)||/No liquidity|insufficient liquidity|流动性不足|没有可用报价/i.test(s))return 'liquidity';
 if(code==='SELL_POOL_BUSY')return 'pool_busy';
 if(/session.*expired|SESSION_EXPIRED|UNCONNECTED|not connected|not logged in/i.test(s))return 'session';
 if(['RPC_READ_FAILED','RPC_READ_TIMEOUT','RPC_UNAVAILABLE'].includes(code)||/timeout|timed out|fetch failed|HTTP (?:429|5\d\d)|network error|ECONN|missing trie node/i.test(s))return 'network';
 return null;
}
export const errorLabels={risk_blocked:'币安风控拦截',balance:'余额不足',gas_balance:'BNB 手续费余额不足',gas_limit:'Gas 上限不足',allowance:'授权额度不足',slippage:'价格变化超出滑点',liquidity:'暂无可用兑换路径',pool_busy:'等待同池原单确认',session:'钱包登录已失效',network:'网络查询失败'};
export function describeError(error){
 if(!error)return '';
 if(isHighRiskBlock(error))return highRiskBlockMessage;
 const raw=safeErrorText(source(error)),message=safeErrorText(error.message??error),category=errorCategory(error);
 const known={balance:'付款币或卖出代币余额不足，请刷新持仓并检查交易数量',gas_balance:'BNB 余额不足以支付交易手续费，请补充 BNB 后重试',gas_limit:'交易所需 Gas 超过本笔上限，交易未完成；请重新估算 Gas',allowance:'代币授权额度不足，需完成本笔必要授权后才能交易',slippage:'预计到账低于本笔最低到账，价格变化超出滑点限制；请按最新报价重试',liquidity:'未找到符合本次币种和费用限制的可成交路径，请检查池子是否开盘及计价币',pool_busy:'同一池子前一笔卖出尚未确认，本次尚未提交；后台继续核对原单',session:'钱包登录已失效或尚未连接，请通过原钱包入口重新连接',network:'节点或接口查询失败，尚未取得可靠结果；请稍后重试'};
 // Keep a specific existing Chinese explanation, including balances/quotas.
 const generic=/^(?:钱包模拟未明确通过|simulation error|execution reverted|预览未通过|检查未通过)$/i.test(message);
 if(category&&(!/[\u3400-\u9fff]/.test(message)||generic))return known[category];
 if(/[\u3400-\u9fff]/.test(message))return message;
 if(/FreeRoundOver|FreeMintEnded/.test(raw))return '免费铸造阶段已结束';
 if(/SoldOut|sold out/i.test(raw))return '项目可用额度已售罄';
 if(/NotAgent|AgentIdRequired/i.test(raw))return '当前钱包没有满足该项目要求的 Agent ID 资格';
 if(/execution reverted|simulation error/i.test(raw))return '合约模拟执行回滚；接口没有返回可识别的具体原因，本次未通过检查';
 return '请求失败：接口返回了未识别的错误'+(error.code?'（错误码 '+safeErrorText(error.code)+'）':'')+'；可在详情查看原始返回';
}
export function presentError(error){const message=describeError(error),raw=safeErrorText(source(error));return {message,code:error?.code||'ERROR',...(raw&&raw!==message?{providerMessage:raw}:{})};}
