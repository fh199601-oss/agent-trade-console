import {ManualSellPreparation} from './manual-sell-preparation.mjs';
import {hash,validateIntent} from './common.mjs';
import {previewUsable} from './preview-cache.mjs';
import {queuedSellEligible} from './queued-sell-preview.mjs';

// These are unsigned official preview handles, not signed transactions. A
// click consumes the entry; fresh planning/guards still determine its use.
export class TradePreparation extends ManualSellPreparation{
 constructor(options){super(options);this.routeSeedTtlMs=60000;}
 intent(input){
  const allowed=new Set(['account','side','asset','amount','percent','currency','slippageBps','slippageMode']);
  if(!input||Object.keys(input).some(k=>!allowed.has(k)))throw Error('交易预热只接受钱包、CA、买卖数量、币种和滑点');
  const i=validateIntent(input);
  if(!['buy','sell'].includes(i.side)||!/^0x[\da-f]{40}$/i.test(i.asset)||/^0x0{40}$/i.test(i.asset))throw Error('交易预热仅支持代币买卖，不执行交易');
  return i;
 }
 slot(i){return i.account+':'+i.side;}
 key(i){return super.key({...i,slippageMode:i.slippageMode||'fixed'});}
 accept(p,i){return p.kind==='swap'?i.side==='buy'&&p.route==='binance-aggregate'&&p.slippage?.mode==='fixed':p.kind==='contract'&&p.steps?.length>0&&p.steps.every(s=>['buy','sell','approve','conversion'].includes(s.kind));}
 shouldPreview(p){return p.kind==='contract';}
 compatible(a,b){return this.key(a)===this.key(b)||a.side==='sell'&&b.side==='sell'&&this.key({...a,percent:'100'})===this.key({...b,percent:'100'});}
 inspect(i){
  const entry=this.entries.get(this.slot(i)),age=entry?this.now()-(entry.readyAt??entry.startedAt):null;
  return {state:!entry?(this.pending.has(i.account)?'preparing':'missing'):!this.compatible(entry.intent,i)?'different-intent':age<0||age>=this.routeSeedTtlMs?'expired':age>=this.ttlMs||this.key(i)!==entry.key?'route-only':'ready',...(age===null?{}:{ageMs:age})};
 }
 take(i){
  const entry=this.entries.get(this.slot(i));let hit;
  // The default 100% warmer used to be useless when a user clicked 10/50%.
  // Reuse only its verified route, never its amount, minimum or requestId.
  const seedAge=this.now()-(entry?.readyAt??entry?.startedAt);
  const routeSeed=i.side==='sell'&&entry&&(this.key(i)!==entry.key||seedAge>=this.ttlMs)&&
   entry.plan.manualRouteRecovery&&queuedSellEligible(entry.plan,entry.plan.steps.length-1)&&
   this.compatible(entry.intent,i);
  if(routeSeed){
   // A route is not a quote or a requestId. Fresh holdings, allowance, registry,
   // code, fees, automatic slippage and minimum are all rebuilt on consumption.
   // Retain topology through idle/hover gaps, never an expired wallet preview.
   super.take(entry.intent);
   hit=!this.closed&&seedAge>=0&&seedAge<this.routeSeedTtlMs&&this.now()>=entry.startedAt?{...entry,preview:null,routeSeedOnly:true}:null;
  }
  else hit=super.take(i);
  this.entries.delete(i.account+':buy');this.entries.delete(i.account+':sell');return hit;
 }
}

// Exact first-step reuse works across curve modes, quote currencies and
// conversion approvals. Do not replace calldata/minimum to fit a requestId.
export function exactPreparedPreview(fresh,warm,now=Date.now()){
 const old=warm?.plan,p=warm?.preview;
 if(!previewUsable(p,now,6000)||!old||!fresh?.steps?.length)return null;
 const binding=q=>hash({wallet:q.wallet,token:q.token,route:q.route,account:q.account,
  input:q.inputToken,output:q.outputToken,amount:q.amountIn,holding:q.holdingBefore,
  identity:q.identity,protocolIdentities:q.protocolIdentities,slippage:q.slippage,
  minOutput:q.steps[0].kind==='approve'?undefined:q.minOutput,step:q.steps[0]});
 return binding(old)===binding(fresh)?{...p,validatedAt:now,preparationReused:true}:null;
}

// Exact sender/target/calldata check runs beside fresh planning. Its timeout
// only drops the optional cache; it never times out or retries a submission.
export function checkPreparedCall(rpc,plan,timeoutMs=300){
 let timer;const s=plan.steps[0];
 return Promise.race([
  Promise.resolve().then(()=>rpc.call({from:plan.wallet,to:s.to,data:s.data,value:'0x'+BigInt(s.value).toString(16)},'latest')).then(()=>true,()=>false),
  new Promise(r=>timer=setTimeout(()=>r(false),timeoutMs))
 ]).finally(()=>clearTimeout(timer));
}
