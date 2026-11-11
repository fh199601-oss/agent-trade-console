import {AbiCoder,keccak256} from 'ethers';
import {Interface,address,read,same,ZeroAddress,BNB,WBNB,ERC20} from './common.mjs';
import {openingReads} from './opening-read.mjs';

// Official BSC deployments: developer.pancakeswap.finance/contracts/infinity/resources/addresses
// and /contracts/permit2/addresses. No project or user address is embedded here.
export const INFINITY={id:'pancake-infinity-cl',kind:'infinity-cl',factory:'0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b',router:'0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB',quoter:'0xd0737C9762912dD34c3271197E362Aa736Df0926',vault:'0x238a358808379702088667322f80aC48bAd5e6c4',permit2:'0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768'};
export const POOL_KEY='(address currency0,address currency1,address hooks,address poolManager,uint24 fee,bytes32 parameters)';
export const INF_MANAGER=new Interface([
 'function poolIdToPoolKey(bytes32) view returns(address currency0,address currency1,address hooks,address poolManager,uint24 fee,bytes32 parameters)',
 'function getSlot0(bytes32) view returns(uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
 'function getLiquidity(bytes32) view returns(uint128)',
 'event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,address hooks,uint24 fee,bytes32 parameters,uint160 sqrtPriceX96,int24 tick)',
 'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee,uint16 protocolFee)'
]);
export const INF_QUOTER=new Interface([`function quoteExactInputSingle((${POOL_KEY} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData)) returns(uint256 amountOut,uint256 gasEstimate)`]);
export const INF_ROUTER=new Interface(['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable']);
export const PERMIT2=new Interface(['function approve(address token,address spender,uint160 amount,uint48 expiration)','function allowance(address owner,address token,address spender) view returns(uint160 amount,uint48 expiration,uint48 nonce)']);
const GETTERS=new Interface(['function vault() view returns(address)','function clPoolManager() view returns(address)','function poolManager() view returns(address)']);
const EVENTS=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)','event Deposit(address indexed dst,uint256 wad)','event Withdrawal(address indexed src,uint256 wad)']);
const coder=AbiCoder.defaultAbiCoder(),topic=a=>'0x'+a.slice(2).toLowerCase().padStart(64,'0');
export const infinityId=key=>keccak256(coder.encode([POOL_KEY],[key]));
export function infinityFee(slot,zeroForOne){const protocol=Number(slot[2]),lp=Number(slot[3]),p=zeroForOne?protocol&4095:protocol>>12;if(p>4000||lp<0||lp>1000000)throw Error('Infinity 费率字段无效');return p+lp-Math.floor(p*lp/1000000);}

// Singleton pools have a bytes32 id, NOT a pair address. Discover from manager
// events / token transfers to the official Vault, then read the full key back.
export class InfinityPools{
 constructor(rpc,{now=Date.now}={}){this.rpc=rpc;this.now=now;this.cache=new Map();this.pending=new Map();}
 async scan(token,{expand=false,deep=true}={}){
  const key=token.toLowerCase();if(this.pending.has(key))return this.pending.get(key);
  const work=this.inspect(address(token),expand,deep);this.pending.set(key,work);try{return await work;}finally{this.pending.delete(key);}
 }
 async inspect(token,expand,deep){
  const key=token.toLowerCase();let e=this.cache.get(key);if(!e){e={ids:[],at:0};this.cache.set(key,e);if(this.cache.size>128)this.cache.delete(this.cache.keys().next().value);}
  const height=await this.rpc.getBlockNumber(),errors=[];
  const deepDue=deep&&(!e.deepAt||this.now()-e.deepAt>60000);
  if(!e.ids.length||expand||this.now()-e.at>15000){
   if(deepDue||expand||this.now()-e.at>1500||!e.at){
    e.at=this.now();try{const ids=await this.discover(token,height,{expand,deep:deepDue});e.ids=[...new Set([...ids,...e.ids])].slice(0,16);if(deepDue||expand)e.deepAt=this.now();}catch(err){errors.push('Infinity 池发现暂不可用：'+err.message);}
   }
  }
  const pools=[];
  await Promise.all(e.ids.map(async id=>{try{const p=await this.state(token,id,height);if(p)pools.push(p);}catch(err){errors.push('Infinity 池核验暂不可用：'+err.message);}}));
  return {pools,errors,block:height};
 }
 async discover(token,height,{expand=false,deep=true}={}){
  // Bounded cold history: a quiet pool must not disappear just because no one
  // traded in the last few blocks. Never infer a pool from an arbitrary log.
  let ids=[];for(const [back,span] of (deep||expand?[[0,256],[256,1792],[2048,2048],[4096,4096]]:[[0,256]])){
   const end=height-back;if(end<0)break;
   const chunks=Array.from({length:Math.ceil(span/512)},(_,i)=>[Math.max(0,end-Math.min(span,(i+1)*512)+1),end-i*512]).filter(x=>x[1]>=0);
   const found=await Promise.allSettled(chunks.map(([start,end])=>this.discoverRange(token,start,end)));
   ids.push(...found.flatMap(r=>r.status==='fulfilled'?r.value:[]));if(ids.length&&!expand)break;
   if(found.every(r=>r.status==='rejected'))throw found[0].reason;
  }return [...new Set(ids)];
 }
 async discoverRange(token,start,height){
  const init=INF_MANAGER.getEvent('Initialize').topicHash,transfer=EVENTS.getEvent('Transfer').topicHash;
  const filters=[
   ...[1,2].map(pos=>({address:INFINITY.factory,topics:pos===1?[init,null,topic(token)]:[init,null,null,topic(token)]})),
   ...[1,2].map(pos=>({address:token,topics:pos===1?[transfer,topic(INFINITY.vault)]:[transfer,null,topic(INFINITY.vault)]}))
  ];
  const rows=await Promise.allSettled(filters.map(filter=>this.rpc.send('eth_getLogs',[{...filter,fromBlock:'0x'+start.toString(16),toBlock:'0x'+height.toString(16)}])));
  const ids=[],hashes=[];let successes=0;
  rows.forEach((r,n)=>{if(r.status!=='fulfilled'||!Array.isArray(r.value))return;successes++;for(const l of r.value.slice(-128)){
   if(l.removed||Number(BigInt(l.blockNumber))<start||Number(BigInt(l.blockNumber))>height)continue;
   try{if(n<2&&same(l.address,INFINITY.factory)){const ev=INF_MANAGER.parseLog(l);if(ev.name==='Initialize'&&[ev.args.currency0,ev.args.currency1].some(a=>same(a,token)))ids.push(ev.args.id);}
    else if(n>=2&&same(l.address,token)){const ev=EVENTS.parseLog(l);if(ev.name==='Transfer'&&[ev.args.from,ev.args.to].some(a=>same(a,INFINITY.vault))&&/^0x[\da-f]{64}$/i.test(l.transactionHash))hashes.push(l.transactionHash);}
   }catch{}
  }});
  if(!successes)throw Error('公共 RPC 日志查询失败');
  const receipts=await Promise.allSettled([...new Set(hashes)].slice(-6).map(h=>this.rpc.getTransactionReceipt(h)));
  for(const r of receipts)if(r.status==='fulfilled'&&r.value&&BigInt(r.value.status)===1n)for(const l of r.value.logs||[]){if(l.removed||!same(l.address,INFINITY.factory))continue;try{const ev=INF_MANAGER.parseLog(l);if(ev?.name==='Swap')ids.push(ev.args.id);}catch{}}
  return [...new Set(ids)];
 }
 async state(token,id,block='latest'){
  const result=await openingReads(this.rpc,['poolIdToPoolKey','getSlot0','getLiquidity'].map(method=>({to:INFINITY.factory,abi:INF_MANAGER,method,args:[id]})),block);
  if(result.results.some(r=>r.status!=='fulfilled'))throw Error('池状态读取未完成');
  const [key,slot,liquidity]=result.results.map(r=>r.value),values=[...key];
  if(!same(key[3],INFINITY.factory)||infinityId(values)!==id.toLowerCase()||![key[0],key[1]].some(a=>same(a,token)))return null;
  const zero=same(token,key[0]),quote=zero?key[1]:key[0];
  return {...INFINITY,pool:id,token,token0:key[0],token1:key[1],quote:same(quote,ZeroAddress)?WBNB:quote,nativeQuote:same(quote,ZeroAddress),key:values.map(v=>typeof v==='bigint'?String(v):v),block:result.block,liquid:slot[0]>0n,liquidity:String(liquidity[0]),sqrtPriceX96:String(slot[0]),fee:infinityFee(slot,zero),lpFee:Number(slot[3]),hooks:key[2]};
 }
}
export async function infinityVenue(rpc){
 const calls=[[INFINITY.router,'clPoolManager',INFINITY.factory],[INFINITY.router,'vault',INFINITY.vault],[INFINITY.quoter,'poolManager',INFINITY.factory],[INFINITY.quoter,'vault',INFINITY.vault],[INFINITY.factory,'vault',INFINITY.vault]];
 await Promise.all(calls.map(async([to,method,expected])=>{if(!same((await read(rpc,to,GETTERS,method))[0],expected))throw Error('Infinity 官方部署归属不一致');}));
 const assets=await Promise.all([INFINITY.router,INFINITY.factory,INFINITY.vault,INFINITY.quoter,INFINITY.permit2].map(async token=>{const code=await rpc.getCode(token);if(code==='0x')throw Error('Infinity 依赖合约为空');if(same(token,INFINITY.router)&&(!code.toLowerCase().includes(INFINITY.permit2.slice(2).toLowerCase())||!code.toLowerCase().includes(WBNB.slice(2).toLowerCase())))throw Error('Infinity 路由付款配置不一致');return {token,codeHash:keccak256(code)};}));
 return {assets};
}
export async function infinityQuote(rpc,pool,token,amount){
 if(amount<=0n||amount>=(1n<<127n))throw Error('Infinity 卖出数量超出范围');
 let quoted;try{quoted=await read(rpc,INFINITY.quoter,INF_QUOTER,'quoteExactInputSingle',[[pool.key,same(pool.token0,token),amount,'0x']],pool.block);}catch(e){
  let reason=e.data;try{if(typeof reason==='string'&&reason.startsWith('0x6190b2b0'))reason=coder.decode(['bytes'],'0x'+reason.slice(10))[0];}catch{}
  const partial=typeof reason==='string'&&reason.startsWith('0x7a5ed734');
  if(partial)throw Object.assign(Error('已识别 Infinity 池，但官方报价返回本次数量流动性不足；未提交，可调整比例或稍后重试'),{code:'SELL_NO_LIQUIDITY',cause:e});
  const exhausted=pool.liquidity==='0'&&(BigInt(pool.sqrtPriceX96)>=1461446703485210103287273052203988822378723970341n||BigInt(pool.sqrtPriceX96)<=4295128740n);
  throw Object.assign(Error(exhausted?'已识别 Infinity 池，但当前价格到达边界且无可用流动性，无法卖出；未提交交易':'Infinity 当前报价失败（流动性、Hook 限制或节点响应），未提交交易'),{code:exhausted?'SELL_NO_LIQUIDITY':'INFINITY_QUOTE_FAILED',cause:e});
 }const [output]=quoted;
 if(output<=0n)throw Error('Infinity 当前没有有效卖出报价（流动性不足或 Hook 拒绝）');
 // Includes Hook deductions and price impact already inside the quote. Never
 // label LP fee alone as total cost when a hook can alter the swap delta.
 const sqrt=BigInt(pool.sqrtPriceX96),spot=same(pool.token0,token)?amount*sqrt*sqrt/(1n<<192n):amount*(1n<<192n)/(sqrt*sqrt);
 if(spot<=0n)throw Error('Infinity 无法核验报价损耗');
 const loss=output>=spot?0:Number((spot-output)*1000000n/spot);
 return {output,fees:{version:1,source:'Infinity 同区块 LP/协议费与现价报价差额（含 Hook 和价格冲击）',poolFeePpm:pool.fee,quoteLossPpm:loss,hook:pool.hooks,referenceOutput:String(spot),pools:[{address:pool.pool,factory:pool.factory,feePpm:pool.fee}],block:pool.block}};
}
export function infinitySaleData(pool,token,owner,amount,minimum,receiveNative){
 if(!same(pool.factory,INFINITY.factory)||infinityId(pool.key)!==pool.pool||amount<=0n||minimum<=0n||amount>=(1n<<127n)||minimum>=(1n<<128n))throw Error('Infinity 交易参数无效');
 const quote=same(pool.token0,token)?pool.token1:pool.token0;
 const routed=pool.nativeQuote||same(quote,WBNB)&&receiveNative;
 const params=[coder.encode([`(${POOL_KEY},bool,uint128,uint128,bytes)`],[[pool.key,same(pool.token0,token),amount,minimum,'0x']]),coder.encode(['address','uint256'],[token,amount]),coder.encode(['address','address','uint256'],[quote,routed?INFINITY.router:owner,0])];
 // Exact input + bounded settlement + all output to THIS wallet. No allow-revert flags.
 const inputs=[coder.encode(['bytes','bytes[]'],['0x060c0e',params])];let commands='0x10';
 if(pool.nativeQuote){commands+='0b';inputs.push(coder.encode(['address','uint256'],[receiveNative?INFINITY.router:owner,1n<<255n]));}
 if(routed&&receiveNative){commands+='0c';inputs.push(coder.encode(['address','uint256'],[owner,minimum]));}
 return INF_ROUTER.encodeFunctionData('execute',[commands,inputs,Math.floor(Date.now()/1000)+120]);
}
export async function infinityApprovals(rpc,token,owner,amount){
 const [[erc],[allowed,expiry]]=await Promise.all([read(rpc,token,ERC20,'allowance',[owner,INFINITY.permit2]),read(rpc,INFINITY.permit2,PERMIT2,'allowance',[owner,token,INFINITY.router])]);
 const expiration=Math.floor(Date.now()/1000)+1800;
 return [
  ...(erc<amount?[{kind:'approve',to:token,value:'0',data:ERC20.encodeFunctionData('approve',[INFINITY.permit2,amount]),spender:INFINITY.permit2,allowance:String(amount)}]:[]),
  ...(allowed<amount||Number(expiry)<Math.floor(Date.now()/1000)+120?[{kind:'approve',approvalType:'infinity-permit2',token,to:INFINITY.permit2,value:'0',data:PERMIT2.encodeFunctionData('approve',[token,INFINITY.router,amount,expiration]),spender:INFINITY.router,allowance:String(amount),expiration}]:[])
 ];
}
export function verifyInfinityApproval(step,plan){
 const v=PERMIT2.decodeFunctionData('approve',step.data);
 if(plan.route!==INFINITY.id+'-opening'||!same(step.to,INFINITY.permit2)||!same(step.token,plan.inputToken)||!same(v[0],step.token)||!same(v[1],INFINITY.router)||!same(step.spender,INFINITY.router)||v[2]!==BigInt(step.allowance)||v[2]!==BigInt(plan.amountIn)||v[3]!==BigInt(step.expiration)||step.expiration>Math.floor(Date.now()/1000)+1800||step.expiration<=Math.floor(Date.now()/1000))throw Error('Permit2 授权超出本笔范围');
}
export async function verifyInfinityAllowance(rpc,step,plan,readState=work=>work()){
 verifyInfinityApproval(step,plan);const [amount,expiry]=await readState(()=>read(rpc,INFINITY.permit2,PERMIT2,'allowance',[plan.wallet,step.token,step.spender]));if(amount<BigInt(step.allowance)||Number(expiry)<Math.floor(Date.now()/1000)+30)throw Error('Permit2 当前额度或有效期不足');
}
export function infinitySettlement({receipt,token,state,plan,step,wallet:owner}){
 if(!same(plan.inputToken,token)||!same(plan.wallet,owner)||!same(step.to,INFINITY.router)||!same(state.factory,INFINITY.factory)||infinityId(state.key)!==state.pool)throw Error('Infinity 原单路线不匹配');
 const swaps=[],transfers=[],wraps=[];
 for(const l of receipt.logs||[]){try{if(same(l.address,INFINITY.factory)){const e=INF_MANAGER.parseLog(l);if(e?.name==='Swap'&&e.args.id===state.pool&&same(e.args.sender,INFINITY.router))swaps.push(e);}
  if(same(l.address,token)||same(l.address,plan.outputToken)||same(l.address,WBNB)){const e=EVENTS.parseLog(l);if(e?.name==='Transfer')transfers.push({asset:l.address,e});else if(e)wraps.push(e);}}catch{}}
 const zero=same(token,state.token0),quote=zero?state.token1:state.token0;
 if(![state.token0,state.token1].some(a=>same(a,token))||!(same(plan.outputToken,BNB)||same(plan.outputToken,WBNB)?same(quote,WBNB)||same(quote,ZeroAddress):same(plan.outputToken,quote)))throw Error('Infinity 回执资产不匹配');
 const decoded=INF_ROUTER.decodeFunctionData('execute',step.data);
 // Regenerate only the deadline to check every command, amount and recipient.
 const expected=INF_ROUTER.decodeFunctionData('execute',infinitySaleData(state,token,owner,BigInt(plan.amountIn),BigInt(plan.minOutput),same(plan.outputToken,BNB)));
 if(decoded[0]!==expected[0]||JSON.stringify([...decoded[1]])!==JSON.stringify([...expected[1]]))throw Error('Infinity 回执 calldata 不匹配');
 const totalDebit=transfers.filter(t=>same(t.asset,token)&&same(t.e.args.from,owner)&&!same(t.e.args.to,owner)).reduce((n,t)=>n+t.e.args.value,0n);
 const debit=transfers.filter(t=>same(t.asset,token)&&same(t.e.args.from,owner)&&same(t.e.args.to,INFINITY.vault)).reduce((n,t)=>n+t.e.args.value,0n);
 if(swaps.length!==1||debit!==BigInt(plan.amountIn)||totalDebit!==debit)throw Error('Infinity 回执不能唯一归属本钱包的卖出');
 const swap=swaps[0].args,poolIn=-swap[zero?'amount0':'amount1'],poolOut=swap[zero?'amount1':'amount0'];
 if(poolIn<=0n||poolIn>debit||poolOut<=0n)throw Error('Infinity 回执方向或数量不一致');
 const native=same(plan.outputToken,BNB),withdrawals=wraps.filter(e=>e.name==='Withdrawal'&&same(e.args.src,INFINITY.router));
 const output=native?(withdrawals.length===1?withdrawals[0].args.wad:0n):transfers.filter(t=>same(t.asset,plan.outputToken)&&same(t.e.args.to,owner)&&[INFINITY.vault,INFINITY.router].some(a=>same(a,t.e.args.from))).reduce((n,t)=>n+t.e.args.value,0n);
 const deposits=wraps.filter(e=>e.name==='Deposit'&&same(e.args.dst,INFINITY.router));
 if(same(quote,ZeroAddress)&&(deposits.length!==1||deposits[0].args.wad!==output))throw Error('Infinity 原生币到账证明不完整');
 if(output<=0n||output>poolOut)throw Error('Infinity 回执未证明到账');
 return {amountIn:debit,amountOut:output,attribution:'wallet-funded-infinity-swap'};
}
