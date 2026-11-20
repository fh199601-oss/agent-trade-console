import {hash,json,same,wallet} from './common.mjs';
import {dexFor} from './opening-dex.mjs';
import {previewUsable} from './preview-cache.mjs';

const key=plan=>hash({...plan,audit:undefined,project:undefined,resolved:undefined});
// Start only an unsigned simulation after chain/wallet readiness and the route
// planner's pool/identity/holding checks. Independent audit work may finish in
// parallel; all final checks and fee gates still run before any submission.
export function primaryPreviewOverlap(intent,preview){
 let pending=null;
 return {
  start(plan){
   if(pending||intent.side!=='sell'||plan.kind!=='contract'||!plan.opening?.declaredByToken||!dexFor(plan.opening)||!plan.requireSellCredit||plan.steps?.length!==1||plan.steps[0].kind!=='sell'||!same(plan.wallet,wallet(intent.account).address))return;
   const copy=JSON.parse(json(plan));
   pending={key:key(copy),startedAt:Date.now(),promise:Promise.resolve().then(()=>preview(copy,intent,0)).then(value=>({value}),error=>({error}))};
  },
  async take(plan){
   const entry=pending;pending=null;if(!entry||entry.key!==key(plan))return null;
   const result=await entry.promise;
   if(result.error)throw result.error;
   return previewUsable(result.value,Date.now(),1000)?{...result.value,overlapped:true}:null;
  },
  startedAt(){return pending?.startedAt;}
 };
}
