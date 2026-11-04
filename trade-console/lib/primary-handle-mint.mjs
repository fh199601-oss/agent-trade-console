import {Interface,keccak256,toUtf8Bytes,ZeroAddress} from 'ethers';
import {BNB,read,same,formatUnits} from './common.mjs';
import {runtimeShape} from './bytecode.mjs';
import {chooseBatch,min,noQuota} from './mint-policy.mjs';
import {mintError} from './mint-errors.mjs';

const REGISTRY='0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F';
// Primary handle is resolved by the contract, unlike mintFree(string). Free
// usage is per ID, paid usage per wallet, and both draw from one total pool.
const fields={
 free:['mintFree()','claimFree()','freeMint()'],paid:['mintPaid(uint256)','paidMint(uint256)'],
 eligibility:['eligibility(address)'],registry:['REGISTRY()','registry()','agentRegistry()'],
 freeCap:['FREE_CAP()','FREE_SUPPLY()','MAX_FREE_SUPPLY()'],freeMinted:['freeMinted()'],paidMinted:['paidMinted()'],
 freeUsed:['freeUsed(bytes32)','freeClaimed(bytes32)'],paidUsed:['paidUsed(address)','paidMintedBy(address)'],
 maxPaid:['MAX_PAID_PER_WALLET()','MAX_PAID_PER_ADDRESS()'],price:['PRICE()','PAID_PRICE()'],
 supply:['MAX_SUPPLY()'],minted:['totalSupply()'],nft:['supportsInterface(bytes4)'],owner:['ownerOf(uint256)'],balance:['balanceOf(address)']
};
const outputs={eligibility:'string,uint256,uint256',registry:'address',freeUsed:'bool',nft:'bool',owner:'address',reward:'address'};
export function recognizePrimaryHandleMint(meta){
 const shape=runtimeShape(meta.runtimeCode);if(meta.proxy||shape.delegate)return null;
 const methods={},abi=[];
 const add=(key,choices,optional=false)=>{
  const matches=choices.filter(s=>shape.selectors.has(new Interface(['function '+s]).fragments[0].selector));
  if(!matches.length&&optional)return true;if(matches.length!==1)return false;
  methods[key]=matches[0];abi.push('function '+matches[0]+(key==='free'?'':key==='paid'?' payable':' view returns('+(outputs[key]||'uint256')+')'));return true;
 };
 for(const [key,choices]of Object.entries(fields))if(!add(key,choices))return null;
 if(!add('reward',['TOKEN()','rewardToken()'],true))return null;
 if(meta.verified){
  const source=new Interface(meta.abi),expected=new Interface(abi);
  if(!expected.fragments.every(f=>{const a=source.getFunction(f.format('sighash'));return a&&(a.stateMutability===f.stateMutability||['pure','view'].includes(a.stateMutability)&&['pure','view'].includes(f.stateMutability))&&a.outputs.map(p=>p.type).join(',')===f.outputs.map(p=>p.type).join(',');}))return null;
 }
 return {kind:'primary-handle-dual-nft',methods,abi};
}

export async function primaryHandleMintState(rpc,intent,meta,w,profile=recognizePrimaryHandleMint(meta)){
 if(!profile)return null;
 const abi=new Interface(profile.abi),m=profile.methods,block=await rpc.getBlockNumber();
 const get=async(key,args=[])=>{
  const raw=await rpc.call({to:meta.address,data:abi.encodeFunctionData(m[key],args)},block);
  if(raw.length>8194)throw Error('身份铸造接口返回过长：'+m[key]);
  const value=abi.decodeFunctionResult(m[key],raw);
  if(abi.encodeFunctionResult(m[key],value).toLowerCase()!==raw.toLowerCase())throw Error('身份铸造接口返回格式不匹配：'+m[key]);
  return value;
 };
 const one=async(key,args=[])=>(await get(key,args))[0];
 const [registry,nft,freeCap,freeMinted,paidMinted,maxPaid,supply,minted,price,usedPaid,eligibility,reward]=await Promise.all([
  one('registry'),one('nft',['0x80ac58cd']),one('freeCap'),one('freeMinted'),one('paidMinted'),one('maxPaid'),one('supply'),one('minted'),one('price'),one('paidUsed',[w.address]),get('eligibility',[w.address]),m.reward?one('reward'):null
 ]);
 if(!same(registry,REGISTRY)||!nft)throw Error('主身份注册合约或 ERC-721 类型未核验');
 if(freeMinted>freeCap||freeCap>supply||freeMinted+paidMinted!==minted||minted>supply||usedPaid>maxPaid||maxPaid===0n||price===0n)throw Error('身份铸造发行计数、钱包额度或付费价格不一致');
 const reg=new Interface(['function handleOf(address) view returns(string)','function ownerOf(uint256) view returns(address)']);
 const [handle]=await read(rpc,registry,reg,'handleOf',[w.address],block);
 if(handle!==eligibility[0]||handle.length>256)throw Error('项目 eligibility 的主 Agent ID 与注册合约不一致');
 let owned=false,usedFree=false;
 if(handle){
  const id=keccak256(toUtf8Bytes(handle));
  const [[owner],used]=await Promise.all([read(rpc,registry,reg,'ownerOf',[BigInt(id)],block),one('freeUsed',[id])]);
  owned=same(owner,w.address);usedFree=used;
 }
 const stock=supply-minted,globalFree=min(freeCap-freeMinted,stock),free=owned&&!usedFree&&globalFree>0n?1n:0n,paid=min(maxPaid-usedPaid,stock);
 if(eligibility[1]!==free||eligibility[2]!==paid)throw Error('eligibility 与 Agent ID 所有权、已领记录及共享库存核验不一致');
 let rewardToken=null;
 if(reward&&!same(reward,ZeroAddress)&&!same(reward,meta.address)){
  // A token getter alone is not proof that the returned address is ERC20.
  const rewardAbi=new Interface(['function decimals() view returns(uint8)','function totalSupply() view returns(uint256)','function balanceOf(address) view returns(uint256)','function transfer(address,uint256) returns(bool)','function allowance(address,address) view returns(uint256)']);
  const shape=runtimeShape(await rpc.getCode(reward,block));
  if(rewardAbi.fragments.every(f=>shape.selectors.has(f.selector))){
   const [[decimals],[total]]=await Promise.all([read(rpc,reward,rewardAbi,'decimals',[],block),read(rpc,reward,rewardAbi,'totalSupply',[],block)]);
   if(decimals<=36n&&total>0n)rewardToken=reward;
  }
 }
 const notes=['免费按主 Agent ID 计算，付费按钱包计算；两种入口共用总库存，全部额度按免费优先分批重新核验。',`付费每份 ${formatUnits(price,18)} BNB（Gas 另计）。`];
 const freeReason=stock===0n?'项目总库存已售罄':freeMinted===freeCap?`全局免费名额已领完（${freeMinted}/${freeCap}）`:!owned?'当前钱包没有有效主 Agent ID':usedFree?'当前 Agent ID 已领取免费名额':null;
 if(freeReason)notes.push(freeReason+'；只打免费不会切换到付费。');
 if(rewardToken)notes.push('铸造凭证为 NFT，另有独立奖励代币；奖励数量以实际模拟和回执为准。');
 const info={agentId:handle||null,freeRemaining:String(free),paidRemaining:String(paid),globalFreeRemaining:String(globalFree),globalRemaining:String(stock),freeCap:String(freeCap),freeMinted:String(freeMinted),paidMinted:String(paidMinted),maxPaidPerWallet:String(maxPaid),freeUsed:usedFree,paidUsed:String(usedPaid),paidPriceBnb:formatUnits(price,18),currency:'BNB',block,notes,mintAsset:{token:meta.address,kind:'Erc721'},rewardToken};
 return {name:profile.kind,free,paid:intent.scope==='all'?min(paid,stock-free):paid,txCap:min(maxPaid,500n),token:meta.address,assetKind:'Erc721',rewardToken,inputToken:BNB,block,notes,freeReason,info,
  quote:async(n,lane)=>{
   if(lane==='free'&&n!==1n)throw Error('免费入口每次只能领取 1 个 NFT');
   const cost=lane==='free'?0n:price*n;
   return {cost,out:n,step:{kind:'mint',to:meta.address,value:String(cost),data:abi.encodeFunctionData(lane==='free'?m.free:m.paid,lane==='free'?[]:[n])}};
  }
 };
}

export async function primaryHandleMintPlan(rpc,intent,meta,budget,w,resolved,profile=recognizePrimaryHandleMint(meta)){
 if(!profile)return null;
 if(resolved?.referralHints?.detected&&intent.referral!=='none'&&[2,3].includes(intent.account))throw Error('此主身份 Mint 尚未核验网站邀请绑定，不能忽略邀请规则');
 if(intent.routeId)throw Error('此类型自动区分免费和付费，请清除旧的铸造方式选择');
 const s=await primaryHandleMintState(rpc,intent,meta,w,profile);
 if(intent.scope==='free'&&s.free===0n)throw noQuota(s.freeReason+'；本钱包免费可用 0 份，付费可用 '+s.info.paidRemaining+' 份（每份 '+s.info.paidPriceBnb+' BNB）。本次未切换到付费。',{quota:s.info});
 const q=await chooseBatch(s,intent,budget),tx={to:meta.address,from:w.address,data:q.step.data,value:q.cost};
 try{await rpc.call(tx,s.block);}catch(e){throw mintError(e);}
 if(!meta.verified&&q.cost>0n){let rejected=false;try{await rpc.call({...tx,value:q.cost-1n},s.block);}catch(e){if(e.executionError||/revert/i.test(e.message))rejected=true;else throw e;}if(!rejected)throw Error('少付 1 wei 仍可执行，无法核验实际付费金额');}
 return {kind:'contract',route:profile.kind+':'+q.lane,token:s.token,wallet:w.address,inputToken:BNB,outputToken:s.token,amountIn:String(q.cost),minOutput:String(q.n),quantity:Number(q.n),identity:meta.identity,
  expectedAsset:{token:s.token,kind:'Erc721',amount:String(q.n)},rewardToken:s.rewardToken,metaVerified:meta.verified,requireNftCredit:true,
  review:['已核验额度及调用方式，接口适配不等于项目安全审计',...(!meta.verified?['源码尚未匹配，执行须通过官方钱包的 NFT 到账模拟']:[]),...s.notes],
  quota:s.info,fill:{continue:q.continue,lane:q.lane,remainingBefore:String(q.remaining)},quote:{cost:String(q.cost),quantity:Number(q.n),block:s.block,currency:'BNB'},budgetCurrency:'BNB',steps:[q.step]};
}
