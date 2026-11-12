// Fixed, factory-verified routes. This is a planner: no signing/broadcast here.
import {Interface,read,ERC20,BNB,WBNB,USDT,same,native} from './common.mjs';
import {OpeningPools,POOL} from './opening-pools.mjs';
import {openingReads} from './opening-read.mjs';
import {OpeningPreparation} from './opening-preparation.mjs';
import {DEXES,dexFor,V2_ROUTER_ABI,V3_LEGACY,V3_MODERN,QUOTER} from './opening-dex.mjs';
import {poolFeeProof,HIGH_FEE_PPM,compoundFees} from './trade-fees.mjs';
import {codeIdentity} from './discovery.mjs';
import {openingSettlement} from './opening-route.mjs';
export const WRAPPED=new Interface(['function deposit() payable','function withdraw(uint256)','event Deposit(address indexed dst,uint256 wad)','event Withdrawal(address indexed src,uint256 wad)','event Transfer(address indexed from,address indexed to,uint256 value)']);
const V2_NATIVE=new Interface(['function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable']);
const clients=new WeakMap();
export function conversions(rpc){if(!clients.has(rpc))clients.set(rpc,new TradeConversions(rpc));return clients.get(rpc);}
export class TradeConversions{
 constructor(rpc,{pools=new OpeningPools(rpc,{quoteDiscovery:null,infinity:null}),prep=new OpeningPreparation(rpc),identityFor=codeIdentity,now=Date.now}={}){Object.assign(this,{rpc,pools,prep,identityFor,now});this.topologies=new Map();this.preparing=new Map();}
 key(a,b){return [native(a)?WBNB:a,native(b)?WBNB:b].map(x=>x.toLowerCase()).sort().join(':');}
 remember(input,output,edges){
  // Only venue identities are retained: no reserves, prices, balances or allowance.
  if([...edges.values()].some(e=>e.errors?.length)||![...edges.values()].some(e=>e.pools.some(p=>p.liquid)))return;
  const clean=new Map([...edges].map(([k,e])=>[k,{token:e.token,quote:e.quote,pools:e.pools.map(p=>{const {reserve0,reserve1,liquidity,block,liquid,...identity}=p;return {...identity,verifiedBlock:p.verifiedBlock??Number(block)};})}]));
  this.topologies.set(this.key(input,output),{until:this.now()+30000,edges:clean});if(this.topologies.size>64)this.topologies.delete(this.topologies.keys().next().value);
 }
 async edge(input,output,graph,block='latest'){
  const key=this.key(input,output);let e=graph.get(key);
  if(!e){e={...await this.pools.inspectQuotes(input,'AUTO',[output],block),token:input,quote:output};graph.set(key,e);}
  return {...e,pools:e.pools.map(p=>({...p,token:input,quote:output}))};
 }
 async refresh(input,output){
  const key=this.key(input,output),old=this.topologies.get(key);if(!old||old.until<=this.now())return null;
  const all=[...old.edges.values()].flatMap(e=>e.pools),unique=[...new Map(all.map(p=>[p.pool.toLowerCase(),p])).values()];
  if(!unique.length)return null;
  const first=await openingReads(this.rpc,unique.slice(0,64).map(p=>({to:p.pool,abi:POOL,method:p.kind==='v2'?'getReserves':'liquidity'})));
  const parts=await Promise.all(Array.from({length:Math.ceil(Math.max(0,unique.length-64)/64)},(_,n)=>openingReads(this.rpc,unique.slice(64+n*64,128+n*64).map(p=>({to:p.pool,abi:POOL,method:p.kind==='v2'?'getReserves':'liquidity'})),first.block)));
  const rows=[...first.results,...parts.flatMap(x=>x.results)],fresh=new Map();
  unique.forEach((p,n)=>{const r=rows[n];if(r?.status!=='fulfilled'||first.block<p.verifiedBlock)return;const v=r.value;fresh.set(p.pool.toLowerCase(),{...p,block:first.block,liquid:v[0]>0n&&(p.kind!=='v2'||v[1]>0n),...(p.kind==='v2'?{reserve0:String(v[0]),reserve1:String(v[1])}:{liquidity:String(v[0])})});});
  // Partial refresh must not turn an RPC failure into "no liquidity".
  if(fresh.size!==unique.length){this.topologies.delete(key);return null;}
  return new Map([...old.edges].map(([k,e])=>[k,{...e,block:first.block,errors:[],pools:e.pools.map(p=>fresh.get(p.pool.toLowerCase()))}]));
 }
 async warm(inputToken,outputToken,{busy=()=>false}={}){
  const input=native(inputToken)?WBNB:inputToken,output=native(outputToken)?WBNB:outputToken,key=this.key(input,output);
  if(busy())return;
  if(this.preparing.has(key))return this.preparing.get(key);
  const work=(async()=>{
   if(same(input,output)){await this.prep.token?.(output);return;}
   if((this.topologies.get(key)?.until||0)>this.now())return;
   const graph=new Map(),block=await this.rpc.getBlockNumber(),mids=[WBNB,USDT].filter(t=>!same(t,input)&&!same(t,output));
   if(busy())return;
   await this.edge(input,output,graph,block);
   if(busy())return;
   await Promise.all(mids.flatMap(mid=>[this.edge(input,mid,graph,block),this.edge(mid,output,graph,block)]));
   this.remember(input,output,graph);
   if(busy())return;
   const venues=[...new Map([...graph.values()].flatMap(e=>e.pools.filter(p=>p.liquid).map(p=>{const d=dexFor(p);return [d?.id,d];}))).values()].filter(Boolean);
   await Promise.allSettled([...venues.map(d=>this.prep.venue(d)),...[input,output].map(t=>this.prep.token?this.prep.token(t):this.prep.quote(t))]);
  })();this.preparing.set(key,work);try{return await work;}finally{this.preparing.delete(key);}
 }
 async plan(args){
  if(args.graph)return this.build(args);
  const input=native(args.inputToken)?WBNB:args.inputToken,output=native(args.outputToken)?WBNB:args.outputToken;
  const prepared=await this.refresh(input,output),graph=prepared||new Map();
  try{const result=await this.build({...args,graph});if(!prepared)this.remember(input,output,graph);return result;}
  catch(e){if(!prepared||e.code!=='QUOTE_CONVERSION_UNAVAILABLE')throw e;this.topologies.delete(this.key(input,output));const fresh=new Map(),result=await this.build({...args,graph:fresh});this.remember(input,output,fresh);return result;}
 }
 async build({inputToken,outputToken,amount,owner,slippageBps,preferredPool,quotedOutput,maxHops=2,graph}){
  amount=BigInt(amount);if(amount<=0n||!Number.isInteger(slippageBps)||slippageBps<0||slippageBps>5000)throw Error('兑换金额或滑点无效');
  const ni=native(inputToken),no=native(outputToken),input=ni?WBNB:inputToken,output=no?WBNB:outputToken;
  if(same(input,output)){
   if(ni===no)throw Error('不需要重复兑换同种资产');
   const identity=await this.identityFor(this.rpc,WBNB),data=WRAPPED.encodeFunctionData(ni?'deposit':'withdraw',ni?[]:[amount]);
   const tradeLeg={inputToken,outputToken,amountIn:String(amount),minOutput:String(amount),settlementRoute:'trade-conversion',state:{wrap:ni?'deposit':'withdraw'}};
   return {outputToken,amountOut:amount,minOutput:String(amount),outputDecimals:18,identities:[identity],fees:{poolFeePpm:0,source:'WBNB 1:1 包装',pools:[]},steps:[{kind:'conversion',to:WBNB,value:ni?String(amount):'0',data,tradeLeg}]};
  }
  const base=await this.edge(input,output,graph),candidates=base.pools.filter(p=>p.liquid);
  // If no direct pair exists, include fixed same-factory two-hop V2 paths.
  if(!candidates.length&&maxHops>1){
   const mids=[WBNB,USDT].filter(t=>!same(t,input)&&!same(t,output));
   const rows=await Promise.all(mids.map(async mid=>{const [a,b]=await Promise.all([this.edge(input,mid,graph,base.block),this.edge(mid,output,graph,base.block)]);return a.pools.filter(p=>p.liquid&&p.kind==='v2').flatMap(p=>b.pools.filter(q=>q.liquid&&q.kind==='v2'&&same(q.factory,p.factory)).map(q=>({...p,quote:output,path:[input,mid,output],legs:[p,q]})));}));candidates.push(...rows.flat());
  }
  const quoted=await Promise.allSettled(candidates.map(async pool=>{
   const d=dexFor(pool);if(!d)throw Error('兑换池不在已核验工厂中');
   const r=await read(this.rpc,d.kind==='v2'?d.router:d.quoter,d.kind==='v2'?V2_ROUTER_ABI:QUOTER,d.kind==='v2'?'getAmountsOut':'quoteExactInputSingle',d.kind==='v2'?[amount,pool.path||[input,output]]:[[input,output,amount,pool.fee,0]],pool.block);
   const raw=d.kind==='v2'?r[0].at(-1):r[0],fees=poolFeeProof(pool,d.kind==='v2'?r[0]:null,input,pool.block);
   if(raw<=0n||fees.poolFeePpm===null||fees.poolFeePpm>=HIGH_FEE_PPM)throw Error('兑换路径无有效低费报价');
   // Tax-handler preview is only applicable to its declared official pair.
   const adjusted=quotedOutput&&same(pool.pool,preferredPool)?await quotedOutput(pool,raw):raw;
   if(adjusted<=0n||adjusted>raw)throw Error('计入税收后的兑换报价无效');
   return {pool,d,amountOut:adjusted,fees};
  }));
  const valid=quoted.filter(r=>r.status==='fulfilled').map(r=>r.value).sort((a,b)=>{
   if(preferredPool&&same(a.pool.pool,preferredPool)!==same(b.pool.pool,preferredPool))return same(a.pool.pool,preferredPool)?-1:1;
   return a.amountOut===b.amountOut?0:a.amountOut>b.amountOut?-1:1;
  });
  // Some stock quotes only have V3 liquidity against USDT, or use a different
  // factory on each leg. Build bounded exact-input steps, spending only each
  // prior leg's guaranteed proceeds. Never recurse into arbitrary-hop searches.
  if(!valid.length&&maxHops>1&&!quotedOutput){
   const mids=[WBNB,USDT].filter(t=>!same(t,input)&&!same(t,output));
   const alternatives=await Promise.allSettled(mids.map(async mid=>{
    const first=await this.plan({inputToken,outputToken:mid,amount,owner,slippageBps:Math.floor(slippageBps/2),maxHops:1,graph});
    const last=await this.plan({inputToken:mid,outputToken,amount:BigInt(first.minOutput),owner,slippageBps:slippageBps-Math.floor(slippageBps/2),maxHops:1,graph});
    const fee=compoundFees([first.fees.poolFeePpm,last.fees.poolFeePpm]);if(fee===null||fee>=HIGH_FEE_PPM)throw Error('中转费用超限');
    return {...last,steps:[...first.steps,...last.steps],identities:[...first.identities,...last.identities],fees:{poolFeePpm:fee,source:'固定工厂跨池兑换',pools:[...first.fees.pools,...last.fees.pools]}};
   }));
   const good=alternatives.filter(r=>r.status==='fulfilled').map(r=>r.value).sort((a,b)=>BigInt(a.minOutput)===BigInt(b.minOutput)?0:BigInt(a.minOutput)>BigInt(b.minOutput)?-1:1);
   if(good.length)return good[0];
  }
  if(!valid.length)throw Object.assign(Error('未找到 '+inputToken+' → '+outputToken+' 的可核验低费兑换路径；可选择池子原币直接交易'),{code:'QUOTE_CONVERSION_UNAVAILABLE'});
  const {pool,d,amountOut,fees}=valid[0],minimum=amountOut*BigInt(10000-slippageBps)/10000n;
  if(minimum<=0n)throw Error('兑换最低到账为零');
  const [venue,identity,[allowance],meta]=await Promise.all([this.prep.venue(d),this.prep.token?this.prep.token(output).then(v=>v.identity):this.identityFor(this.rpc,output),ni?[amount]:read(this.rpc,input,ERC20,'allowance',[owner,d.router]),this.prep.quote(output)]);
  const deadline=Math.floor(Date.now()/1000)+180;let data;
  if(d.kind==='v2')data=ni?V2_NATIVE.encodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens',[minimum,pool.path||[input,output],owner,deadline]):V2_ROUTER_ABI.encodeFunctionData(no?'swapExactTokensForETHSupportingFeeOnTransferTokens':'swapExactTokensForTokensSupportingFeeOnTransferTokens',[amount,minimum,pool.path||[input,output],owner,deadline]);
  else{
   const abi=d.legacy?V3_LEGACY:V3_MODERN,call=abi.encodeFunctionData('exactInputSingle',[[input,output,pool.fee,no?d.router:owner,...(d.legacy?[deadline]:[]),amount,minimum,0]]),calls=[call,...(no?[abi.encodeFunctionData('unwrapWETH9',[minimum,owner])]:[])];
   data=d.legacy?(calls.length===1?call:abi.encodeFunctionData('multicall(bytes[])',[calls])):abi.encodeFunctionData('multicall(uint256,bytes[])',[deadline,calls]);
  }
  const tradeLeg={inputToken,outputToken,amountIn:String(amount),minOutput:String(minimum),settlementRoute:'trade-conversion',state:pool};
  return {outputToken,amountOut,minOutput:String(minimum),outputDecimals:meta.decimals,fees,identities:[{...identity,learnedAssets:venue.assets}],steps:[...(allowance<amount?[{kind:'approve',to:input,value:'0',data:ERC20.encodeFunctionData('approve',[d.router,amount]),spender:d.router,allowance:String(amount)}]:[]),{kind:'conversion',to:d.router,value:ni?String(amount):'0',data,tradeLeg}]};
 }
}
export function conversionSettlement({receipt,wallet:owner,state,plan,step}){
 const logs=(receipt.logs||[]).flatMap(l=>{try{return [{...WRAPPED.parseLog(l),address:l.address}];}catch{return [];}});
 if(state.wrap){
  if(!same(step.to,WBNB))throw Error('包装回执目标不符');const matches=logs.filter(e=>same(e.address,WBNB)&&e.name===(state.wrap==='deposit'?'Deposit':'Withdrawal')&&same(e.args[state.wrap==='deposit'?'dst':'src'],owner));
  if(matches.length!==1||matches[0].args.wad!==BigInt(plan.amountIn))throw Error('WBNB 包装回执金额不符');return {amountIn:matches[0].args.wad,amountOut:matches[0].args.wad};
 }
 if(!native(plan.inputToken))return openingSettlement({receipt,wallet:owner,token:plan.inputToken,state,plan,step});
 const d=dexFor(state);if(!d||!same(step.to,d.router)||BigInt(step.value)!==BigInt(plan.amountIn)||native(plan.outputToken)||!same(plan.outputToken,state.quote))throw Error('原生币兑换回执身份不符');
 const deposits=logs.filter(e=>same(e.address,WBNB)&&e.name==='Deposit'&&same(e.args.dst,d.router));
 if(deposits.length!==1||deposits[0].args.wad!==BigInt(step.value))throw Error('兑换回执未证明 BNB 包装金额');
 const lastPool=state.legs?.at(-1)?.pool||state.pool;
 const amountOut=logs.filter(e=>same(e.address,plan.outputToken)&&e.name==='Transfer'&&same(e.args.from,lastPool)&&same(e.args.to,owner)).reduce((n,e)=>n+e.args.value,0n);
 if(amountOut<=0n)throw Error('兑换回执没有本钱包的输出资产到账');return {amountIn:BigInt(step.value),amountOut};
}
