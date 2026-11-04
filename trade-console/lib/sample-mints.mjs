// Pinned runtime identities. Matching source is interface evidence, never a safety audit.
import {Interface,keccak256,toUtf8Bytes,ZeroAddress} from 'ethers';
import {read,BNB,USDT,ERC20,wallet,same,parseUnits} from './common.mjs';
import {chooseBatch,min,positive} from './mint-policy.mjs';
import {bnbullState} from './bnbull-mint.mjs';
export const samples={
 'fe1cb472ce8a465d745bc83208bcf628ee70221026220b1c5ebf3749ed9250a5':'bnbull',
 '4aabe4a4705f20de506001da67bea68e022c81e74d196a3c13e268c3a9d9a2d4':'burn',
 '1d6d6a0d14b1bf6d5663b47171e6551c06e31527d94506eae2004bca3afef15a':'ikigai',
 '2815d4f17d613c397b11442b480bf9e0a3dabe6bca46587d06add548bf77414a':'pixel',
 '6953a57c0b2af386e961306ce52d11534fc52cb6d16355e23ca603a053c5d611':'rush',
 'c6d2f400415422c0afcf27ca1e8aaf1a4ad6b464ff2ee43c16cd2db1d270e085':'unbroken',
 '58a538985a34cd6d0871b1d420880d191cddff5cc0a355cbb6d336a717b5257a':'muse',
 'e68b68dee6eced9ff1d13403794e95936ec6d606b73eb9d0ce7efc751e22aefb':'jin',
 'f6a08600b5af3accfd07c011237d88960188758d8f990e7928aedea07cbc592d':'qagent',
 '7c4f4fab9a92c658aaa8d1061c75ab681556a2d5787326504ef405c0c3fca27f':'yyds',
 '4bbaffbd9def81215780787769728d0435a0448a500c5167e869ec5d0074a20f':'shaling',
 'c362166e2e427e3687a9f240969d06ec4a4cad8fcbbc664eabc111bb8f672984':'slime',
 '6c79507e6ab890d03b6893fb8738df75c96e31d8daa330cfe35bfaa145afb3cb':'dino',
 'bd4d2d9929b1ee458954726b6d7171a35ead2097fe6f1caf13c2b23d5b1d45a4':'fox',
 '38a281e9c50e8b8ed03a71625306b3fa8e44027506f29f655e1064f35d92ea07':'agc'
};
export function agentHandle(a){const candidates=[a?.agentId?.domain,a?.agentId?.name,a?.domain,a?.name,a?.handle,a?.agentName,a?.agentId];const h=candidates.find(x=>typeof x==='string'&&/^[a-zA-Z0-9_-]+(?:\.ai)?$/.test(x));if(!h)throw Error('钱包未返回可核验的 Agent ID 名称');return h.replace(/\.ai$/,'');}
const domains={burn:'burnagent.fun',ikigai:'ikigai-mint.netlify.app',yyds:'yydsgoat.onrender.com',shaling:'shalinggou.onrender.com',agc:'agcc.fun'};
export async function sampleState(rpc,bridge,i,meta,w){
 const name=samples[meta.hash];if(!name)return null;
 if(!meta.verified)throw Error('样本适配要求当前源码与运行代码匹配');
 const abi=new Interface(meta.abi),block=await rpc.getBlockNumber();
 const get=(method,args=[])=>read(rpc,meta.address,abi,method,args,block);
 const one=async(method,args=[])=> (await get(method,args))[0];
 const build=(method,args,cost)=>({kind:'mint',to:meta.address,data:abi.encodeFunctionData(method,args),value:String(cost)});
 const result=(method,args,cost,out,value=cost)=>({cost,out,step:build(method,args,value)});
 const s={name,free:0n,paid:0n,txCap:500n,token:meta.address,assetKind:['pixel','unbroken','muse','slime','fox'].includes(name)?'Erc721':'Erc20',inputToken:BNB,notes:[],block};
 const handle=async account=>agentHandle(await bridge.call(account,['wallet','agent-id']));
 const idOf=async account=>BigInt(keccak256(toUtf8Bytes(await handle(account))));
 let ref=ZeroAddress,refId=0n;
 const hasReferral=['burn','ikigai','yyds','shaling','dino','agc'].includes(name);
 if(hasReferral){
  const inviter=wallet(1);refId=await idOf(1);
  const url=domains[name]?`https://${domains[name]}/?ref=${name==='burn'?refId:name==='agc'?(await handle(1))+'.ai':inviter.address}`:null;
  s.referral={detected:true,account:1,address:inviter.address,url,appliesTo:[2,3],bindingVerified:name!=='agc',active:i.referral!=='none',valueKind:name==='burn'?'agentId':name==='agc'?'domain':'address',linkValue:name==='burn'?String(refId):name==='agc'?(await handle(1))+'.ai':inviter.address,note:name==='agc'?'首次 mint 绑定，推荐人须先 mint 过':name==='ikigai'?'首次付费 mint 计入邀请，1 号须先 mint 过':'邀请由合约条件决定；免费领取通常不计入邀请'};
  if(i.referral!=='none'&&[2,3].includes(i.account))ref=inviter.address;
 }
 if(name==='bnbull'){
  await bnbullState({rpc,i,w,s,get,one,result,handle});
 }else if(name==='burn'){
  const id=await idOf(i.account);
  const [quota,used,max,total,supply,collection,freeUsed,freeTotal,freeMax]=await Promise.all([one('quotaOf',[id]),one('mintedById',[id]),one('MAX_PER_TX'),one('totalMinted'),one('MAX_SHARES'),one('idCollection'),one('freeClaimed',[id]),one('freeMinted'),one('FREE_SHARES')]);
  const ownerAbi=new Interface(['function ownerOf(uint256) view returns(address)']);
  if(!same((await read(rpc,collection,ownerAbi,'ownerOf',[id],block))[0],w.address))throw Error('Agent ID 所有者与当前钱包不一致');
  if(ref!==ZeroAddress&&!same((await read(rpc,collection,ownerAbi,'ownerOf',[refId],block))[0],ref))throw Error('1 号 Agent ID 所有权不匹配');
  const cap=positive(min(quota-used,supply-total));s.free=!freeUsed&&freeTotal<freeMax&&cap?1n:0n;s.paid=cap-s.free;s.txCap=max;s.mixed=true;
  const b=await rpc.send('eth_getBlockByNumber',['0x'+block.toString(16),false]),deadline=BigInt(b.timestamp)+120n;
  const first=await one('firstPaid',[id]);
  s.quote=async n=>{const [cost,tokens]=await get('quoteFor',[id,n]),out=tokens*BigInt(10000-i.slippageBps)/10000n;const referred=ref!==ZeroAddress&&cost>0n&&!first;return result(referred?'mintWithInviter':'mint',[id,n,total+1n,out,deadline,...(referred?[refId]:[])],cost,out);};
 }else if(name==='ikigai'||name==='jin'){
  const h=await handle(i.account),e=await get('eligibility',[w.address,h]);
  if(name==='ikigai'){
   if(!e[0])throw Error('项目未认可此钱包 Agent ID');
   s.free=e[2]?1n:0n;s.paid=e[3];s.txCap=await one('MAX_PER_TX');s.token=await one('token');
   const per=await one('TOKENS_PER_SHARE');
   if(ref!==ZeroAddress){const joined=await one('agentOfWallet',[ref]);s.referral.ready=joined!==0n;if(!joined)s.referral.blocked='1 号尚未在本项目 mint，先完成 1 号才能有效邀请 2、3 号';}
   s.quote=async(n,lane)=>{if(lane==='free')return result('mintFree',[h],0n,per);if(s.referral?.blocked)throw Error(s.referral.blocked);return result('mintPaid',[n,h,ref],await one('quote',[n]),n*per);};
  }else{
   if(BigInt(e[0])===0n)throw Error('项目未认可此钱包 Agent ID');s.free=e[1];s.paid=e[2];s.txCap=9n;
   const [price,per]=await Promise.all([one('PRICE'),one('TOKENS_PER_UNIT')]);
   s.quote=async(n,lane)=>lane==='free'?result('claimFree',[h],0n,per):result('paidMint',[n,h],n*price,n*per);
  }
 }else if(name==='rush'){
  const [remaining,opened,token,per]=await Promise.all([one('remainingOf',[w.address]),one('opened'),one('token'),one('B')]);s.token=token;s.paid=remaining;
  s.quote=async n=>result(opened?'mint2':'buy',[n],await one(opened?'quote2':'quoteCost',[n]),n*per);
  if(remaining&&(await s.quote(1n)).cost===0n){s.free=1n;s.paid=remaining-1n;s.mixed=true;}
  s.notes.push('基础代币立即到账；reveal 与奖励领取须另行操作');
 }else if(name==='pixel'){
  const [left,max,stock,free,price,paid]=await Promise.all([one('walletRemaining',[w.address]),one('MAX_MINT_PER_TRANSACTION'),one('remainingSupply'),one('walletFreeRemaining',[w.address]),one('mintPrice'),one('walletPaidRemaining',[w.address])]);
  s.free=min(free,left,stock);s.paid=positive(min(paid,left-s.free,stock-s.free));s.txCap=max;s.mixed=true;
  s.quote=async n=>result('mint',[n],(n-min(n,s.free))*price,n);
 }else if(['muse','unbroken','slime'].includes(name)){
  let cap;
  if(name==='slime'){
   const status=await get('mintStatus',[w.address]);cap=min(status[4],positive(status[7]-status[6]));s.txCap=await one('MAX_BATCH');
   if(!status[0]||!status[1])s.blocked='Mint 未开放或钱包不符合项目资格';
   s.quote=async n=>{const q=await get('quote',[w.address,n]);return result('mint',[n],q[1],n);};
  }else{
   const [max,used,supply,minted]=await Promise.all([one(name==='muse'?'maxPerWallet':'MAX_PER_WALLET'),one('mintedBy',[w.address]),one(name==='muse'?'maxSupply':'MAX_SUPPLY'),one('totalMinted')]);cap=positive(min(max-used,supply-minted));
   s.quote=async n=>{const q=await get(name==='muse'?'quote':'mintPrice',[w.address,n]);return result('mint',[n],q[name==='muse'?1:0],n);};
  }
  s.free=cap&&(await s.quote(1n)).cost===0n?1n:0n;s.paid=cap-s.free;s.mixed=true;
 }else if(name==='qagent'){
  const [free,paid,per,token,pay,price,stock,minted]=await Promise.all([one('freeAvailable',[w.address]),one('paidRemainingFor',[w.address]),one('TOKENS_PER_SHARE'),one('token'),one('usdt'),one('PRICE'),one('MAX_SHARES'),one('sharesMinted')]);
  if(!same(pay,USDT))throw Error('付款币与已核验 BSC USDT 不一致');s.inputToken=USDT;s.token=token;s.free=free&&stock>minted?1n:0n;s.paid=min(paid,positive(stock-minted-s.free));s.mixed=true;
  s.quote=async n=>{const paid=n-min(n,s.free);return result('mint',[paid],paid*price,n*per,0n);};
 }else if(name==='dino'){
  const [q,fs,fm,ps,pm,price,per]=await Promise.all([get('quota',[w.address]),one('FREE_SHARES'),one('freeMinted'),one('PAID_SHARES'),one('paidMinted'),one('PRICE'),one('SHARE')]);
  if(!q[0])throw Error('钱包不具备项目认可的 Agent ID');s.free=!q[1]&&fm<fs?1n:0n;s.paid=positive(min(q[3]-q[2],ps-pm));
  if(ref!==ZeroAddress&&!(await get('quota',[ref]))[0])throw Error('1 号不具备有效邀请身份');
  s.quote=async(n,lane)=>lane==='free'?result('claimFree',[],0n,per):result('mintPaid',[n,ref],n*price,n*per);
 }else if(name==='fox'){
  const [freeUsed,freeLeft,paidLeft,max,price,freeOpen,paidOpen]=await Promise.all([one('freeMinted',[w.address]),one('freeRemaining'),one('paidRemaining'),one('MAX_PAID_PER_TX'),one('PAID_PRICE'),one('freeOpen'),one('paidOpen')]);
  s.free=!freeUsed&&freeLeft&&freeOpen?1n:0n;s.paid=paidOpen?paidLeft:0n;s.txCap=max;s.unboundedPaid=true;
  s.notes.push('付费没有每钱包限额；paidRemaining 是全局库存，打满须改为明确份数');
  s.quote=async(n,lane)=>lane==='free'?result('freeMint',[],0n,1n):result('mint',[n],n*price,n);
 }else if(name==='yyds'||name==='shaling'){
  const a=name==='yyds';const [p,total,freeMax,max,ceiling,freePer,per,kickoff]=await Promise.all([get(a?'playerInfo':'accountInfo',[w.address]),one(a?'ticketsOut':'sharesSold'),one(a?'GRATIS_TICKETS':'GIFT_SHARES'),one(a?'PER_CALL_MAX':'TX_LIMIT'),one(a?'TICKET_CEILING':'MAX_SHARES'),one(a?'GRATIS_UNITS':'GIFT_AMOUNT'),one(a?'TICKET_UNITS':'SHARE_AMOUNT'),one(a?'KICKOFF_TICKET':'LAUNCH_AT')]);
  if(!p[0])throw Error('钱包不具备项目认可的 Agent ID');s.token=await one(a?'coin':'dog');s.free=!p[5]&&total<freeMax?1n:0n;s.paid=total>=freeMax?positive(min(p[3]-p[2],ceiling-total)):0n;s.txCap=max;
  if(ref!==ZeroAddress){const sponsor=await get(a?'playerInfo':'accountInfo',[ref]);s.referral.ready=!!sponsor[0]&&sponsor[1]!==p[1];if(!s.referral.ready)throw Error('1 号邀请身份无效或与当前钱包共用同一 Agent ID');s.referral.alreadyPaid=!!p[4];if(p[4])s.notes.push('此钱包已完成首次付费，后续 mint 不会再次产生邀请奖励');}
  if(total<freeMax)s.notes.push('项目尚处全局免费阶段，付费额度暂不可用');
  // Post-launch mint buys against project reserves; this contract exposes no min-token parameter.
  if(total>=kickoff)s.notes.push('开盘后份额按储备换算；合约只能限制最高成本，无法锁定最低代币到账');
  s.quote=async(n,lane)=>{if(lane==='free')return result(a?'mintGratis':'takeGift',[],0n,freePer);const cost=await one(a?'priceOf':'quote',[n]);return result(a?'mintTickets':'buy',[n,ref,cost],cost,total+n<=kickoff?n*per:1n);};
 }else if(name==='agc'){
  const q=(await get('quota',[w.address,1n]))[0];s.token=await one('agc');s.free=0n;s.paid=q.bLeft;
  s.deposit={shares:String(q.aLeft),unitBnb:String(await one('PRICE_PER_SHARE')),refundableAfterSeconds:String(await one('REFUND_DELAY'))};
  s.blocked='该项目 A「免费」需要 BNB 押金且延后领取，B 是锁定 LP；不能按普通零费用 Mint 执行。须单独适配押金与持仓回执';
 }
 s.free=positive(s.free);s.paid=positive(s.paid);
 s.info={...s.extraInfo,freeRemaining:String(s.free),paidRemaining:String(s.paid),paidIsGlobalInventory:!!s.unboundedPaid,maxPerTransaction:String(s.txCap),mixed:!!s.mixed,currency:same(s.inputToken,USDT)?'USDT':'BNB',block,deposit:s.deposit,notes:s.notes,blocked:s.blocked};
 return s;
}
export async function samplePlan(rpc,bridge,i,meta,budget,w){
 const s=await sampleState(rpc,bridge,i,meta,w);if(!s)return null;
 const paymentIsUsdt=same(s.inputToken,USDT),limit=paymentIsUsdt?parseUnits(i.maxUsdt||'0',18):budget;
 const q=await chooseBatch(s,i,limit),steps=[];
 if(paymentIsUsdt&&q.cost>0n){
  const [allowed]=await read(rpc,USDT,ERC20,'allowance',[w.address,meta.address]);
  if(allowed<q.cost){if(allowed!==0n)throw Error('当前 USDT 授权非零且不足，需先明确处理旧授权');steps.push({kind:'approve',to:USDT,spender:meta.address,allowance:String(q.cost),value:'0',data:ERC20.encodeFunctionData('approve',[meta.address,q.cost])});}
 }
 // An eth_call cannot apply a preceding approval; official approval preview comes first.
 if(!steps.length)try{await rpc.call({to:q.step.to,from:w.address,data:q.step.data,value:BigInt(q.step.value)});}catch(e){
  const hex=String(e.message).match(/0x[0-9a-fA-F]{8,}/)?.[0];let name;try{name=new Interface(meta.abi).parseError(hex)?.name;}catch{}
  throw Error('合约模拟拒绝：'+(name||e.message));
 }
 steps.push(q.step);
 return {kind:'contract',route:'sample:'+s.name,token:s.token,wallet:w.address,amountIn:String(q.cost),inputToken:s.inputToken,outputToken:s.token,minOutput:String(q.out),quantity:Number(q.n),identity:meta.identity,
  review:['只完成接口兼容与模拟检查，尚未完成安全审计',...s.notes],expectedAsset:{token:s.token,kind:s.assetKind,amount:String(q.out)},steps,metaVerified:true,
  quota:s.info,referral:s.referral,fill:{continue:q.continue,remainingBefore:String(q.remaining),lane:q.lane},quote:{cost:String(q.cost),currency:paymentIsUsdt?'USDT':'BNB',quantity:Number(q.n),block:s.block},budgetCurrency:paymentIsUsdt?'USDT':'BNB'};
}
