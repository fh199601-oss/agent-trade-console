import {BNB,WBNB,ERC20,read,wallet,same,formatUnits} from './common.mjs';
import {freshOpeningSnapshot} from './opening-pools.mjs';
import {dexFor,matchesCurrency} from './opening-dex.mjs';
import {sellAmount,quotedSlippage} from './sell-policy.mjs';
import {openingPlan} from './opening-route.mjs';
import {unsubmittedContractStep} from './provider-outcome.mjs';

// A retry needs proof of a reverted or locally unsubmitted sale, not a timeout, successful
// receipt with an undecoded payout, or a failed approval. Old tasks never opt in.
export function recoverableOpeningSale(order){
 const entry=order?.steps?.at(-1),plan=entry?.plan||order?.plan;
 let reverted=false;try{reverted=entry?.receipt?.status!==undefined&&BigInt(entry.receipt.status)===0n;}catch{}
 const unsubmitted=unsubmittedContractStep(order,entry);
 const failedOnChain=order?.error?.code==='TRANSACTION_REVERTED'&&entry?.revertVerified===true&&reverted&&/^0x[\da-f]{64}$/i.test(entry.txHash||'');
 return order?.status==='FAILED'&&entry?.status==='FAILED'&&entry.step?.kind==='sell'&&(failedOnChain||unsubmitted)&&plan?.requireSellCredit===true&&!!dexFor(plan.opening)&&order.steps.slice(0,-1).every(e=>e.status==='CONFIRMED'&&e.step?.kind==='approve');
}
export async function openingRecoveryPlan(rpc,bridge,intent,original,{scan,snapshot,preparation}={}){
 if(!intent.openingOnly||intent.side!=='sell'||!recoverableOpeningSale(original)||original.intent.account!==intent.account||
  !same(original.intent.asset,intent.asset)||original.intent.percent!==intent.percent||original.intent.slippageBps!==intent.slippageBps||original.intent.currency!==intent.currency||original.intent.gasLimit!==intent.gasLimit)
  throw Error('备用卖出缺少已核验的未成交原单或原交易约束不一致');
 const previous=original.steps.at(-1).plan||original.plan,owner=wallet(intent.account).address;
 if(!same(owner,previous.wallet))throw Error('备用卖出钱包绑定已变化');
 snapshot=freshOpeningSnapshot(snapshot,intent.asset)?snapshot:await scan(intent.asset,{currency:intent.currency});
 const quoteToken=same(previous.outputToken,BNB)?WBNB:previous.outputToken;
 if(!snapshot.pools.some(p=>p.liquid&&dexFor(p)&&matchesCurrency(p,intent.currency)&&same(p.quote,quoteToken)))throw Error('备用卖出未核验到原到账币种的外盘流动性');
 const [meta,[balance]]=await Promise.all([preparation.token(intent.asset),read(rpc,intent.asset,ERC20,'balanceOf',[owner])]);
 if(!previous.identity?.fingerprint||meta.identity?.fingerprint!==previous.identity.fingerprint)throw Object.assign(Error('回滚后代币合约身份已变化，停止备用卖出'),{code:'OPENING_RECOVERY_IDENTITY_CHANGED'});
 const amount=sellAmount(balance,intent.percent);
 if(String(balance)!==previous.holdingBefore||String(amount)!==previous.amountIn)throw Object.assign(Error('回滚后持仓已变化，停止备用卖出，避免与手动交易重复'),{code:'OPENING_RECOVERY_HOLDINGS_CHANGED'});
 // The aggregate endpoint cannot enforce a user-selected gas ceiling. Rebuild
 // a verified direct route once, preserving that ceiling and the exact asset
 // constraints, instead of silently dropping it during recovery.
 if(intent.gasLimit!==undefined){
  const plan=await openingPlan(rpc,bridge,intent,{preparation,scan:async()=>({...snapshot,pools:snapshot.pools.filter(p=>same(p.quote,quoteToken))})});
  if(plan.holdingBefore!==previous.holdingBefore||plan.amountIn!==previous.amountIn||!same(plan.outputToken,previous.outputToken))throw Object.assign(Error('备用直连卖出的持仓或到账币种已变化'),{code:'OPENING_RECOVERY_HOLDINGS_CHANGED'});
  return {...plan,recovery:{originalId:original.id,reason:original.steps.at(-1).revertVerified?'verified-revert':'not-dispatched',maxAttempts:1}};
 }
 const args=['--binanceChainId','56','--fromToken',intent.asset,'--toToken',previous.outputToken,'--fromTokenQty',formatUnits(amount,meta.decimals),'--slippage',String(intent.slippageBps/100)];
 const quote=await bridge.call(intent.account,['market-order','quote',...args]);
 if(!quote.toCoinAmount||!Number.isFinite(Number(quote.toCoinAmount))||Number(quote.toCoinAmount)<=0)throw Object.assign(Error('备用卖出暂时没有有效聚合报价'),{code:'OPENING_QUOTE_UNAVAILABLE'});
 const slippage=quotedSlippage(intent,quote);
 return {kind:'swap',route:'binance-aggregate',wallet:owner,token:intent.asset,inputToken:intent.asset,outputToken:previous.outputToken,
  amountIn:String(amount),holdingBefore:String(balance),decimals:meta.decimals,identity:meta.identity,quote,slippage,args,review:[],steps:[],
  opening:snapshot.pools.find(p=>p.liquid&&dexFor(p)&&same(p.quote,quoteToken)),recovery:{originalId:original.id,reason:original.steps.at(-1).revertVerified?'verified-revert':'not-dispatched',maxAttempts:1}};
}
