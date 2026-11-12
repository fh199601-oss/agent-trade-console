import {normalizeMintQuantity} from './mint-quantity.mjs';
// Pure exact arithmetic shared by the dashboard and regression tests.
function decimal(raw,places){const s=raw.toString().padStart(places+1,'0');return places?(s.slice(0,-places)+'.'+s.slice(-places)).replace(/\.?0+$/,''):s;}
export function corlaBudget(project,accounts,scope,quantity){
 if(project?.budgetPolicy==='stars-fixed-quote')return stagedBudget(project,accounts,scope,quantity);
 if(project?.budgetPolicy==='current-wallet-quote')return currentWalletBudget(project,accounts,scope,quantity);
 if(project?.budgetPolicy==='verified-staged-quote')return stagedBudget(project,accounts,scope,quantity);
 if(project?.platform==='binancians')return binanciansBudget(project,accounts,scope,quantity);
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
function binanciansBudget(project,accounts,scope,quantity){
 if(normalizeMintQuantity(quantity)!=='max'||!['paid','all'].includes(scope))return null;
 const rows=accounts.map(a=>project.quotas?.find(q=>q.account===a));if(!rows.length||rows.some(q=>!q))throw Error('请选择钱包并刷新额度');
 const ready=rows.filter(q=>!q.error||['MINT_ENDED','NO_QUOTA','MINT_INELIGIBLE','MINT_PAUSED'].includes(q.errorCode));
 const currency=ready[0]?.budgetCurrency;if(!['BNB','USDT'].includes(currency))throw Error('未取得可核验的付款币和钱包报价，请重新预览');
 let maximum=0n,total=0n;const costs=[],unavailable=[];const bufferBps=1000;
 for(const q of rows){
  if(!ready.includes(q)){unavailable.push({account:q.account,error:q.error});continue;}
  if(q.budgetCurrency!==currency||!Number.isInteger(q.fullBudget?.quantity)||q.fullBudget.quantity<0||q.fullBudget.quantity>500||!/^\d+$/.test(q.fullBudget.raw))throw Error('未取得完整的链上打满报价');
  const raw=BigInt(q.fullBudget.raw),cap=(raw*BigInt(10000+bufferBps)+9999n)/10000n;maximum=cap>maximum?cap:maximum;total+=raw;costs.push({account:q.account,lots:q.fullBudget.quantity,cost:decimal(raw,18),budget:decimal(cap,18),limited:BigInt(q.paidRemaining||'0')>500n,error:q.error});
 }
 return {currency,symbol:currency,decimals:18,token:ready[0].paymentToken,maxBnb:currency==='BNB'?decimal(maximum,18):'0',maxUsdt:currency==='USDT'?decimal(maximum,18):'0',maxQuote:'0',total:decimal(total,18),totalLimit:decimal(maximum*BigInt(accounts.length),18),bufferBps,costs,unavailable};
}

// Only automatic price caps may be refreshed before confirmation. The caller
// supplies a stable snapshot so edits during a request cannot change its scope.
export async function refreshMintBudget({project,asset,accounts,scope,quantity,manual=false},inspect){
 const staged=['verified-staged-quote','current-wallet-quote'].includes(project?.budgetPolicy);
 if(manual||!staged&&(project?.platform!=='binancians'||normalizeMintQuantity(quantity)!=='max')||!['all','paid'].includes(scope))return null;
 const fresh=await inspect(asset);
 if(staged&&fresh?.budgetPolicy!==project.budgetPolicy||fresh?.platform!==project.platform||String(fresh.address).toLowerCase()!==String(project.address).toLowerCase()||String(fresh.token).toLowerCase()!==String(project.token).toLowerCase())throw Error('预算刷新时项目入口或到账代币发生变化，请重新识别');
 return {project:fresh,budget:corlaBudget(fresh,accounts,scope,quantity)};
}

// Generic contracts may have nonlinear prices. Reuse only the exact quantity
// actually simulated for this wallet; never multiply a website's advertised fee.
function currentWalletBudget(project,accounts,scope,quantity){
 if(!['all','paid'].includes(scope))return null;quantity=normalizeMintQuantity(quantity);
 let maximum=0n,total=0n;const costs=[],unavailable=[];
 for(const account of accounts){const q=project.quotas?.find(q=>q.account===account);if(!q)throw Error('请选择钱包并刷新额度');
  if(q.error){unavailable.push({account,error:q.error});continue;}
  const full=quantity==='max'||Number(quantity)===q.fullBudget?.quantity?q.fullBudget:Number(quantity)===1?q.singleBudget:null;
  if(!full)return null;
  if(q.budgetCurrency!=='BNB'||!Number.isInteger(full.quantity)||full.quantity<1||full.quantity>500||!/^\d+$/.test(full.raw)||!['paid','all'].includes(full.scope))throw Error('缺少当前钱包的完整份数报价');
  if(scope==='paid'&&full.scope!=='paid')throw Error('当前入口包含免费份额，不能按纯付费额度自动预算');
  const raw=BigInt(full.raw);maximum=raw>maximum?raw:maximum;total+=raw;costs.push({account,lots:full.quantity,cost:decimal(raw,18)});
 }
 if(!costs.length)throw Error('当前钱包均没有可核验的认购报价');
 return {currency:'BNB',symbol:'BNB',decimals:18,maxBnb:decimal(maximum,18),maxUsdt:'0',maxQuote:'0',total:decimal(total,18),costs,unavailable};
}

// This capability is emitted only by a source-verified adapter with a bounded,
// fixed-price pre-open quote. Public/unbounded inventory is never auto-budgeted.
function stagedBudget(project,accounts,scope,quantity){
 if(!['all','paid'].includes(scope))return null;quantity=normalizeMintQuantity(quantity);
 const rows=accounts.map(a=>project.quotas?.find(q=>q.account===a));if(!rows.length||rows.some(q=>!q))throw Error('请选择钱包并刷新额度');
 let maximum=0n,total=0n;const costs=[],unavailable=[];
 for(const q of rows){
  if(q.error){unavailable.push({account:q.account,error:q.error});continue;}
  if(q.unboundedPaid||!q.fullBudget)throw Error('开盘后需指定份数及最高费用，不能把项目总库存作为钱包额度');
  const full=q.fullBudget;if(q.budgetCurrency!=='BNB'||!Number.isInteger(full.quantity)||full.quantity<0||full.quantity>500||!/^\d+$/.test(full.raw))throw Error('未取得本钱包的完整认购报价');
  const n=quantity==='max'?full.quantity:Number(quantity),raw=BigInt(full.raw);
  if(n>full.quantity||n<0||full.quantity&&raw%BigInt(full.quantity)!==0n)throw Error('份数超过当前可核验额度，请刷新项目');
  const cost=full.quantity?raw*BigInt(n)/BigInt(full.quantity):0n;maximum=cost>maximum?cost:maximum;total+=cost;costs.push({account:q.account,lots:n,cost:decimal(cost,18)});
 }
 if(!costs.length)throw Error('当前钱包均没有可核验的认购报价');
 return {currency:'BNB',symbol:'BNB',decimals:18,maxBnb:decimal(maximum,18),maxUsdt:'0',maxQuote:'0',total:decimal(total,18),costs,unavailable};
}
