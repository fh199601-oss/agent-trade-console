import {recognizeRuntimeAnswerMint,runtimeAnswerState} from './runtime-answer-mint.mjs';
import {recognizeQuotaTokenSale,quotaTokenSaleState} from './quota-token-sale.mjs';
import {recognizeChallengePow,challengePowState} from './challenge-pow.mjs';
import {recognizePowMint,powMintState} from './pow-mint.mjs';
import {recognizeSpecialMint,specialMintState} from './special-mint.mjs';
import {recognizeVerifiedSale,verifiedSaleState} from './verified-sale.mjs';
import {bindings,Interface,read,same} from './common.mjs';
import {discover,sourceFor} from './discovery.mjs';
import {sampleState,samples} from './sample-mints.mjs';
import {recognizeMint,adaptiveQuote} from './adaptive-mint.mjs';
import {ROLE_LABELS} from './address-roles.mjs';
import {mintRouteOptions} from './mint-selection.mjs';
import {addressReferral,resolveReferral} from './referral.mjs';
import {recognizeHandleMint,handleMintState} from './handle-mint.mjs';
import {recognizeNftMint,nftMintState} from './nft-mint.mjs';
import {recognizeFairMint,fairMintState} from './fair-mint.mjs';
import {recognizePrimaryHandleMint,primaryHandleMintState} from './primary-handle-mint.mjs';
import {recognizeGuardedIdMint,guardedIdMintState,guardedIdReferral} from './guarded-id-mint.mjs';
import {profiled,measure,snapshot,failureKind} from './diagnostics.mjs';
import {ExperienceStore} from './experience.mjs';
import {selectMintRoute} from './mint-selection.mjs';
import {mintError} from './mint-errors.mjs';
import {recognizeDirectTokenMint,directTokenMintState} from './direct-token-mint.mjs';
import {assistMint,applyChainEvidence,adaptiveQuoteWithLearning} from './chain-assist.mjs';
import {recognizeSocialSale,socialSaleState,socialSaleReferral} from './social-sale.mjs';
import {recognizeSourceSale,sourceSaleState} from './source-sale.mjs';
import {recognizeProtectedSale,protectedSaleState} from './protected-sale.mjs';
let defaultExperience;
export async function inspectProject(rpc,bridge,asset,{experience=defaultExperience??=new ExperienceStore(),learn=false}={}){
 return profiled('inspect',async()=>{try{const result=await inspectImpl(rpc,bridge,asset,experience,learn);return {...result,diagnostics:snapshot()};}catch(e){e.diagnostics=snapshot();throw e;}});
}
async function inspectImpl(rpc,bridge,asset,experience,learn,resolvedOverride=null){
 const resolved=resolvedOverride||await measure('projectDiscovery',()=>discover(asset,{rpc,chainFallback:true,learn}));if(!resolved.address)return {...resolved,quotas:[],inputExperience:experience.lookupInput(resolved.source||asset),needAiDeep:failureKind(resolved.failure)==='adapter_needed',referral:await resolveReferral(rpc,bridge,resolved,{})};
 await rpc.verifyChain();const meta={...await sourceFor(rpc,resolved.address),abiHints:resolved.abiHints};
 const assetRoles=resolved.addresses?.find(r=>same(r.address,resolved.token))?.verifiedRoles||[];
 let token=resolved.token||null,assetKind=assetRoles.includes('token')?'Erc20':assetRoles.includes('nft')?'Erc721':null,referral=null;
 const answerType=recognizeRuntimeAnswerMint(meta,resolved),quotaType=recognizeQuotaTokenSale(meta),protectedType=recognizeProtectedSale(meta),sourceType=recognizeSourceSale(meta),socialType=recognizeSocialSale(meta),challengeType=recognizeChallengePow(meta),specialType=recognizeSpecialMint(meta),powType=recognizePowMint(meta),saleType=recognizeVerifiedSale(meta),directType=recognizeDirectTokenMint(meta),guardedType=recognizeGuardedIdMint(meta),primaryType=recognizePrimaryHandleMint(meta),fairType=recognizeFairMint(meta),nftType=recognizeNftMint(meta),handleType=recognizeHandleMint(meta),recognition=samples[meta.hash]||answerType||quotaType||protectedType||sourceType||socialType||challengeType||specialType||powType||saleType||directType||guardedType||primaryType||handleType||nftType||fairType?null:await assistMint(rpc,meta,resolved,sourceFor),mintRoutes=recognition?mintRouteOptions(recognition.routes):[];
 if(recognition&&!recognition.routes.length&&resolved.chainLearning&&!resolved.chainRedirected){const next=applyChainEvidence(resolved,resolved.chainLearning);if(next.address&&!same(next.address,meta.address))return inspectImpl(rpc,bridge,asset,experience,false,{...next,chainRedirected:true});}
 const result=await measure('walletEligibility',()=>Promise.all(bindings().map(async w=>{
  const learned=experience.lookup(meta.identity,{account:w.account,wallet:w.address,scope:'free',referral:'account1'});
  try{
   if(answerType){const s=await runtimeAnswerState(rpc,{account:w.account,scope:'free'},meta,w,resolved,answerType);token=s.token;assetKind=s.assetKind;return {...w,...s.info,adapter:s.name};}
   if(socialType){const s=await socialSaleState(rpc,{account:w.account,scope:'free'},meta,w,socialType);token=s.token;assetKind=s.assetKind;if(w.account===1)referral=socialSaleReferral(s);return {...w,...s.info,adapter:s.name,failureKind:s.blocked?failureKind({code:s.blockedCode,message:s.blocked}):null};}
   if(challengeType){const s=await challengePowState(rpc,meta,w,challengeType);token=s.token;assetKind=s.assetKind;return {...w,...s.info,adapter:s.name};}
   if(specialType){const s=await specialMintState(rpc,{account:w.account,scope:"free",slippageBps:100},meta,w,specialType);token=s.token;assetKind=s.assetKind;return {...w,...s.info,adapter:s.name,routes:s.routes||[]};}
   if(powType){const s=await powMintState(rpc,{account:w.account,scope:'free'},meta,w,powType);token=s.token;assetKind=s.assetKind;return {...w,...s.info,adapter:s.name};}
   if(saleType){const s=await verifiedSaleState(rpc,{account:w.account,scope:'free'},meta,w,saleType);token=s.token;assetKind=s.assetKind;return {...w,...s.info,adapter:s.name,failureKind:s.blocked?failureKind({code:s.blockedCode,message:s.blocked}):null};}
   if(directType){await bridge.ready(w.account);const s=await directTokenMintState(rpc,bridge,{account:w.account},meta,w,directType);token=s.token;assetKind=s.assetKind;return {...w,...s.info,adapter:s.name,needAiDeep:s.freeUnknown};}
   if(guardedType){const s=await guardedIdMintState(rpc,{account:w.account,scope:'free'},meta,w,guardedType);token=s.token;assetKind=s.assetKind;if(w.account===1)referral=await guardedIdReferral(rpc,meta,s);return {...w,...s.info,adapter:s.name};}
   if(primaryType){const s=await primaryHandleMintState(rpc,{account:w.account,scope:'free'},meta,w,primaryType);token=s.rewardToken||s.token;assetKind=s.rewardToken?'Erc20':s.assetKind;return {...w,...s.info,adapter:s.name};}
   if(fairType){const s=await fairMintState(rpc,meta,w);token=s.token;assetKind=s.assetKind;return {...w,...s.info,blocked:s.blocked,adapter:s.name};}
   if(nftType){const s=await nftMintState(rpc,{account:w.account,scope:'free'},meta,w,nftType);token=s.token;assetKind=s.assetKind;return {...w,...s.info,adapter:s.name};}
   if(handleType){
    await bridge.ready(w.account);
    const s=await handleMintState(rpc,bridge,{account:w.account},meta,w,handleType);
    token=s.token;assetKind=s.assetKind;
    return {...w,...s.info,adapter:s.name};
   }
   if(samples[meta.hash]){
    await bridge.ready(w.account);
    const s=await sampleState(rpc,bridge,{account:w.account,asset,scope:'free',referral:'account1',slippageBps:100},meta,w);
    token=s.token;assetKind=s.assetKind;referral??=s.referral;
    return {...w,...s.info,referral:s.referral,adapter:s.name};
   }
   if(quotaType){const s=await quotaTokenSaleState(rpc,{account:w.account,scope:'free'},meta,w,quotaType);token=s.token;assetKind=s.assetKind;return {...w,...s.info,adapter:s.name};}
   if(sourceType){const s=await sourceSaleState(rpc,{account:w.account,scope:'free'},meta,w,sourceType);token=s.token;assetKind=s.assetKind;return {...w,...s.info,adapter:s.name,failureKind:s.blocked?failureKind({code:s.blockedCode,message:s.blocked}):null};}
   if(protectedType){const s=await protectedSaleState(rpc,{account:w.account,scope:'free'},meta,w,protectedType);token=s.token;assetKind=s.assetKind;if(w.account===1)referral=s.referral;return {...w,...s.info,adapter:s.name};}
   const m={...meta,abi:recognition.abi};
   const lanes=recognition.routes.length>1&&recognition.routes.length<=4&&recognition.routes.every(r=>r.lane);
   let route;try{route=lanes?null:selectMintRoute(recognition,null,learned.recommendedRouteId);}catch(e){return {...w,error:recognition.reason||e.message,errorCode:e.code,failureKind:failureKind(e),routes:mintRoutes,experience:learned,needAiDeep:e.code==='MINT_UNSUPPORTED'};}
   const bn=await rpc.getBlockNumber(),b=await rpc.send('eth_getBlockByNumber',['0x'+bn.toString(16),false]);
   if(lanes){
    const states=await Promise.all(recognition.routes.map(async r=>{try{
     const ref=addressReferral(m,r,{account:w.account,referral:'account1'});referral??=ref;
     const q=await adaptiveQuoteWithLearning(rpc,m,resolved,r,w,1,{tag:'0x'+bn.toString(16),number:bn,timestamp:Number(BigInt(b.timestamp))},sourceFor,{referrer:ref?.callValue});
     return {id:r.id,method:r.method,lane:r.lane,quote:q,available:q.available,error:q.reason};
    }catch(e){return {id:r.id,method:r.method,lane:r.lane,available:false,error:e.message,code:e.code};}}));
    const ready=states.filter(s=>s.available),free=states.find(s=>s.lane==='free'),paid=states.find(s=>s.lane==='paid');
    const q=ready[0]?.quote;if(q?.expectedAsset){token=q.expectedAsset.token;assetKind=q.expectedAsset.kind;}
    const knownRemaining=s=>s?.quote?.limits.walletRemaining!=null?String(Math.min(s.quote.limits.walletRemaining,s.quote.limits.publicRemaining??Infinity)):null;
    return {...w,available:ready.length>0,error:ready.length?null:states.map(s=>s.error).filter(Boolean).join('；'),freeRemaining:free?.available&&free.quote.total.raw==='0'?knownRemaining(free)||'至少 1（未证明全部免费上限）':free?.code==='NO_QUOTA'?'0':null,paidRemaining:paid?.available?knownRemaining(paid)||'至少 1（请指定份数）':paid?.code==='NO_QUOTA'?'0':null,unitPrice:paid?.quote?.total||q?.total,adapter:recognition.routes.map(r=>r.method).join(' / '),routes:states.map(({quote,...s})=>s),experience:learned,notes:states.filter(s=>s.error).map(s=>s.method+'：'+s.error)};
   }
   const ref=addressReferral(m,route,{account:w.account,referral:'account1'});referral??=ref;
   const q=await adaptiveQuoteWithLearning(rpc,m,resolved,route,w,1,{tag:'0x'+bn.toString(16),number:bn,timestamp:Number(BigInt(b.timestamp))},sourceFor,{referrer:ref?.callValue});
   if(q.expectedAsset){token=q.expectedAsset.token;assetKind=q.expectedAsset.kind;}
   return {...w,available:q.available,error:q.reason,freeRemaining:q.total.raw==='0'?'至少 1（未证明全部免费上限）':'0 或未知',paidRemaining:null,limits:q.limits,unitPrice:q.total,adapter:q.routeMethod,experience:learned,notes:['通用入口仅显示已核验数据，未识别额度不会猜测']};
  }catch(e){const error=mintError(e,meta.verified?meta.abi:null);return {...w,error:error.message,errorCode:error.code,failureKind:failureKind(error),needAiDeep:failureKind(error)==='adapter_needed'};}
 })));
 if(resolved.addresses&&assetKind&&token){const role=['Erc721','Erc1155'].includes(assetKind)?'nft':'token';let row=resolved.addresses.find(r=>same(r.address,token));if(!row){row={address:token,field:'已核验到账资产',roles:[],verifiedRoles:[],evidence:[],primary:false};resolved.addresses.push(row);}row.roles=row.roles.filter(r=>r!=='unknown');if(!row.roles.includes(role))row.roles.push(role);if(!row.verifiedRoles.includes(role)){row.verifiedRoles.push(role);row.evidence.push({role,kind:'mint-asset',label:'当前合约适配器核验的到账资产'});}row.roleLabels=row.roles.map(r=>ROLE_LABELS[r]);}
 referral=await measure('referral',()=>resolveReferral(rpc,bridge,resolved,meta,referral));
 return {...resolved,mintRoutes,mintContract:resolved.addresses&&!resolved.addresses.find(r=>r.primary)?.verifiedRoles.includes('mint')?null:meta.address,token,assetKind,quotas:result,referral,verifiedSource:meta.verified,runtimeFingerprint:meta.hash,experience:experience.lookup(meta.identity),needAiDeep:result.some(r=>r.needAiDeep),at:Date.now()};
}
