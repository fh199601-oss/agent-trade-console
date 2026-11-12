// Gang's official, registry-backed 3.0 entry forwards earlier merged pads and
// flywheel pads too. No website name, CA suffix or API response authorizes a tx.
// Source: gangfun/gang-launchpad, GangLaunchpad3.sol / LegacyRoute.sol.
import {Interface,read,ERC20,BNB,WBNB,ZeroAddress,same,native,parseUnits,formatUnits} from './common.mjs';
import {codeIdentity} from './discovery.mjs';
export const GANG_ENTRY='0x2bEbED4be8c8F46C17776C71D7a6A45dbC5CAB29';
export const GANG_REGISTRY='0x4fF77D4d9ac080939a24E1B805206bA094C44e5C';
export const GANG_ABI=new Interface([
 'function padRegistry() view returns(address)',
 'function getTokenInfo(address) view returns(uint8 status,address quote,address pair,uint256 protocolFeeBps,uint256 graduationLeft)',
 'function tryBuy(address,address,uint256,uint256) view returns(address manager,address quote,uint256 amount,uint256 cost,uint256 fee,uint256 value,uint256 approval,uint256 funds)',
 'function trySell(address,uint256) view returns(address manager,address quote,uint256 funds,uint256 fee)',
 'function buyTokenAMAP(address,address,uint256,uint256) payable returns(uint256,uint256)',
 'function sellToken(uint256,address,address,uint256,uint256,uint256,address) returns(uint256)',
 'event GatewayBuy(address indexed token,address indexed trader,address indexed caller,uint256 fundsUsed,uint256 amountOut)',
 'event GatewaySell(address indexed token,address indexed trader,address indexed caller,uint256 amount,uint256 funds,uint256 fundsToSeller,uint256 routerFee,address feeRecipient)',
]);
export const GANG_REGISTRY_ABI=new Interface(['function lookup(address) view returns(address pad,uint8 kind)']);
export const GANG_PAD_ABI=new Interface([
 'function kindOf(address) view returns(uint8)','function isAgent(address) view returns(bool)',
 'function walletRoom(address,address) view returns(uint256)','function taxHandler() view returns(address)','function flyTaxHandler() view returns(address)',
 'function shareSizeOf(address) view returns(uint256)',
 'function curves(address) view returns(address creator,address quote,uint128 realQuote,uint128 sold,uint128 gradAmt,uint128 virtualQuote,bool graduated,uint16 buyTaxBps,uint16 sellTaxBps,uint16 dividendBps,address pair,address refPair)',
 'function sales(address) view returns(address creator,uint64 progressAt,uint16 capShares,uint16 holdBps,address quote,uint16 sold,bool launched,uint16 mintFeeBps,uint16 exitFeeBps,address gate,uint128 sharePrice,address pair,address refPool,uint16 markSold)',
 'function previewMint(address,address,uint256) view returns(uint256 accepted,uint256 cost,uint256 fee)',
 'function previewWithdraw(address,address,uint256) view returns(uint256 payout,uint256 fee)',
 'function mint(address,uint256,uint256) returns(uint256)',
 'function withdraw(address,uint256,uint256) returns(uint256)',
 'event Minted(address indexed token,address indexed trader,uint256 shares,uint256 cost,uint256 fee,uint256 sold)',
 'event Withdrawn(address indexed token,address indexed trader,uint256 shares,uint256 payout,uint256 fee)',
]);
export const FLY_ABI=new Interface([
 'function sales(address) view returns((address creator,address quote,address gate,address pair,uint128 basePrice,uint64 totalShares,uint64 filledAt,uint64 progressAt,uint16 sold,uint16 creatorShares,uint16 markSold,uint16 baseQuota,uint16 holdBps,uint16 mintFeeBps,uint16 exitFeeBps,uint16 devCutBps,uint16 buyBps,uint32 launchDelay,uint32 window,uint8 inviteBonus,uint8 maxPerTx,uint8 windowCapMul,uint8 tierMode,uint16 stepBps,uint32 stepShares,uint16 maxMulX100,bool postMint,bool launched))',
 'function quotaLeft(address,address) view returns(uint256)',
 'function mint(address,uint256,uint256,address) returns(uint256)',
 'function mintWithBnb(address,uint256,uint256,address) payable returns(uint256)',
]);
const clients=new WeakMap();
export function gangClient(rpc){if(!clients.has(rpc))clients.set(rpc,new GangClient(rpc));return clients.get(rpc);}
export class GangClient{
 constructor(rpc,{identityFor=codeIdentity}={}){this.rpc=rpc;this.identityFor=identityFor;this.pending=new Map();this.metadata=new Map();this.known=new Set();this.warmAfter=new Map();this.identities=new Map();}
 async shared(key,fn){if(this.pending.has(key))return this.pending.get(key);const p=fn();this.pending.set(key,p);try{return await p;}finally{this.pending.delete(key);}}
 // Display-driven, read-only registration/metadata warmup. No balances, quotes,
 // approvals or transactions are cached. A real plan still rereads live state.
 warm(token){const key=token.toLowerCase();if((this.warmAfter.get(key)||0)>Date.now())return Promise.resolve(null);this.warmAfter.set(key,Date.now()+15000);if(this.warmAfter.size>128)this.warmAfter.delete(this.warmAfter.keys().next().value);return this.probe(token).then(async s=>{if(s)await this.meta(s.quoteToken);return s;});}
 // Coalesce simultaneous wallets, never cache balances or tradability.
 probe(token){return this.shared('probe:'+token.toLowerCase(),async()=>{
  const raw=await this.rpc.call({to:GANG_ENTRY,data:GANG_ABI.encodeFunctionData('getTokenInfo',[token])}),v=GANG_ABI.decodeFunctionResult('getTokenInfo',raw);
  if(GANG_ABI.encodeFunctionResult('getTokenInfo',v).toLowerCase()!==raw.toLowerCase())throw Object.assign(Error('Gang 登记返回不规范'),{code:'GANG_IDENTITY_MISMATCH'});
  if(Number(v.status)===0)return null;
  if(![1,2,3].includes(Number(v.status)))throw Object.assign(Error('Gang 返回未知交易状态'),{code:'GANG_IDENTITY_MISMATCH'});
  const [[registry],[pad,kind]]=await Promise.all([read(this.rpc,GANG_ENTRY,GANG_ABI,'padRegistry'),read(this.rpc,GANG_REGISTRY,GANG_REGISTRY_ABI,'lookup',[token])]).catch(e=>{throw Object.assign(Error('Gang 已识别，但链上登记核验暂未完成：'+e.message),{code:'GANG_IDENTITY_MISMATCH'});});
  if(!same(registry,GANG_REGISTRY)||same(pad,ZeroAddress)||![1,2,3].includes(Number(kind)))throw Object.assign(Error('Gang 官方登记与交易入口不一致'),{code:'GANG_IDENTITY_MISMATCH'});
  this.known.add(token.toLowerCase());if(this.known.size>512)this.known.delete(this.known.values().next().value);
  const quoteToken=native(v.quote)?BNB:v.quote;
  return {platform:'gang',modern:true,token,pad,kind:Number(kind),mode:['','curve','fair','fly'][Number(kind)],status:Number(v.status),migrated:Number(v.status)===2,pair:v.pair,quoteToken,feeBps:Number(v.protocolFeeBps),graduationLeft:String(v.graduationLeft)};
 });}
 meta(token){const key=token.toLowerCase(),old=this.metadata.get(key);if(old?.until>Date.now())return Promise.resolve(old.value);return this.shared('meta:'+key,async()=>{
  const value=native(token)?{decimals:18,symbol:'BNB'}:await Promise.all([read(this.rpc,token,ERC20,'decimals'),read(this.rpc,token,ERC20,'symbol').catch(()=>['代币'])]).then(([d,s])=>({decimals:Number(d[0]),symbol:String(s[0]).slice(0,32)}));
  if(value.decimals>36)throw Error('Gang 计价币精度不支持');this.metadata.set(key,{value,until:Date.now()+60000});if(this.metadata.size>128)this.metadata.delete(this.metadata.keys().next().value);return value;
 });}
 async identity(state){const key=state.pad.toLowerCase(),old=this.identities.get(key);if(old?.until>Date.now())return old.value;return this.shared('identity:'+key,async()=>{const value=await Promise.all([...new Set([GANG_ENTRY,GANG_REGISTRY,state.pad])].map(a=>this.identityFor(this.rpc,a)));this.identities.set(key,{value,until:Date.now()+15000});if(this.identities.size>64)this.identities.delete(this.identities.keys().next().value);return value;});}
 async detail(state){return this.shared('detail:'+state.token,async()=>{
  if(state.kind===1){const c=await read(this.rpc,state.pad,GANG_PAD_ABI,'curves',[state.token]);return {creator:c.creator,refPair:c.refPair,buyTaxBps:Number(c.buyTaxBps),sellTaxBps:Number(c.sellTaxBps)};}
  if(state.kind===2){const s=await read(this.rpc,state.pad,GANG_PAD_ABI,'sales',[state.token]);return {gate:s.gate,price:s.sharePrice,mintFeeBps:Number(s.mintFeeBps),cap:Number(s.capShares),sold:Number(s.sold),shareSize:50000n*10n**18n};}
  const [s]=await read(this.rpc,state.pad,FLY_ABI,'sales',[state.token]);return {gate:s.gate,price:s.basePrice,mintFeeBps:Number(s.mintFeeBps),cap:Number(s.maxPerTx),sold:Number(s.sold),filledAt:Number(s.filledAt),launchDelay:Number(s.launchDelay),postMint:s.postMint,shareSize:100000n*10n**18n};
 });}
 async quote(state,owner,side,amount){
  amount=BigInt(amount);let q;
  if(side==='sell'&&state.kind!==1){const size=state.kind===2?50000n*10n**18n:100000n*10n**18n;amount=amount/size*size;if(amount===0n)throw Object.assign(Error('Gang 此内盘按整份退售，本次比例不足 1 份；可提高卖出比例'),{code:'GANG_WHOLE_SHARE_REQUIRED'});}
  if(side==='buy'){
   const r=await read(this.rpc,GANG_ENTRY,GANG_ABI,'tryBuy',[state.token,owner,0,amount]);
   if(!same(r.manager,GANG_ENTRY)||!(same(r.quote,state.quoteToken)||native(r.quote)&&native(state.quoteToken)))throw Error('Gang 买入报价身份不一致');
   q={amountIn:r.value+r.approval,amountOut:r.amount,cost:r.cost,fee:r.fee,value:r.value};
   if(q.amountIn>amount||q.value!==0n&&r.approval!==0n||q.cost>q.amountIn)throw Error('Gang 报价超过付款预算');
  }else{
   const r=await read(this.rpc,GANG_ENTRY,GANG_ABI,'trySell',[state.token,amount]);
   if(!same(r.manager,GANG_ENTRY)||!(same(r.quote,state.quoteToken)||native(r.quote)&&native(state.quoteToken)))throw Error('Gang 卖出报价身份不一致');
   q={amountIn:amount,amountOut:r.funds,fee:r.fee,value:0n};
  }
  // Ungated fair/fly sales deliberately reject aggregator buys. Use their
  // official direct share interfaces, after registry + fresh per-wallet quote.
  if(q.amountOut===0n&&state.kind!==1){
   const d=await this.detail(state);
   if(side==='buy'&&d.price>0n&&amount<d.price*(10000n+BigInt(d.mintFeeBps))/10000n){const m=await this.meta(state.quoteToken);throw Object.assign(Error('Gang 本次预算不足 1 份：每份至少 '+formatUnits(d.price*(10000n+BigInt(d.mintFeeBps))/10000n,m.decimals)+' '+m.symbol+'（Gas 另计）'),{code:'GANG_BELOW_MIN_LOT'});}
   if(same(d.gate,ZeroAddress)){
    const shares=side==='sell'?amount/d.shareSize:(amount*10000n/(d.price*BigInt(10000+d.mintFeeBps)));
    const n=side==='buy'?shares<BigInt(d.cap||10000)?shares:BigInt(d.cap||10000):shares;
    if(n>0n){const r=await read(this.rpc,state.pad,GANG_PAD_ABI,side==='buy'?'previewMint':'previewWithdraw',[state.token,owner,n]);q=side==='buy'?{amountIn:r.cost+r.fee,amountOut:r.accepted*d.shareSize,cost:r.cost+r.fee,fee:r.fee,value:0n,shares:r.accepted,direct:true}:{amountIn:n*d.shareSize,amountOut:r.payout,fee:r.fee,value:0n,shares:n,direct:true};}
   }
  }
  if(side==='buy'&&q.amountIn>amount)throw Error('Gang 报价超过付款预算');
  if(q.amountOut<=0n||q.amountIn<=0n){
   const agent=await read(this.rpc,state.pad,GANG_PAD_ABI,'isAgent',[owner]).catch(()=>null);
   throw Object.assign(Error(agent?.[0]===false?'Gang Agent ID 资格检查未通过；Agentic 钱包登录不等于已持有 .ai Agent ID':'Gang 当前额度、持仓上限、整份金额或开盘状态不允许本次操作；未提交，可修改金额重试'),{code:agent?.[0]===false?'GANG_AGENT_REQUIRED':'GANG_QUOTE_UNAVAILABLE'});
  }
  return q;
 }
}
export async function gangInternalPlan(rpc,intent,state,owner,balance,{amount,conversion,client=gangClient(rpc)}={}){
 const identityTask=client.identity(state).then(value=>({value}),error=>({error}));
 const meta=await client.meta(state.quoteToken),buy=intent.side==='buy';
 const requested=buy?intent.currency==='QUOTE'?state.quoteToken:intent.currency==='USDT'?'0x55d398326f99059fF775485246999027B3197955':intent.currency==='WBNB'?WBNB:BNB:state.token;
 const budget=amount??parseUnits(intent.amount,native(requested)?18:same(requested,state.quoteToken)?meta.decimals:18);
 let prefix=null,suffix=null,available=budget,slip=intent.slippageBps;
 if(buy&&!same(requested,state.quoteToken)){
  if(!conversion)throw Error('需要先兑换 Gang 计价币：'+meta.symbol);
  prefix=await conversion({inputToken:requested,outputToken:state.quoteToken,amount:budget,owner,slippageBps:Math.floor(slip/2)});available=BigInt(prefix.minOutput);slip-=Math.floor(slip/2);
 }
 const [q,identityResult]=await Promise.all([client.quote(state,owner,intent.side,available),identityTask]);if(identityResult.error)throw identityResult.error;const identities=identityResult.value;
 let input=buy?state.quoteToken:state.token,output=buy?state.token:state.quoteToken;
 // The native unified entry wraps WBNB itself. Direct ungated share entries
 // need ERC20 WBNB, except Fly's explicit mintWithBnb.
 if(q.direct&&native(input)&&!(state.kind===3&&buy)){
  if(!conversion)throw Error('此打新入口需要 WBNB');
  const wrap=await conversion({inputToken:BNB,outputToken:WBNB,amount:q.amountIn,owner,slippageBps:0});prefix=prefix?{...wrap,steps:[...prefix.steps,...wrap.steps],identities:[...prefix.identities,...wrap.identities]}:wrap;input=WBNB;
 }
 const target=q.direct?state.pad:GANG_ENTRY;
 const wantOutput=buy?null:['AUTO','QUOTE'].includes(intent.currency)?output:intent.currency==='USDT'?'0x55d398326f99059fF775485246999027B3197955':intent.currency==='WBNB'?WBNB:BNB;
 if(!buy&&!same(wantOutput,output))slip=Math.floor(slip/2);
 const minimum=q.amountOut*BigInt(10000-slip)/10000n;if(minimum<=0n)throw Error('Gang 最低到账为零');
 let data,value=buy&&native(input)?q.amountIn:0n;
 if(q.direct){
  if(buy&&state.kind===3)data=FLY_ABI.encodeFunctionData(native(input)?'mintWithBnb':'mint',[state.token,q.shares,q.shares,ZeroAddress]);
  else data=GANG_PAD_ABI.encodeFunctionData(buy?'mint':'withdraw',[state.token,q.shares,buy?q.shares:minimum]);
  if(!buy&&native(output))output=WBNB;
 }else data=GANG_ABI.encodeFunctionData(buy?'buyTokenAMAP':'sellToken',buy?[state.token,owner,q.amountIn,minimum]:[0,state.token,owner,q.amountIn,minimum,0,ZeroAddress]);
 const [allowance]=native(input)?[q.amountIn]:await read(rpc,input,ERC20,'allowance',[owner,target]);
 const scope={inputToken:input,outputToken:output,amountIn:String(q.amountIn),minOutput:String(minimum),state:{...state,direct:!!q.direct,shareSize:state.kind===2?String(50000n*10n**18n):String(100000n*10n**18n)}};
 const steps=[...(prefix?.steps||[]),...(allowance<q.amountIn?[{kind:'approve',to:input,value:'0',data:ERC20.encodeFunctionData('approve',[target,q.amountIn]),spender:target,allowance:String(q.amountIn)}]:[]),{kind:intent.side,to:target,value:String(value),data,tradeLeg:{...scope,settlementRoute:'gang-modern'}}];
 if(!buy&&!same(wantOutput,output)){
  if(!conversion)throw Error('需要兑换 Gang 卖出到账币种');
  suffix=await conversion({inputToken:output,outputToken:wantOutput,amount:minimum,owner,slippageBps:intent.slippageBps-slip});steps.push(...suffix.steps);
 }
 const feeBase=buy?q.amountIn:q.amountOut+q.fee;
 return {kind:'contract',route:'gang-modern',token:state.token,wallet:owner,account:intent.account,amountIn:String(buy?budget:q.amountIn),inputToken:buy?requested:state.token,outputToken:suffix?.outputToken||output,minOutput:suffix?.minOutput||String(minimum),holdingBefore:String(balance),decimals:18,outputDecimals:buy?18:suffix?.outputDecimals??meta.decimals,
  state:{...state,feeBps:Number((q.fee*10000n+feeBase-1n)/feeBase)},gang:true,stagedTrade:true,protocolIdentities:[...identities,...(prefix?.identities||[]),...(suffix?.identities||[])],requireSellCredit:!buy,requireTradeCredit:true,
  quote:{fromCoinAmount:formatUnits(buy?budget:q.amountIn,buy&&same(requested,state.quoteToken)?meta.decimals:18),fromCoinSymbol:buy?(intent.currency==='QUOTE'?meta.symbol:intent.currency):'项目代币',toCoinSymbol:buy?'项目代币':suffix?intent.currency:meta.symbol,toCoinAmount:formatUnits(suffix?.amountOut??q.amountOut,buy?18:suffix?.outputDecimals??meta.decimals),quoteSymbol:meta.symbol,quoteToken:state.quoteToken,roundedShares:state.kind!==1,conversion:!!(prefix||suffix)},
  poolFees:suffix?.fees,slippage:{mode:'fixed',bps:intent.slippageBps,capBps:intent.slippageBps},review:[],steps};
}
// Reprice only the unsent sell leg. Never recalculate the percentage, replace a
// sent transaction or spend more. A following conversion retains its input floor.
export async function refreshGangSell(rpc,plan,index,client=gangClient(rpc)){
 const old=plan.steps[index],leg=old?.tradeLeg,state=leg?.state;
 if(old?.kind!=='sell'||leg?.settlementRoute!=='gang-modern'||!state)throw Error('Gang 卖出刷新缺少已核验入口');
 const fresh=await client.probe(state.token);
 if(!fresh||fresh.migrated||!same(fresh.pad,state.pad)||fresh.kind!==state.kind||!same(fresh.quoteToken,state.quoteToken))throw Object.assign(Error('Gang 已迁移或交易入口变化，请重新按当前市场预览'),{code:'GANG_MARKET_CHANGED'});
 const [q,[balance]]=await Promise.all([client.quote(fresh,plan.wallet,'sell',BigInt(leg.amountIn)),read(rpc,state.token,ERC20,'balanceOf',[plan.wallet])]);
 if(String(balance)!==plan.holdingBefore||String(q.amountIn)!==leg.amountIn||!!q.direct!==!!state.direct)throw Error('Gang 当前持仓或卖出份数已变化，请重新预览');
 const hasConversion=plan.steps.slice(index+1).some(s=>s.kind==='conversion');
 let minimum=q.amountOut*BigInt(10000-(hasConversion?Math.floor(plan.slippage.bps/2):plan.slippage.bps))/10000n;
 if(hasConversion&&minimum<BigInt(leg.minOutput))minimum=BigInt(leg.minOutput);
 if(minimum<=0n||q.amountOut<minimum)throw Object.assign(Error('Gang 最新卖出到账不足后续兑换所需金额，请重新预览'),{code:'SLIPPAGE_LIMIT'});
 const data=q.direct?GANG_PAD_ABI.encodeFunctionData('withdraw',[state.token,q.shares,minimum]):GANG_ABI.encodeFunctionData('sellToken',[0,state.token,plan.wallet,q.amountIn,minimum,0,ZeroAddress]);
 const feeBase=q.amountOut+q.fee,feeBps=Number((q.fee*10000n+feeBase-1n)/feeBase);
 const steps=plan.steps.map((s,n)=>n===index?{...s,data,tradeLeg:{...leg,minOutput:String(minimum),state:{...state,feeBps}}}:s);
 return {...plan,steps,state:{...plan.state,feeBps},...(!hasConversion?{minOutput:String(minimum),quote:{...plan.quote,toCoinAmount:formatUnits(q.amountOut,plan.outputDecimals)}}:{}),quoteRefreshedAt:Date.now()};
}
export function gangSettlement({receipt,wallet:owner,token,side,state,step}){
 const abi=state.direct?GANG_PAD_ABI:GANG_ABI,name=state.direct?side==='buy'?'Minted':'Withdrawn':side==='buy'?'GatewayBuy':'GatewaySell';
 const events=(receipt.logs||[]).filter(l=>same(l.address,step.to)).flatMap(l=>{try{const e=abi.parseLog(l);return e?.name===name&&same(e.args.token,token)&&same(e.args.trader,owner)?[e]:[];}catch{return [];}});
 if(events.length!==1)throw Error('Gang 回执中无法唯一核验本钱包成交');const e=events[0].args;
 if(!state.direct&&(!same(e.caller,owner)||side==='sell'&&e.routerFee!==0n))throw Error('Gang 实际调用者或额外路由费用不一致');
 return state.direct?{amountIn:side==='buy'?e.cost+e.fee:e.shares*BigInt(state.shareSize),amountOut:side==='buy'?e.shares*BigInt(state.shareSize):e.payout}:{amountIn:side==='buy'?e.fundsUsed:e.amount,amountOut:side==='buy'?e.amountOut:e.fundsToSeller};
}
