import fs from 'node:fs';
import {Interface,read,same,BNB,USDT,ERC20,ZeroAddress,wallet,parseUnits,formatUnits} from './common.mjs';
import {codeIdentity} from './discovery.mjs';
import {getJson} from './network.mjs';

// This deployment is NOT source verified. The adapter is deliberately limited
// to its observed pre-opening sale, pinned runtime and official asset simulation.
export const BAGENT=JSON.parse(fs.readFileSync(new URL('./bagent-protocol.json',import.meta.url),'utf8'));
export const BAGENT_ABI=new Interface(BAGENT.abi);
const M=BAGENT_ABI,C=BAGENT.config;
const fail=(message,code='BAGENT_VALIDATION_FAILED')=>Object.assign(Error(message),{code});
const min=(a,b)=>a<b?a:b;
export function bagentInput(input){
 if([C.mint,C.token].some(a=>same(a,input)))return true;
 try{const u=new URL(input);return u.protocol==='https:'&&u.hostname==='bagent.club'&&!u.username&&!u.password&&!u.port;}catch{return false;}
}
export async function verifyBagent(rpc){
 await rpc.verifyChain();
 const entries=Object.entries(BAGENT.identities),ids=await Promise.all(entries.map(([,p])=>codeIdentity(rpc,p.target)));
 if(ids.some((v,i)=>v.fingerprint!==entries[i][1].fingerprint))throw fail('BAGENT 合约或代理实现变化，停止并重新核验','BAGENT_VERSION_CHANGED');
 const keys=['token','stable','quote','registrar','priceOracle','router','stableV3Router','quoteStablePair'];
 const expected=[C.token,C.stable,C.bncb,C.registry,C.priceOracle,C.router,C.stableV3Router,C.quoteStablePair];
 const values=await Promise.all(keys.map(k=>read(rpc,C.mint,M,k)));
 const T=new Interface(['function minter() view returns(address)']);
 if(values.some((v,i)=>!same(v[0],expected[i]))||!same((await read(rpc,C.token,T,'minter'))[0],C.mint))throw fail('BAGENT 依赖地址或代币发行入口发生变化');
 return {identity:ids[entries.findIndex(([k])=>k==='mint')],protocolIdentities:ids.filter((_,i)=>entries[i][0]!=='mint')};
}
export async function bagentState(rpc,w){
 const block=await rpc.getBlockNumber(),get=(k,args=[])=>read(rpc,C.mint,M,k,args,block);
 const [[id,valid],[opened],[finished],[total],[openAt],[units]]=await Promise.all([get('agentOf',[w.address]),get('poolOpen'),get('finished'),get('totalMinted'),get('OPEN_AT'),get('INITIAL_PER_SHARE')]);
 if(!valid||id===0n)throw fail('本钱包没有有效 Agent ID','MINT_INELIGIBLE');
 if(finished)throw fail('BAGENT Mint 已结束','MINT_ENDED');
 if(opened||total>=openAt||openAt!==10000n||units!==2000000n*10n**18n)throw fail('本次适配仅支持已核验的开池前固定价格阶段；阶段改变需重新核验','BAGENT_PHASE_CHANGED');
 const [[quota],[used],ref,[invites],[extra]]=await Promise.all([get('quotaOf',[id]),get('mintedCount',[id]),get('referralOf',[id]),get('inviteCount',[id]),get('extraQuota',[id])]);
 if(used>quota)throw fail('BAGENT 钱包额度计数异常');
 return {block,id,valid,total,openAt,units,quota,used,remaining:quota-used,referrer:ref[0],referrerId:ref[1],invites,extra};
}
export async function discoverBagent(rpc,input){
 if(!bagentInput(input))return null;await verifyBagent(rpc);
 return {platform:'bagent',name:'BAGENT',source:BAGENT.origin+'/',address:C.mint,mintContract:C.mint,token:C.token,assetKind:'Erc20',sourceVerified:false,needsSelection:false,mintRoutes:[{id:'bagent:mint',method:'mint / mintWithBNB',label:'开池前付费 Mint'}]};
}
export async function inspectBagent(rpc,resolved,wallets){
 await verifyBagent(rpc);const quotas=await Promise.all(wallets.map(async w=>{try{const s=await bagentState(rpc,w);return {...w,paidRemaining:String(s.remaining),freeRemaining:'0',used:String(s.used),invites:String(s.invites),extraQuota:String(s.extra),referrer:s.referrer,unitPriceUsdt:'10',sourceVerified:false};}catch(e){return {...w,error:e.message,errorCode:e.code};}}));
 const ref=await getJson(BAGENT.origin+'/api/referrals/xzz.ai');
 if(!same(ref.address,wallet(1).address))throw fail('官网邀请链接与 1 号钱包不符');
 return {...resolved,quotas,referral:{detected:true,account:1,address:ref.address,appliesTo:[2,3,4],status:'ready',bindingVerified:true,url:BAGENT.origin+'/?ref=xzz.ai',valueKind:'agentId',note:'需单独绑定；满5个有效付费邀请增加1份付费额度'},at:Date.now()};
}
export function validateBagentQuote(q,{n,cost,out,nativeRequired=0n,payment,now,maxUsdt,maxBnb,slippageBps}){
 const native=payment==='BNB',method=native?'mintWithBNB':'mint';
 if(!q||q.mode!=='chain'||q.paymentToken!==payment||!same(q.stable,USDT)||BigInt(q.cost)!==cost||BigInt(q.tokens)!==out||!same(q.transaction?.to,C.mint))throw fail('官网报价与链上付款币、成本、代币数量或交易目标不一致');
 let args;try{args=M.decodeFunctionData(method,q.transaction.data);}catch{throw fail('官网交易方法不匹配');}
 if(args[0]!==n||M.encodeFunctionData(method,args).toLowerCase()!==q.transaction.data.toLowerCase())throw fail('官网份数或交易编码不规范');
 const l=args[1].toObject();
 for(const k of Object.keys(l))if(BigInt(q.limits[k])!==l[k])throw fail('官网保护参数与交易数据不一致');
 const bps=BigInt(slippageBps),cap=cost*(10000n+bps)/10000n;
 if(l.maxCost<cost||l.maxCost>cap||l.minTokens<out*(10000n-bps)/10000n||l.minTokens>out||l.minQuote<=0n||l.minBuy!==0n||l.minLpToken<=0n||l.minLpQuote<=0n||l.deadline<=now+15n||l.deadline>now+900n)throw fail('官网报价缺少有效的付款、到账、兑换或时间保护');
 let value=0n,usdDebit=cost;
 if(native){
  value=BigInt(q.transaction.value);
  const quotedRequired=BigInt(q.nativeEstimate),difference=quotedRequired>nativeRequired?quotedRequired-nativeRequired:nativeRequired-quotedRequired;
  if(q.bnbPricing!=='chainlink'||q.retainsExcessBNB!==true||nativeRequired<=0n||difference*10000n>nativeRequired*bps||BigInt(q.nativeValue)!==value||value<nativeRequired||value>(quotedRequired*(10000n+bps)+9999n)/10000n)throw fail('BNB 支付金额或链上汇率不匹配');
  // The site and RPC can observe different oracle updates. Never increase the
  // site's value; lower it to the current on-chain 1% ceiling when necessary.
  value=min(value,(nativeRequired*(10000n+bps)+9999n)/10000n);
  usdDebit=(cost*value+nativeRequired-1n)/nativeRequired;
  if(value>maxBnb)throw fail('BNB 最高付款超过本次预算','BUDGET_LIMIT');
 }else if(BigInt(q.transaction.value)!==0n)throw fail('USDT Mint 不得附带 BNB');
 if(usdDebit>maxUsdt)throw fail('本次付款折合 USDT 超出预算','BUDGET_LIMIT');
 // Stronger bounds than the website: exact USDT cost and full fixed issuance.
 l.maxCost=cost;l.minTokens=out;
 return {value,usdDebit,data:M.encodeFunctionData(method,[n,l]),limits:l};
}
export async function bagentPlan(rpc,intent,w,resolved,{officialPreview=false}={}){
 if(intent.routeId&&intent.routeId!=='bagent:mint')throw fail('BAGENT Mint 入口选择无效','MINT_ROUTE_INVALID');
 if(intent.scope==='free')throw fail('此入口是付费 Mint，无免费额度','NO_FREE_MINT');
 if(intent.slippageBps<0||intent.slippageBps>100)throw fail('BAGENT 当前适配最高允许1%滑点');
 const [proof,s]=await Promise.all([verifyBagent(rpc),bagentState(rpc,w)]);
 if(!s.remaining)throw fail('本钱包当前可用额度已打满','NO_QUOTA');
 const n=intent.quantity==='max'?min(s.remaining,500n):BigInt(intent.quantity);
 if(n>s.remaining||n<=0n)throw fail('本次份数超过当前钱包额度','NO_QUOTA');
 if(s.total+n>=s.openAt)throw fail('本批可能触发开池，超出当前已核验阶段','BAGENT_PHASE_CHANGED');
 const [[cost,out],[chainCost]]=await Promise.all([read(rpc,C.mint,M,'quoteMint',[n]),read(rpc,C.mint,M,'costOf',[n])]);
 if(cost!==n*10n**19n||chainCost!==cost||out!==n*s.units)throw fail('固定阶段价格或到账数量改变');
 const maxUsdt=parseUnits(intent.maxUsdt||'0',18),maxBnb=parseUnits(intent.maxBnb||'0',18),payment=intent.currency==='USDT'?'USDT':'BNB';
 if(cost>maxUsdt)throw fail('全部当前额度的费用超过本次预算','BUDGET_LIMIT');
 const q=await getJson(BAGENT.origin+'/api/mint/quote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({address:w.address,shares:Number(n),paymentToken:payment,slippageBps:intent.slippageBps})});
 const [header,[nativeRequired]]=await Promise.all([rpc.send('eth_getBlockByNumber',['latest',false]),payment==='BNB'?read(rpc,C.mint,M,'bnbRequired',[cost]):[0n]]);
 const checked=validateBagentQuote(q,{n,cost,out,nativeRequired,payment,now:BigInt(header.timestamp),maxUsdt,maxBnb,slippageBps:intent.slippageBps});
 const steps=[],inviter=wallet(1),useReferral=intent.referral==='account1'&&[2,3,4].includes(w.account);
 let referral=null;
 if(useReferral){
  const [[refId,valid],web]=await Promise.all([read(rpc,C.mint,M,'agentOf',[inviter.address]),getJson(BAGENT.origin+'/api/referrals/xzz.ai')]);
  if(!valid||refId===s.id||!same(web.address,inviter.address)||String(refId)!==web.agentId)throw fail('1号邀请身份不匹配');
  if(!same(s.referrer,ZeroAddress)&&(!same(s.referrer,inviter.address)||s.referrerId!==refId))throw fail('本钱包已经绑定其他邀请人，不能改绑');
  referral={address:inviter.address,agentId:String(s.id),referrerId:String(refId),url:BAGENT.origin+'/?ref=xzz.ai'};
  if(same(s.referrer,ZeroAddress))steps.push({kind:'referral',to:C.mint,value:'0',data:M.encodeFunctionData('bindReferrer',[inviter.address]),binding:referral});
 }
 const nativeBalance=await rpc.getBalance(w.address);
 if(payment==='USDT'){
  const [[balance],[allowance]]=await Promise.all([read(rpc,USDT,ERC20,'balanceOf',[w.address]),read(rpc,USDT,ERC20,'allowance',[w.address,C.mint])]);
  if(balance<cost)throw fail('USDT余额不足本次份数','BUDGET_LIMIT');
  if(allowance<cost)steps.push({kind:'approve',to:USDT,value:'0',spender:C.mint,allowance:String(cost),data:ERC20.encodeFunctionData('approve',[C.mint,cost])});
 }
 const step={kind:'mint',to:C.mint,value:String(checked.value),data:checked.data};
 if(nativeBalance<checked.value+parseUnits('0.0005',18))throw fail('BNB余额不足支付本笔及Gas预留','GAS_BALANCE_LOW');
 if(!steps.some(x=>x.kind==='approve'))await rpc.call({from:w.address,to:C.mint,data:step.data,value:checked.value});
 return {kind:'contract',route:'bagent:mint',token:C.token,wallet:w.address,inputToken:payment==='BNB'?BNB:USDT,outputToken:C.token,amountIn:String(payment==='BNB'?checked.value:cost),minOutput:String(out),quantity:Number(n),...proof,metaVerified:false,requireAssetCredit:true,expectedAsset:{token:C.token,kind:'Erc20',amount:String(out)},budgetCurrency:payment,quota:{remaining:String(s.remaining),used:String(s.used),invites:String(s.invites),extra:String(s.extra)},referral,bagent:{agentId:String(s.id),mintedBefore:String(s.used),cost:String(cost),maxUsdtDebit:String(checked.usdDebit),payment,deadline:String(checked.limits.deadline),sourceVerified:false},fill:{continue:false},review:['BAGENT Mint实现未公开验证源码；已固定当前代码与依赖，仍需官方模拟及实际到账核验。',...(payment==='BNB'?['BNB直接支付，1%报价余量会被合约收取且不退还；该余量计入本次预算。']:[])],steps:[...steps,step]};
}
export async function refreshBagentMint(rpc,plan,intent){
 const fresh=await bagentPlan(rpc,{...intent,quantity:plan.quantity},wallet(intent.account),plan.resolved);
 if(fresh.quantity!==plan.quantity||fresh.identity.fingerprint!==plan.identity.fingerprint||fresh.minOutput!==plan.minOutput||fresh.bagent.mintedBefore!==plan.bagent.mintedBefore||fresh.bagent.payment!==plan.bagent.payment||fresh.steps.some(s=>s.kind!=='mint'))throw fail('BAGENT 后续步骤的额度、邀请、授权或资产状态发生变化');
 return {...fresh,project:plan.project,resolved:plan.resolved,steps:plan.steps.map(s=>s.kind==='mint'?fresh.steps.at(-1):s)};
}
export async function verifyBagentBinding(rpc,step){
 const r=await read(rpc,C.mint,M,'referralOf',[BigInt(step.binding.agentId)]);
 if(!same(r[0],step.binding.address)||String(r[1])!==step.binding.referrerId)throw fail('邀请绑定上链结果与1号不一致');
}
export function verifyBagentReceipt(receipt,plan){
 let minted=0n,cost=0n;for(const log of receipt.logs||[]){if(!same(log.address,C.mint))continue;let e;try{e=M.parseLog(log);}catch{continue;}
  if(e?.name==='Minted'&&same(e.args.wallet,plan.wallet)&&String(e.args.agentId)===plan.bagent.agentId){if(plan.referral&&!same(e.args.referrer,plan.referral.address))throw fail('Mint 事件的邀请人不符');minted+=e.args.shares;cost+=e.args.cost;}
 }
 if(minted!==BigInt(plan.quantity)||cost!==BigInt(plan.bagent.cost))throw fail('Mint 回执份数或实际USDT成本不符');
 return {quantity:String(minted),costUsdtRaw:String(cost)};
}
