import {hash,validateIntent} from './common.mjs';
import {queuedSellEligible} from './queued-sell-preview.mjs';
import {assessSellFees} from './trade-fees.mjs';
import {previewUsable} from './preview-cache.mjs';

// A requestId binds the sender and the entire first transaction. In particular
// an exact approval does not change when the later swap's quote changes.
const firstCallKey=p=>hash({account:p.account,wallet:p.wallet,step:p.steps[0]});

// An ephemeral, single-use READ-ONLY preparation, never an order or consent.
// Foreground work never waits for an unfinished warmup. A changed intent,
// account binding, holding, allowance or route falls back to normal planning.
export class ManualSellPreparation {
 constructor({plan,preview,busy=()=>false,now=Date.now,ttlMs=6000,maxPreparationMs=30000,limit=4}){
  Object.assign(this,{plan,preview,busy,now,ttlMs,maxPreparationMs,limit});this.entries=new Map();this.pending=new Map();this.epochs=new Map();this.after=new Map();this.closed=false;
 }
 intent(input){
  const allowed=new Set(['account','side','asset','percent','currency','slippageBps','slippageMode']);
  if(!input||Object.keys(input).some(k=>!allowed.has(k)))throw Error('卖出预热只接受钱包、CA、比例、到账币和滑点');
  const intent=validateIntent(input);
  if(intent.side!=='sell'||!/^0x[\da-f]{40}$/i.test(intent.asset)||/^0x0{40}$/i.test(intent.asset))throw Error('预热只支持代币卖出，不执行交易');
  return intent;
 }
 key(intent){return hash(Object.fromEntries(Object.entries(intent).sort(([a],[b])=>a.localeCompare(b))));}
 slot(intent){return intent.account;}
 accept(plan){return plan.manualRouteRecovery&&queuedSellEligible(plan,plan.steps.length-1)&&plan.steps.every(s=>['approve','sell'].includes(s.kind));}
 shouldPreview(plan){return plan.steps[0].kind==='approve';}
 compatible(previous,next){return this.key(previous)===this.key(next);}
 request(input,allowed=()=>true){
  const intent=this.intent(input),a=intent.account,slot=this.slot(intent),key=this.key(intent),now=this.now();
  if(this.closed||!allowed()||this.busy(a)||this.pending.has(a)||this.pending.size>=this.limit)return null;
  if(this.after.get(a)?.key===key&&this.after.get(a).at>now)return null;
  const epoch=this.epochs.get(a)||0;this.after.set(a,{key,at:now+4000});
  const previous=this.entries.get(slot);if(previous&&!this.compatible(previous.intent,intent))this.entries.delete(slot);
  const valid=()=>!this.closed&&allowed()&&!this.busy(a)&&(this.epochs.get(a)||0)===epoch;
  const task=Promise.resolve().then(async()=>{
   if(!valid())return;
   const plan=await this.plan(intent,valid);
   if(!valid()||!this.accept(plan,intent)||this.now()-now>=this.maxPreparationMs)return;
   const fees=intent.side==='sell'?assessSellFees(plan,null):null;if(fees?.blocked||fees?.required)return;
   // The legacy cache warms approvals only; TradePreparation also allows the
   // first unsigned trade preview. Consumption always rechecks fresh state.
   // A slow optional preview must not throw away a useful verified route.
   // This entry is only a planning seed: take() always runs fresh state guards.
   // Never extend a requestId's own timestamp or server expiry.
   const previous=this.entries.get(slot);
   const retained=previous&&this.compatible(previous.intent,intent)&&
    previewUsable(previous.preview,this.now(),this.ttlMs)&&firstCallKey(previous.plan)===firstCallKey(plan)?previous.preview:null;
   const entry={key,intent,plan,preview:retained,startedAt:now,readyAt:this.now()};
   this.entries.set(slot,entry);
   if(this.shouldPreview(plan))try{
    const preview=await this.preview(plan,intent);
    // A click may own this entry while its independent fresh guards run. It
    // can consume a preview that finishes during those guards, but a late
    // result can never reinsert an entry or start/continue any operation.
    if(!this.closed&&(entry.consumed||valid()&&this.entries.get(slot)===entry))entry.preview=preview;
   }catch{/* Foreground obtains its own preview; retain only the planning seed. */}
  }).catch(()=>{}).finally(()=>{if(this.pending.get(a)===task)this.pending.delete(a);});
  this.pending.set(a,task);return task;
 }
 take(intent){
  const a=intent.account,slot=this.slot(intent),entry=this.entries.get(slot);this.entries.delete(slot);this.epochs.set(a,(this.epochs.get(a)||0)+1);
  const ready=entry?.readyAt??entry?.startedAt;
  if(this.closed||!entry||this.key(intent)!==entry.key||this.now()<entry.startedAt||this.now()<ready||this.now()-ready>=this.ttlMs)return null;
  entry.consumed=true;return entry;
 }
 close(){this.closed=true;this.entries.clear();}
}
