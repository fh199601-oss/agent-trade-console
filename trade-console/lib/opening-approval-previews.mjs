import {ERC20,hash,percentOf,same,wallet} from './common.mjs';
import {dexFor,matchesCurrency} from './opening-dex.mjs';
import {freshOpeningSnapshot} from './opening-pools.mjs';

// Memory-only, single-use official APPROVAL previews. No sale quotes, signing,
// authorization transactions or infinite allowances are prepared here.
export class OpeningApprovalPreviews{
 constructor({preview,now=Date.now,busy=()=>false,ttlMs=10000}){Object.assign(this,{preview,now,busy,ttlMs});this.entries=new Map();this.pending=new Set();}
 key(plan,intent,step){
  if(intent.side!=='sell'||!intent.openingOnly||step?.kind!=='approve'||step.approvalType||!plan.identity?.fingerprint)return null;
  if(!same(wallet(intent.account).address,plan.wallet)||!same(step.to,plan.token)||BigInt(step.value)!==0n||BigInt(step.allowance)!==BigInt(plan.amountIn))return null;
  const d=dexFor(plan.opening);if(!d||!same(d.router,step.spender))return null;
  const decoded=ERC20.decodeFunctionData('approve',step.data);if(!same(decoded[0],d.router)||decoded[1]!==BigInt(plan.amountIn))return null;
  return hash({account:intent.account,wallet:plan.wallet.toLowerCase(),token:plan.token.toLowerCase(),holding:plan.holdingBefore,identity:plan.identity,step});
 }
 take(plan,intent,index){
  const step=plan.steps?.[index],key=this.key(plan,intent,step);if(!key)return null;
  const hit=this.entries.get(key);if(!hit)return null;this.entries.delete(key);
  if(this.now()-hit.at<0||this.now()-hit.at>this.ttlMs)return null;
  return {...hit,approvalPrewarmed:true};
 }
 async warm(config,preflight,snapshot,preparation,allowed=()=>true){
  if(!preparation||!freshOpeningSnapshot(snapshot,config.asset,6000)||!allowed())return;
  // Only pre-existing factory-verified pools. Prefer the token's declared pool;
  // don't generate five wallet requests for speculative destinations.
  const candidates=snapshot.pools.filter(p=>['v2','v3'].includes(p.kind)&&dexFor(p)&&matchesCurrency(p,config.currency));
  candidates.sort((a,b)=>Number(!!b.declaredByToken)-Number(!!a.declaredByToken));
  const pool=candidates[0];if(!pool)return;const d=dexFor(pool);
  const [meta,venue]=await Promise.all([preparation.token(config.asset),preparation.venue(d)]);
  if(meta.identity.fingerprint!==preflight.fingerprint||!allowed())return;
  await Promise.all(config.accounts.map(async account=>{
   if(this.busy(account)||this.pending.has(account)||!allowed())return;
   const row=preflight.rows.find(r=>r.account===account),w=wallet(account);
   if(!row||!same(row.address,w.address)||row.routes.find(r=>r.id===d.id)?.approvalNeeded!==true)return;
   const amount=percentOf(BigInt(row.balance),config.percent);if(amount<=0n)return;
   const step={kind:'approve',to:config.asset,value:'0',data:ERC20.encodeFunctionData('approve',[d.router,amount]),spender:d.router,allowance:String(amount)};
   const plan={kind:'contract',account,token:config.asset,wallet:w.address,inputToken:config.asset,amountIn:String(amount),holdingBefore:row.balance,identity:{...meta.identity,learnedAssets:venue.assets},opening:pool,steps:[step]};
   const intent={...config,side:'sell',openingOnly:true,account},key=this.key(plan,intent,step);
   if(!key||this.entries.get(key)?.at>this.now()-5000)return;
   this.pending.add(account);
   try{
    const preview=await this.preview(plan,intent);
    if(!allowed()||this.busy(account))return;
    this.entries.set(key,preview);
    for(const [k,v]of this.entries)if(this.now()-v.at>this.ttlMs||this.entries.size>32)this.entries.delete(k);
   }catch{/* Optional warm failure never stops the real operation. */}
   finally{this.pending.delete(account);}
  }));
 }
}
