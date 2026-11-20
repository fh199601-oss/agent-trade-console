import {personalExecutor} from './personal-address.mjs';
import {Interface,ZeroAddress,id,keccak256,getCreate2Address,solidityPackedKeccak256} from 'ethers';
import {codeIdentity} from '../discovery.mjs';
import {ERC20,WBNB,read,same} from '../common.mjs';
import {openingReads} from '../opening-read.mjs';
export const TAX_BSC_SALE=Object.freeze({chainId:56,factory:'0xca143ce32fe78f1f7019d7d551a6402fc5350c73',wrapped:WBNB,executorHash:'0x03a65e203b402f68ec81f5ac4e1c2979ab449ddfda16885d1ec1248ba9940f01',taxAware:true});
export function pinnedBscSale(address,hash,payer){
 if(!payer||hash!==TAX_BSC_SALE.executorHash)return;
 try{
  const executor=personalExecutor(payer);
  if(same(executor,address))return {...TAX_BSC_SALE,executor,payer};
 }catch{}
}
export function activeDeployment(manifest,jobs=[]){
 if(manifest?.chainId!==56)return null;
 const pin=pinnedBscSale(manifest.executor,manifest.executorHash,manifest.payer);
 if(!pin)return null;
 if(jobs.some(j=>!same(j.executor||j.settings?.executor,pin.executor)&&(
  (!j.deletedAt&&!['COMPLETED','REVIEW'].includes(j.status))||j.batches?.some(b=>['SIGNED','SUBMITTING','PENDING','UNKNOWN'].includes(b.status))||
  j.rows?.some(r=>['APPROVAL_PENDING','REGISTRATION_PENDING'].includes(r.status)))))return null;
 return pin;
}
const venueType='(address token,address quote,address pair,address source,bytes4 getter,bytes32 tokenHash,bytes32 quoteHash,bytes32 sourceHash)';
export const SALE=new Interface([
 'function openingState(address token,address source) view returns(bool known,bool opened)',
 'function canReplace(bytes32 id,'+venueType+' next) view returns(bool)',
 'function verify('+venueType+' v,bool preparing) view returns(bool)',
 'function registerSale('+venueType+' v,uint112 cap,uint128 minOut,address trigger,bool nativeOutput,uint8 percent,uint8 hoursValid) returns(bytes32)',
 'function plans(bytes32) view returns(address owner,address trigger,bytes32 venue,uint112 cap,uint128 minOut,uint48 deadline,uint8 state,bool paused,bool nativeOutput)',
 'function executeBatch(bytes32[] ids)',
 'function sellPercent(bytes32) view returns(uint8)','function active(address,address) view returns(bytes32)',
 'event Registered(bytes32 indexed id,address indexed owner,address token,uint256 cap,uint256 deadline)',
 'event Sold(bytes32 indexed id,address indexed owner,uint256 amount,uint256 output,bool nativePaid)',
 'event ItemFailed(bytes32 indexed id,bytes4 reason)','event BatchDeferred(uint256 nextIndex)'
]);
const view=new Interface(['function WBNB() view returns(address)','function router() view returns(address)','function sale() view returns(address)','function token() view returns(address)','function wrappedNative() view returns(address)','function factory() view returns(address)','function getPair(address,address) view returns(address)','function INIT_CODE_PAIR_HASH() view returns(bytes32)','function token0() view returns(address)','function token1() view returns(address)','function getReserves() view returns(uint112,uint112,uint32)',...['pair','pancakePair','uniswapV2Pair','lpPair'].map(x=>'function '+x+'() view returns(address)')]);
export const TRANSFER_MESSAGE='执行合约检测到转账实收与计划不符，本钱包卖出已回滚；可在快捷交易重新预览。';
const transfer=new Interface(['function transferFrom(address,address,uint256) returns(bool)']);
const transferMismatch=id('UnsupportedTransfer()').slice(0,10);
const highFee=id('HighTransferFee()').slice(0,10);
const minimumNotMet=id('MinimumNotMet()').slice(0,10);
const reasons=Object.fromEntries(Object.entries({MarketClosed:'项目尚未开放交易或 Mint 尚未完成',OpeningUnknown:'项目缺少可核验的开盘状态',HighTransferFee:'本钱包本次转账税与主池手续费合计达到 50% 保护线，卖出已回滚',AllowanceLow:'授权额度不足',WrongPrimary:'主池核验未通过',EmptyBalance:'可卖数量为零',MinimumNotMet:'报价低于钱包最低到账',Expired:'计划已过期',UnsupportedTransfer:TRANSFER_MESSAGE,WrongTrigger:'触发地址不匹配',Paused:'计划已暂停',NotActive:'计划已执行或取消',ItemError:'该钱包执行回滚'}).map(([name,msg])=>[id(name+'()').slice(0,10),msg]));
export function saleEvents(receipt,name,executor){return (receipt.logs||[]).filter(x=>same(x.address,executor)).flatMap(l=>{try{const e=SALE.parseLog(l);return e?.name===name?[e.args]:[];}catch{return [];}});}
export class BscVenue {
 constructor(rpc,deployment={}){
  const pin=pinnedBscSale(deployment.executor,deployment.executorHash,deployment.payer);
  if(!pin)throw Error('未知的主网执行合约版本');
  this.rpc=rpc;this.chainId=56;this.executor=pin.executor;this.executorHash=pin.executorHash;this.payer=pin.payer;this.taxAware=!!pin.taxAware;this.venues=new Map();this.batchSize=20;}
 async identity(){
  const [chain,code]=await Promise.all([this.rpc.send('eth_chainId',[]),this.rpc.send('eth_getCode',[this.executor,'latest'])]);
  if(BigInt(chain)!==56n||keccak256(code)!==this.executorHash)throw Error('BNB 主网执行合约地址或代码核验失败');
 }
 async verifiedVenue(token){
  await this.identity();
  const one=async(to,method,args=[]) => (await read(this.rpc,to,view,method,args))[0];
  const tryOne=async(to,method)=>{
   try{return await one(to,method);}
   catch(e){if(e.code==='BAD_DATA'||e.code==='CALL_EXCEPTION'||/revert|invalid opcode/i.test(e.message))return null;throw e;}
  };
  let source=token,pair,quote,getter;
  const sale=await tryOne(token,'sale');
  if(sale&&!same(sale,ZeroAddress)&&same(await tryOne(sale,'token'),token))source=sale;
  const getters=['pair','pancakePair','uniswapV2Pair','lpPair'];
  const declared=await Promise.all(getters.map(k=>tryOne(source,k)));
  const [known,opened]=this.taxAware?await read(this.rpc,this.executor,SALE,'openingState',[token,source]):[true,true];
  if(!known)throw Error('项目没有可核验的开盘状态，暂不能建立极速卖出任务');
  const pairs=new Set(declared.filter(x=>x&&!same(x,ZeroAddress)).map(x=>x.toLowerCase()));
  const index=declared.findIndex(x=>x&&!same(x,ZeroAddress));
  if(!opened&&this.taxAware||index<0){
   const slot=index>=0?index:declared.findIndex(x=>x&&same(x,ZeroAddress));
   if(slot<0)throw Error('项目尚未提供可核验的主池声明入口');
   let f=await tryOne(source,'factory');
   if(!f&&this.taxAware){const router=await tryOne(source,'router');if(router&&!same(router,ZeroAddress))f=await tryOne(router,'factory');}
   const q=await tryOne(source,'wrappedNative')||(this.taxAware&&await tryOne(source,'WBNB'));
   if(!same(f,TAX_BSC_SALE.factory)||!q||same(q,ZeroAddress)||!this.taxAware&&(!same(q,WBNB)||same(source,token)))throw Error('Mint 期间尚未核实最终主池的工厂与计价币，等待项目正式开盘');
   const initHash=await one(f,'INIT_CODE_PAIR_HASH');
   quote=q;getter=getters[slot];
   const coins=[token,quote].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
   pair=getCreate2Address(f,solidityPackedKeccak256(['address','address'],coins),initHash);
  }else{
   if(pairs.size>1)throw Error('项目声明了多个不同交易池，无法核验唯一主池');
   pair=declared[index];getter=getters[index];
   const [a,b]=await Promise.all([one(pair,'token0'),one(pair,'token1')]);
   if(!same(a,token)&&!same(b,token))throw Error('项目主池未包含所选代币');
   quote=same(a,token)?b:a;
  }
  if(opened&&!same(source,token)){
   const tokenPools=await Promise.all(getters.map(k=>tryOne(token,k)));
   if(tokenPools.some(p=>p&&!same(p,ZeroAddress)&&!same(p,pair)))throw Error('代币与发行合约声明的主池不一致');
  }
  const contracts=[...new Set([token,quote,source])];
  const hashed=new Map(await Promise.all(contracts.map(async a=>{
   const identity=await codeIdentity(this.rpc,a);
   if(identity.implementation||identity.beacon)throw Error('此主池涉及代理合约，目前无法锁定执行代码');
   return [a,keccak256(identity.code)];
  })));
  const [tokenHash,quoteHash,sourceHash]=[token,quote,source].map(a=>hashed.get(a));
  const v={token,quote,pair,source,getter:id(getter+'()').slice(0,10),tokenHash,quoteHash,sourceHash,verified:true};
  await read(this.rpc,this.executor,SALE,'verify',[v,true]);
  const [[decimals],[tokenDecimals]]=await Promise.all([read(this.rpc,quote,ERC20,'decimals'),read(this.rpc,token,ERC20,'decimals').catch(()=>[])]);
  if(decimals>36n)throw Error('主池计价币精度异常');
  if(tokenDecimals!==undefined&&tokenDecimals<=36n)v.tokenDecimals=Number(tokenDecimals);
  v.quoteDecimals=Number(decimals);v.quoteSymbol=same(quote,WBNB)?'BNB':String((await read(this.rpc,quote,ERC20,'symbol').catch(()=>['计价币']))[0]).slice(0,18);
  v.marketPending=this.taxAware&&!opened;
  if(index>=0&&opened){
   const [r0,r1]=await read(this.rpc,pair,view,'getReserves');
   v.openAtVerification=r0>0n&&r1>0n;
  }
  this.venues.set(token.toLowerCase(),v);return v;
 }
 async transferCompatibility(v,owner,amount){
  // Simulate the same spender and pool balance delta the deployed executor checks.
  // The four calls share only simulated state, including a temporary allowance.
  const balance={to:v.token,data:ERC20.encodeFunctionData('balanceOf',[v.pair])};
  const calls=[{from:owner,to:v.token,data:ERC20.encodeFunctionData('approve',[this.executor,amount])},balance,
   {from:this.executor,to:v.token,data:transfer.encodeFunctionData('transferFrom',[owner,v.pair,amount])},balance];
  try{
   const [block]=await this.rpc.send('eth_simulateV1',[{blockStateCalls:[{calls}],validation:false},'latest']);
   const steps=block.calls;
   if(steps.length!==4||!steps.every(x=>x.status==='0x1'))return null;
   const result=steps[2].returnData;
   if(result!=='0x'&&!transfer.decodeFunctionResult('transferFrom',result)[0])return null;
   const [before,after]=[1,3].map(i=>ERC20.decodeFunctionResult('balanceOf',steps[i].returnData)[0]);
   return after-before===amount;
  }catch{return null;}
 }
 async opening(asset){
  const v=this.venues.get(asset.toLowerCase())||await this.verifiedVenue(asset);
  if(this.taxAware){
   // Read the registered venue and its reserves in the same block, once for
   // all holders. verify returns token ordering; either boolean is valid.
   const {block,results:[verified,reserves,market,declaration]}=await openingReads(this.rpc,[
    {to:this.executor,abi:SALE,method:'verify',args:[v,false],canonical:true},
    {to:v.pair,abi:view,method:'getReserves',canonical:true},
    {to:this.executor,abi:SALE,method:'openingState',args:[v.token,v.source],canonical:true},
    {to:v.source,abi:view,method:view.getFunction(v.getter).name,canonical:true}
   ]);
   if(market.status==='rejected')throw market.reason;
   const [known,opened]=market.value;
   if(!known||!opened)return {open:false,token:v.token,pair:v.pair,block};
   if(declaration.status==='rejected')throw declaration.reason;
   const [declared]=declaration.value;
   if(declared&&!same(declared,ZeroAddress)&&!same(declared,v.pair)){
    this.venues.delete(asset.toLowerCase());
    return {open:false,changed:true,token:v.token,pair:declared,block};
   }
   if(verified.status==='rejected')throw verified.reason;
   if(reserves.status==='rejected')throw reserves.reason;
   const [a,b]=reserves.value;
   return {open:same(declared,v.pair)&&a>0n&&b>0n,pair:v.pair,token:v.token,block};
  }
  await read(this.rpc,this.executor,SALE,'verify',[v,false]);
  const [a,b]=await read(this.rpc,v.pair,view,'getReserves');
  return {open:a>0n&&b>0n,pair:v.pair,token:v.token};
 }
 matchesPrimary(v,s){return s?.open&&same(v.pair,s.pair)&&same(v.token,s.token);}
 async verifyClaim({hash,owner,token}){
  const receipt=await this.rpc.send('eth_getTransactionReceipt',[hash]);
  return receipt&&BigInt(receipt.status)===1n&&receipt.logs.some(l=>same(l.address,token)&&l.topics?.length===3&&l.topics[0]===id('Transfer(address,address,uint256)')&&same('0x'+l.topics[2].slice(-40),owner)&&BigInt(l.data)>0n);
 }
 async followHash(b){
  if(!b.hash)return null;const receipt=await this.rpc.send('eth_getTransactionReceipt',[b.hash]);
  if(!receipt||!same(receipt.transactionHash,b.hash))return null;
  return {hash:b.hash,status:BigInt(receipt.status)===1n?'CONFIRMED':'REVERTED',receipt};
 }
 async simulateTaxBatch(trigger,rows){
  const call={from:trigger,to:this.executor,gas:'0xb71b00',data:SALE.encodeFunctionData('executeBatch',[rows.map(r=>r.plan.id)])};
  const [block]=await this.rpc.send('eth_simulateV1',[{blockStateCalls:[{calls:[call]}],validation:false},'latest']);
  const result=block?.calls?.[0];
  if(block?.calls?.length!==1||result.status!=='0x1')throw Error('节点未能模拟原计划的税后到账');
  const sold=saleEvents(result,'Sold',this.executor);
  return rows.filter(r=>sold.some(e=>e.id===r.plan.id&&same(e.owner,r.address)&&e.amount>0n&&e.amount<=BigInt(r.plan.cap)&&e.output>=BigInt(r.plan.minOut)));
 }
 async outcomes(receipt,ids,rows=[],hash){
  const results=new Map();
  const block=Number(receipt.blockNumber);
  for(const e of saleEvents(receipt,'Sold',this.executor)){
   const row=rows.find(r=>r.plan?.id===e.id);
   const verified=row&&ids.includes(e.id)&&!results.has(e.id)&&hash&&same(receipt.transactionHash,hash)&&same(receipt.to,this.executor)&&
    same(receipt.from,row.plan.trigger)&&Number(receipt.status)===1&&Number.isSafeInteger(block)&&block>0&&same(e.owner,row.address)&&
    e.amount>0n&&e.amount<=BigInt(row.plan.cap)&&e.output>0n&&e.output>=BigInt(row.plan.minOut);
   results.set(e.id,verified?{sold:true,fill:{amount:String(e.amount),output:String(e.output),nativePaid:e.nativePaid,block},message:'收益已回原钱包'}:
    {sold:false,message:'成交事件与本钱包原计划不符，请核对原回执'});
  }
  for(const e of saleEvents(receipt,'ItemFailed',this.executor))results.set(e.id,{sold:false,failed:e.reason===transferMismatch||e.reason===highFee,reason:e.reason===highFee?'HIGH_TRANSFER_FEE':e.reason===transferMismatch?'TRANSFER_MISMATCH':e.reason===minimumNotMet?'MINIMUM_NOT_MET':undefined,retryable:false,message:reasons[e.reason]||'钱包执行回滚，原因 '+e.reason});
  for(const e of saleEvents(receipt,'BatchDeferred',this.executor))for(const k of ids.slice(Number(e.nextIndex)))results.set(k,{retryable:true,message:'本批剩余 Gas 不足，此钱包尚未执行'});
  return results;
 }
}
