import {AbiCoder} from 'ethers';
import {Interface,WBNB,ZeroAddress,native,same} from './common.mjs';
import {INFINITY,INF_ROUTER,INF_MANAGER,POOL_KEY,infinityId,infinityFee,infinityApprovals} from './infinity.mjs';
const coder=AbiCoder.defaultAbiCoder();
const EVENTS=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)','event Deposit(address indexed dst,uint256 wad)','event Withdrawal(address indexed src,uint256 wad)']);
export const INFINITY_BUY=INFINITY.id+'-buy';
export function infinityBuyPool(pool,output){
 const input=same(pool.token0,output)?pool.token1:same(pool.token1,output)?pool.token0:null;
 if(!input||!same(pool.factory,INFINITY.factory)||infinityId(pool.key)!==pool.pool)throw Error('Infinity 买入池身份不匹配');
 if(!Number.isInteger(pool.protocolFee)||!Number.isInteger(pool.lpFee))throw Error('Infinity 买入方向费率尚未核验');
 return {...pool,inputCurrency:input,fee:infinityFee([0,0,pool.protocolFee,pool.lpFee],same(input,pool.token0))};
}
// Official UniversalRouter commands and Infinity actions. Exact input, no
// allow-revert flags, credit to the caller, bounded settlement and minimum credit.
export function infinityBuyData(pool,inputToken,outputToken,owner,amount,minimum){
 const p=infinityBuyPool(pool,outputToken),currency=p.inputCurrency;
 if(amount<=0n||amount>=(1n<<127n)||minimum<=0n||minimum>=(1n<<128n))throw Error('Infinity 买入金额或最低到账无效');
 if(!(native(inputToken)?same(currency,ZeroAddress)||same(currency,WBNB):same(inputToken,currency)||same(inputToken,WBNB)&&same(currency,ZeroAddress)))throw Error('Infinity 买入付款币不匹配');
 let commands='',inputs=[],actions='0x06',params=[coder.encode([`(${POOL_KEY},bool,uint128,uint128,bytes)`],[[p.key,same(currency,p.token0),amount,minimum,'0x']])];
 if(native(inputToken)&&same(currency,WBNB)){
  commands+='0b';inputs.push(coder.encode(['address','uint256'],[INFINITY.router,amount]));
  actions+='0b';params.push(coder.encode(['address','uint256','bool'],[currency,amount,false]));
 }else{
  if(same(inputToken,WBNB)&&same(currency,ZeroAddress)){
   commands+='020c';inputs.push(coder.encode(['address','address','uint160'],[WBNB,INFINITY.router,amount]),coder.encode(['address','uint256'],[INFINITY.router,amount]));
  }
  actions+='0c';params.push(coder.encode(['address','uint256'],[currency,amount]));
 }
 actions+='0f';params.push(coder.encode(['address','uint256'],[outputToken,minimum]));
 commands+='10';inputs.push(coder.encode(['bytes','bytes[]'],[actions,params]));
 return INF_ROUTER.encodeFunctionData('execute',['0x'+commands,inputs,Math.floor(Date.now()/1000)+120]);
}
export async function infinityBuySteps(rpc,pool,inputToken,outputToken,owner,amount,minimum){
 return [...(native(inputToken)?[]:await infinityApprovals(rpc,inputToken,owner,amount)),{kind:'buy',to:INFINITY.router,value:native(inputToken)?String(amount):'0',data:infinityBuyData(pool,inputToken,outputToken,owner,amount,minimum)}];
}
export function infinityBuySettlement({receipt,wallet:owner,state,plan,step}){
 const pool=infinityBuyPool(state,plan.outputToken),amount=BigInt(plan.amountIn),minimum=BigInt(plan.minOutput),nativeInput=native(plan.inputToken);
 if(!same(owner,plan.wallet)||!same(step.to,INFINITY.router)||BigInt(step.value)!==(nativeInput?amount:0n))throw Error('Infinity 买入原单身份不符');
 const expected=INF_ROUTER.decodeFunctionData('execute',infinityBuyData(pool,plan.inputToken,plan.outputToken,owner,amount,minimum)),actual=INF_ROUTER.decodeFunctionData('execute',step.data);
 if(actual[0]!==expected[0]||JSON.stringify([...actual[1]])!==JSON.stringify([...expected[1]]))throw Error('Infinity 买入原单参数不符');
 const transfers=[],wraps=[],swaps=[];
 for(const l of receipt.logs||[])try{
  if(same(l.address,INFINITY.factory)){const e=INF_MANAGER.parseLog(l);if(e?.name==='Swap'&&e.args.id===pool.pool&&same(e.args.sender,INFINITY.router))swaps.push(e.args);}
  if([plan.inputToken,plan.outputToken,WBNB].some(t=>same(t,l.address))){const e=EVENTS.parseLog(l);if(e?.name==='Transfer')transfers.push({asset:l.address,...e.args.toObject()});else if(e)wraps.push({asset:l.address,name:e.name,...e.args.toObject()});}
 }catch{}
 const zero=same(pool.inputCurrency,pool.token0),out=swaps[0]?.[zero?'amount1':'amount0'],spent=swaps[0]?-swaps[0][zero?'amount0':'amount1']:0n;
 if(swaps.length!==1||spent!==amount||out<=0n)throw Error('Infinity 买入回执方向或金额不符');
 if(!nativeInput){const debit=transfers.filter(t=>same(t.asset,plan.inputToken)&&same(t.from,owner)&&!same(t.to,owner));if(debit.reduce((n,t)=>n+t.value,0n)!==amount||debit.some(t=>![INFINITY.vault,INFINITY.router].some(a=>same(a,t.to))))throw Error('Infinity 买入付款归属不符');}
 if(nativeInput&&same(pool.inputCurrency,WBNB)){const deposits=wraps.filter(e=>e.name==='Deposit'&&same(e.dst,INFINITY.router));if(deposits.length!==1||deposits[0].wad!==amount)throw Error('Infinity 买入包装金额不符');}
 if(!nativeInput&&same(pool.inputCurrency,ZeroAddress)){const withdrawals=wraps.filter(e=>e.name==='Withdrawal'&&same(e.src,INFINITY.router));if(withdrawals.length!==1||withdrawals[0].wad!==amount)throw Error('Infinity 买入解包金额不符');}
 const credit=transfers.filter(t=>same(t.asset,plan.outputToken)&&same(t.from,INFINITY.vault)&&same(t.to,owner)).reduce((n,t)=>n+t.value,0n);
 if(credit<minimum||credit>out)throw Error('Infinity 买入回执未证明本钱包足额到账');
 return {amountIn:amount,amountOut:credit,attribution:'wallet-funded-infinity-buy'};
}
