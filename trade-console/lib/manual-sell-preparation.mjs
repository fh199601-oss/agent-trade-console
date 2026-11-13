import {hash,validateIntent} from './common.mjs';
import {queuedSellEligible} from './queued-sell-preview.mjs';
import {assessSellFees} from './trade-fees.mjs';

// An ephemeral, single-use READ-ONLY preparation, never an order or consent.
// Foreground work never waits for an unfinished warmup. A changed intent,
// account binding, holding, allowance or route falls back to normal planning.
export class ManualSellPreparation {
 constructor({plan,preview,busy=()=>false,now=Date.now,ttlMs=6000,limit=4}){
  Object.assign(this,{plan,preview,busy,now,ttlMs,limit});this.entries=new Map();this.pending=new Map();this.epochs=new Map();this.after=new Map();this.closed=false;
 }
 intent(input){
  const allowed=new Set(['account','side','asset','percent','currency','slippageBps','slippageMode']);
  if(!input||Object.keys(input).some(k=>!allowed.has(k)))throw Error('卖出预热只接受钱包、CA、比例、到账币和滑点');
  const intent=validateIntent(input);
  if(intent.side!=='sell'||!/^0x[\da-f]{40}$/i.test(intent.asset)||/^0x0{40}$/i.test(intent.asset))throw Error('预热只支持代币卖出，不执行交易');
  return intent;
 }
 key(intent){return hash(Object.fromEntries(Object.entries(intent).sort(([a],[b])=>a.localeCompare(b))));}
 request(input,allowed=()=>true){
  const intent=this.intent(input),a=intent.account,key=this.key(intent),now=this.now();
  if(this.closed||!allowed()||this.busy(a)||this.pending.has(a)||this.pending.size>=this.limit)return null;
  if(this.after.get(a)?.key===key&&this.after.get(a).at>now)return null;
  const epoch=this.epochs.get(a)||0;this.after.set(a,{key,at:now+4000});if(this.entries.get(a)?.key!==key)this.entries.delete(a);
  const valid=()=>!this.closed&&allowed()&&!this.busy(a)&&(this.epochs.get(a)||0)===epoch;
  const task=Promise.resolve().then(async()=>{
   if(!valid())return;
   const plan=await this.plan(intent,valid);
   if(!valid()||!plan.manualRouteRecovery||!queuedSellEligible(plan,plan.steps.length-1)||plan.steps.some(s=>!['approve','sell'].includes(s.kind))||this.now()-now>=this.ttlMs)return;
   const fees=assessSellFees(plan,null);if(fees.blocked||fees.required)return;
   // A sale must be repriced at click anyway. Only the exact approval can save
   // an official simulation here; don't flood a wallet with unused sale previews.
   const preview=plan.steps[0].kind==='approve'?await this.preview(plan,intent):null;
   if(!valid()||this.now()-now>=this.ttlMs)return;
   this.entries.set(a,{key,intent,plan,preview,startedAt:now});
  }).catch(()=>{}).finally(()=>{if(this.pending.get(a)===task)this.pending.delete(a);});
  this.pending.set(a,task);return task;
 }
 take(intent){
  const a=intent.account,entry=this.entries.get(a);this.entries.delete(a);this.epochs.set(a,(this.epochs.get(a)||0)+1);
  if(this.closed||!entry||this.key(intent)!==entry.key||this.now()<entry.startedAt||this.now()-entry.startedAt>=this.ttlMs)return null;
  return entry;
 }
 close(){this.closed=true;this.entries.clear();}
}
