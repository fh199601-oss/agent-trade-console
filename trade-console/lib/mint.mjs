import {runtimeAnswerPlan} from './runtime-answer-mint.mjs';
import {quotaTokenSalePlan} from './quota-token-sale.mjs';
import {challengePowPlan} from './challenge-pow.mjs';
import {powMintPlan} from './pow-mint.mjs';
import {specialMintPlan} from './special-mint.mjs';
import path from 'node:path';
import {verifiedSalePlan} from './verified-sale.mjs';
import {Interface,id,ZeroAddress,keccak256,toUtf8Bytes} from 'ethers';
import {read,ERC20,BNB,parseUnits,wallet,same} from './common.mjs';
import {sourceFor,codeIdentity} from './discovery.mjs';
import {recognizeMint,adaptiveQuote,runtimeShape} from './adaptive-mint.mjs';
import {samplePlan} from './sample-mints.mjs';
import {selectMintRoute} from './mint-selection.mjs';
import {addressReferral,resolveReferral} from './referral.mjs';
import {handleMintPlan} from './handle-mint.mjs';
import {nftMintPlan} from './nft-mint.mjs';
import {fairMintPlan} from './fair-mint.mjs';
import {primaryHandleMintPlan} from './primary-handle-mint.mjs';
import {guardedIdMintPlan} from './guarded-id-mint.mjs';
import {measure} from './diagnostics.mjs';
import {mintError} from './mint-errors.mjs';
import {directTokenMintPlan} from './direct-token-mint.mjs';
import {assistMint,applyChainEvidence,adaptiveQuoteWithLearning} from './chain-assist.mjs';
import {socialSalePlan} from './social-sale.mjs';
import {sourceSalePlan} from './source-sale.mjs';
import {protectedSalePlan} from './protected-sale.mjs';
import {corlaPlan} from './corla.mjs';
const REGISTRY='0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F';
const templates=[
 {name:'scarab',detect:['547c1db9','fd326592','a2309ff8'],signature:'mintWithBnb(uint256,address,uint256,address,uint256)',price:'costOf(uint256)',output:'quoteTokens(uint256)'},
 {name:'bianren_hub',detect:['bf2c8a94','b3d7f6b9','e2de89b8'],signature:'mint(uint256,address,uint256,uint256)',price:'previewMint(uint256)'},
 {name:'bianren_core',detect:['e38fd349','fd326592'],signature:'mintWithBnb(uint256,address,uint256)',price:'costOf(uint256)'}
];
function selects(code){const b=Buffer.from(code.slice(2),'hex'),set=new Set();for(let i=0;i<b.length;i++){const op=b[i];if(op>=0x60&&op<=0x7f){if(op===0x63)set.add(b.subarray(i+1,i+5).toString('hex'));i+=op-0x5f;}}return set;}
export async function mintPlan(rpc,bridge,intent,target,resolved={source:'用户输入 CA'},experienceStore=null,{sourceLoader=sourceFor,chainLearner=null,officialPreview=false}={}){
 if(resolved.platform==='corla')return measure('corlaMintPlan',()=>corlaPlan(rpc,intent,wallet(intent.account),resolved,{officialPreview}));
 if(intent.quoteToken!==undefined)throw Object.assign(Error('其他付款币预算目前仅适用于 Corla 专用入口'),{code:'MINT_ROUTE_INVALID'});
 const w=wallet(intent.account),meta={...await sourceLoader(rpc,target),abiHints:resolved.abiHints},experience=experienceStore?.lookup(meta.identity,{...intent,wallet:w.address});
 try{const plan=await measure('mintPlan',()=>buildMintPlan(rpc,bridge,intent,target,resolved,w,meta,experience,experienceStore,{sourceLoader,chainLearner}));plan.experience??=experience||null;return plan;}
 catch(e){e=mintError(e,meta.verified?meta.abi:null);e.mintContext={identity:meta.identity,wallet:w.address,sourceVerified:meta.verified,experience};if(resolved.chainLearning)e.details={...e.details,chainLearning:resolved.chainLearning};throw e;}
}
async function buildMintPlan(rpc,bridge,intent,target,resolved,w,meta,experience,experienceStore,{sourceLoader,chainLearner}){
 const sels=selects(meta.runtimeCode),template=templates.find(t=>t.detect.every(s=>sels.has(s)));
 const limit=intent.scope==='free'?0n:parseUnits(intent.maxBnb,18);
 const answer=await runtimeAnswerPlan(rpc,intent,meta,w,resolved);if(answer){answer.referral=await resolveReferral(rpc,bridge,resolved,meta);return answer;}
 const social=await socialSalePlan(rpc,intent,meta,w,resolved);if(social){social.referral=await resolveReferral(rpc,bridge,resolved,meta,social.referral);return social;}
 const special=await specialMintPlan(rpc,intent,meta,w,resolved,{data:experienceStore?.dir?path.dirname(experienceStore.dir):undefined});if(special){special.referral=await resolveReferral(rpc,bridge,resolved,meta);return special;}
 const challenge=await challengePowPlan(rpc,intent,meta,w,resolved,{data:experienceStore?.dir?path.dirname(experienceStore.dir):undefined});if(challenge){challenge.referral=await resolveReferral(rpc,bridge,resolved,meta);return challenge;}
 const pow=await powMintPlan(rpc,intent,meta,limit,w,resolved);if(pow){pow.referral=await resolveReferral(rpc,bridge,resolved,meta);return pow;}
 const sale=await verifiedSalePlan(rpc,intent,meta,limit,w,resolved);if(sale){sale.referral=await resolveReferral(rpc,bridge,resolved,meta);return sale;}
 const quotaSale=await quotaTokenSalePlan(rpc,intent,meta,w,resolved);if(quotaSale){quotaSale.referral=await resolveReferral(rpc,bridge,resolved,meta,quotaSale.referral);return quotaSale;}
 const direct=await directTokenMintPlan(rpc,bridge,intent,meta,w,resolved);if(direct){direct.referral=await resolveReferral(rpc,bridge,resolved,meta);return direct;}
 const guarded=await guardedIdMintPlan(rpc,intent,meta,limit,w,resolved);if(guarded){guarded.referral=await resolveReferral(rpc,bridge,resolved,meta,guarded.referral);return guarded;}
 const sample=await samplePlan(rpc,bridge,intent,meta,limit,w);if(sample){sample.referral=await resolveReferral(rpc,bridge,resolved,meta,sample.referral);return sample;}
 const handle=await handleMintPlan(rpc,bridge,intent,meta,limit,w,resolved);if(handle){handle.referral=await resolveReferral(rpc,bridge,resolved,meta);return handle;}
 const primary=await primaryHandleMintPlan(rpc,intent,meta,limit,w,resolved);if(primary){primary.referral=await resolveReferral(rpc,bridge,resolved,meta);return primary;}
 const nft=await nftMintPlan(rpc,intent,meta,limit,w,resolved);if(nft){nft.referral=await resolveReferral(rpc,bridge,resolved,meta);return nft;}
 const fair=await fairMintPlan(rpc,intent,meta,w);if(fair)return fair;
 const inferred=await sourceSalePlan(rpc,intent,meta,w,resolved);if(inferred){inferred.referral=await resolveReferral(rpc,bridge,resolved,meta,inferred.referral);return inferred;}
 const protectedPlan=await protectedSalePlan(rpc,intent,meta,w,resolved);if(protectedPlan){protectedPlan.referral=await resolveReferral(rpc,bridge,resolved,meta,protectedPlan.referral);return protectedPlan;}
 // A matching paid template must not hide a separate free entry or ignore an
 // explicit user-selected method. Keep scope/selection ahead of template reuse.
 if(template&&!intent.routeId&&!(['free','all'].includes(intent.scope)&&recognizeMint(meta).routes.some(r=>r.freeEntry)))return templatePlan(rpc,bridge,intent,meta,template,limit,w);
 const recognized=await assistMint(rpc,meta,resolved,sourceLoader,chainLearner?{learner:chainLearner}:{});
 if(!recognized.routes.length&&resolved.chainLearning&&!resolved.chainRedirected){const next=applyChainEvidence(resolved,resolved.chainLearning);if(next.address&&!same(next.address,target)){Object.assign(resolved,next,{chainRedirected:true});return mintPlan(rpc,bridge,intent,next.address,resolved,experienceStore,{sourceLoader,chainLearner});}}
 meta.abi=recognized.abi;
 let route=selectMintRoute(recognized,intent.routeId,experience?.recommendedRouteId,intent.scope);
 const bn=await rpc.getBlockNumber(),raw=await rpc.send('eth_getBlockByNumber',['0x'+bn.toString(16),false]),block={tag:'0x'+bn.toString(16),number:bn,timestamp:Number(BigInt(raw.timestamp))};
 let ref=addressReferral(meta,route,intent);
 if(!ref&&resolved.referralHints?.detected&&intent.referral==='account1'&&[2,3].includes(intent.account))throw Error('网站存在邀请机制，但所选铸造入口没有已核验的邀请参数；可能需要接口绑定，暂不能忽略 1 号邀请直接铸造');
 const quote=q=>adaptiveQuoteWithLearning(rpc,meta,resolved,route,w,q,block,sourceLoader,{referrer:ref?.callValue,learner:chainLearner});
 let q;try{q=await quote(intent.quantity==='max'?1:intent.quantity);}catch(e){
  const paid=recognized.routes.filter(r=>r.lane==='paid');
  if(!['NO_QUOTA','MINT_ENDED'].includes(e.code)||intent.scope!=='all'||intent.routeId||route.lane!=='free'||paid.length!==1)throw e;
  if(intent.quantity!=='max'&&intent.quantity>1){let exhausted=false;try{await quote(1);}catch(check){if(!['NO_QUOTA','MINT_ENDED'].includes(check.code))throw check;exhausted=true;}if(!exhausted)throw e;}
  route=paid[0];ref=addressReferral(meta,route,intent);
  if(!ref&&resolved.referralHints?.detected&&intent.referral==='account1'&&[2,3].includes(intent.account))throw Error('付费入口的邀请绑定方式尚未核验');
  q=await quote(intent.quantity==='max'?1:intent.quantity);
 }
 if(route.chainEvidence&&[q.limits.walletRemaining,q.limits.publicRemaining,q.limits.callRemaining].includes(0))throw Object.assign(Error(q.reason||'当前可核验铸造额度为 0'),{code:'NO_QUOTA'});
 if(!q.available)throw Object.assign(Error(q.reason||'当前 Mint 不可执行'),{code:'MINT_STATE'});
 if(intent.scope==='free'&&q.freeUnits===0&&BigInt(q.total.raw)>0n)throw Object.assign(Error('当前没有可用的零费用份额；此报价需要付款，未自动切换到付费'),{code:'NO_FREE_MINT'});
 if(intent.scope==='paid'&&(q.freeUnits===null||q.freeUnits>0))throw Error('该入口无法证明只消耗付费额度；先核对免费额度或选择全部');
 if(intent.quantity==='max'){
  if(q.limits.walletRemaining===null&&q.limits.callRemaining===null)throw Error('未读取到可靠上限，不能把未知额度当作打满；请指定份数');
  let lo=0,hi=q.limits.max,best=null;
  while(lo<hi){const mid=Math.ceil((lo+hi)/2),v=mid===1?q:await quote(mid);if(v.available&&BigInt(v.total.raw)<=limit){lo=mid;best=v;}else hi=mid-1;}
  if(!lo)throw Error('没有符合预算的可铸造额度');q=best?.quantity===lo?best:await quote(lo);
 }
 if(!q.available)throw Error(q.reason||'当前 Mint 不可执行');if(BigInt(q.total.raw)>limit)throw Error('报价超过本次最高 BNB 预算');
 return {kind:'contract',route:'mint:'+route.method,freshBeforeExecute:!!Object.keys(route.programs||{}).length,token:q.expectedAsset?.token||target,wallet:w.address,amountIn:q.total.raw,inputToken:BNB,outputToken:q.expectedAsset?.token||target,
  minOutput:q.expectedAsset?.amount||'0',quantity:q.quantity,identity:{...meta.identity,learnedAssets:route.chainEvidence?.assets},review:['通用识别未完成项目安全审计',...(!meta.verified?['当前仅通过链上接口识别，源码未核验']:[]),...(route.chainEvidence?['参考他人成功回执重新构造，本次费用与到账以当前钱包官方预览为准']:[])],
  referral:await resolveReferral(rpc,bridge,resolved,meta,ref),quota:{freeInBatch:q.freeUnits,paidInBatch:q.paidUnits,limits:q.limits},fill:{continue:(intent.scope==='all'&&!intent.routeId&&route.lane==='free'&&recognized.routes.filter(r=>r.lane==='paid').length===1&&limit>0n&&intent.quantity==='max')||((q.limits.walletRemaining??q.limits.callRemaining??q.quantity)>q.quantity)&&(intent.quantity==='max')&&(BigInt(q.total.raw)<limit||q.total.raw==='0'&&!!(route.chainEvidence||route.freeEntry||route.zeroOnly))},budgetCurrency:'BNB',expectedAsset:q.expectedAsset,requireNftCredit:q.expectedAsset?.kind==='Erc721',erc1155InterfaceVerified:q.expectedAsset?.kind==='Erc1155',requireAssetCredit:!!route.chainEvidence||q.expectedAsset?.kind==='Erc1155',chainEvidence:route.chainEvidence,recognition:q.recognition,quote:q,steps:[{kind:'mint',to:q.call.to,data:q.call.data,value:q.call.value}],metaVerified:meta.verified};
}
async function templatePlan(rpc,bridge,i,meta,t,limit,w){
 if(i.referral==='account1'&&[2,3].includes(i.account))throw Error('该模板有推荐参数，邀请资格尚未核验，不能将 1 号邀请静默替换为零地址');
 const get=async(sig,args=[])=>{const f=new Interface(['function '+sig+' view returns(uint256)']);const raw=await rpc.call({to:meta.address,from:w.address,data:f.encodeFunctionData(sig,args)});if(!/^0x(?:[0-9a-f]{64})+$/i.test(raw))throw Error('模板返回格式不符：'+sig);return Array.from({length:(raw.length-2)/64},(_,n)=>BigInt('0x'+raw.slice(2+n*64,66+n*64)));};
 const global=['totalMinted()','opened()','paused()'];
 const v=await Promise.all(global.map(s=>get(s)));const [minted,opened,paused]=v.map(a=>a[0]);if(paused!==0n)throw Error('合约暂停');
 let cap,token,available;
 if(t.name==='scarab'){
  const [tx,max,extra,used,total,tok]=await Promise.all([get('MAX_UNITS_PER_TX()'),get('MAX_UNITS_PER_WALLET()'),get('extraQuota(address)',[w.address]),get('mintedBy(address)',[w.address]),get('MAX_SUPPLY_UNITS()'),get('token()')]);
  cap=[tx[0],max[0]+extra[0]-used[0],total[0]-minted].reduce((a,b)=>a<b?a:b);token='0x'+tok[0].toString(16).padStart(40,'0');
 }else{
  const aid=await bridge.call(i.account,['wallet','agent-id']);const handle=aid.handle||aid.domain||aid.agentId||aid.name;
  if(typeof handle!=='string')throw Error('Agent ID 返回缺少域名，无法计算该模板的额度');
  const agent=BigInt(keccak256(toUtf8Bytes(handle.replace(/\.ai$/,''))));
  const [quota,used,tx,total,tok]=await Promise.all([get('quotaOf(uint256)',[agent]),get('mintedCount(uint256)',[agent]),t.name==='bianren_hub'?get('MAX_PER_TX()'):Promise.resolve([10n]),t.name==='bianren_hub'?get('TOTAL_SHARES()'):Promise.resolve([10000n]),get('token()').catch(()=>null)]);
  cap=[quota[0]-used[0],tx[0],total[0]-minted].reduce((a,b)=>a<b?a:b);token=tok?'0x'+tok[0].toString(16).padStart(40,'0'):meta.address;
  if(t.name==='bianren_hub'&&(await get('refunding()'))[0]!==0n)throw Error('项目处于退款状态');
 }
 if(opened!==0n)throw Error('模板已经开盘，Mint 阶段已结束');if(cap<=0n)throw Error('当前剩余额度为 0');cap=cap>500n?500n:cap;
 const price=async n=>{const p=await get(t.price,[n]);let out=t.output?(await get(t.output,[n]))[0]:p[1]||0n;return {cost:p[0],out};};
 let n=i.quantity==='max'?cap:BigInt(i.quantity);if(n>cap)throw Error('份数超过当前剩余额度');let p=await price(n);
 if(i.quantity==='max'&&p.cost>limit){let lo=0n,hi=n;while(lo<hi){const mid=(lo+hi+1n)/2n;if((await price(mid)).cost<=limit)lo=mid;else hi=mid-1n;}n=lo;if(n<=0n)throw Error('预算不足以铸造一份');p=await price(n);}
 if(i.scope==='paid'&&(await price(1n)).cost===0n)throw Error('该模板自动使用免费份额，不能单独消耗付费额度');
 if(p.cost>limit)throw Error('Mint 报价超过预算');
 const min=p.out*BigInt(10000-i.slippageBps)/10000n;if(p.out&&min===0n)throw Error('最低到账为 0');
 const args=t.name==='scarab'?[n,ZeroAddress,p.cost,token,min]:t.name==='bianren_hub'?[n,ZeroAddress,p.cost,min]:[n,ZeroAddress,p.cost];
 const abi=new Interface(['function '+t.signature+' payable']),step={kind:'mint',to:meta.address,value:String(p.cost),data:abi.encodeFunctionData(t.signature,args)};
 await rpc.call({to:step.to,data:step.data,from:w.address,value:p.cost});
 return {kind:'contract',route:'mint-template:'+t.name,token,wallet:w.address,inputToken:BNB,outputToken:token,amountIn:String(p.cost),minOutput:String(min),quantity:Number(n),identity:meta.identity,expectedAsset:p.out?{token,kind:'Erc20',amount:String(min)}:null,
  review:['模板匹配只证明接口兼容，不能证明合约安全',...(!meta.verified?['源码未核验']:[])],steps:[step],metaVerified:meta.verified};
}
export async function verifyIdentity(rpc,identity){
 if(!identity)return;
 // Independent code reads share the same RPC batch. Both checks still finish
 // immediately before dispatch; warmed fingerprints never skip this guard.
 const [now,assets]=await Promise.all([codeIdentity(rpc,identity.target),Promise.all((identity.learnedAssets||[]).map(async a=>({expected:a.codeHash,actual:keccak256(await rpc.getCode(a.token))})))]);
 if(now.fingerprint!==identity.fingerprint)throw Error('合约或代理实现已变化，必须重新预览');
 if(assets.some(a=>a.actual!==a.expected))throw Error('链上学习的到账资产代码已变化，必须重新识别');
}
