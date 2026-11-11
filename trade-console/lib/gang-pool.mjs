import {Interface,read,BNB,WBNB,USDT,ZeroAddress,same,native,parseUnits,formatUnits} from './common.mjs';
import {gangClient,GANG_PAD_ABI} from './gang-modern.mjs';
import {conversions} from './trade-conversion.mjs';
import {compoundFees} from './trade-fees.mjs';
import {codeIdentity} from './discovery.mjs';
import {dexFor,V2_ROUTER_ABI} from './opening-dex.mjs';
const HANDLER=new Interface(['function previewSellNextBlock(address,uint256) view returns(uint256,uint256)','function previewSell(address,uint256) view returns(uint256,uint256)']);
const TOKEN=new Interface(['function buyTaxBps() view returns(uint16)','function sellTaxBps() view returns(uint16)','function OUTER_TAX_BPS() view returns(uint256)']);
export async function gangPoolPlan(rpc,intent,state,owner,balance,{amount}={}){
 const client=gangClient(rpc),buy=intent.side==='buy',quote=native(state.quoteToken)?WBNB:state.quoteToken,meta=await client.meta(quote);
 const input=buy?intent.currency==='QUOTE'?quote:intent.currency==='USDT'?USDT:intent.currency==='WBNB'?WBNB:BNB:state.token;
 const output=buy?state.token:['AUTO','QUOTE'].includes(intent.currency)?(same(quote,WBNB)?BNB:quote):intent.currency==='USDT'?USDT:intent.currency==='WBNB'?WBNB:BNB;
 const amountIn=amount??parseUnits(intent.amount,same(input,quote)?meta.decimals:18),convert=args=>conversions(rpc).plan(args);
 const identities=state.modern?await client.identity(state):[await codeIdentity(rpc,state.spender)];let prefix=null,suffix=null,spend=amountIn,slip=intent.slippageBps;
 if(buy&&!(same(input,quote)||native(input)&&same(quote,WBNB))){prefix=await convert({inputToken:input,outputToken:quote,amount:amountIn,owner,slippageBps:Math.floor(slip/2)});spend=BigInt(prefix.minOutput);slip-=Math.floor(slip/2);}
 if(!buy&&!(same(output,quote)||native(output)&&same(quote,WBNB)))slip=Math.floor(slip/2);
 const officialOutput=!buy&&native(output)&&same(quote,WBNB)?BNB:quote;
 const tax=state.modern?Number((await read(rpc,state.token,TOKEN,buy?'buyTaxBps':'sellTaxBps'))[0]):state.curve?.taxed?Number((await read(rpc,state.token,TOKEN,'OUTER_TAX_BPS'))[0]):0;if(!Number.isInteger(tax)||tax<0||tax>10000)throw Error('Gang 外盘税率无效');
 let handler=null;
 if(!buy&&tax>0&&state.modern){
  const method=state.kind===3&&same(state.pad,'0x2bEbED4be8c8F46C17776C71D7a6A45dbC5CAB29')?'flyTaxHandler':'taxHandler';
  [handler]=await read(rpc,state.pad,GANG_PAD_ABI,method);
  if(same(handler,ZeroAddress))throw Error('Gang 毕业池税收合约未配置');
  identities.push(await client.identityFor(rpc,handler));
 }
 const quotedOutput=buy?async(pool,raw)=>raw*(10000n-BigInt(tax))/10000n:async(pool,raw)=>{
  if(!tax)return raw;
  if(!state.modern){const dex=dexFor(pool);if(dex?.kind!=='v2')throw Error('该旧版税币须使用支持转账扣税的 V2 池');return (await read(rpc,dex.router,V2_ROUTER_ABI,'getAmountsOut',[amountIn*BigInt(10000-tax)/10000n,pool.path||[state.token,quote]],pool.block))[0].at(-1);}
  try{return (await read(rpc,handler,HANDLER,'previewSellNextBlock',[state.token,amountIn]))[0];}
  catch(e){if(!(e.data==='0x'||e.code==='BAD_DATA'&&e.value==='0x'))throw e;return (await read(rpc,handler,HANDLER,'previewSell',[state.token,amountIn]))[0];}
 };
 const trade=await convert({inputToken:buy?(prefix?quote:input):input,outputToken:buy?state.token:officialOutput,amount:spend,owner,slippageBps:slip,preferredPool:state.pair||state.curve?.pair,quotedOutput});
 // Conversion planner emits the exact DEX call. The UI still describes the
 // user's primary action as buy/sell and validates its own asset credit.
 trade.steps.at(-1).kind=intent.side;
 if(!buy&&!same(output,officialOutput)){suffix=await convert({inputToken:officialOutput,outputToken:output,amount:BigInt(trade.minOutput),owner,slippageBps:intent.slippageBps-slip});}
 const result=suffix||trade,fees={source:'Gang 已毕业：固定工厂池及中转池',poolFeePpm:compoundFees([...(prefix?[prefix.fees.poolFeePpm]:[]),trade.fees.poolFeePpm,...(suffix?[suffix.fees.poolFeePpm]:[])]),pools:[...(prefix?.fees.pools||[]),...trade.fees.pools,...(suffix?.fees.pools||[])]};
 return {kind:'contract',route:'gang-pool',token:state.token,wallet:owner,account:intent.account,inputToken:input,outputToken:result.outputToken,amountIn:String(amountIn),minOutput:result.minOutput,holdingBefore:String(balance),decimals:18,outputDecimals:result.outputDecimals,gang:true,stagedTrade:true,state:{...state,...(!buy?{verifiedSellTaxBps:tax}:{})},requireSellCredit:!buy,requireTradeCredit:true,poolFees:fees,
  protocolIdentities:[...identities,...(prefix?.identities||[]),...trade.identities,...(suffix?.identities||[])],slippage:{mode:'fixed',bps:intent.slippageBps,capBps:intent.slippageBps},quote:{fromCoinAmount:formatUnits(amountIn,buy&&same(input,quote)?meta.decimals:18),fromCoinSymbol:buy?(intent.currency==='QUOTE'?meta.symbol:intent.currency):'项目代币',toCoinSymbol:buy?'项目代币':suffix?intent.currency:same(quote,WBNB)?'BNB':meta.symbol,toCoinAmount:formatUnits(result.amountOut,result.outputDecimals),quoteSymbol:meta.symbol,quoteToken:state.quoteToken,conversion:!!(prefix||suffix)},review:[],steps:[...(prefix?.steps||[]),...trade.steps,...(suffix?.steps||[])]};
}
