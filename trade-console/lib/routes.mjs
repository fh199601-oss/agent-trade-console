import {openingSettlement} from './opening-route.mjs';
import {DEXES} from './opening-dex.mjs';
import {findOpenFourHelper} from './optional-tools.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import * as flap from '../support/curve-trader/adapters/flap.mjs';
import * as gang from '../support/curve-trader/adapters/gang.mjs';
import {wallet,read,Interface,ERC20,BNB,WBNB,USDT,ZeroAddress,native,same,parseUnits,formatUnits,percentOf} from './common.mjs';
import {sellAmount,quotedSlippage} from './sell-policy.mjs';
import {measure,count} from './diagnostics.mjs';
const exec=promisify(execFile),run=(file,args,options={})=>exec(file,args,{...options,windowsHide:true}),routeCache=new Map();
// Scheduling hints only: fresh registration checks still determine every route.
// Never cache holdings, prices, calldata, allowances, or negative registrations.
const aggregateHints=new WeakMap();
function hintMap(rpc){let hints=aggregateHints.get(rpc);if(!hints){hints=new Map();aggregateHints.set(rpc,hints);}return hints;}
// Official IPortal error, including the queried token (not any generic revert):
// https://github.com/flap-sh/FlapVaultExample/blob/main/src/flap/IPortal.sol
const flapErrors=new Interface(['error TokenNotFound(address token)']);
// Discover registration before reading every platform's balances, fees, gates,
// allowances and quotas. These official registry getters are wallet independent.
// Only an explicit, canonically decoded absence skips the full adapter.
export async function probeRegistrations(rpc,token){
 const check=async(to,abi,method)=>{count('routeRegistrationReads');const raw=await rpc.call({to,data:abi.encodeFunctionData(method,[token])}),v=abi.decodeFunctionResult(method,raw);if(abi.encodeFunctionResult(method,v).toLowerCase()!==raw.toLowerCase())throw Error('注册接口返回不规范');return v;};
 const result=await Promise.allSettled([check(flap.portal,flap.portalAbi,'getTokenV8Safe'),...gang.PADS.map(p=>check(p.address,p.kind==='soft'?gang.SOFT_ABI:p.id==='s'?gang.S_ABI:gang.V2_ABI,'curves'))]);
 let flapKnown=result[0].status==='fulfilled'?Number(result[0].value[0].status)!==0:null;
 if(result[0].status==='rejected')try{const raw=result[0].reason.data,decoded=flapErrors.parseError(raw);if(decoded?.name==='TokenNotFound'&&same(decoded.args[0],token)&&flapErrors.encodeErrorResult(decoded.fragment,decoded.args).toLowerCase()===raw.toLowerCase())flapKnown=false;}catch{}
 const pads=result.slice(1),gangKnown=pads.some(r=>r.status==='fulfilled'&&!same(r.value[0],ZeroAddress))?true:pads.every(r=>r.status==='fulfilled')?false:null;
 return {flap:flapKnown,gang:gangKnown};
}
async function four(command,params){
 const script=findOpenFourHelper();
 let out;try{out=(await run(process.execPath,[script,command,JSON.stringify(params)],{timeout:18000,maxBuffer:2<<20,env:{...process.env,NODE_USE_ENV_PROXY:'1'}})).stdout;}catch(e){out=e.stdout;if(!out)throw e;}
 const r=JSON.parse(out);if(!r.success)throw Object.assign(Error(r.error?.message||'Open Four 检查失败'),{code:r.error?.code});return r.data;
}
export async function detectRoute(rpc,token,w,platform){
 const cached=routeCache.get(token.toLowerCase());
 if(cached){try{const s=await cached.inspect({rpc,token,wallet:w});return {adapter:cached,state:s,route:s.migrated?'aggregate':cached.id};}catch{routeCache.delete(token.toLowerCase());}}
 const registered=await measure('routeRegistration',()=>probeRegistrations(rpc,token));
 const checks=await Promise.allSettled([registered.flap===false?Promise.resolve(null):flap.inspect({rpc,token,wallet:w}),registered.gang===false?Promise.resolve(null):gang.inspect({rpc,token,wallet:w}),/(4444|ffff)$/i.test(token)?four('info',{token,wallet:w}):Promise.resolve(null)]);
 const found=checks.slice(0,2).map((r,i)=>r.status==='fulfilled'&&r.value?{adapter:[flap,gang][i],state:r.value}:null).filter(Boolean);
 if(found.length>1)throw Error('多个发射台同时返回有效注册，需要核对合约');
 if(found.length){const f=found[0];routeCache.set(token.toLowerCase(),f.adapter);return {...f,route:f.state.migrated?'aggregate':f.adapter.id};}
 const f=checks[2].status==='fulfilled'?checks[2].value:null;
 if(f?.route==='contract-call')return {route:'openfour',state:f};
 if(f?.route==='wait'||f?.route==='unavailable'&&f.isAgentIdExclusive)throw Error('Open Four 正在迁移或暂停，目前不能交易');
 if(platform)throw Error(`未能核验 ${platform} 代币注册；不猜测交易入口`);
 return {route:'aggregate',diagnostics:checks.filter(r=>r.status==='rejected').map(r=>r.reason.message)};
}
export async function tradePlan(rpc,bridge,intent,token,platform,{overlapQuotes=true,overlapRouteReads=false,coldQuoteOverlap=true,earlyBuyQuote=true}={}){
 const w=wallet(intent.account).address,hints=hintMap(rpc),hintKey=token.toLowerCase();
 // Opt-in benchmark only: on the current RPC, putting registry and balance
 // reads in the same batch increased latency. Production starts the balance
 // first, then overlaps the quote and registry reads (see round 3 evidence).
 const warm=intent.side==='sell'&&!platform&&!routeCache.has(hintKey)&&(hints.get(hintKey)||0)>Date.now();
 const pendingRoute=warm&&overlapRouteReads?measure('tradeRoute',()=>detectRoute(rpc,token,w,platform)).then(route=>({route}),error=>({error})):null;
 // Buy input is already known; quote can run while token metadata/holdings are
 // read. This is read-only speculation; registry, audit and balance checks still
 // gate the final plan. Never do this for sell: its amount needs a fresh balance.
 const canSpeculate=overlapQuotes&&intent.currency!=='QUOTE'&&!platform&&!routeCache.has(hintKey)&&(coldQuoteOverlap||(hints.get(hintKey)||0)>Date.now());
 const earlyArgs=earlyBuyQuote&&canSpeculate&&intent.side==='buy'?['--binanceChainId','56','--fromToken',intent.currency==='USDT'?USDT:intent.currency==='WBNB'?WBNB:BNB,'--toToken',token,'--fromTokenQty',formatUnits(parseUnits(intent.amount,18),18),'--slippage',intent.slippageMode==='auto'?'auto':String(intent.slippageBps/100)]:null;
 const early=earlyArgs?measure('tradeQuote',()=>bridge.call(intent.account,['market-order','quote',...earlyArgs])).then(value=>({value}),error=>({error})):null;
 const [[d],[balance]]=await measure('tradeBalance',()=>Promise.all([read(rpc,token,ERC20,'decimals'),read(rpc,token,ERC20,'balanceOf',[w])]));
 const decimals=Number(d);if(decimals>36)throw Error('代币精度不支持');
 const amount=intent.side==='sell'?sellAmount(balance,intent.percent):null;
 const aggregateInput=intent.side==='sell'?token:intent.currency==='USDT'?USDT:intent.currency==='WBNB'?WBNB:BNB;
 const aggregateOutput=intent.side==='buy'?token:intent.currency==='USDT'?USDT:intent.currency==='WBNB'?WBNB:BNB;
 const aggregateAmount=amount??(intent.currency==='QUOTE'?null:parseUnits(intent.amount,18)),qty=aggregateAmount===null?'':formatUnits(aggregateAmount,intent.side==='sell'?decimals:18);
 const aggregateArgs=['--binanceChainId','56','--fromToken',aggregateInput,'--toToken',aggregateOutput,'--fromTokenQty',qty,'--slippage',intent.slippageMode==='auto'?'auto':String(intent.slippageBps/100)];
 const quoteOnly=()=>measure('tradeQuote',()=>bridge.call(intent.account,['market-order','quote',...aggregateArgs]));
 // Quote and registry are independent READS, including a first visit. Any
 // curve registration wins and discards this quote; its error is also isolated.
 // Holdings are always current and a zero holding never requests a quote.
 const speculative=early||(canSpeculate?quoteOnly().then(value=>({value}),error=>({error})):null);
 const routed=pendingRoute?await pendingRoute:{route:await measure('tradeRoute',()=>detectRoute(rpc,token,w,platform))};if(routed.error)throw routed.error;const route=routed.route;
 if(route.route!=='aggregate')hints.delete(hintKey);
 if(route.route==='aggregate'){
  if(intent.currency==='QUOTE')throw Error('聚合兑换没有唯一曲线计价币，请明确选择 BNB、USDT 或 WBNB');
  if(!route.diagnostics?.length){if(hints.size>256)hints.clear();hints.set(hintKey,Date.now()+30000);}
  const input=aggregateInput,output=aggregateOutput,amountIn=aggregateAmount,args=aggregateArgs;
  const result=speculative?await speculative:{value:await quoteOnly()};if(result.error)throw result.error;const quote=result.value;
  if(!quote.toCoinAmount||Number(quote.toCoinAmount)<=0)throw Error('聚合器没有返回有效报价');
  const slippage=quotedSlippage(intent,quote);args[args.indexOf('--slippage')+1]=String(slippage.bps/100);
  return {kind:'swap',route:'binance-aggregate',wallet:w,token,amountIn:String(amountIn),inputToken:input,outputToken:output,decimals,holdingBefore:String(balance),quote,slippage,args,review:[],steps:[]};
 }
 await bridge.ready(intent.account,{external:true});
 if(route.route==='openfour'){
  const params={token,wallet:w,slippageBps:intent.slippageBps,amount:amount?formatUnits(amount,decimals):intent.amount};
  if(intent.side==='buy'){if(!['BNB','QUOTE'].includes(intent.currency))throw Error('Open Four 该入口使用 BNB 或 QUOTE');params.payToken=intent.currency==='QUOTE'?route.state.quote.address:'BNB';}else{if(intent.currency==='USDT'&&!same(route.state.quote.address,USDT))throw Error('此内盘收款币不是 USDT，请选择 QUOTE 或 BNB');params.receive=['USDT','AUTO'].includes(intent.currency)?'QUOTE':intent.currency;}
  const q=await four(intent.side==='buy'?'quote-buy':'quote-sell',params);
  if(q.simulation?.ok===false)throw Error('Open Four 模拟失败');
  const tx=t=>({to:t.to,data:t.inputData,value:String(t.value||0)});
  const input=intent.side==='buy'?q.pay.token:token,output=intent.side==='buy'?token:['QUOTE','USDT','AUTO'].includes(intent.currency)?q.quote.address:intent.currency==='WBNB'?WBNB:BNB;
  const amountIn=amount??BigInt(q.pay.maxPayRaw),min=intent.side==='buy'?q.minTokenOutRaw:q.minReceiveRaw;
  return {kind:'contract',route:'openfour',wallet:w,token,inputToken:input,outputToken:output,amountIn:String(amountIn),holdingBefore:String(balance),decimals,minOutput:String(min),review:[],quote:q,steps:[...(q.approveTx?[{kind:'approve',...tx(q.approveTx),spender:q.tx.to,allowance:String(amountIn)}]:[]),{kind:intent.side,...tx(q.tx)}]};
 }
 const a=route.adapter,s=route.state;
 if(intent.side==='sell'&&!['AUTO','QUOTE'].includes(intent.currency)){
  const requested=intent.currency==='BNB'?ZeroAddress:intent.currency==='USDT'?USDT:WBNB;
  if(!same(requested,s.quoteToken)&&!(native(requested)&&native(s.quoteToken)))throw Error(`此内盘直接卖出到账 ${s.quoteSymbol}，请选择 AUTO / QUOTE；不会擅自更换指定收款币`);
 }
 let input=intent.side==='sell'?token:s.quoteToken;
 if(intent.side==='buy'&&intent.currency!=='QUOTE'){
  const requested=intent.currency==='BNB'?ZeroAddress:intent.currency==='USDT'?USDT:WBNB;
  if(a.id==='flap'&&same(requested,ZeroAddress)&&s.nativeToQuoteSwapEnabled)input=requested;
  else if(!same(requested,s.quoteToken))throw Error(`此曲线需 ${s.quoteSymbol}，请选择 QUOTE；不会额外自动兑换`);
 }
 const amountIn=amount??parseUnits(intent.amount,native(input)?18:s.quoteDecimals);
 const q=await a[intent.side==='buy'?'quoteBuy':'quoteSell']({rpc,token,wallet:w,amountIn,state:s,inputToken:input});
 const min=q.amountOut*BigInt(10000-intent.slippageBps)/10000n;if(min<=0n)throw Error('最低到账为零');
 const tx=await a[intent.side==='buy'?'buildBuy':'buildSell']({token,wallet:w,amountIn,minAmountOut:min,state:s,inputToken:input});
 const allowance=native(input)?amountIn:(await read(rpc,input,ERC20,'allowance',[w,s.spender]))[0];
 const approval=allowance<amountIn?[{kind:'approve',to:input,value:'0',data:ERC20.encodeFunctionData('approve',[s.spender,amountIn]),spender:s.spender,allowance:String(amountIn)}]:[];
 return {kind:'contract',route:a.id,wallet:w,token,amountIn:String(amountIn),inputToken:input,outputToken:intent.side==='buy'?token:s.quoteToken,holdingBefore:String(balance),decimals,minOutput:String(min),quote:q,review:[],state:s,steps:[...approval,{kind:intent.side,...tx,value:String(tx.value)}]};
}
export const settlements={...Object.fromEntries(DEXES.map(d=>[d.id+'-opening',openingSettlement])),flap:flap.settlement,gang:gang.settlement};
