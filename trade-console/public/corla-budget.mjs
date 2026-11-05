import {normalizeMintQuantity} from './mint-quantity.mjs';
// Pure exact arithmetic shared by the dashboard and regression tests.
function decimal(raw,places){const s=raw.toString().padStart(places+1,'0');return places?(s.slice(0,-places)+'.'+s.slice(-places)).replace(/\.?0+$/,''):s;}
export function corlaBudget(project,accounts,scope,quantity){
 if(project?.platform!=='corla'||normalizeMintQuantity(quantity)!=='max'||!['paid','all'].includes(scope))return null;
 const rows=accounts.map(a=>project.quotas?.find(q=>q.account===a));if(!rows.length||rows.some(q=>!q))throw Error('请选择钱包并刷新额度');
 let maximum=0n,total=0n,meta=null;const costs=[];
 for(const q of rows){
  if(q.error&&!['MINT_ENDED','NO_QUOTA','MINT_INELIGIBLE'].includes(q.errorCode))throw Error(q.account+' 号额度尚未核验：'+q.error);
  if(!/^\d+$/.test(q.paidRemaining)||!/^\d+$/.test(q.unitPrice?.raw)||!Number.isInteger(q.paymentDecimals)||q.paymentDecimals<0||q.paymentDecimals>36)throw Error('项目未返回可核验的份数或固定单价');
  const key=[q.budgetCurrency,q.paymentToken?.toLowerCase(),q.paymentDecimals,q.unitPrice.raw].join(':');if(meta&&meta.key!==key)throw Error('钱包的付款币或价格不一致，请重新识别');
  meta={key,currency:q.budgetCurrency,decimals:q.paymentDecimals,token:q.paymentToken,symbol:q.currency};
  const quota=BigInt(q.paidRemaining),lots=quota>500n?500n:quota,cost=lots*BigInt(q.unitPrice.raw);maximum=cost>maximum?cost:maximum;total+=cost;
  costs.push({account:q.account,lots:Number(lots),cost:decimal(cost,q.paymentDecimals),limited:quota>500n,error:q.error});
 }
 return {...meta,maxBnb:meta.currency==='BNB'?decimal(maximum,meta.decimals):'0',maxUsdt:meta.currency==='USDT'?decimal(maximum,meta.decimals):'0',maxQuote:meta.currency==='QUOTE'?decimal(maximum,meta.decimals):'0',perWallet:decimal(maximum,meta.decimals),total:decimal(total,meta.decimals),costs};
}
