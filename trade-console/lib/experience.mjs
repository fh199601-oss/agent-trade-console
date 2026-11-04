import fs from 'node:fs';
import path from 'node:path';
import {keccak256} from 'ethers';
import {DATA,hash,load,save} from './common.mjs';
import {failureKind} from './diagnostics.mjs';

const lower=v=>typeof v==='string'?v.toLowerCase():null;
const successful=new Set(['preview_passed','mint_confirmed']);
function fingerprint(identity){
 if(!identity?.target||!/^[0-9a-f]{64}$/i.test(identity.fingerprint||''))return null;
 const code=identity.implementationCode||identity.code;
 return {chainId:56,target:lower(identity.target),fingerprint:identity.fingerprint,implementation:lower(identity.implementation),beacon:lower(identity.beacon),runtimeCodeHash:code?keccak256(code):null};
}
// Local order-derived evidence only. Never store credentials, website instructions,
// signatures, calldata or cached prices/quotas as reusable execution facts.
export class ExperienceStore{
 constructor(data=DATA){this.dir=path.join(data,'mint-experience');this.rows=new Map();this.sequence=0;fs.mkdirSync(this.dir,{recursive:true,mode:0o700});
  for(const f of fs.readdirSync(this.dir).filter(f=>/^[a-f0-9]{64}\.json$/.test(f))){try{const r=load(path.join(this.dir,f));if(r?.schema===1&&r.chainId===56){this.rows.set(f,r);this.sequence=Math.max(this.sequence,r.sequence||0);}}catch{}}
 }
 record(o){
  if(o.intent?.side!=='mint')return;
  const phase=o.status==='PREPARED'&&o.preview?'preview_passed':o.status==='CONFIRMED'&&o.steps?.some(s=>s.status==='CONFIRMED'&&s.step?.kind==='mint'&&/^0x[0-9a-f]{64}$/i.test(s.txHash||'')&&s.receipt&&BigInt(s.receipt.status)===1n)?'mint_confirmed':['BLOCKED','FAILED','PARTIAL'].includes(o.status)?'failed':null;
  if(!phase)return;
  const p=o.plan,identity=fingerprint(p?.identity||o.mintContext?.identity),key=hash([o.id,phase]);
  if(this.rows.has(key+'.json'))return; // Immutable phase evidence, retry/follow is idempotent.
  const row={schema:1,chainId:56,...identity,orderId:o.id,asset:o.intent.asset,at:o.updatedAt||Date.now(),sequence:++this.sequence,outcome:phase,
   wallet:lower(p?.wallet||o.mintContext?.wallet),account:o.intent.account,scope:o.intent.scope,referral:o.intent.referral||null,
   routeId:p?.quote?.routeId||o.intent.routeId||null,route:p?.route||null,
   sourceVerified:p?.metaVerified??o.mintContext?.sourceVerified??null,
   failure:phase==='failed'?{kind:failureKind(o.error),code:o.error?.code||null,message:String(o.error?.message||'').slice(0,600)}:null,
   timings:o.diagnostics||null,
   txHashes:phase==='mint_confirmed'?o.steps.filter(s=>s.status==='CONFIRMED'&&s.step?.kind==='mint').map(s=>s.txHash).filter(Boolean):[]};
  save(path.join(this.dir,key+'.json'),row);this.rows.set(key+'.json',row);
 }
 lookupInput(asset){return {recent:[...this.rows.values()].filter(r=>r.asset===asset).sort((a,b)=>b.at-a.at||(b.sequence||0)-(a.sequence||0)).slice(0,5).map(r=>({orderId:r.orderId,outcome:r.outcome,at:r.at,failure:r.failure})),note:'相同输入的历史仅供诊断，不证明当前部署、价格或资格'};}
 lookup(identity,intent={}){
  const current=fingerprint(identity);if(!current)return {exactMatches:0,sameCodeMatches:0,recommendedRouteId:null,recent:[]};
  const all=[...this.rows.values()].sort((a,b)=>b.at-a.at||(b.sequence||0)-(a.sequence||0)),exact=all.filter(r=>r.target===current.target&&r.fingerprint===current.fingerprint),sameCode=all.filter(r=>r.target!==current.target&&current.runtimeCodeHash&&r.runtimeCodeHash===current.runtimeCodeHash);
  const eligible=exact.filter(r=>r.wallet===lower(intent.wallet)&&r.account===intent.account&&r.scope===intent.scope&&r.referral===(intent.referral||null));
  // A later failed preview invalidates an earlier route recommendation. Same-code
  // deployments are informational because storage, payment and allowlists differ.
  const latest=eligible[0],route=latest&&successful.has(latest.outcome)?latest.routeId:null;
  return {exactMatches:exact.length,sameCodeMatches:sameCode.length,recommendedRouteId:route||null,
   similar:sameCode.slice(0,3).map(r=>({target:r.target,orderId:r.orderId,outcome:r.outcome,route:r.route,failure:r.failure})),
   recent:exact.slice(0,5).map(r=>({orderId:r.orderId,outcome:r.outcome,at:r.at,route:r.route,failure:r.failure})),
   note:'仅相同链、地址、完整代码指纹、钱包、额度范围及邀请策略可建议入口；价格、余额、资格和额度每次重查'};
 }
}
