import fs from 'node:fs';
import {Interface,read,same,BNB,ZeroAddress,parseUnits,formatUnits,bindings} from './common.mjs';
import {codeIdentity} from './discovery.mjs';
import {publicText} from './network.mjs';
import {normalizeMintQuantity} from '../public/mint-quantity.mjs';

// The published deployment has no matching verified source in Sourcify.
// Limit this adapter to reviewed runtime fingerprints; official asset simulation
// remains mandatory. Website labels alone never authorize a contract call.
export const PAP=JSON.parse(fs.readFileSync(new URL('./pap-protocol.json',import.meta.url),'utf8'));
export const PAP_ABI=new Interface(PAP.abi);
const M=PAP_ABI,C=PAP.config,T=new Interface(['function sale() view returns(address)','function distributor() view returns(address)','function tradingEnabled() view returns(bool)']);
const fail=(message,code='PAP_VALIDATION_FAILED')=>Object.assign(Error(message),{code});
const min=(...n)=>n.reduce((a,b)=>a<b?a:b);
export function papInput(input){
 if([C.sale,C.token].some(a=>same(a,input)))return true;
 try{const u=new URL(input);return u.protocol==='https:'&&['papagent.app','www.papagent.app'].includes(u.hostname)&&!u.username&&!u.password&&!u.port;}catch{return false;}
}
export function validatePapDeployment(text){
 if(!/##\s*Contracts\s*\(chainId\s+56\)/i.test(text))throw fail('PAPER 官网部署网络不符');
 const section=text.split(/##\s*Contracts\s*\(chainId\s+56\)/i)[1].split(/\n##\s/)[0];
 for(const key of ['sale','token','distributor']){const matches=[...section.matchAll(new RegExp('(?:^|\\n)\\s*-?\\s*'+key+'\\s*:\\s*(0x[0-9a-f]{40})(?![0-9a-f])','gi'))];if(matches.length!==1||!same(matches[0][1],C[key]))throw fail('PAPER 官网 '+key+' 部署变化，需重新核验','PAP_VERSION_CHANGED');}
}
export async function verifyPap(rpc){
 await rpc.verifyChain();
 const entries=Object.entries(PAP.identities),ids=await Promise.all(entries.map(([,v])=>codeIdentity(rpc,v.target)));
 if(ids.some((v,i)=>v.fingerprint!==entries[i][1].fingerprint))throw fail('PAPER 合约代码或代理实现已变化，需重新核验','PAP_VERSION_CHANGED');
 const [[token],[sale],[distributor],[registry]]=await Promise.all([read(rpc,C.sale,M,'token'),read(rpc,C.token,T,'sale'),read(rpc,C.token,T,'distributor'),read(rpc,C.sale,M,'AGENT_ID')]);
 if(!same(token,C.token)||!same(sale,C.sale)||!same(distributor,C.distributor)||!same(registry,'0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F'))throw fail('PAPER Sale、代币、分红或身份合约关系不符');
 return {identity:ids[0],protocolIdentities:ids.slice(1)};
}
export async function papState(rpc,w){
 const block=await rpc.getBlockNumber(),get=(name,args=[])=>read(rpc,C.sale,M,name,args,block);
 const [info,[opened],[refunding],[left],[eligible],[remaining],[used],[quota],[extra],[referrer],[launched],bnb]=await Promise.all([
  get('saleInfo'),get('saleOpen'),get('refunding'),get('remainingMints'),get('isAgentWallet',[w.address]),get('remainingFor',[w.address]),get('mintedBy',[w.address]),get('quotaOf',[w.address]),get('extraQuota',[w.address]),get('referrerOf',[w.address]),read(rpc,C.token,T,'tradingEnabled',[],block),rpc.getBalance(w.address,block)
 ]);
 const [price,units,total,base,totalTokens]=info;
 if(price!==1500000000000000n||units!==2000n*10n**18n||total!==20000n||base!==10n||totalTokens!==units*total||left>total||used>quota||quota!==base+extra||remaining!==quota-used)throw fail('PAPER 单价、发行量或额度规则与已核验部署不符');
 const available=min(remaining,left),reason=refunding?'认购已结束，项目处于退款阶段':launched?'项目已开盘，认购已结束':!left?'项目认购已售罄':!eligible?'当前钱包没有有效的 .ai Agent ID':!remaining?'当前钱包认购额度已打满':!opened?'项目尚未开放认购，请开放后重新预览':null;
 const reasonCode=refunding||launched||!left?'MINT_ENDED':!eligible?'MINT_INELIGIBLE':!remaining?'NO_QUOTA':!opened?'MINT_NOT_OPEN':null;
 return {block,price,units,remaining,used,quota,extra,referrer,available,eligible,opened,launched,refunding,left,bnb,reason,reasonCode};
}
const role=(address,label,r,primary=false)=>({address,field:label,roles:[r],verifiedRoles:[r],roleLabels:[label],primary,evidence:[{role:r,kind:'pinned-runtime',label:'官网部署与链上合约关系已核验'}]});
export async function discoverPap(rpc,input,{fetchText=publicText}={}){
 if(!papInput(input))return null;
 await Promise.all([verifyPap(rpc),fetchText(PAP.origin+'/llms.txt').then(validatePapDeployment)]);
 return {platform:'pap',name:'PAPER (PAP)',source:PAP.origin+'/',address:C.sale,mintContract:C.sale,token:C.token,assetKind:'Erc20',verifiedSource:false,needsSelection:false,addresses:[role(C.sale,'Mint / 认购入口','mint',true),role(C.token,'代币 CA','token'),role(C.distributor,'分红合约','treasury')],mintRoutes:[],discovery:{strategy:'published-deployment-runtime',historySkipped:true}};
}
export async function inspectPap(rpc,resolved,wallets){
 const quotas=await Promise.all(wallets.map(async w=>{try{const s=await papState(rpc,w),n=min(s.available,500n);return {...w,freeRemaining:'0',paidRemaining:String(s.available),used:String(s.used),extraQuota:String(s.extra),unitPriceBnb:formatUnits(s.price,18),budgetCurrency:'BNB',paymentToken:BNB,paymentDecimals:18,currency:'BNB',unitPrice:{raw:String(s.price)},phase:s.reasonCode||'OPEN',statusMessage:s.reason,eligible:s.eligible,fullBudget:{quantity:Number(n),raw:String(n*s.price),scope:'paid'},singleBudget:{quantity:1,raw:String(s.price),scope:'paid'},...(!s.eligible||s.refunding||s.launched||!s.available?{error:s.reason,errorCode:s.reasonCode}:{}),notes:['纯付费认购，无免费份额；Gas 另计。']};}catch(e){return {...w,error:e.message,errorCode:e.code};}}));
 const inviter=wallets.find(w=>w.account===1),referral=inviter?{detected:true,status:'ready',account:1,address:inviter.address,appliesTo:wallets.filter(w=>w.account!==1).map(w=>w.account),url:PAP.origin+'/?ref='+inviter.address,bindingVerified:true,note:'首次认购尝试使用 1 号邀请；未生效不影响认购，不等待其他钱包。'}:{detected:true,status:'needs-adapter',url:null,note:'未配置 1 号邀请钱包'};
 return {...resolved,budgetPolicy:'pap-fixed-quote',quotas,referral,at:Date.now()};
}
// Invites are optional in this pinned deployment: an ineligible / not-yet-minted
// referrer is ignored by the sale. Never serialize wallets to wait for a bonus.
function papReferral(intent,w,s,wallets){
 if(intent.referral!=='account1'||w.account===1)return {referral:null,note:null};
 if(!same(s.referrer,ZeroAddress))return {referral:null,note:'保留已有邀请绑定，不影响本次认购。'};
 if(s.used>0n)return {referral:null,note:'首次认购已完成，无法补绑邀请；继续认购。'};
 const inviter=wallets.find(x=>x.account===1);
 if(!inviter||same(inviter.address,w.address))return {referral:null,note:'未配置有效的 1 号邀请钱包，继续普通认购。'};
 return {referral:{address:inviter.address,account:1,optional:true,url:PAP.origin+'/?ref='+inviter.address},note:'尝试使用 1 号邀请；邀请未生效不影响认购。'};
}
export async function papPlan(rpc,intent,w,{wallets=bindings(),quantityCeiling=null}={}){
 if(intent.scope==='free')throw fail('PAPER 只有付费认购，没有免费额度；请选择全部或付费额度','NO_FREE_MINT');
 if(intent.currency!=='BNB'||intent.quoteToken)throw fail('PAPER 认购只接受 BNB');
 if(intent.routeId&&intent.routeId!=='pap:mint')throw fail('PAPER 认购入口无效','MINT_ROUTE_INVALID');
 const [proof,s]=await Promise.all([verifyPap(rpc),papState(rpc,w)]);
 if(s.reason)throw fail(s.reason,s.reasonCode);
 const full=normalizeMintQuantity(intent.quantity)==='max',requested=full?min(s.available,500n):BigInt(intent.quantity);
 if(requested<1n||requested>500n)throw fail('本次份数须为 1–500 或全部打满','MINT_QUANTITY_INVALID');
 // Full fill is an explicit balance-based instruction, not a stale UI budget.
 // A numbered order still respects its separately supplied monetary limit.
 const budget=full?requested*s.price:parseUnits(intent.maxBnb||'0',18);
 const target=min(requested,s.available,budget/s.price,quantityCeiling===null?500n:BigInt(quantityCeiling));
 if(target<1n)throw fail('费用上限不足认购 1 份，本钱包已跳过；其他钱包继续','BUDGET_LIMIT');
 const insufficient=()=>fail('BNB 余额不足认购 1 份并支付 Gas，本钱包已跳过；其他钱包继续','INSUFFICIENT_FUNDS');
 if(s.bnb<=s.price)throw insufficient();
 let {referral,note}=papReferral(intent,w,s,wallets);
 const stepFor=n=>({kind:'mint',to:C.sale,value:String(n*s.price),data:M.encodeFunctionData(referral?'mintWithReferrer':'mintMany',referral?[n,referral.address]:[n])});
 const estimate=async n=>{const step=stepFor(n);return BigInt(await rpc.send('eth_estimateGas',[{from:w.address,to:step.to,value:'0x'+BigInt(step.value).toString(16),data:step.data}]));};
 // Estimate one share before sizing the batch, so an all-balance candidate
 // cannot fail estimation for lack of gas. Exact batch gas is checked below.
 const seedEstimate=async()=>{try{return await estimate(1n);}catch(e){if(!referral||!(e.code==='CALL_EXCEPTION'||/revert/i.test(e.message||'')))throw e;referral=null;note='邀请入口估算未通过，改用普通认购。';return estimate(1n);}};
 const [seedGas,gasPrice]=await Promise.all([seedEstimate(),rpc.send('eth_gasPrice',[]).then(BigInt)]);
 if(seedGas<=0n||gasPrice<=0n)throw fail('Gas 估算无效，尚未提交','GAS_ESTIMATE_INVALID');
 let gasReserve=seedGas*gasPrice*2n,n=min(target,s.bnb>gasReserve?(s.bnb-gasReserve)/s.price:0n),step,accepted=false;
 for(let tries=0;tries<4;tries++){
  if(n<1n)throw insufficient();
  step=stepFor(n);
  // No state overrides in production. A successful return must match the
  // promised token amount; official asset simulation is additionally required.
  let result;
  try{result=await rpc.call({from:w.address,to:step.to,value:BigInt(step.value),data:step.data},s.block);}
  catch(e){
   if(!referral||!(e.code==='CALL_EXCEPTION'||/revert/i.test(e.message||'')))throw e;
   referral=null;note='邀请入口模拟未通过，已改用普通认购并重新模拟。';continue;
  }
  const method=M.parseTransaction({data:step.data}).name;
  if(M.decodeFunctionResult(method,result)[0]!==n*s.units)throw fail('PAPER 模拟到账数量与认购份数不符');
  const batchGas=await estimate(n);if(batchGas<=0n)throw fail('Gas 估算无效，尚未提交','GAS_ESTIMATE_INVALID');
  gasReserve=batchGas*gasPrice*2n;
  const affordable=s.bnb>gasReserve?(s.bnb-gasReserve)/s.price:0n;
  if(n>affordable){n=affordable;step=null;continue;}
  accepted=true;break;
 }
 if(!accepted||!step||s.bnb<n*s.price+gasReserve)throw fail('余额或 Gas 波动，本次尚未提交，请重新预览','GAS_BALANCE_LOW');
 const cost=n*s.price,out=n*s.units,limited=n<requested;
 const sizingNote=limited?`本次可认购 ${n} 份 / 目标 ${requested} 份，费用 ${formatUnits(cost,18)} BNB；已按余额、Gas 和剩余额度缩减，其他钱包继续。`:null;
 return {kind:'contract',route:'pap:mint',token:C.token,wallet:w.address,inputToken:BNB,outputToken:C.token,amountIn:String(cost),minOutput:String(out),quantity:Number(n),...proof,metaVerified:false,requireAssetCredit:true,expectedAsset:{token:C.token,kind:'Erc20',amount:String(out)},budgetCurrency:'BNB',quota:{remaining:String(s.available),used:String(s.used),extra:String(s.extra)},referral,fill:{continue:false},pap:{used:String(s.used),gasReserve:String(gasReserve),full,requestedQuantity:Number(requested),limited,sizingNote},review:['PAPER 当前部署未取得匹配的公开验证源码；已固定代码并核验关系，仍须官方资产模拟。',...[sizingNote,note].filter(Boolean)],steps:[step]};
}
export async function refreshPapMint(rpc,plan,intent,{wallets=bindings()}={}){
 const w=wallets.find(w=>w.account===intent.account);if(!w||!same(w.address,plan.wallet))throw fail('钱包绑定已变化，请重新预览');
 // Recheck affordability inside the account lock, but never increase an
 // already reviewed payment / quantity or mint again after a changed counter.
 const fresh=await papPlan(rpc,intent,w,{wallets,quantityCeiling:plan.quantity});
 if(BigInt(fresh.amountIn)>BigInt(plan.amountIn)||fresh.quantity>plan.quantity||fresh.pap.used!==plan.pap.used||!same(fresh.token,plan.token)||!same(fresh.steps[0].to,plan.steps[0].to)||fresh.identity.fingerprint!==plan.identity.fingerprint)throw fail('PAPER 已认购份数或交易目标发生变化，请重新预览');
 return {...fresh,project:plan.project,resolved:plan.resolved};
}
