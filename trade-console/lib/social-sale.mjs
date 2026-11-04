import {Interface,keccak256,toUtf8Bytes,ZeroAddress} from 'ethers';
import parser from '@solidity-parser/parser';
import {createHash} from 'node:crypto';
import {BNB,USDT,ERC20,parseUnits,formatUnits,same,wallet} from './common.mjs';
import {runtimeShape} from './bytecode.mjs';
import {chooseBatch,min,positive} from './mint-policy.mjs';
import {validateSiteProof} from './site-proof.mjs';

// Source-body families, not a domain/address allowlist. Current deployment,
// identity, price and quota are always reread; signatures are never learned.
const families={
 'identity-voucher-sale':{
  methods:['mint(uint256)','claimFreeWithVoucher(uint256,bytes32,bytes32,uint256,bytes)','userInfo(address)','info()','paused()','balanceOf(address)','tokensPerShare()'],
  bodies:{userInfo:'094635b45fb9c9c25009e15a506f691afce21fefd5c841d31c35e3687e7d1644',claimFreeWithVoucher:'7068dc8893770f8e9eae6cedcc512a1aa6d7c7eae308e7f195b27d722c0d3976',mint:'6fecf3d665992319949e796f8d38e939c0c459ff2565ba9c822f4f5e70cab62d',_distribute:'53e5f020960f9fa2e992d40032d039376445d4e5451fb84e04fd1e655f313750'}
 },
 'social-quota-sale':{
  methods:['mint(uint256,address,uint256)','mintWithBnb(uint256,address,uint256)','freeMint(bytes32,uint256,bytes)','freeMintDone(uint256,bytes32)','FREE_MINT_REPOST_COMMENT()','FREE_MINT_AVATAR()','registrar()','quotaOf(uint256)','mintedCount(uint256)','costOf(uint256)','bnbQuote(uint256)','USER_SHARE()','TOTAL_SHARES()','MAX_PER_TX()','totalMinted()','paused()','token()','usdt()','paidOnce(uint256)'],
  bodies:{_agent:'a2d41d44312e9201611ee93bd55ab902987d9689f4a2115e4f8401fae1792207',_creditInvite:'2d87503ffd462f07411d68098856ca0177df5dccfea58b371fb1aa7092598e2f',mint:'338254b150249c86d8f2afd7a141f68d182527a3405d5f910badc8f225b02e16',freeMint:'e3cc3f4cf6039bbd7f17efac45db5cb6191d103fb30c3616ee86615ded40e2b1',mintWithBnb:'a7683620856766d20df172fbdb239b381943e16293dc1407b8a42a4910ee47c3',_check:'23083f97c3db73ca041f1eacb6387f5aeca40039f69b5e0bc16d75af5588eadf',_mintShares:'23b3c683d3f049d8763d912f275fb13a7b9e01bd5b47409074277f6080e3c3fd'}
 }
};
const recognized=new WeakMap();
export function recognizeSocialSale(meta){
 if(recognized.has(meta))return recognized.get(meta);
 let result=null;
 if(meta.verified&&!meta.proxy&&!meta.identity?.implementation&&!runtimeShape(meta.runtimeCode).delegate){
  const abi=new Interface(meta.abi),shape=runtimeShape(meta.runtimeCode);
  const possible=Object.entries(families).filter(([,f])=>f.methods.every(m=>{const fn=abi.getFunction(m);return fn&&shape.selectors.has(fn.selector);}));
  if(possible.length===1){const [kind,f]=possible[0];
   for(const source of Object.values(meta.sources||{}))try{
    parser.visit(parser.parse(source.content),{ContractDefinition(c){const functions=c.subNodes.filter(n=>n.type==='FunctionDefinition'&&n.body);
     if(Object.entries(f.bodies).every(([name,h])=>functions.some(n=>n.name===name&&createHash('sha256').update(JSON.stringify(n.body)).digest('hex')===h)))result={kind,abi:meta.abi};
    }});
   }catch{}
  }
 }
 recognized.set(meta,result);return result;
}
const stop=(code,message,details)=>{throw Object.assign(Error(message),{code,details});};
export async function socialSaleState(rpc,intent,meta,w,profile=recognizeSocialSale(meta)){
 if(!profile)return null;
 const abi=new Interface(profile.abi),block=await rpc.getBlockNumber(),header=await rpc.send('eth_getBlockByNumber',['0x'+block.toString(16),false]),now=BigInt(header.timestamp);
 const call=async(to,iface,name,args=[])=>{const raw=await rpc.call({to,from:w.address,data:iface.encodeFunctionData(name,args)},block),v=iface.decodeFunctionResult(name,raw);if(iface.encodeFunctionResult(name,v).toLowerCase()!==raw.toLowerCase())throw Error('发售数据格式不规范：'+name);return v.length===1?v[0]:v;};
 const get=(name,args=[])=>call(meta.address,abi,name,args);
 const s={name:profile.kind,token:meta.address,assetKind:'Erc20',free:0n,paid:0n,txCap:500n,inputToken:BNB,block,abi,get,call,now,info:{block,currency:'BNB',freeRequiresProof:true}};
 const blocked=(code,message)=>{s.blockedCode=code;s.blocked=message;};
 const step=(name,args,value)=>({kind:'mint',to:meta.address,data:abi.encodeFunctionData(name,args),value:String(value)});
 if(profile.kind==='identity-voucher-sale'){
  const [info,user,paused,stock]=await Promise.all([get('info'),get('userInfo',[w.address]),get('paused'),get('balanceOf',[meta.address])]);
  if(info.price<=0n||info.tokensPerShare<=0n||info.sold+info.freeClaimed>info.maxShares||info.freeClaimed>info.freeShares)throw Error('发售计数或价格不一致');
  s.agentId=user.id;s.units=info.tokensPerShare;
  const global=min(info.maxShares-info.sold-info.freeClaimed,stock/info.tokensPerShare);
  s.free=user.id&&!user.freeClaimed&&info.freeClaimed<info.freeShares?min(1n,global):0n;
  s.paid=user.id?min(user.remaining,global):0n;
  if(info.phase===3n||info.phase===4n||now>info.deadline)blocked('MINT_ENDED',info.phase===3n?'项目已经开池，铸造阶段已结束':info.phase===4n?'项目处于退款阶段，不能继续铸造':'铸造截止时间已到');
  else if(info.phase!==1n)blocked('MINT_NOT_OPEN','铸造阶段尚未开放');
  else if(paused)blocked('MINT_PAUSED','合约已暂停铸造');
  else if(user.id===0n)blocked('MINT_INELIGIBLE','当前钱包没有项目要求的 Agent ID');
  s.info={...s.info,phase:Number(info.phase),deadline:String(info.deadline),unitPriceBnb:formatUnits(info.price,18),globalRemaining:String(global),globalFreeRemaining:String(info.freeShares-info.freeClaimed),freeClaimed:user.freeClaimed,agentId:String(user.id),proofKind:'social-voucher',proofRequirement:'免费领取需要本人完成官网 X 发帖验证并取得绑定本钱包的签名凭证'};
  s.quote=async(n,lane)=>{if(lane==='free'){const p=s.proof;return {cost:0n,out:info.tokensPerShare,step:step('claimFreeWithVoucher',[user.id,p.xUsernameHash,p.xPostIdHash,BigInt(p.voucherDeadline),p.signature],0n)};}const cost=n*info.price;return {cost,out:n*info.tokensPerShare,step:step('mint',[n],cost)};};
 }else{
  const [reg,token,pay,total,max,cap,units,paused,tasks]=await Promise.all([get('registrar'),get('token'),get('usdt'),get('totalMinted'),get('TOTAL_SHARES'),get('MAX_PER_TX'),get('USER_SHARE'),get('paused'),Promise.all(['FREE_MINT_REPOST_COMMENT','FREE_MINT_AVATAR'].map(n=>get(n)))]);
  if(!same(pay,USDT)||total>max||!units||!cap)throw Error('社交铸造的付款币、计数或额度未核验');
  const registry=new Interface(['function handleOf(address) view returns(string)','function ownerOf(uint256) view returns(address)']);
  const identity=async a=>{const label=await call(reg,registry,'handleOf',[a]);if(!label||label.length>256)return null;const id=BigInt(keccak256(toUtf8Bytes(label)));return same(await call(reg,registry,'ownerOf',[id]),a)?id:null;};
  const id=await identity(w.address);s.agentId=id;s.identityFor=identity;s.token=token;s.units=units;s.txCap=cap;
  const [limit,used,done,paidOnce]=id?await Promise.all([get('quotaOf',[id]),get('mintedCount',[id]),Promise.all(tasks.map(t=>get('freeMintDone',[id,t]))),get('paidOnce',[id])]):[0n,0n,tasks.map(()=>false),false];
  const room=min(positive(limit-used),max-total);s.tasks=tasks.filter((t,i)=>!done[i]);s.free=min(room,BigInt(s.tasks.length));s.paid=room;
  if(total===max)blocked('NO_QUOTA','项目的铸造总份额已用完');else if(paused)blocked('MINT_PAUSED','合约已暂停铸造');else if(!id)blocked('MINT_INELIGIBLE','当前钱包没有项目要求的 Agent ID');
  s.info={...s.info,agentId:id?String(id):null,sharedRemaining:String(room),globalRemaining:String(max-total),paidOnce,proofKind:'social-task',tasks:s.tasks,proofRequirement:'免费份额需要本人完成官网社交任务并取得绑定钱包、Agent ID 和任务的签名凭证；未领取不代表已完成任务'};
  s.quote=async(n,lane)=>{
   if(lane==='free')return {cost:0n,out:units,step:step('freeMint',[s.proof.task,id,s.proof.signature],0n)};
   const cost=await get(s.inputToken===USDT?'costOf':'bnbQuote',[n]);if(cost<=0n)throw Error('付费报价无效');
   return {cost,out:n*units,step:step(s.inputToken===USDT?'mint':'mintWithBnb',[n,s.referrer||ZeroAddress,cost],s.inputToken===USDT?0n:cost)};
  };
 }
 s.info={...s.info,freeRemaining:String(s.free),paidRemaining:String(s.paid),blocked:s.blocked,errorCode:s.blockedCode,notes:[...(s.free>0n?[s.info.proofRequirement]:[]),...(s.info.sharedRemaining?['免费与付费共用个人总额度，不能将两个余量相加；完成免费后会重读付费余量。']:[])]};return s;
}
export function socialSaleReferral(state){
 if(state.name!=='social-quota-sale'||!state.agentId)return null;
 const inviter=wallet(1);return {detected:true,account:1,address:inviter.address,appliesTo:[2,3],valueKind:'address',linkValue:inviter.address,bindingVerified:true,bindingRule:'first-paid',note:'已核验 1 号身份及合约邀请参数；2、3 号首次付费可使用，免费领取不绑定邀请。'};
}
export async function socialSalePlan(rpc,intent,meta,w,resolved,profile=recognizeSocialSale(meta)){
 if(!profile)return null;const s=await socialSaleState(rpc,intent,meta,w,profile);
 if(s.blocked)stop(s.blockedCode,s.blocked,s.info);
 if(intent.scope==='free'&&s.free===0n)stop('NO_QUOTA',s.info.globalFreeRemaining==='0'?'项目的免费池已领完；付费额度独立，不会自动切换付费':'当前钱包没有剩余免费份额',{quota:s.info});
 const free=intent.scope!=='paid'&&s.free>0n;
 const method=free?profile.kind==='identity-voucher-sale'?'claimFreeWithVoucher(uint256,bytes32,bytes32,uint256,bytes)':'freeMint(bytes32,uint256,bytes)':profile.kind==='identity-voucher-sale'?'mint(uint256)':parseUnits(intent.maxBnb||'0',18)>0n?'mintWithBnb(uint256,address,uint256)':'mint(uint256,address,uint256)';
 if(intent.routeId&&!['social:'+method,'auto:'+method,method].includes(intent.routeId))stop('MINT_ROUTE_INVALID','所选铸造入口与当前范围不一致，请重新预览');
 if(free){
  const p=intent.siteProof;
  if(!p)stop('SITE_PROOF_REQUIRED',s.info.proofRequirement,s.info);
  validateSiteProof(p);
  if(p.kind!==s.info.proofKind||!same(p.wallet,w.address)||BigInt(p.agentId)!==s.agentId)stop('SITE_PROOF_INVALID','免费凭证不属于当前钱包、Agent ID 或接口类型');
  if(p.kind==='social-voucher'){
   if(BigInt(p.voucherDeadline)<s.now)stop('SITE_PROOF_INVALID','免费凭证已过期');
   if((await Promise.all([s.get('usedXUsername',[p.xUsernameHash]),s.get('usedXPost',[p.xPostIdHash])])).some(Boolean))stop('NO_QUOTA','此 X 账号或帖子对应的免费凭证已使用');
  }else{
   if(!s.tasks.some(t=>same(t,p.task)))stop('SITE_PROOF_INVALID','该任务不存在或本 Agent ID 已领取');
   if(intent.quantity==='max'&&s.free>1n)stop('SITE_PROOF_REQUIRED','当前提供了一个任务的凭证；还有其他任务额度，不能将一份凭证当作全部打满。可明确铸造 1 份。',s.info);
  }
  s.proof=p;s.txCap=1n;
 }else if(profile.kind==='social-quota-sale'){
  s.inputToken=parseUnits(intent.maxBnb||'0',18)>0n?BNB:USDT;s.info.currency=s.inputToken===USDT?'USDT':'BNB';
 }
 if(profile.kind==='social-quota-sale'){
  const inviter=wallet(1),use=!free&&!s.info.paidOnce&&intent.referral==='account1'&&[2,3].includes(intent.account);
  if(use){const id=await s.identityFor(inviter.address);if(!id||id===s.agentId)stop('REFERRAL_NOT_VERIFIED','1 号邀请身份无效或与当前钱包是同一 Agent ID');s.referrer=inviter.address;}
  s.referral={detected:true,account:1,address:inviter.address,appliesTo:[2,3],valueKind:'address',linkValue:inviter.address,bindingVerified:true,bindingRule:'first-paid',callValue:s.referrer||ZeroAddress,active:!free&&!s.info.paidOnce,note:free?'免费入口不绑定邀请；首次付费时才给有效邀请人增加额度':'首次付费使用 1 号地址；邀请奖励仍以实际链上结果为准'};
 }else if(resolved.referralHints?.detected&&intent.referral==='account1'&&[2,3].includes(intent.account))stop('REFERRAL_NOT_VERIFIED','网站提示邀请，但当前发售合约未核验邀请绑定');
 const budget=parseUnits(s.inputToken===USDT?intent.maxUsdt||'0':intent.maxBnb||'0',18);
 // Free and paid consume a shared quota in social-quota-sale; choose one lane
 // now and reread the remaining quota before a subsequent operation.
 const state=intent.scope==='all'&&profile.kind==='social-quota-sale'?{...s,paid:positive(s.paid-s.free)}:s;
 const q=await chooseBatch(state,intent,budget),steps=[];
 if(s.inputToken===USDT&&q.cost>0n&&await s.call(USDT,ERC20,'allowance',[w.address,meta.address])<q.cost)steps.push({kind:'approve',to:USDT,value:'0',data:ERC20.encodeFunctionData('approve',[meta.address,q.cost]),spender:meta.address,allowance:String(q.cost)});
 if(!steps.length)await rpc.call({from:w.address,to:meta.address,data:q.step.data,value:BigInt(q.step.value)},s.block);
 return {kind:'contract',route:s.name+':'+method,wallet:w.address,token:s.token,inputToken:s.inputToken,outputToken:s.token,amountIn:String(q.cost),minOutput:String(q.out),quantity:Number(q.n),identity:meta.identity,metaVerified:true,expectedAsset:{token:s.token,kind:'Erc20',amount:String(q.out)},requireAssetCredit:true,freshBeforeExecute:true,quota:s.info,referral:s.referral,review:['当前钱包的报价、额度及凭证经合约模拟核验；适配不代表项目安全审计'],fill:{continue:q.continue,lane:q.lane,remainingBefore:String(q.remaining)},budgetCurrency:s.info.currency,steps:[...steps,q.step]};
}
