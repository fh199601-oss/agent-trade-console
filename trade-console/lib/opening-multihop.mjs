import {Interface,same,BNB,WBNB} from './common.mjs';
import {dexFor,V2_ROUTER_ABI} from './opening-dex.mjs';
const EVENTS=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)','event Withdrawal(address indexed src,uint256 wad)','event Swap(address indexed sender,uint amount0In,uint amount1In,uint amount0Out,uint amount1Out,address indexed to)']);
export function multiHopSettlement({receipt,token,state,wallet:owner,plan,step}){
 const d=dexFor(state),legs=state.legs,path=state.path,native=same(plan.outputToken,BNB);
 if(!d||d.kind!=='v2'||!owner||legs.length!==2||path?.length!==3||!same(path[0],token)||!same(path[2],state.quote)||!same(plan.inputToken,token)||!same(step?.to,d.router)||!(native?same(path[2],WBNB):same(path[2],plan.outputToken)))throw Error('多跳卖出缺少可信路径');
 if(same(legs[0].pool,legs[1].pool)||new Set(path.map(t=>t.toLowerCase())).size!==3)throw Error('多跳卖出路径重复');
 const call=V2_ROUTER_ABI.parseTransaction(step),expected=native?'swapExactTokensForETHSupportingFeeOnTransferTokens':'swapExactTokensForTokensSupportingFeeOnTransferTokens';
 if(call?.name!==expected||call.args[0]!==BigInt(plan.amountIn)||call.args[1]!==BigInt(plan.minOutput)||!same(call.args[3],owner)||call.args[2].length!==3||path.some((a,i)=>!same(a,call.args[2][i])))throw Error('多跳卖出参数不匹配');
 const events=(receipt.logs||[]).flatMap((log,index)=>{try{const e=EVENTS.parseLog(log);return e?[{...e,index,asset:log.address}]:[];}catch{return [];}});
 const transfers=events.filter(e=>e.name==='Transfer');
 let amountIn=0n,firstCredit=0n,output=0n,previousSwap=-1;
 for(let n=0;n<2;n++){
  const p=legs[n],input=path[n],out=path[n+1],from=n===0?owner:legs[n-1].pool,recipient=n===0?legs[1].pool:native?d.router:owner;
  if(p.kind!=='v2'||!same(p.factory,d.factory)||!same(p.quote,out)||!((same(p.token0,input)&&same(p.token1,out))||(same(p.token1,input)&&same(p.token0,out))))throw Error('中转池身份不一致');
  const debits=transfers.filter(e=>same(e.asset,input)&&same(e.args.from,from)&&!same(e.args.to,from));
  const funding=debits.filter(e=>same(e.args.to,p.pool)&&e.args.value>0n),credit=funding.reduce((v,e)=>v+e.args.value,0n);
  if(!funding.length||credit<=0n)throw Error('缺少中转池资金流');
  if(n===0){amountIn=debits.reduce((v,e)=>v+e.args.value,0n);firstCredit=credit;if(amountIn>BigInt(plan.amountIn)||amountIn<credit)throw Error('多跳实际支出不符');}
  else if(credit!==output)throw Error('中转实际到账与下一池输入不符');
  const swaps=events.filter(e=>e.name==='Swap'&&same(e.asset,p.pool));
  const candidates=swaps.filter(e=>e.index>funding.at(-1).index&&e.index>previousSwap&&same(e.args.sender,d.router)&&same(e.args.to,recipient));
  if(candidates.length!==1)throw Error('不能唯一归属中转卖出事件');
  const leg=candidates[0],zero=same(input,p.token0),poolIn=leg.args[zero?'amount0In':'amount1In'],poolOut=leg.args[zero?'amount1Out':'amount0Out'];
  if(poolIn!==credit||poolOut<=0n||leg.args[zero?'amount1In':'amount0In']!==0n||leg.args[zero?'amount0Out':'amount1Out']!==0n)throw Error('中转池输入输出方向不符');
  const boundary=swaps.filter(e=>e.index<leg.index).at(-1)?.index??-1;
  output=transfers.filter(e=>same(e.asset,out)&&e.index>boundary&&e.index<leg.index&&same(e.args.from,p.pool)&&same(e.args.to,recipient)).reduce((v,e)=>v+e.args.value,0n);
  if(output<=0n||output>poolOut)throw Error('多跳未核验实际到账');previousSwap=leg.index;
 }
 if(native){const withdrawals=events.filter(e=>e.name==='Withdrawal'&&same(e.asset,WBNB)&&e.index>previousSwap&&same(e.args.src,d.router));if(withdrawals.length!==1||withdrawals[0].args.wad<output)throw Error('多跳未证明 BNB 解包到账');}
 return {amountIn,amountOut:output,poolAmountIn:firstCredit,attribution:'wallet-funded-multihop'};
}
