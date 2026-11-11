import * as gang from '../support/curve-trader/adapters/gang.mjs';
import {read,ERC20,BNB,WBNB,USDT,native,same,parseUnits,formatUnits} from './common.mjs';
import {conversions} from './trade-conversion.mjs';
import {codeIdentity} from './discovery.mjs';
export async function legacyGangPlan(rpc,intent,state,owner,balance,sellAmount){
 const buy=intent.side==='buy',quote=native(state.quoteToken)?BNB:state.quoteToken;
 const currency=c=>c==='USDT'?USDT:c==='WBNB'?WBNB:BNB;
 const input=buy?intent.currency==='QUOTE'?quote:currency(intent.currency):state.token;
 const token=state.token,output=buy?token:['AUTO','QUOTE'].includes(intent.currency)?quote:currency(intent.currency);
 const budget=sellAmount??parseUnits(intent.amount,same(input,quote)?state.quoteDecimals:18),convert=args=>conversions(rpc).plan(args);let prefix=null,suffix=null,slip=intent.slippageBps,available=budget;
 if(buy&&!same(input,quote)){prefix=await convert({inputToken:input,outputToken:quote,amount:budget,owner,slippageBps:Math.floor(slip/2)});available=BigInt(prefix.minOutput);slip-=Math.floor(slip/2);}
 if(!buy&&!same(output,quote))slip=Math.floor(slip/2);
 const q=await gang[buy?'quoteBuy':'quoteSell']({rpc,token,wallet:owner,amountIn:available,state,inputToken:buy?quote:token});
 const minimum=q.amountOut*BigInt(10000-slip)/10000n;if(minimum<=0n)throw Error('Gang 最低到账为零');
 const tx=await gang[buy?'buildBuy':'buildSell']({token,wallet:owner,amountIn:available,minAmountOut:minimum,state,inputToken:buy?quote:token});
 const legInput=buy?quote:token,[allowance]=native(legInput)?[available]:await read(rpc,legInput,ERC20,'allowance',[owner,state.spender]);
 const steps=[...(prefix?.steps||[]),...(allowance<available?[{kind:'approve',to:legInput,value:'0',data:ERC20.encodeFunctionData('approve',[state.spender,available]),spender:state.spender,allowance:String(available)}]:[]),{kind:intent.side,...tx,value:String(tx.value),tradeLeg:{inputToken:legInput,outputToken:buy?token:quote,amountIn:String(available),minOutput:String(minimum),settlementRoute:'gang',state}}];
 if(!buy&&!same(output,quote)){suffix=await convert({inputToken:quote,outputToken:output,amount:minimum,owner,slippageBps:intent.slippageBps-slip});steps.push(...suffix.steps);}
 return {kind:'contract',route:'gang',token,wallet:owner,inputToken:input,outputToken:output,amountIn:String(budget),minOutput:suffix?.minOutput||String(minimum),holdingBefore:String(balance),decimals:state.decimals,outputDecimals:buy?state.decimals:suffix?.outputDecimals??state.quoteDecimals,
  stagedTrade:true,gang:true,state,requireSellCredit:!buy,requireTradeCredit:true,protocolIdentities:[await codeIdentity(rpc,state.spender),...(prefix?.identities||[]),...(suffix?.identities||[])],poolFees:suffix?.fees,quote:{...q,fromCoinAmount:formatUnits(budget,buy&&same(input,quote)?state.quoteDecimals:buy?18:state.decimals),fromCoinSymbol:buy?(intent.currency==='QUOTE'?state.quoteSymbol:intent.currency):'项目代币',toCoinSymbol:buy?'项目代币':suffix?intent.currency:state.quoteSymbol,toCoinAmount:formatUnits(suffix?.amountOut??q.amountOut,buy?state.decimals:suffix?.outputDecimals??state.quoteDecimals),quoteToken:quote,quoteSymbol:state.quoteSymbol,conversion:!!(prefix||suffix)},review:[],steps};
}
