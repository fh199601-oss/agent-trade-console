import {Interface,keccak256,toUtf8Bytes} from 'ethers';
import {read,same,wallet} from './common.mjs';
import {min,positive} from './mint-policy.mjs';

// Called only after sampleState has matched the verified runtime fingerprint.
// Website labels are not sufficient evidence for choosing a payable method.
export async function bnbullState({rpc,i,w,s,get,one,result,handle}){
 const [initial,registry]=await Promise.all([one('status(address,uint256)',[w.address,0n]),one('agentId')]);
 const ownerAbi=new Interface(['function ownerOf(uint256) view returns(address)']);
 const identity=async(account,expected)=>{
  const label=(await handle(account)).toLowerCase(),id=BigInt(keccak256(toUtf8Bytes(label)));
  const [owner]=await read(rpc,registry,ownerAbi,'ownerOf',[id],s.block);
  if(!same(owner,expected))throw Error(`${account} 号 Agent ID 所有者与绑定钱包不一致`);
  return {label,id};
 };
 const own=initial.agentIds>0n?await identity(i.account,w.address):null;
 const q=own?await one('status(address,uint256)',[w.address,own.id]):initial;
 if(own&&!q.eligible)throw Error('项目未认可当前钱包的 Agent ID 所有权');
 const id=own?.id||0n;
 s.txCap=q.maxPaidPerTx;
 s.extraInfo={stage:q.launched?'post-launch':'pre-launch',agentId:own?.label||null,futureToken:s.token};
 s.referral={detected:true,account:1,address:wallet(1).address,url:null,appliesTo:[2,3],bindingVerified:true,valueKind:'label',active:!q.launched&&i.referral!=='none',note:'免费铸造不产生付费返佣；邀请奖励以合约条件为准'};
 let refId=0n;
 if(!q.launched&&i.referral!=='none'){
  const inviter=i.account===1?own:await identity(1,s.referral.address);
  if(inviter){
   s.referral.url='https://moomoo.cloud/bnbull/?ref='+encodeURIComponent(inviter.label);
   s.referral.linkValue=inviter.label;
   if([2,3].includes(i.account)){
    if(same(w.address,s.referral.address)||id===inviter.id)throw Error('邀请人与当前钱包或 Agent ID 重复');
    refId=inviter.id;
   }
  }else s.referral.note='1 号没有可核验的 Agent ID，无法生成本项目邀请链接';
 }
 if(q.launched){
  s.assetKind='Erc20';
  const left=positive(q.postCap-q.postSold);
  s.paid=own?left:positive(min(left,(await one('MAX_PAID_PER_NOID_WALLET'))-(await one('paidOfWallet',[w.address]))));
  s.unboundedPaid=!!own;
  const per=await one('TOKENS_PER_SHARE');
  s.quote=async n=>result('mintAfter',[id,n],(await get('quotePost',[n,!own]))[0],n*per);
  s.referral.note='已开池：后续铸造直接到账 BNBULL；此入口没有邀请参数，不产生铸造邀请奖励';
  s.notes.push(s.referral.note);
  if(own)s.notes.push('开池后持有 Agent ID 的付费铸造无钱包总上限；请指定份数，不能将全局库存当成个人额度');
  return;
 }
 s.token=await one('pass');s.assetKind='Erc721';
 const stock=positive(q.freeSupply-q.freeMinted),bonus=min(stock,q.refBonusLeft);
 const ownFree=own&&!q.freeUsed&&stock>bonus?1n:0n;
 s.free=bonus+ownFree;s.paid=positive(min(own?q.paidLeft:q.noIdLeft,q.paidLeftAll));
 s.extraInfo={...s.extraInfo,pass:s.token,ownFreeRemaining:String(ownFree),referralFreeRemaining:String(bonus),freeOpensAt:String(q.freeOpensAt),currentBlock:String(q.currentBlock),freeSlotBlocks:String(q.freeSlotBlocks),freeSlotReady:q.currentBlock>=q.freeOpensAt};
 s.notes.push('本阶段铸造到账为 Pass NFT；BNBULL 代币需在开池后另行领取，不会在本次预览中当作已到账');
 if(ownFree)s.notes.push(`普通免费份全网每 ${q.freeSlotBlocks} 个区块仅一个名额；${q.currentBlock>=q.freeOpensAt?'当前槽已开放，仍可能被其他人抢先':'下次开放区块 '+q.freeOpensAt+'，当前 '+q.currentBlock}。邀请奖励免费份不受该等待限制`);
 if(!own)s.notes.push('当前钱包无项目认可的 Agent ID，仅可按无 ID 价格付费；不会回退冒用其他钱包身份');
 if(!q.open){
  const block=await rpc.send('eth_getBlockByNumber',['0x'+s.block.toString(16),false]);
  s.blocked=BigInt(block.timestamp)<q.startTime?'项目铸造尚未开始':'本阶段铸造已结束；不能继续领取免费份或付费 Pass';
 }
 const freeQuote=()=>{
  if(q.currentBlock<q.freeOpensAt)throw Object.assign(Error(`免费抢槽尚未开放：当前区块 ${q.currentBlock}，开放区块 ${q.freeOpensAt}（还差 ${q.freeOpensAt-q.currentBlock} 块）。不会改为付费铸造，请开放后重新预览`),{code:'MINT_SLOT_WAIT',details:s.info});
  return result('mintFree',[id,refId],0n,1n);
 };
 // "all" can use the project's combined method, but "paid" must leave the
 // free entitlement untouched, and "free" must never pay to skip a slot.
 s.mixed=i.scope==='all'&&ownFree>0n&&bonus===0n&&s.paid>0n;
 if(s.mixed)s.txCap=q.maxPaidPerTx+1n;
 else if(i.scope!=='paid'&&s.free>0n)s.txCap=bonus||1n;
 s.quote=async(n,lane)=>{
  if(lane==='mixed'&&n>1n)return result('mintPaidPlusFree',[id,n-1n,refId],(await get('quotePaid',[n-1n]))[0],n);
  if(lane==='mixed'||lane==='free')return bonus>0n?result('mintRefBonus',[n],0n,n):freeQuote();
  return own?result('mintPaid',[id,n,refId],(await get('quotePaid',[n]))[0],n):result('mintPaidNoId',[n,refId],(await get('quotePaidNoId',[n]))[0],n);
 };
}
