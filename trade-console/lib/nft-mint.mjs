import {Interface} from 'ethers';
import {BNB,read,same,formatUnits} from './common.mjs';
import {runtimeShape} from './bytecode.mjs';
import {chooseBatch,min,positive,noQuota} from './mint-policy.mjs';
import {recognizeErc20Nft,erc20NftState,erc20NftPlan} from './erc20-nft.mjs';
const REGISTRY='0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F';
const base={supports:'supportsInterface(bytes4) view returns(bool)',max:'MAX_SUPPLY() view returns(uint256)',minted:'totalMinted() view returns(uint256)',txCap:'MAX_PER_TX() view returns(uint256)'};
const families=[
 {kind:'wallet-tier-nft',verified:true,fields:{supports:base.supports,max:base.max,minted:'totalSupply() view returns(uint256)',walletCap:'MAX_PER_WALLET() view returns(uint256)',used:'mintedCount(address) view returns(uint256)',price:'priceFor(address,uint256) view returns(uint256)',tier:'priceAt(uint256) pure returns(uint256)',open:'mintOpen() view returns(bool)',registry:'AGENT_ID_REGISTRY() view returns(address)',mint:'mint(uint256) payable'}},
 {kind:'wallet-fixed-nft',verified:true,fields:{supports:base.supports,max:base.max,minted:base.minted,walletCap:'MAX_PER_WALLET() view returns(uint256)',used:'mintedBy(address) view returns(uint256)',price:'PRICE() view returns(uint256)',open:'saleActive() view returns(bool)',closed:'saleClosed() view returns(bool)',registry:'agentId() view returns(address)',mint:'mint(uint256) payable'}},
 {kind:'shared-pool-dual-nft',fields:{...base,open:'mintOpen() view returns(bool)',fee:'FREE_FEE() view returns(uint256)',price:'PAID_PRICE() view returns(uint256)',free:'mintFree(uint256) payable',mint:'mintPaid(uint256) payable'}}
];
export function recognizeNftMint(meta){
 const erc20=recognizeErc20Nft(meta);if(erc20)return erc20;
 const shape=runtimeShape(meta.runtimeCode);if(meta.proxy||shape.delegate)return null;
 for(const family of families){
  if(family.verified&&!meta.verified)continue;
  const abi=Object.values(family.fields).map(s=>'function '+s),expected=new Interface(abi),methods=Object.fromEntries(Object.entries(family.fields).map(([k,s])=>[k,s.slice(0,s.indexOf(' '))]));
  if(!expected.fragments.every(f=>shape.selectors.has(f.selector)))continue;
  if(meta.verified){const actual=new Interface(meta.abi);if(!expected.fragments.every(f=>{const a=actual.getFunction(f.format('sighash'));return a&&(a.stateMutability===f.stateMutability||['view','pure'].includes(a.stateMutability)&&['view','pure'].includes(f.stateMutability))&&a.outputs.map(x=>x.type).join(',')===f.outputs.map(x=>x.type).join(',');}))continue;}
  return {...family,abi,methods};
 }
 return null;
}
export async function nftMintState(rpc,intent,meta,w,profile=recognizeNftMint(meta)){
 if(profile?.kind==='source-free-paid-erc20-nft')return erc20NftState(rpc,intent,meta,w,profile);
 if(!profile)return null;
 const abi=new Interface(profile.abi),block=await rpc.getBlockNumber(),m=profile.methods;
 const one=async(key,args=[])=>{const raw=await rpc.call({to:meta.address,data:abi.encodeFunctionData(m[key],args)},block);if(!/^0x[0-9a-f]{64}$/i.test(raw))throw Error('NFT 接口返回格式不符：'+m[key]);const result=abi.decodeFunctionResult(m[key],raw);if(abi.encodeFunctionResult(m[key],result).toLowerCase()!==raw.toLowerCase())throw Error('NFT 返回值不规范');return result[0];};
 const [nft,max,minted,open]=await Promise.all([one('supports',['0x80ac58cd']),one('max'),one('minted'),one('open')]);
 if(!nft||minted>max)throw Error('NFT 类型或发行计数核验失败');
 const stock=max-minted,s={name:profile.kind,block,free:0n,paid:0n,txCap:500n,token:meta.address,assetKind:'Erc721',inputToken:BNB,notes:[],info:{globalRemaining:String(stock),currency:'BNB',block}};
 if(!open)s.blocked='合约当前尚未开放铸造';
 let cost,method=m.mint;
 if(profile.kind==='shared-pool-dual-nft'){
  const [fee,price,txCap]=await Promise.all([one('fee'),one('price'),one('txCap')]);
  if(!txCap||price<=0n)throw Error('NFT 批次上限或付款报价无效');
  s.txCap=txCap;s.unboundedPaid=true;s.info.paidIsGlobalInventory=true;
  s.notes.push('未核验到每钱包上限；剩余库存不是个人额度，请填写明确份数。');
  if(fee>0n)s.notes.push('网站称为免费入口，但每份仍收 '+formatUnits(fee,18)+' BNB 手续费（Gas 另计）；只打免费不会付款。');
  s.info.websiteFreeFeeBnb=formatUnits(fee,18);s.info.paidPriceBnb=formatUnits(price,18);
  if(intent.scope==='free'){
   if(fee>0n)s.blocked='该网站的“免费铸造”每份需要 '+formatUnits(fee,18)+' BNB 手续费，不属于零费用额度；请明确选择全部并填写份数和预算，或选择付费入口。';
   else if(intent.quantity==='max')s.blocked='此免费入口没有已核验的个人上限，请指定铸造份数';
   s.free=fee===0n?stock:0n;s.paid=fee>0n?stock:0n;cost=fee;method=m.free;
  }else {s.paid=stock;const useFee=intent.scope==='all'&&fee<price;cost=useFee?fee:price;method=useFee?m.free:m.mint;if(useFee)s.notes.push('本次全部范围使用收费较低的 mintFree 入口，实际仍按手续费占用预算。');}
 }else{
  const [cap,used,registry]=await Promise.all([one('walletCap'),one('used',[w.address]),one('registry')]);
  if(used>cap||cap>500n||!same(registry,REGISTRY))throw Error('NFT 钱包额度或身份注册合约尚不能核验');
  const registryAbi=new Interface(['function balanceOf(address) view returns(uint256)']);
  if((await read(rpc,registry,registryAbi,'balanceOf',[w.address],block))[0]===0n)s.blocked='该钱包没有项目要求的 Agent ID';
  const remaining=min(cap-used,stock);s.txCap=cap;s.mixed=true;s.info.walletCap=String(cap);s.info.walletUsed=String(used);
  if(profile.kind==='wallet-fixed-nft'){
   const [price,closed]=await Promise.all([one('price'),one('closed')]);if(closed)s.blocked='项目铸造阶段已关闭';cost=price;s.free=price===0n?remaining:0n;s.paid=remaining-s.free;s.info.unitPriceBnb=formatUnits(price,18);
  }else{
   const prices=await Promise.all(Array.from({length:Number(remaining)},(_,j)=>one('tier',[used+BigInt(j)+1n])));let paidSeen=false;
   for(const p of prices){if(p===0n){if(paidSeen)throw Error('免费额度不连续，不能按顺序自动铸造');s.free++;}else paidSeen=true;}s.paid=remaining-s.free;
   cost=async n=>{const total=await one('price',[w.address,n]),sum=prices.slice(0,Number(n)).reduce((a,b)=>a+b,0n);if(total!==sum)throw Error('钱包总报价与逐档价格不一致');return total;};
   s.notes.push('首份免费及后续阶梯价格按本钱包已铸造数量计算；跨档使用合约总报价。');
  }
 }
 s.info={...s.info,freeRemaining:String(s.free),paidRemaining:String(s.paid),blocked:s.blocked,notes:s.notes};
 s.quote=async n=>{const value=typeof cost==='function'?await cost(n):cost*n;return {cost:value,out:n,step:{kind:'mint',to:meta.address,value:String(value),data:abi.encodeFunctionData(method,[n])}};};return s;
}
export async function nftMintPlan(rpc,intent,meta,budget,w,resolved,profile=recognizeNftMint(meta)){
 if(profile?.kind==='source-free-paid-erc20-nft')return erc20NftPlan(rpc,intent,meta,w,resolved,profile);
 if(!profile)return null;
 if(resolved?.referralHints?.detected&&intent.referral!=='none'&&[2,3].includes(intent.account))throw Error('网站提到邀请，但此 NFT 入口尚未核验邀请绑定方式');
 if(intent.routeId)throw Error('此 NFT 类型按免费 / 付费 / 全部选择，请清除旧入口选择');
 const s=await nftMintState(rpc,intent,meta,w,profile),q=await chooseBatch(s,intent,budget),tx={to:meta.address,from:w.address,data:q.step.data,value:q.cost};await rpc.call(tx,s.block);
 if(!meta.verified&&q.cost>0n){let rejected=false;try{await rpc.call({...tx,value:q.cost-1n},s.block);}catch(e){if(e.executionError||/revert/i.test(e.message))rejected=true;else throw e;}if(!rejected)throw Error('少付 1 wei 仍可执行，无法证明所需费用');}
 return {kind:'contract',route:profile.kind+':'+new Interface(profile.abi).parseTransaction({data:tx.data}).name,token:meta.address,wallet:w.address,inputToken:BNB,outputToken:meta.address,amountIn:String(q.cost),minOutput:String(q.n),quantity:Number(q.n),identity:meta.identity,expectedAsset:{token:meta.address,kind:'Erc721',amount:String(q.n)},metaVerified:meta.verified,requireNftCredit:true,review:['本次到账为 NFT，不能用 ERC20 快捷卖出；接口适配不等于项目安全审计',...(!meta.verified?['源码未匹配，必须以官方预览的 NFT 足额到账为准']:[]),...s.notes],quota:s.info,fill:{continue:q.continue,lane:q.lane,remainingBefore:String(q.remaining)},quote:{cost:String(q.cost),quantity:Number(q.n),block:s.block,currency:'BNB'},budgetCurrency:'BNB',steps:[q.step]};
}
