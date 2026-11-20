// Read the holder's net credit for the exact fee-supporting router call. Only
// the read-only simulation uses a probe minimum. Never return its calldata.
import {Interface,toQuantity} from 'ethers';
import {WBNB,ERC20,same,native,parseUnits,formatUnits} from './common.mjs';
import {dexFor,V2_ROUTER_ABI} from './opening-dex.mjs';
import {MULTICALL} from './opening-read.mjs';
import {HIGH_FEE_PPM,compoundFees} from './trade-fees.mjs';

const router=new Interface([...V2_ROUTER_ABI.fragments,'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable']);
const balances=new Interface(['function getEthBalance(address) view returns(uint256)']);
const wrapped=token=>native(token)?WBNB:token;
const ppmLoss=(gross,net)=>Number(((gross-net)*1000000n+gross-1n)/gross);
function balanceCall(token,owner){
 return native(token)?{to:MULTICALL,data:balances.encodeFunctionData('getEthBalance',[owner])}:
  {to:token,data:ERC20.encodeFunctionData('balanceOf',[owner])};
}
function balance(result){
 if(!/^0x[\da-f]{64}$/i.test(result?.returnData))throw Error('模拟余额格式无效');
 return BigInt(result.returnData);
}
export function quotedTaxSide(plan,side){
 return plan.audit?.available&&Number(plan.audit.taxes?.[side==='buy'?'buyTax':'sellTax'])>0;
}
export async function withV2NetQuote(rpc,plan,{minimumOutput}={}){
 const step=plan.steps?.at(-1),pool=plan.opening||plan.state,d=pool&&dexFor(pool);
 if(!rpc?.send||!step||d?.kind!=='v2'||!same(d.router,step.to)||!['buy','sell'].includes(step.kind)||
   !(plan.route===d.id+'-opening'||plan.route==='primary-pool'))return plan;
 const owner=plan.wallet,amount=BigInt(plan.amountIn),buyNative=native(plan.inputToken),outNative=native(plan.outputToken);
 const method=buyNative?'swapExactETHForTokensSupportingFeeOnTransferTokens':outNative?'swapExactTokensForETHSupportingFeeOnTransferTokens':'swapExactTokensForTokensSupportingFeeOnTransferTokens';
 const args=Array.from(router.decodeFunctionData(method,step.data)),pos=buyNative?0:1,path=Array.from(args[pos+1]);
 const expected=pool.path||[wrapped(plan.inputToken),wrapped(plan.outputToken)];
 if(!same(args[pos+2],owner)||path.length!==expected.length||path.some((t,i)=>!same(t,expected[i]))||
    !same(path[0],wrapped(plan.inputToken))||!same(path.at(-1),wrapped(plan.outputToken))||
    args[pos]!==BigInt(plan.minOutput)||(buyNative?BigInt(step.value)!==amount:args[0]!==amount||BigInt(step.value)!==0n))throw Error('税后报价的持币人、金额或主池路径不一致');
 const query={to:d.router,data:router.encodeFunctionData('getAmountsOut',[amount,path])};
 const input=balanceCall(plan.inputToken,owner),output=balanceCall(plan.outputToken,owner);
 const calls=[query,input,output];
 if(!buyNative&&plan.steps.some(s=>s.kind==='approve')){
  calls.push({from:owner,to:plan.inputToken,data:ERC20.encodeFunctionData('approve',[d.router,amount])});
 }
 const probe=[...args];probe[pos]=1n;
 calls.push({from:owner,to:d.router,value:toQuantity(BigInt(step.value)),data:router.encodeFunctionData(method,probe)},input,output);
 let net,gross,spent;
 try{
  const block=pool.block!=null?toQuantity(pool.block):'latest';
  const [simulation]=await rpc.send('eth_simulateV1',[{blockStateCalls:[{calls}],validation:false},block]);
  const rows=simulation.calls;
  if(rows.length!==calls.length||rows.some(r=>r.status!=='0x1'))return plan;
  const [amounts]=router.decodeFunctionResult('getAmountsOut',rows[0].returnData);
  if(amounts.length!==path.length||amounts[0]!==amount)return plan;
  gross=amounts.at(-1);spent=balance(rows[1])-balance(rows.at(-2));net=balance(rows.at(-1))-balance(rows[2]);
 }catch{return plan;} // The original full quote and wallet preview remain mandatory.
 if(spent!==amount)throw Error('模拟显示本钱包实际扣款与计划金额不符，已停止');
 if(gross<=0n||net<=0n)throw Error('模拟显示扣税后没有代币到账，已停止');
 const baseline=parseUnits(plan.quote.toCoinAmount,plan.outputDecimals??18);
 if(baseline<=0n)return plan;
 // Some verified project adapters already quote net. Use absolute credit and
 // never apply their known tax percentage a second time.
 const projected=net<baseline?net:baseline;
 const loss=net<gross?ppmLoss(gross,net):0;
 if(step.kind==='buy'&&compoundFees([Math.max(plan.poolFees?.poolFeePpm||0,plan.poolFees?.quoteLossPpm||0),loss])>=HIGH_FEE_PPM)throw Error('本次模拟的买入扣费与主池报价损耗合计达到 50%，已停止');
 const floor=BigInt(minimumOutput??0)>BigInt(plan.authorizationMinOutput??0)?BigInt(minimumOutput):BigInt(plan.authorizationMinOutput??0);
 let minimum=projected*BigInt(10000-plan.slippage.bps)/10000n;
 if(minimum<floor)minimum=floor;
 if(minimum<=0n||net<minimum)throw Error('扣税后实际可得金额低于本次最低到账，已停止');
 args[pos]=minimum;
 const updated={...step,data:router.encodeFunctionData(method,args),...(step.tradeLeg?{tradeLeg:{...step.tradeLeg,minOutput:String(minimum)}}:{})};
 return {...plan,minOutput:String(minimum),transferQuote:{side:step.kind,gross:String(gross),net:String(net),lossPpm:loss},
  quote:{...plan.quote,netCoinAmount:formatUnits(net,plan.outputDecimals??18)},steps:[...plan.steps.slice(0,-1),updated]};
}
