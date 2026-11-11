import {Interface} from 'ethers';
import {same,BNB} from './common.mjs';
import {recognizeMint,runtimeShape,adaptiveQuote} from './adaptive-mint.mjs';
import {ROLE_LABELS} from './address-roles.mjs';
import {learnerFor} from './chain-learning.mjs';
import {unavailableMintState} from './source-constraints.mjs';
import {runtimeReferralEvidence} from './runtime-referral.mjs';

// Evidence can resolve address roles, but never override another verified
// project entry or turn a token into a mint target without a checked link.
export function applyChainEvidence(resolved,evidence){
 const rows=structuredClone(resolved.addresses||[]),ensure=a=>{let r=rows.find(r=>same(r.address,a));if(!r){r={address:a,field:'链上成功 Mint 记录',roles:[],verifiedRoles:[],evidence:[],hasCode:true,inspected:true};rows.push(r);}return r;};
 const add=(a,role,label)=>{const r=ensure(a);r.roles=r.roles.filter(x=>x!=='unknown');if(!r.roles.includes(role))r.roles.push(role);if(!r.verifiedRoles.includes(role))r.verifiedRoles.push(role);r.evidence.push({role,kind:'chain-history',label});r.roleLabels=r.roles.map(x=>ROLE_LABELS[x]);};
 for(const t of evidence.targets||[])if(t.corroborated){add(t.address,'mint',`${t.participants} 个不同参与者的成功铸造回执，并核验当前代码及资产关联`);for(const a of t.assets)add(a.token,a.kind==='Erc721'?'nft':'token',a.issuance==='verified-sale-inventory'?'已核验发售源码的库存分发事件及当前资产接口':'成功回执的零地址发行事件及当前资产接口');}
 const targets=(evidence.targets||[]).filter(t=>t.corroborated),existing=rows.filter(r=>r.verifiedRoles.includes('mint'));
 const priority=targets.length===1?rows.find(r=>same(r.address,targets[0].address))?.priority||0:0;
 const uncertain=rows.some(r=>r.inspected===false&&(r.priority||0)>=priority&&!r.verifiedRoles?.length);
 const unique=!uncertain&&targets.length===1&&existing.every(r=>same(r.address,targets[0].address))?targets[0]:null;
 if(unique){for(const r of rows)r.primary=same(r.address,unique.address);const erc20=unique.assets.filter(a=>a.kind==='Erc20');return {...resolved,address:unique.address,token:erc20.length===1?erc20[0].token:resolved.token,addresses:rows,candidates:rows.filter(r=>r.verifiedRoles.includes('mint')),needsSelection:false,failure:null,reason:'成功铸造回执与当前合约代码交叉核验',chainLearning:evidence};}
 return {...resolved,addresses:rows,chainLearning:evidence,candidates:resolved.candidates?.length?resolved.candidates:rows.filter(r=>r.verifiedRoles.includes('mint'))};
}

const dangerous=/approve|transfer|withdraw|redeem|burn|stake|deposit|claimReward|admin|owner|upgrade|initialize|execute|multicall|set[A-Z_]|sweep|rescue/i;
export function learnedRecognition(meta,base,evidence){
 if(meta.proxy||meta.identity?.implementation||runtimeShape(meta.runtimeCode).delegate)return base;
 const target=evidence.targets?.find(t=>same(t.address,meta.address)&&t.corroborated&&t.fingerprint===meta.hash);if(!target)return base;
 const observations=(evidence.methods||[]).filter(m=>m.usable&&same(m.target,meta.address)&&m.fingerprint===meta.hash&&runtimeShape(meta.runtimeCode).selectors.has(m.selector));
 const extended=recognizeMint(meta,{observedSelectors:observations.map(m=>m.selector)}),iface=new Interface(extended.abi),routes=[];
 for(const m of observations){
  if(!m.output?.minPerUnit||BigInt(m.output.minPerUnit)<=0n)continue;
  let route=extended.routes.find(r=>iface.getFunction(r.method)?.selector===m.selector);
  if(route&&dangerous.test(route.method))continue;
  // Unknown ABI: only a four-byte entry with no arguments, zero native value,
  // and mandatory exact asset proof. No historical input/value is replayed.
  if(!route&&!meta.verified&&m.noArgs)route={method:'链上入口 '+m.selector,rawSelector:m.selector,payment:BNB,pricing:'adaptive',quantity:false,roles:[],quotes:[],units:[],runtime:true,zeroOnly:true};
  if(!route)continue;
  routes.push({...route,id:base.routes.find(r=>r.method===route.method)?.id||'chain:'+m.selector,maxQuantity:m.maxQuantity,observedAsset:m.output,chainEvidence:{selector:m.selector,participants:m.participants,samples:m.samples.map(s=>({txHash:s.txHash,block:s.block,blockHash:s.blockHash})),assets:target.assets.map(a=>({token:a.token,codeHash:a.codeHash}))}});
 }
 return {...extended,routes:[...base.routes.map(b=>routes.find(r=>r.method===b.method)||b),...routes.filter(r=>!base.routes.some(b=>b.method===r.method))],reason:routes.length?null:base.reason+'；'+(evidence.methods?.filter(m=>same(m.target,meta.address)).map(m=>m.reason).join('；')||evidence.note||'近期没有可验证的成功样本')};
}

export async function assistMint(rpc,meta,resolved,sourceLoader,{learner=learnerFor(rpc),recover=false}={}){
 const base=recognizeMint(meta);if(base.routes.length&&!recover){
  await Promise.all(base.routes.map(async r=>{if(r.runtime&&/^mint(?:WithBnb|WithBNB)?\(uint256,address\)$/.test(r.method))r.referralEvidence=await runtimeReferralEvidence(learner.logRpc||rpc,meta,r.method);}));
  return base;
 }
 const stopped=await unavailableMintState(rpc,meta);if(stopped)return {...base,reason:stopped.message,failure:stopped};
 const entries=(meta.abi||[]).filter(f=>f.type==='function'&&!['view','pure'].includes(f.stateMutability)&&/^(mint|freeMint|paidMint|publicMint|claimFree)/.test(f.name));
 if(meta.verified&&entries.length&&entries.every(f=>f.inputs.some(p=>['bytes','bytes32[]'].includes(p.type)&&/signature|proof|sig$/i.test(p.name)))){
  const message='已识别钱包专属签名 / 白名单凭证入口；自动获取当前钱包凭证尚未适配，不能重放其他钱包的成功记录';
  return {...base,reason:message,failure:{code:'SITE_PROOF_REQUIRED',message,details:{methods:entries.map(f=>f.name),automaticProofAcquisition:false}}};
 }
 // Revalidate cached fingerprints and canonical sample blocks at every prepare.
 const evidence=await learner.learn(resolved.chainLearning?.seeds?.map(address=>({address}))||(resolved.addresses?.length?resolved.addresses:[{address:meta.address}]),{sourceLoader});
 resolved.chainLearning=evidence;
 return learnedRecognition(meta,base,evidence);
}

// A recognized selector is not a complete adapter. Recover missing asset
// evidence once, keep the selected target/method/referral, and re-simulate the
// current wallet. Eligibility, reverted transactions and price/budget failures
// must never turn into attempts to bypass a contract restriction.
export async function adaptiveQuoteWithLearning(rpc,meta,resolved,route,w,quantity,block,sourceLoader,{referrer,learner,readCache}={}){
 const query=(m,p)=>{
  if(!readCache)return rpc.send(m,p);
  const key=JSON.stringify([m,p]);if(!readCache.has(key)){const pending=Promise.resolve().then(()=>rpc.send(m,p));readCache.set(key,pending);pending.catch(e=>{if(!e.executionError&&!/revert/i.test(e.message||''))readCache.delete(key);});}return readCache.get(key);
 };
 try{return await adaptiveQuote(meta,route,w,quantity,block,query,referrer);}
 catch(e){
  if(e.code!=='MINT_ASSET_UNKNOWN'||route.chainEvidence)throw e;
  const found=await assistMint(rpc,meta,resolved,sourceLoader,{recover:true,...(learner?{learner}:{})});
  const enriched=found.routes.find(r=>r.method===route.method&&r.chainEvidence);
  if(!enriched)throw Object.assign(e,{details:{...e.details,chainLearning:resolved.chainLearning}});
  Object.assign(route,enriched);meta.abi=found.abi;
  return adaptiveQuote(meta,route,w,quantity,block,query,referrer);
 }
}
