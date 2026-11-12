import {invitationFailure} from './mint-funding.mjs';
import {refreshStarsMint,verifyStarsPreview,verifyStarsReceipt} from './stars.mjs';
import {OpeningApprovalPreviews} from './opening-approval-previews.mjs';
import {diagnoseRevert} from './revert-reason.mjs';
import {describeError} from '../public/error-message.mjs';
import {SellCoordinator,sellLane} from './sell-coordinator.mjs';
import {refreshGangSell} from './gang-modern.mjs';
import {INFINITY,verifyInfinityApproval,verifyInfinityAllowance} from './infinity.mjs';
import {tradeLegPlan} from './trade-leg.mjs';
import {providerRefusal,repairRejectedOrder,applyContractRefusal} from './provider-outcome.mjs';
import {refreshBagentMint,verifyBagentBinding,verifyBagentReceipt} from './bagent.mjs';
import {sellGasArgs} from './sell-gas.mjs';
import {updateFeeReview,blockUnverifiableFees,assessSellFees} from './trade-fees.mjs';
import {findLowFeeSell,searchableSellPreviewError} from './sell-fee-search.mjs';
import {manualDirectSell} from './manual-sell-recovery.mjs';
import {openingPlan,refreshOpeningSell} from './opening-route.mjs';
import {openingRecoveryPlan} from './opening-recovery.mjs';
import {recentOpeningPreviewFailures} from './sell-route-history.mjs';
import {hasPreviewRisks} from './preview-risks.mjs';
import {erc1155Received} from './erc1155-credit.mjs';
import path from 'node:path';
import fs from 'node:fs';
import {OrderIndex} from './order-index.mjs';
import {orderSummary} from './order-summary.mjs';
import {lateSink,readLate} from './late-result.mjs';
import {randomUUID} from 'node:crypto';
import {DATA,json,hash,load,save,wallet,validateIntent,read,ERC20,same,native,BNB,sleep,publicError,parseUnits,formatUnits} from './common.mjs';
import {discover} from './discovery.mjs';
import {tradeTarget} from './trade-target.mjs';
import {mintPlan,verifyIdentity} from './mint.mjs';
import {tradePlan,settlements} from './routes.mjs';
import {auditToken} from '../support/curve-trader/audit.mjs';
import {ExperienceStore} from './experience.mjs';
import {profiled,measure,snapshot,preflightReport} from './diagnostics.mjs';
import {rejectedSwapQuery,uniqueFailedSwap,applyFailedSwap} from './order-reconciliation.mjs';
import {tradeError} from './sell-policy.mjs';
import {corlaReceipt,corlaRefundReceipt,corlaInput,corlaClient} from './corla.mjs';
const unresolved=new Set(['SUBMITTING','SUBMISSION_UNKNOWN','PENDING','APPROVAL_CONFIRMED','READY_TO_CONTINUE','RECEIPT_REVIEW']);
const terminal=new Set(['CONFIRMED','CONFIRMED_REVIEW','FAILED','SIMULATED','BLOCKED','PARTIAL','CANCELLED','SKIPPED','REJECTED']);
function integer(x){if(typeof x==='number'&&!Number.isSafeInteger(x))throw Error('模拟金额精度不足，无法安全核验');if(!/^-?\d+$/.test(String(x)))throw Error('模拟金额不是精确整数');return BigInt(x);}
const receiptReadError=e=>Object.assign(Error('原单链上查询暂不可用，继续跟踪原交易：'+e.message),{code:'ORIGINAL_READ_UNAVAILABLE'});
async function originalRead(work){try{return await work();}catch(e){throw receiptReadError(e);}}
export function verifyPreview(p,plan,step){
 plan=tradeLegPlan(plan,step);
 const s=p?.simulationResult;
 if(!p?.requestId||s?.simulationCode!=='000000000'||s.simulationErrorDetail)throw Object.assign(Error(s?.simulationErrorDetail?describeError({message:'钱包模拟未明确通过',details:{simulationErrorDetail:s.simulationErrorDetail}}):'钱包模拟未明确通过：接口未提供具体原因'),{code:p?.requestId&&s?.simulationCode?'OFFICIAL_SIMULATION_FAILED':'OFFICIAL_PREVIEW_INVALID',details:{simulationCode:s?.simulationCode,simulationErrorDetail:s?.simulationErrorDetail}});
 // Official Permit2 previews describe the approved TOKEN in contractAddress,
 // not the execution target. Accept that representation only for our pinned,
 // exact-input Permit2 step, never as a generic target-check exemption.
 let permitTokenView=false;
 if(step.kind==='approve'&&step.approvalType==='infinity-permit2'){
  verifyInfinityApproval(step,plan);
  if(same(p.parsedTx?.contractAddress,step.token)){
   if(p.parsedTx.transactionType!=='Approve'||!same(p.parsedTx.spender,step.spender))throw Error('Permit2 预览授权对象不一致');
   const amount=p.parsedTx.amount;
   // Large metadata numbers may be rounded by the wallet JSON. The exact
   // calldata remains bound and verified above, independently of this label.
   if((typeof amount==='string'||Number.isSafeInteger(amount))&&integer(amount)!==BigInt(step.allowance))throw Error('Permit2 预览授权数量不一致');
   permitTokenView=true;
  }
 }
 if(p.parsedTx?.contractAddress&&!same(p.parsedTx.contractAddress,step.to)&&!permitTokenView)throw Error('模拟目标合约不匹配');
 if(s.authorityChanges?.length)throw Error('模拟出现权限变更');
 const starsAllowance=plan.route==='stars:mint'&&verifyStarsPreview(p,plan,step);
 if(step.kind==='referral'&&(s.allowanceChanges?.length||(s.balanceChanges||[]).some(c=>same(c.owner,plan.wallet)&&integer(c.change)!==0n)))throw Error('邀请绑定模拟出现资产或授权变更');
 for(const c of s.allowanceChanges||[]){
  if(starsAllowance)continue; // Exact token, owner, spender and amount checked above.
  if(!same(c.owner,plan.wallet))continue;
  if(step.kind==='approve'){
   if(!same(c.tokenAddress,step.approvalType==='infinity-permit2'?step.token:step.to)||!same(c.spender,step.spender)||integer(c.postAmount)>BigInt(step.allowance))throw Error('授权范围超出本笔所需');
  }else if(!same(c.tokenAddress,plan.inputToken)||!(same(c.spender,step.to)||plan.route===INFINITY.id+'-opening'&&same(step.to,INFINITY.router)&&same(c.spender,INFINITY.permit2))||integer(c.postAmount)>integer(c.preAmount))throw Error('模拟出现额外授权');
 }
 const debits=new Map(),nftCredits=new Set(),multiIds=new Set();let multiCredit=0n,output=0n;
 for(const c of s.balanceChanges||[]){if(!same(c.owner,plan.wallet))continue;const token=c.contractAddress;
  // Some official previews round huge positive credits into scientific notation.
  // They cannot authorize a debit and are not proof of exact incoming quantity.
  if(typeof c.change==='number'&&!Number.isSafeInteger(c.change)&&c.change>0){if(plan.requireSellCredit||(!plan.metaVerified||plan.requireAssetCredit)&&step.kind==='mint')throw Error('模拟到账精度不足，无法核验未知模板');continue;}
  const v=integer(c.change);
  if(v>0n&&(same(token,plan.outputToken)||(plan.requireRefundCredit||plan.requireSellCredit||plan.requireTradeCredit)&&native(token)&&native(plan.outputToken))&&(!plan.requireAssetCredit||plan.expectedAsset?.kind!=='Erc20'||c.tokenType==='Erc20'))output+=v;
  if(v===1n&&same(token,plan.outputToken)&&c.tokenType==='Erc721'&&/^(?:0x[0-9a-f]+|\d+)$/i.test(String(c.tokenId)))nftCredits.add(String(BigInt(c.tokenId)));
  if(v>0n&&same(token,plan.outputToken)&&(c.tokenType==='Erc1155'||plan.erc1155InterfaceVerified&&c.tokenType==='Erc721'&&v===1n)){if(!/^(?:0x[0-9a-f]+|\d+)$/i.test(String(c.tokenId)))throw Error('ERC1155 模拟缺少 tokenId');const key=String(BigInt(c.tokenId));if(multiIds.has(key))throw Error('ERC1155 模拟重复资产变更，需要核对');multiIds.add(key);multiCredit+=v;}
  if(v>=0n)continue;const k=native(token)?BNB:token.toLowerCase(),n=(debits.get(k)||0n)-v;debits.set(k,n);
  if(step.kind==='approve')throw Error('授权模拟出现资产支出');
  if(native(token)){if(n>BigInt(step.value))throw Error('模拟 BNB 支出超出 value');}
  else if(!same(token,plan.inputToken)||n>BigInt(plan.amountIn))throw Error('模拟支出超出本笔资产及数量');
 }
 if(step.kind==='approve'){
  if(step.approvalType==='infinity-permit2')verifyInfinityApproval(step,plan);
  else{const v=ERC20.decodeFunctionData('approve',step.data);if(!same(v[0],step.spender)||v[1]!==BigInt(step.allowance))throw Error('授权 calldata 不一致');}
 }
 if(step.kind==='sell'&&plan.requireSellCredit&&output<BigInt(plan.minOutput))throw Object.assign(Error('官方卖出模拟到账不足最低到账，停止提交'),{code:'SELL_OUTPUT_BELOW_MIN'});
 if(plan.requireTradeCredit&&step.kind!=='approve'&&output<BigInt(plan.minOutput))throw Object.assign(Error('官方交易模拟到账不足本步骤最低到账，未提交'),{code:'TRADE_OUTPUT_BELOW_MIN'});
 if(plan.requireRefundCredit&&output<BigInt(plan.minOutput))throw Error('官方预览未证明本钱包退款足额到账');
 // Runtime-only ERC20 recognition requires proof of the promised incoming asset.
 if(step.kind==='mint'&&(!plan.metaVerified||plan.requireAssetCredit)&&plan.expectedAsset?.kind==='Erc20'&&output<BigInt(plan.minOutput||0))throw Error('模拟到账少于模板最低数量');
 if(step.kind==='mint'&&plan.requireNftCredit&&BigInt(nftCredits.size)<BigInt(plan.minOutput||0))throw Error('官方预览未证明本次 NFT 足额到账，停止提交');
 if(step.kind==='mint'&&plan.expectedAsset?.kind==='Erc1155'&&multiCredit<BigInt(plan.minOutput||0))throw Error('官方预览未证明本次 ERC1155 足额到账');
 return {parsedTx:p.parsedTx,risks:p.risks||[],authorityChanges:s.authorityChanges||[],allowanceChanges:s.allowanceChanges||[],balanceChanges:(s.balanceChanges||[]).map(c=>({...c,...(typeof c.change==='number'&&!Number.isSafeInteger(c.change)?{amountApproximate:true}:{} )})),requireConfirmation:p.requireConfirmation};
}
export class Engine{
 constructor({rpc,bridge,data=DATA,live=false,planFn=null,auditFn=auditToken,tradePlanOptions={}}){Object.assign(this,{rpc,bridge,data,live,planFn,auditFn,tradePlanOptions});this.experience=new ExperienceStore(data);this.running=new Set();this.sellCoordinator=new SellCoordinator();this.mintSequences=new Map();this.previews=new Map();this.ordersDir=path.join(data,'orders');fs.mkdirSync(this.ordersDir,{recursive:true,mode:0o700});
  this.orderIndex=new OrderIndex(this.ordersDir);this.following=new Map();this.openingRefreshes=new Map();
  this.openingApprovalPreviews=new OpeningApprovalPreviews({preview:(plan,intent)=>this.preview(plan,intent,0,{background:true}),busy:account=>this.running.has(account)||this.bridge.queues?.has(account)});
  for(const row of this.list()){if(this.repairRefusal(row))continue;if(row.status==='SUBMITTING'){row.status='SUBMISSION_UNKNOWN';row.error={message:'服务在提交过程中退出，只能核对原单'};this.write(row);}else{try{this.experience.record(row);}catch{}}}
 }
 file(id){if(typeof id!=='string'||!/^[a-zA-Z0-9_.:-]{1,160}$/.test(id))throw Error('订单 ID 只能包含字母、数字、下划线、点、冒号、横线');return path.join(this.ordersDir,hash(id)+'.json');}
 get(id){return load(this.file(id));}
 write(o){o.updatedAt=Date.now();const file=this.file(o.id);save(file,o);this.orderIndex?.invalidate(file);try{this.experience.record(o);}catch(e){o.experienceWarning='经验记录失败：'+e.message;}return o;}
 list(limit=Infinity){return this.orderIndex.list(limit);}
 history(limit=50){return this.orderIndex.list(limit,orderSummary);}
 repairRefusal(o){const repaired=repairRejectedOrder(o);if(!repaired)return null;const backup=path.join(this.data,'order-repair-backups',hash(o.id)+'.json');if(!fs.existsSync(backup))save(backup,o);return this.write(repaired);}
 async reconcileAccount(account,exceptId){
  const pending=this.list().filter(o=>o.intent.account===account&&o.id!==exceptId&&unresolved.has(o.status));if(!pending.length)return {account,ready:true};
  if(this.running.has(account)){
   const tracking=pending.map(o=>this.following.get(o.id)).filter(Boolean);
   if(tracking.length)await Promise.allSettled(tracking);
   if(this.running.has(account))return {account,ready:false,order:pending[0]};
  }
  // Reconcile originals independently. Two unresolved journals must not block
  // each other's read-only receipt lookup. Never submit or continue here.
  let firstResult;
  for(const row of pending.slice(0,16)){
   try{const result=this.repairRefusal(row)||await this.follow(row.id);if(row.id===pending[0].id)firstResult=result;}catch(e){if(e.code!=='WALLET_BUSY')throw e;break;}
  }
  const remaining=this.orderIndex.find(o=>o.intent.account===account&&o.id!==exceptId&&unresolved.has(o.status));
  return {account,ready:!remaining,order:remaining||firstResult||this.get(pending[0].id)};
 }
 async exclusive(account,fn,id,{trackingOnly=false}={}){if(this.running.has(account))throw Object.assign(Error('该钱包正在处理上一笔操作，请稍后核对'),{code:'WALLET_BUSY',details:{account,requestAccepted:false}});const pending=!trackingOnly&&this.orderIndex.find(o=>o.intent.account===account&&o.id!==id&&unresolved.has(o.status));if(pending)throw Object.assign(Error('上一笔交易尚未确定结果，已保留原单供核对'),{code:'ORDER_UNRESOLVED',details:{account,orderId:pending.id,status:pending.status,requestAccepted:false}});this.running.add(account);try{return await fn();}finally{this.running.delete(account);}}
 async sellAudit(token){
  this.sellAudits??=new Map();const key=token.toLowerCase(),old=this.sellAudits.get(key);
  if(old&&old.until>Date.now())return old.result;
  let timer;const result=Promise.race([Promise.resolve().then(()=>this.auditFn(token)),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('卖出税查询超时，按未知处理')),1200))]).catch(e=>({available:false,reason:e.message})).then(a=>({...a,checkedAt:Date.now()})).finally(()=>clearTimeout(timer));
  this.sellAudits.set(key,{until:Date.now()+5000,result});if(this.sellAudits.size>128)this.sellAudits.delete(this.sellAudits.keys().next().value);return result;
 }
 async plan(intent,context={}){
  if(this.planFn)return this.planFn(intent);
  const preflight=()=>Promise.all([this.rpc.verifyChain(),measure('walletReady',()=>this.bridge.ready(intent.account,{external:intent.side==='mint'}))]).then(()=>({}),error=>({error}));
  const earlyReady=intent.side==='mint'&&(corlaInput(intent.asset)?.priority||/^corla:/.test(intent.routeId||''))?preflight():null;
  // A claim names the previously registered mint contract. The dedicated
  // planner still verifies its factory/implementation and fresh claim state;
  // fetching website/title/creation terms again adds no claim authorization.
  const directClaim=intent.side==='mint'&&intent.routeId==='corla:claim'&&/^0x[\da-f]{40}$/i.test(intent.asset);
  const resolved=intent.side!=='mint'?tradeTarget(intent.asset):directClaim?{address:intent.asset,platform:'corla',source:'Corla 领取合约'}:await measure('projectDiscovery',()=>discover(intent.asset,{rpc:this.rpc,chainFallback:true,corlaRouting:true}));
  const project={name:resolved.name||resolved.addresses?.find(r=>r.primary)?.name||null,source:resolved.source,address:resolved.address,platform:resolved.platform};
  try{
  if(!resolved.address)throw Object.assign(Error(resolved.failure?.message||resolved.reason||'尚未核验项目 Mint 入口，请提供完整合约地址'),{code:resolved.failure?.code||'MINT_NOT_VERIFIED',details:resolved});
  if(intent.side!=='mint'&&/^https:/i.test(intent.asset))throw Error('网址可能指向 Mint 合约。买卖请使用 inspect 返回的 token（到账代币 CA），不要把 Mint 地址当作代币');
  // Public balance/registry reads need no wallet session. Start them during a
  // cold/reconnecting preflight, while every official quote still waits for
  // both the chain and wallet checks. Failed guards cannot produce a plan.
  const ready=earlyReady||preflight();
  const ensureReady=async()=>{const r=await ready;if(r.error)throw r.error;};
  const overlap=intent.side==='mint'?['corla','binancians','stars'].includes(resolved.platform):!intent.openingOnly&&this.tradePlanOptions.overlapTradePreflight!==false;
  if(!overlap)await ensureReady();
  const tradeBridge=overlap?{call:async(...args)=>{await ensureReady();return this.bridge.call(...args);},ready:async(...args)=>{await ensureReady();return this.bridge.ready(...args);}}:this.bridge;
  const directSellPlan=(seed,slippagePromise)=>manualDirectSell(this.rpc,tradeBridge,intent,seed,{scan:this.openingScan,preparation:this.openingPreparation,slippagePromise});
  // Buying always targets the explicitly supplied token CA. Audit and quote
  // are independent reads; both still complete before preview/submission.
  let [p,audit]=await Promise.all([
   intent.side==='mint'?mintPlan(this.rpc,this.bridge,intent,resolved.address,resolved,this.experience,{officialPreview:true,quantityCeiling:context.mintCeiling??500}):(intent.openingOnly?(context.openingRecovery?openingRecoveryPlan(this.rpc,this.bridge,intent,this.get(context.openingRecovery.sourceId),{scan:this.openingScan,snapshot:context.openingSnapshot,preparation:this.openingPreparation}):openingPlan(this.rpc,this.bridge,intent,{scan:this.openingScan,snapshot:context.openingSnapshot,preparation:this.openingPreparation,holdingHint:context.openingHoldingHint,failedPreviews:recentOpeningPreviewFailures(this.list(),intent)})):tradePlan(this.rpc,tradeBridge,intent,resolved.address,resolved.platform,{...this.tradePlanOptions,directSellPlan})),
   intent.side==='sell'?measure('tokenAudit',()=>this.sellAudit(resolved.address)):intent.side==='buy'?measure('tokenAudit',()=>this.auditFn(resolved.address)).catch(e=>({available:false,reason:e.message})):null,
   ensureReady()
  ]);
  // Manual external sells already built their verified direct pool while the
  // independent quote/registry reads ran. Never rebuild the same plan here.
  if(intent.side==='sell')p.audit=audit;
  project.address=resolved.address;p.resolved=resolved;p.project=project;
  if(intent.claimSell&&p.route!=='corla:mint')throw Error('领取后联动卖出目前仅支持 Corla 认购');
  if(intent.side==='buy'){
   if(!same(p.token,resolved.address))throw Error('交易目标与本次已审计代币不一致');p.audit=audit;
   if(audit.available&&audit.level>=5)throw Error('代币风险 5 级，拒绝提交');
   if(!audit.available)p.review.push('代币安全审计不可用：'+(audit.reason||'无结果'));
   if(audit.available&&audit.level>=4)p.review.push('代币安全审计高风险：'+audit.level);
   const hits=(audit.items||[]).flatMap(x=>x.details||[]).filter(x=>x.isHit).map(x=>x.description||x.title);p.review.push(...hits);
  }
  return p;
  }catch(e){project.address=resolved.address;e.project=project;throw e;}
 }
 async warmOpeningApprovals(config,preflight,snapshot,allowed){return this.openingApprovalPreviews.warm(config,preflight,snapshot,this.openingPreparation,allowed);}
 openingRefreshKey(plan){return hash({wallet:plan.wallet,token:plan.token,amount:plan.amountIn,balance:plan.holdingBefore,slippage:plan.slippage,opening:plan.opening,steps:plan.steps,minimum:plan.authorizationMinOutput});}
 primeOpeningRefresh(o,entry,plan){
  // Only AFTER the successful, exact original approval receipt is verified.
  // Overlap fresh pool/holding reads with the independent allowance check.
  // This performs no official preview/signature and grants no continuation.
  if(o.intent.side!=='sell'||!plan.opening||entry.step.kind!=='approve'||plan.steps.at(-1)?.kind!=='sell')return;
  const key=this.openingRefreshKey(plan),old=this.openingRefreshes.get(o.id);if(old?.key===key&&Date.now()-old.startedAt<1000)return;
  const pending={key,startedAt:Date.now(),promise:refreshOpeningSell(this.rpc,{...plan,account:o.intent.account}).then(value=>({value,at:Date.now()}),error=>({error}))};
  this.openingRefreshes.set(o.id,pending);while(this.openingRefreshes.size>32)this.openingRefreshes.delete(this.openingRefreshes.keys().next().value);
 }
 async freshOpeningSale(o,{repriced=false}={}){
  const pending=this.openingRefreshes.get(o.id);this.openingRefreshes.delete(o.id);
  if(!repriced&&pending?.key===this.openingRefreshKey(o.plan)&&Date.now()-pending.startedAt<1000){
   const result=await pending.promise;
   if(result.value&&Date.now()-result.at<1000){o.timing.postApprovalReadsOverlapped=true;return result.value;}
  }
  return refreshOpeningSell(this.rpc,{...o.plan,account:o.intent.account});
 }
 async preview(plan,intent,index=0,{background=false}={}){
  if(plan.kind==='swap')return null;
  await this.bridge.ready(intent.account,{external:true,...(background?{background:true}:{})});
  const s=plan.steps[index];let p;
  const warmed=!background&&this.openingApprovalPreviews?.take(plan,intent,index);
  if(warmed){const review=verifyPreview(warmed.raw,plan,s);return {...warmed,review};}
  try{p=await this.bridge.call(intent.account,['contract-call','preview','--binanceChainId','56','--from',plan.wallet,'--to',s.to,'--value',String(s.value),'--inputData',s.data,...sellGasArgs(intent,s)],background?{background:true,readOnlyTimeoutMs:1500}:{});}
  catch(e){if(String(e.code)==='351805'&&e.responseReceived===true)e.details={...e.details,officialSimulationFailed:true};throw e;}
  const review=verifyPreview(p,plan,s);return {raw:p,review,at:Date.now()};
 }
 async warmCorlaClaim(mint){const client=corlaClient(this.rpc),row=await client.locate(mint,{explicit:true});if(!row)throw Error('Corla 项目登记未找到');return client.verify(row);}
 async previewWithFeeSearch(o,index=0,{cached,minimumOutput}={}){
  let p,error;try{p=cached||await this.preview(o.plan,o.intent,index);}catch(e){error=e;}
  if(p)p={...p,rerouted:false};
  const fees=o.intent.side==='sell'?assessSellFees(o.plan,o.plan.steps?.[index]?.kind==='sell'?p?.review:null):null;
  if(!o.plan.stagedTrade&&o.intent.side==='sell'&&(error?o.plan.steps?.[index]?.kind==='sell'&&searchableSellPreviewError(error):fees?.required||fees?.blocked)){
   const alternative=await findLowFeeSell(o,{rpc:this.rpc,bridge:this.bridge,scan:this.openingScan,preparation:this.openingPreparation,preview:this.preview.bind(this),...(this.feeRoutePlanner?{planFn:this.feeRoutePlanner}:{}),minimumOutput});
   if(alternative){o.plan=JSON.parse(json(alternative.plan));p=alternative.preview;o.nextStep=0;o.needsReview=false;o.needsFeeReview=false;error=null;p={...p,rerouted:true};}
  }
  if(error&&o.plan.route==='stars:mint'&&o.intent.referral!=='none'&&!o.plan.referral?.fallback&&!o.steps?.length&&invitationFailure(error)){
   const fresh=await this.plan({...o.intent,referral:'none'},{mintCeiling:o.plan.fill?.targetQuantity||o.plan.quantity||500});
   if(!same(fresh.token,o.plan.token)||fresh.resolved?.address!==o.plan.resolved?.address)throw Error('邀请回退时 Mint 目标发生变化，未提交');
   fresh.referral={...fresh.referral,active:false,fallback:true,note:'邀请未生效，已改为不带邀请重新模拟'};
   o.plan=JSON.parse(json(fresh));p=await this.preview(o.plan,{...o.intent,referral:'none'},0);error=null;
  }
  if(error)throw error;
  if(p){this.previews.set(o.id,{...p,rerouted:false});o.preview=p.review;o.previewAt=p.at;if(p.approvalPrewarmed)(o.timing??={}).approvalPreviewReused=true;}
  return p;
 }
 async prepare(input,id=randomUUID(),context={}){
  const intent=validateIntent(input),old=this.get(id);
  if(old){if(hash(old.intent)!==hash(intent))throw Error('同一消息 ID 不能用于不同交易');if(!(context.retryBlocked===true&&old.status==='BLOCKED'&&old.steps?.length===0&&!old.txHash&&!old.orderId))return {...old,duplicateSuppressed:true};}
  await this.reconcileAccount(intent.account,id);
  return profiled('prepare',()=>this.exclusive(intent.account,async()=>{
   const o={id,intent,status:'PREPARING',createdAt:Date.now(),timing:{receivedAt:Date.now()},steps:[],simulationOnly:!this.live,...(old?{preparationHistory:[...(old.preparationHistory||[]),{at:old.updatedAt,error:old.error,timing:old.timing}]}:{})};this.write(o);
   try{let plan=await measure('plan',()=>this.plan(intent,context));o.plan=JSON.parse(json(plan));o.project=plan.project;o.timing.planReadyAt=Date.now();const p=await measure('officialPreview',()=>this.previewWithFeeSearch(o));plan=o.plan;
    if(plan.route==='bagent:mint'&&plan.steps[0].kind==='referral'&&!plan.steps.some(s=>s.kind==='approve')){
     const mintPreview=await this.preview(plan,intent,plan.steps.length-1);o.mintPreview=mintPreview.review;
     if(hasPreviewRisks(mintPreview.raw.risks))plan.review.push('BAGENT Mint 官方预览存在风险提示，请查看详情');
    }
    o.status='PREPARED';o.review=[...(plan.review||[]),...(hasPreviewRisks(p?.raw.risks)?['钱包预览存在风险提示，请查看详情']:[])];updateFeeReview(o,plan.steps?.[0]?.kind==='sell'?o.preview:null);blockUnverifiableFees(o);o.timing.preparedAt=Date.now();o.timing.prepareMs=o.timing.preparedAt-o.createdAt;
   }catch(e){o.status=intent.side==='sell'&&e.code==='NO_HOLDINGS'?'SKIPPED':'BLOCKED';o.project??=e.project;o.mintContext=e.mintContext;o.error={...tradeError(e),details:e.details};o.timing.prepareMs=Date.now()-o.createdAt;}
   o.diagnostics=snapshot();o.preflight=preflightReport(o);if(intent.side==='mint'&&o.project?.platform!=='corla')o.inputExperience=this.experience.lookupInput(intent.asset);
   return this.write(o);
  },id));
 }
 async selectMintRoute(id,routeId){
  const old=this.get(id);
  if(!old||old.intent.side!=='mint'||old.status!=='BLOCKED'||old.steps?.length)throw Error('只能为尚未提交的待选 Mint 预览选择方式');
  if(!old.error?.details?.routes?.some(r=>r.id===routeId))throw Error('请选择该项目列出的铸造方式');
  // A stable child ID makes double clicks/retries idempotent; the original
  // intent is preserved and this endpoint never executes, even in LIVE mode.
  const next=await this.prepare({...old.intent,routeId},'route-'+hash([id,routeId]));
  next.parentId=id;next.project??=old.project;return this.write(next);
 }
 // Stateful mint counters are shared across wallets, including simultaneous bot/UI requests.
 async mintSequence(o,work){
  if(!o.plan?.freshBeforeExecute)return work();
  const key=o.plan.steps[0].to.toLowerCase(),prior=this.mintSequences.get(key)||Promise.resolve();
  const task=prior.catch(()=>{}).then(()=>{
   const current=this.get(o.id);if(!['PREPARED','READY_TO_CONTINUE'].includes(current?.status))return {...current,duplicateSuppressed:true};
   const pending=this.orderIndex.find(r=>r.id!==o.id&&r.plan?.freshBeforeExecute&&same(r.plan.steps?.[0]?.to,key)&&unresolved.has(r.status));
   if(pending)throw Error('同一 Mint 合约有待核对原单：'+pending.id+'；先核对该单，不能复用旧起始编号');
   return work();
  });this.mintSequences.set(key,task);
  try{return await task;}finally{if(this.mintSequences.get(key)===task)this.mintSequences.delete(key);}
 }
 async execute(id,{authorization,acknowledgeReview=false,feeAcknowledgement,swapReceiptWaitMs=10000,continueAllowed=()=>true,rejectRisks=false}={}){
  const o=this.get(id);if(!o)throw Error('找不到原始预览');
  if(!['PREPARED','READY_TO_CONTINUE'].includes(o.status))return {...o,duplicateSuppressed:true};
  if(!this.live){o.status='SIMULATED';o.executeCalls=0;o.message='模拟模式，未签名、未广播；多批次仅预览首批，未宣称额度已打满';return this.write(o);}
  if(o.simulationOnly)throw Error('旧模拟记录不能提交实盘，请从操作面板或使用新的操作 ID 重新预览本次真实操作');
  if(typeof authorization!=='string'||!authorization.trim())throw Error('执行须附本次用户原始交易指令');
  // Separate, per-order consent. Quick trade's acknowledgeReview=true and
  // automatic task authorization can NEVER silently accept high/unknown fees.
  const feeGate=(preview,beforeSell=false)=>{const fee=updateFeeReview(o,preview,{beforeSell});if(blockUnverifiableFees(o))return this.write(o);if(fee?.required&&(rejectRisks||feeAcknowledgement!==fee.id)){o.status='PREPARED';o.message='费用检查未通过，卖出未提交；可在详情中核对费用';o.needsReview=true;return this.write(o);}o.needsFeeReview=false;o.needsReview=false;if(o.message?.startsWith('费用检查未通过')||o.message==='卖出尚未提交，请确认池费与卖出税')delete o.message;return null;};
  return this.mintSequence(o,()=>this.exclusive(o.intent.account,async()=>{
   o.authorization=authorization;o.acknowledgeReview=acknowledgeReview;
   const mayContinue=()=>typeof continueAllowed!=='function'||continueAllowed();
   const cancelled=()=>{o.status='CANCELLED';o.message='任务已停止，尚未提交的步骤已取消；已完成的授权不会自动撤销';return this.write(o);};
   try{
    const currentFees=o.intent.side==='sell'?assessSellFees(o.plan,o.plan.steps?.[o.nextStep||0]?.kind==='sell'?o.preview:null):null;
    if((currentFees?.required||currentFees?.blocked)&&feeAcknowledgement!==o.feeReview?.id){
     const p=await this.previewWithFeeSearch(o,o.nextStep||0,{cached:this.previews.get(id),minimumOutput:o.plan.minOutput});
     if(p?.rerouted)o.review=[...(o.plan.review||[])];
    }
    const initiallyHeld=feeGate(o.plan.steps?.[o.nextStep||0]?.kind==='sell'?o.preview:null);if(initiallyHeld)return initiallyHeld;
    if(o.review?.length&&!acknowledgeReview)return {...this.write(o),needsReview:true};
    if(['corla:mint','binancians:mint'].includes(o.plan.route))o.targetQuantity??=o.plan.fill.targetQuantity;
    if(!mayContinue())return cancelled();
    if(o.status==='PREPARED'&&!o.nextStep&&(o.plan.freshBeforeExecute||o.plan.refreshQuoteBeforeExecute||Date.now()-o.timing.preparedAt>15000)){
     const refreshIntent=o.plan.route==='binancians:mint'&&o.targetQuantity?{...o.intent,quantity:o.targetQuantity}:o.intent;
     const fresh=await this.plan(refreshIntent,o.intent.openingOnly&&o.plan.recovery?{openingRecovery:{sourceId:o.plan.recovery.originalId}}:o.plan.route==='stars:mint'?{mintCeiling:o.plan.quantity}:{});
     if(!same(fresh.token,o.plan.token)||fresh.resolved?.address!==o.plan.resolved?.address)throw Error('预览期间目标资产发生变化，停止提交');
     if(o.plan.refreshQuoteBeforeExecute&&(fresh.route!==o.plan.route||!same(fresh.inputToken,o.plan.inputToken)||fresh.quantity!==o.plan.quantity||fresh.fill?.targetQuantity!==o.targetQuantity||BigInt(fresh.minOutput)<BigInt(o.plan.minOutput)))throw Error('最新报价的份数、付款币或最低到账已超出本次预览，请重新核对');
     if(o.plan.freshBeforeExecute&&(fresh.quantity!==o.plan.quantity||BigInt(fresh.amountIn)>BigInt(o.plan.amountIn)||BigInt(fresh.minOutput)<BigInt(o.plan.minOutput)))throw Error('动态 Mint 的份数、费用或最低到账已超出本次预览，请重新核对');
     o.plan=JSON.parse(json(fresh));const p=await this.previewWithFeeSearch(o,0,{minimumOutput:fresh.minOutput});
     o.review=[...(o.plan.review||[]),...(hasPreviewRisks(p?.raw.risks)?['钱包预览包含风险提示']:[])];o.timing.preparedAt=Date.now();this.write(o);
     const held=feeGate(o.plan.steps?.[0]?.kind==='sell'?o.preview:null);if(held)return held;
     if(o.review.length&&!acknowledgeReview)return {...o,needsReview:true};
    }
    if(o.plan.afterMint){if(!this.onAuthorized)throw Error('自动领取服务未连接，请关闭自动领取或使用交易台服务');this.onAuthorized(o);}
    // Start all independent read-only guards together with identity/preview.
    // Capture the reviewed amount; a later reroute must not rewrite this guard.
    const guardedPlan=o.plan;
    const executionReady=Promise.all([this.bridge.ready(o.intent.account,{external:guardedPlan.kind==='contract'}),(async()=>{
     if(o.intent.side==='sell'&&!(guardedPlan.stagedTrade&&o.steps.some(e=>e.step.kind==='sell'&&e.status==='CONFIRMED'))){const [now]=await read(this.rpc,guardedPlan.token,ERC20,'balanceOf',[guardedPlan.wallet]);if(String(now)!==guardedPlan.holdingBefore)throw Error('当前持仓已变化，请重新预览，按最新余额计算');}
    })()]).then(()=>({}),error=>({error}));
    if(o.plan.kind==='swap'){const ready=await executionReady;if(ready.error)throw ready.error;await verifyIdentity(this.rpc,o.plan.identity);if(!mayContinue())return cancelled();return await this.submitSwap(o,swapReceiptWaitMs===0?0:10000);}
    // Contract identity is checked below, immediately before EACH step. Avoid
    // the redundant identical check here and retain approval -> swap ordering.
    while(true){
     for(let index=o.nextStep||0;index<o.plan.steps.length;index++){
      if(!mayContinue())return cancelled();
      if(o.plan.route==='bagent:mint'&&o.plan.steps[index].kind==='mint'){
       o.plan=await refreshBagentMint(this.rpc,o.plan,o.intent);this.previews.delete(id);this.write(o);
      }
      if(o.plan.route==='stars:mint'&&o.plan.steps[index].kind==='mint'){
       o.plan=await refreshStarsMint(this.rpc,o.plan,o.plan.mintFunding?.effectiveIntent||{...o.intent,...(o.plan.referral?.fallback?{referral:'none'}:{})});this.previews.delete(id);this.write(o);
      }
      // Fresh identity checks and quote/official preview reads are independent.
      // Capture THIS plan: a fee-search reroute restarts the loop and checks the
      // new target again. Every guard must finish before execute can be called.
      const laneKey=o.intent.side==='sell'?sellLane(o.plan,o.plan.steps[index]):null;
      const lane=await this.sellCoordinator.enter(laneKey);
      try{
      // A previous fast-return submit may still be on-chain. Follow that exact
      // original before quoting another wallet against the same pool.
      const prior=laneKey?this.orderIndex.find(r=>r.id!==o.id&&unresolved.has(r.status)&&r.intent?.side==='sell'&&sellLane(r.plan,r.steps?.at(-1)?.step)===laneKey):null;
      let repriced=lane.waited||!!(laneKey&&this.orderIndex.find(r=>r.id!==o.id&&r.intent?.side==='sell'&&r.updatedAt>=o.createdAt&&r.steps?.some(e=>e.status==='CONFIRMED'&&sellLane(e.plan||r.plan,e.step)===laneKey)));
      if(prior){let original=this.get(prior.id);const until=Date.now()+8000;
       // Share the normal original-order follower and account lock. A separate
       // observer could overwrite a newer background confirmation with stale data.
       while(original.steps?.at(-1)?.txHash&&original.steps.at(-1).status!=='CONFIRMED'&&unresolved.has(original.status)&&Date.now()<until){
        try{original=await this.follow(prior.id,{receiptTimeoutMs:Math.max(0,until-Date.now())});}catch(e){if(e.code!=='WALLET_BUSY')throw e;original=this.get(prior.id);}
        if(original.steps?.at(-1)?.status!=='CONFIRMED'&&unresolved.has(original.status))await sleep(100);
       }
       if(original.steps?.at(-1)?.status!=='CONFIRMED'&&unresolved.has(original.status))throw Object.assign(Error('同一池子前一笔卖出尚未确认，本次尚未提交；后台继续核对原单'),{code:'SELL_POOL_BUSY'});
       repriced=true;
      }
      const identityPlan=o.plan;
      const identityCheck=measure('executionIdentity',()=>Promise.all([verifyIdentity(this.rpc,identityPlan.identity),...(identityPlan.protocolIdentities||[]).map(identity=>verifyIdentity(this.rpc,identity))])).then(()=>({}),error=>({error}));
      // Authorization can take several blocks. Refresh the automatic sale's
      // quote and deadline AFTER approval, then obtain a new official preview.
      // Preserve the original amount, venue, recipient and slippage percentage.
      const fastSale=o.intent.side==='sell'&&o.plan.opening&&o.plan.steps[index].kind==='sell';
      if(fastSale&&(repriced||o.steps.some(e=>e.step.kind==='approve'&&e.status==='CONFIRMED')||Date.now()-(o.previewAt||0)>1000)){
       o.plan=await this.freshOpeningSale(o,{repriced});this.previews.delete(id);this.write(o);
      }
      if(laneKey&&o.plan.route==='gang-modern'&&(repriced||o.steps.some(e=>e.step.kind==='approve'&&e.status==='CONFIRMED')||Date.now()-(o.previewAt||0)>1000)){
       o.plan=await refreshGangSell(this.rpc,o.plan,index);this.previews.delete(id);this.write(o);
      }
      const step=o.plan.steps[index];let p=o.steps.length===0?this.previews.get(id):null;
      if(o.intent.side==='sell'&&step.kind==='sell'&&o.plan.audit?.checkedAt&&Date.now()-o.plan.audit.checkedAt>5000)o.plan.audit=await this.sellAudit(o.plan.token);
      p=await this.previewWithFeeSearch(o,index,{cached:p&&Date.now()-p.at<=(fastSale?1000:15000)?p:null,minimumOutput:o.plan.minOutput});
      if(p?.rerouted){this.previews.set(id,{...p,rerouted:false});o.review=[...(o.plan.review||[])];o.nextStep=0;this.write(o);index=-1;continue;}
      if(hasPreviewRisks(p.raw.risks)&&(rejectRisks||!acknowledgeReview))throw Error('新的钱包预览包含风险，需要查看并确认');
      o.preview=p.review;o.previewAt=p.at;
      const held=feeGate(step.kind==='sell'?p.review:null,step.kind==='sell');if(held){o.nextStep=index;return this.write({...held,nextStep:index});}
      const [identityResult,readyResult]=await Promise.all([identityCheck,executionReady]);if(readyResult.error)throw readyResult.error;if(identityResult.error)throw identityResult.error;
      if(!mayContinue())return cancelled();
      const entry={index,stage:o.stage||0,plan:o.plan,step,preview:p.review,requestId:p.raw.requestId,status:'SUBMITTING',submitStartedAt:Date.now()};
      o.steps.push(entry);o.status='SUBMITTING';this.write(o);
      let result;try{result=await this.bridge.call(o.intent.account,['contract-call','execute','--requestId',p.raw.requestId],{onLateResponse:lateSink(this.data,o,entry)});}
      catch(e){
       if(applyContractRefusal(o,e))return this.write(o);
       entry.status=e.dispatched===false?'FAILED':'SUBMISSION_UNKNOWN';
       entry.error={...publicError(e),responseReceived:e.responseReceived===true,...(e.errorName?{errorName:e.errorName}:{})};o.error=entry.error;o.status=entry.status;
       if(e.dispatched===false){entry.submissionOutcome={accepted:false,source:'local-wallet'};o.timing.finishedAt=Date.now();if(o.intent.side==='mint'&&o.steps.slice(0,-1).some(x=>x.status==='CONFIRMED'&&x.step.kind==='mint'))o.status='PARTIAL';}
       return this.write(o);
      }
      entry.result=result;entry.txHash=result?.txHash||result?.transactionHash||null;entry.orderId=result?.orderId||null;entry.status=entry.txHash?'PENDING':'SUBMISSION_UNKNOWN';entry.submittedAt=Date.now();o.status=entry.status;o.timing.submittedAt??=Date.now();o.timing.toSubmitMs=o.timing.submittedAt-o.createdAt;
      if(step.kind==='sell'){o.timing.saleSubmittedAt=entry.submittedAt;o.timing.toSaleSubmitMs=entry.submittedAt-o.createdAt;}this.write(o);
      await this.observeContract(o,entry,(step.kind==='sell'||o.plan.route==='corla:claim')&&swapReceiptWaitMs===0?0:10000);
      if(entry.status!=='CONFIRMED')return this.write(o);
      o.nextStep=index+1;o.status='READY_TO_CONTINUE';this.write(o);
      }finally{lane.release();}
     }
     if(o.intent.side!=='mint')return this.finish(o);
     if(o.settledStage!==(o.stage||0)){
      o.completedQuantity=(o.completedQuantity||0)+o.plan.quantity;
      const key=o.plan.budgetCurrency==='QUOTE'?'quote':o.plan.budgetCurrency==='USDT'?'usdt':'bnb';o.spent??={bnb:'0',usdt:'0'};o.spent[key]=String(BigInt(o.spent[key]||'0')+BigInt(o.plan.amountIn));o.settledStage=o.stage||0;this.write(o);
     }
     const requested=o.plan.route==='binancians:mint'&&o.targetQuantity?o.targetQuantity-o.completedQuantity:o.intent.quantity==='max'?null:o.intent.quantity-o.completedQuantity;
     if(!o.plan.fill?.continue||requested===0||o.plan.route==='corla:mint'&&o.completedQuantity>=o.targetQuantity)return this.finish(o);
     const batchLimit=o.plan.route==='corla:mint'?500:50;
     if(o.completedQuantity>=500||(o.stage||0)>=batchLimit-1){o.status='PARTIAL';o.error={message:'达到本次 500 份 / '+batchLimit+' 批次保护上限；尚未打满'};return this.write(o);}
     const next={...o.intent,quantity:requested===null?'max':requested,maxBnb:formatUnits(parseUnits(o.intent.maxBnb,18)-BigInt(o.spent.bnb),18),...(o.intent.maxUsdt!==undefined?{maxUsdt:formatUnits(parseUnits(o.intent.maxUsdt,18)-BigInt(o.spent.usdt),18)}:{}),...(o.intent.maxQuote!==undefined?{maxQuote:formatUnits(parseUnits(o.intent.maxQuote,o.plan.budgetDecimals)-BigInt(o.spent.quote||'0'),o.plan.budgetDecimals)}:{})};
     try{
      const plan=await this.plan(next);
      if(plan.identity?.fingerprint!==o.plan.identity?.fingerprint||!same(plan.token,o.plan.token))throw Error('跨批次合约或输出资产发生变化');
      if(o.plan.route==='corla:mint'&&(!same(plan.inputToken,o.plan.inputToken)||plan.budgetDecimals!==o.plan.budgetDecimals||plan.budgetCurrency!==o.plan.budgetCurrency))throw Error('Corla 跨批次付款币或精度发生变化，停止剩余认购');
      o.plan=JSON.parse(json(plan));o.stage=(o.stage||0)+1;o.nextStep=0;this.write(o);
     }catch(e){if((e.code==='NO_QUOTA'||e.code==='NO_FREE_MINT'&&o.intent.scope==='free')&&o.plan.route!=='binancians:mint')return this.finish(o);o.status='PARTIAL';o.error=publicError(e);o.timing.finishedAt=Date.now();return this.write(o);}
    }
   }catch(e){
    const pendingStep=o.steps?.at(-1);
    if(e.code==='ORIGINAL_READ_UNAVAILABLE'&&pendingStep?.status==='PENDING'&&/^0x[\da-f]{64}$/i.test(pendingStep.txHash||'')){
     o.status='PENDING';o.followError=publicError(e);return this.write(o);
    }
    // A receipt lookup failure is not proof that a dispatched swap failed.
    if(o.plan?.kind==='swap'&&(o.orderId||['SUBMITTING','SUBMISSION_UNKNOWN','PENDING'].includes(o.status))){if(o.status==='SUBMITTING')o.status='SUBMISSION_UNKNOWN';o.followError=publicError(e);return this.write(o);}
    // A later Corla preview can fail after earlier lots/approval settled. There
    // is no unknown transaction in that case; keep the completed portion and
    // let a new explicit operation retry without locking the wallet forever.
    const mintPartial=(o.intent.side==='mint'&&o.steps.some(x=>x.step.kind==='mint')||o.plan.stagedTrade&&o.steps.some(x=>x.step.kind!=='approve'))&&o.steps.every(x=>x.status==='CONFIRMED');
    const approvalOnly=o.steps.length>0&&o.steps.every(x=>x.status==='CONFIRMED'&&x.step.kind==='approve');
    o.status=mintPartial?'PARTIAL':approvalOnly?'BLOCKED':o.steps.some(x=>x.submittedAt)?'RECEIPT_REVIEW':'BLOCKED';o.error=publicError(e);if(terminal.has(o.status))o.timing.finishedAt=Date.now();return this.write(o);
   }
  },id));
 }
 clearResolvedErrors(o){if(o.error||o.followError){o.resolvedErrors=[...(o.resolvedErrors||[]),{at:Date.now(),error:o.error,followError:o.followError}].slice(-10);delete o.error;delete o.followError;}}
 finish(o){this.clearResolvedErrors(o);o.status='CONFIRMED';o.needsReview=false;o.needsFeeReview=false;o.timing.confirmedAt=Date.now();o.timing.toConfirmedMs=o.timing.confirmedAt-o.createdAt;return this.write(o);}
 confirmedReview(o,entry,error){
  this.clearResolvedErrors(o);entry.status=o.status='CONFIRMED_REVIEW';entry.settlementError=publicError(error);
  o.error={code:'SETTLEMENT_REVIEW',message:'原交易已成功上链，到账或授权结果需核验；本单已结束，不会重发，钱包可发起新操作。'+error.message};
  o.timing??={};o.timing.confirmedAt=Date.now();o.timing.toConfirmedMs=o.timing.confirmedAt-o.createdAt;
 }
 async stopRemaining(id){
  const old=this.get(id);if(!old)throw Error('找不到原单');
  return this.exclusive(old.intent.account,async()=>{
   const o=this.get(id);if(o.status==='PARTIAL'&&o.remainingCancelled||o.status==='CANCELLED')return o;
   if(!['READY_TO_CONTINUE','APPROVAL_CONFIRMED'].includes(o.status)||!o.steps?.length||o.steps.some(e=>e.status!=='CONFIRMED'))throw Error('只有已确认且尚未提交的后续步骤可以结束；待确认交易必须先核对');
   o.status=o.steps.some(e=>e.step?.kind==='mint')?'PARTIAL':'CANCELLED';o.remainingCancelled=true;
   o.message='用户结束尚未提交的剩余步骤；已成功交易保留，未撤销授权，未提交新交易。';o.timing??={};o.timing.finishedAt=Date.now();return this.write(o);
  },id,{trackingOnly:true});
 }
 async submitSwap(o,receiptWaitMs=10000){
  if(o.plan?.kind!=='swap')throw Error('聚合提交不能接受非聚合计划');
  // Defense in depth at the actual provider boundary, including legacy/retry
  // callers. An opaque sale has no route/fee bound and cannot be consented away.
  if(o.intent?.side==='sell'){updateFeeReview(o);if(blockUnverifiableFees(o))return this.write(o);}
  o.status='SUBMITTING';o.timing.submitStartedAt=Date.now();this.write(o);let r;
  try{r=await this.bridge.call(o.intent.account,['market-order','swap',...o.plan.args,'--gasLevel','HIGH','--mev','true'],{onLateResponse:lateSink(this.data,o)});}
  catch(e){
   const refusal=providerRefusal(e);o.status=refusal?'REJECTED':e.dispatched===false?'FAILED':'SUBMISSION_UNKNOWN';o.error={...tradeError(e),responseReceived:e.responseReceived===true};o.timing.finishedAt=Date.now();if(refusal)o.submissionOutcome=refusal;this.write(o);
   const query=rejectedSwapQuery(o);
   if(query)try{const result=await this.bridge.call(o.intent.account,query.args),failed=uniqueFailedSwap(o,result,this.list());if(failed)applyFailedSwap(o,failed);}catch(error){o.followError=publicError(error);}
   return this.write(o);
  }
  o.result=r;o.orderId=r?.orderId;o.txHash=r?.txHash||null;o.status=o.orderId?'PENDING':'SUBMISSION_UNKNOWN';o.timing.submittedAt=Date.now();o.timing.toSubmitMs=o.timing.submittedAt-o.createdAt;this.write(o);
  if(o.orderId&&receiptWaitMs>0)await this.observeSwap(o,receiptWaitMs);return this.write(o);
 }
 async observeSwap(o,timeout=0,readOptions={}){
  const end=Date.now()+timeout;do{const r=await this.bridge.call(o.intent.account,['market-order','list','--orderId',String(o.orderId)],readOptions);const row=r.list?.find(x=>String(x.orderId)===String(o.orderId))||(String(r.orderId)===String(o.orderId)?r:null);
   if(row){o.receipt=row;o.txHash=row.txHash||o.txHash;if(row.status==='FAILED'){o.status='FAILED';o.timing??={};o.timing.finishedAt=Date.now();break;}if(row.status==='FINISHED'){o.status='CONFIRMED';o.actualReceived=row.toTokenActualQty??null;o.refund=row.refund??null;o.timing.confirmedAt=Date.now();o.timing.toConfirmedMs=o.timing.confirmedAt-o.createdAt;break;}}
   if(Date.now()>=end)break;await sleep(300);
  }while(true);
 }
 async observeContract(o,entry,timeout=0){
  const plan=entry.plan||o.plan;
  if(!entry.txHash){o.status='SUBMISSION_UNKNOWN';entry.status='SUBMISSION_UNKNOWN';o.error={message:'官方返回未包含交易哈希，仅可核对原 requestId/orderId，禁止重发'};return;}
  const end=Date.now()+timeout;do{
   // Claim confirmation gates a subsequent sale. Fetch its immutable original
   // transaction alongside the receipt, not one network round trip later.
   const txRead=originalRead(()=>this.rpc.getTransaction(entry.txHash)).then(tx=>({tx}),error=>({error}));
   const receipt=await originalRead(()=>this.rpc.getTransactionReceipt(entry.txHash));
   if(receipt){entry.receipt=receipt;if(!same(receipt.from,plan.wallet)||!same(receipt.to,entry.step.to)){entry.status=o.status='RECEIPT_REVIEW';o.error={code:'ORIGINAL_MISMATCH',message:'节点回执与原交易目标不一致，正在重新核对原单'};break;}
    const result=txRead?await txRead:{tx:await this.rpc.getTransaction(entry.txHash)};if(result.error)throw result.error;
    const tx=result.tx;if(!tx)throw receiptReadError(Error('节点已返回回执，但原交易暂未同步'));
    if(!same(tx.from,plan.wallet)||!same(tx.to,entry.step.to)||tx.input.toLowerCase()!==entry.step.data.toLowerCase()||BigInt(tx.value)!==BigInt(entry.step.value)||receipt.transactionHash&&!same(receipt.transactionHash,entry.txHash)||tx.hash&&!same(tx.hash,entry.txHash)){entry.status=o.status='RECEIPT_REVIEW';o.error={code:'ORIGINAL_MISMATCH',message:'节点返回的交易内容与原单不一致，正在重新核对原单'};break;}
    if(!['0x0','0x1','0','1',0,1,0n,1n].includes(receipt.status))throw receiptReadError(Error('节点回执状态无效'));
    if(BigInt(receipt.status)===0n){this.clearResolvedErrors(o);entry.revertVerified=true;entry.status=o.status='FAILED';o.error={code:'TRANSACTION_REVERTED',message:'原交易已上链但执行回滚；回执未提供具体原因；可按当前持仓重新预览'};o.timing.finishedAt=Date.now();
     // Diagnostics never delay wallet release or dispatch another transaction.
     this.write(o);void diagnoseRevert(this.rpc,tx,receipt).then(reason=>{if(!reason)return;const current=this.get(o.id);if(current?.status!=='FAILED'||current.steps?.at(-1)?.txHash!==entry.txHash)return;current.steps.at(-1).revertDiagnosis=reason;current.error={code:'TRANSACTION_REVERTED',...reason};this.write(current);}).catch(()=>{});break;}
    try{if(entry.step.kind==='approve'){
     this.primeOpeningRefresh(o,entry,plan);
     if(entry.step.approvalType==='infinity-permit2')await verifyInfinityAllowance(this.rpc,entry.step,plan,originalRead);
     else{const [allowance]=await originalRead(()=>read(this.rpc,entry.step.to,ERC20,'allowance',[plan.wallet,entry.step.spender]));if(allowance<BigInt(entry.step.allowance))throw Error('当前授权额度不足，后续步骤未执行');}
    }else if(settlements[entry.step.tradeLeg?.settlementRoute||plan.route]){
     try{
      const leg=tradeLegPlan(plan,entry.step);
      entry.settlement=settlements[leg.route]({receipt,wallet:leg.wallet,token:leg.token,side:o.intent.side,state:leg.state,plan:leg,step:entry.step});
      if(entry.settlement.amountOut<BigInt(leg.minOutput||0)||entry.settlement.amountIn!==null&&entry.settlement.amountIn>BigInt(leg.amountIn))throw Error('实际成交超出本笔输入或最低到账约束');
     }catch(e){
      // Receipt success AND the exact original transaction were verified above.
      // An accounting/decoder problem is not an unknown submission. End this
      // operation without auto-retry or continuing another step, and release the
      // wallet for a new explicit action using its current balance.
      this.confirmedReview(o,entry,e);break;
     }
    }
    else if(entry.step.kind==='referral'&&plan.route==='bagent:mint'){
     await verifyBagentBinding(this.rpc,entry.step);
    }else if(entry.step.kind==='mint'&&plan.subscription?.protocol==='corla'){
     entry.settlement=corlaReceipt(receipt,plan);entry.received='1';
    }else if(entry.step.kind==='mint'&&plan.redemption?.protocol==='corla'){
     entry.settlement=corlaRefundReceipt(receipt,plan);entry.received=entry.settlement.amount;
    }else if(entry.step.kind==='mint'){
     const asset=plan.expectedAsset;const topic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';let received=0n;
     for(const log of receipt.logs||[])if(same(log.address,asset?.token||plan.token)&&log.topics?.[0]===topic&&same('0x'+log.topics[2]?.slice(-40),plan.wallet))received+=log.topics.length===4?1n:BigInt(log.data);
     if(asset?.kind==='Erc1155')received=erc1155Received(receipt.logs,asset.token,plan.wallet);
     const expected=asset?.amount?BigInt(asset.amount):1n;if(received<expected)throw Error('Mint 到账未达到预期，未继续后续步骤');entry.received=String(received);
     if(plan.route==='bagent:mint')entry.settlement=verifyBagentReceipt(receipt,plan);
     if(plan.route==='stars:mint')entry.settlement=verifyStarsReceipt(receipt,plan);
    }
    delete entry.settlementError;this.clearResolvedErrors(o);entry.status='CONFIRMED';entry.confirmedAt??=Date.now();break;
    }catch(e){if(e.code==='ORIGINAL_READ_UNAVAILABLE')throw e;this.confirmedReview(o,entry,e);break;}
   }
   if(Date.now()>=end)break;await sleep(200);
  }while(true);
 }
 follow(id,options={}){
  if(this.following.has(id))return this.following.get(id);
  const task=this.followOriginal(id,options);this.following.set(id,task);
  task.finally(()=>{if(this.following.get(id)===task)this.following.delete(id);}).catch(()=>{});return task;
 }
 recoverLate(o){
  if(o.status!=='SUBMISSION_UNKNOWN'||o.lateResponseAppliedAt||!['contract','swap'].includes(o.plan?.kind))return o;
  const contract=o.plan?.kind==='contract',entry=contract?o.steps?.at(-1):null;
  if(o.orderId||o.txHash||o.result||o.receipt||contract&&(!entry?.requestId||entry.status!=='SUBMISSION_UNKNOWN'||entry.txHash||entry.orderId||entry.result||entry.receipt||entry.submittedAt))return o;
  const event=readLate(this.data,o,entry);if(!event)return o;
  o.lateResponseAppliedAt=event.at;
  if(event.data){
   this.clearResolvedErrors(o);delete o.timing.finishedAt;
   if(contract){Object.assign(entry,{result:event.data,txHash:event.data.txHash,orderId:event.data.orderId,submittedAt:event.at,status:event.data.txHash?'PENDING':'SUBMISSION_UNKNOWN'});o.status=entry.status;}
   else{Object.assign(o,{result:event.data,txHash:event.data.txHash,orderId:event.data.orderId,status:event.data.orderId?'PENDING':'SUBMISSION_UNKNOWN'});}
   o.timing.submittedAt=event.at;o.timing.toSubmitMs=event.at-o.createdAt;
  }else if(event.error){
   const e=event.error;
   if(contract&&applyContractRefusal(o,e))return this.write(o);
   const refusal=!contract&&providerRefusal(e);
   o.error=refusal?{...e,...tradeError(e)}:{...e};if(entry)entry.error={...e};
   if(refusal||e.dispatched===false){o.status=refusal?'REJECTED':'FAILED';if(entry){entry.status='FAILED';entry.submissionOutcome={accepted:false,source:'local-wallet'};if(o.intent.side==='mint'&&o.steps.slice(0,-1).some(x=>x.status==='CONFIRMED'&&x.step.kind==='mint'))o.status='PARTIAL';}if(refusal)o.submissionOutcome=refusal;o.timing.finishedAt=event.at;}
   if(terminal.has(o.status)&&o.tracking)o.tracking={...o.tracking,state:'finished'};
  }
  return this.write(o);
 }
 async followOriginal(id,{background=false,receiptTimeoutMs=0}={}){let o=this.get(id);if(!o)throw Error('找不到订单');o=this.repairRefusal(o)||o;if(terminal.has(o.status)||['PREPARED','READY_TO_CONTINUE'].includes(o.status))return o;
  return this.exclusive(o.intent.account,async()=>{o=this.recoverLate(o);if(terminal.has(o.status))return o;const previousFollowError=o.followError;let readSucceeded=false;try{
   const readOptions={readOnlyTimeoutMs:1000,...(background?{background:true}:{})};
   o.tracking={attempts:(o.tracking?.attempts||0)+1,lastCheckedAt:Date.now(),state:'checking'};
   const query=rejectedSwapQuery(o);if(query){const result=await this.bridge.call(o.intent.account,query.args,readOptions),failed=uniqueFailedSwap(o,result,this.list());if(failed)applyFailedSwap(o,failed);}
   if(o.orderId&&!terminal.has(o.status))await this.observeSwap(o,0,readOptions);else if(!terminal.has(o.status)){
    const e=o.steps?.at(-1);if(e?.txHash){await this.observeContract(o,e,Math.min(8000,Math.max(0,Number(receiptTimeoutMs)||0)));if(e.status==='CONFIRMED'){
     o.nextStep=e.index+1;
     if(o.nextStep<o.plan.steps.length||o.intent.side==='mint'&&o.plan.fill?.continue)o.status='READY_TO_CONTINUE';else{
      if(o.intent.side==='mint'&&o.settledStage!==(o.stage||0)){o.completedQuantity=(o.completedQuantity||0)+o.plan.quantity;const key=o.plan.budgetCurrency==='QUOTE'?'quote':o.plan.budgetCurrency==='USDT'?'usdt':'bnb';o.spent??={bnb:'0',usdt:'0'};o.spent[key]=String(BigInt(o.spent[key]||'0')+BigInt(o.plan.amountIn));o.settledStage=o.stage||0;}
      this.finish(o);
     }
    }}
   }
   readSucceeded=true;
  }catch(e){o.followError=publicError(e);}
  if(readSucceeded&&previousFollowError&&o.followError===previousFollowError){o.resolvedErrors=[...(o.resolvedErrors||[]),{at:Date.now(),followError:previousFollowError}].slice(-10);delete o.followError;}
  if(o.tracking){const identified=o.orderId||o.steps?.at(-1)?.txHash;o.tracking.state=terminal.has(o.status)?'finished':o.status==='READY_TO_CONTINUE'?'awaiting-continuation':o.followError?'read-unavailable':identified?'waiting':'needs-provider-check';}
  return this.write(o);},id,{trackingOnly:true});
 }
 async run(input,id,options={}){const o=await this.prepare(input,id);return ['PREPARED','READY_TO_CONTINUE'].includes(o.status)&&options.execute?this.execute(id,options):o;}
}
