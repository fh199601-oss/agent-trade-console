import {Interface,keccak256,toUtf8Bytes} from 'ethers';
import {BNB,read,same} from './common.mjs';
import {runtimeShape} from './bytecode.mjs';
import {agentHandle} from './sample-mints.mjs';
import {chooseBatch,min,positive,noQuota} from './mint-policy.mjs';

const REGISTRY='0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F';
// A bounded interface family, independent of website, variable name or CA.
// String arguments are only filled after official Agent ID ownership is checked.
const fields={
 free:['claimFree(string)','mintFree(string)','freeMint(string)'],
 paid:['paidMint(uint256,string)','mintPaid(uint256,string)','paidMint(string,uint256)','mintPaid(string,uint256)'],
 eligibility:['eligibility(address,string)'],
 quote:['quote(uint256)','quotePaid(uint256)'],
 registry:['REGISTRY()','registry()','agentRegistry()'],
 freeCap:['FREE_CAP()','FREE_SUPPLY()','MAX_FREE_SUPPLY()'],
 paidCap:['PAID_CAP()','PAID_SUPPLY()'],
 freeMinted:['freeMinted()'],paidMinted:['paidMinted()'],
 freeUsed:['freeUsed(bytes32)','freeClaimed(bytes32)'],
 paidUsed:['paidUsed(bytes32)','paidMintedById(bytes32)'],
 maxPaid:['MAX_PAID_PER_ID()','MAX_PAID_PER_AGENT()'],
 supply:['MAX_SUPPLY()'],minted:['totalSupply()'],
 nft:['supportsInterface(bytes4)'],owner:['ownerOf(uint256)'],balance:['balanceOf(address)']
};
const outputs={eligibility:'bytes32,uint256,uint256',registry:'address',freeUsed:'bool',nft:'bool',owner:'address'};
export function recognizeHandleMint(meta){
 const shape=runtimeShape(meta.runtimeCode);if(meta.proxy||shape.delegate)return null;
 const methods={},abi=[];
 for(const [key,choices]of Object.entries(fields)){
  const matches=choices.filter(s=>shape.selectors.has(new Interface(['function '+s]).fragments[0].selector));
  if(matches.length!==1)return null;
  methods[key]=matches[0];
  abi.push('function '+matches[0]+(key==='free'?'':key==='paid'?' payable':' view returns('+ (outputs[key]||'uint256') +')'));
 }
 if(meta.verified){
  const source=new Interface(meta.abi),expected=new Interface(abi);
  for(const f of expected.fragments){const actual=source.getFunction(f.format('sighash'));if(!actual||actual.stateMutability!==f.stateMutability||actual.outputs.map(p=>p.type).join(',')!==f.outputs.map(p=>p.type).join(','))return null;}
 }
 return {kind:'agent-handle-nft',methods,abi};
}

export async function handleMintState(rpc,bridge,intent,meta,w,profile=recognizeHandleMint(meta)){
 if(!profile)return null;
 const abi=new Interface(profile.abi),m=profile.methods,block=await rpc.getBlockNumber();
 const get=async(key,args=[])=>{
  const method=m[key],raw=await rpc.call({to:meta.address,data:abi.encodeFunctionData(method,args)},block),f=abi.getFunction(method);
  if(raw.length!==2+64*f.outputs.length)throw Error('Agent ID 铸造接口返回格式不匹配：'+method);
  const values=abi.decodeFunctionResult(method,raw);
  if(abi.encodeFunctionResult(method,values).toLowerCase()!==raw.toLowerCase())throw Error('Agent ID 铸造接口返回值不规范：'+method);
  return values;
 };
 const one=async(key,args=[])=> (await get(key,args))[0];
 const [registry,nft,freeCap,paidCap,freeMinted,paidMinted,maxPaid,supply,minted,agent]=await Promise.all([
  one('registry'),one('nft',['0x80ac58cd']),one('freeCap'),one('paidCap'),one('freeMinted'),one('paidMinted'),one('maxPaid'),one('supply'),one('minted'),bridge.call(intent.account,['wallet','agent-id'])
 ]);
 if(!same(registry,REGISTRY))throw Error('此字符串 Mint 使用的身份注册合约尚未适配');
 if(!nft)throw Error('未能核验 ERC-721 到账资产');
 if(freeMinted>freeCap||paidMinted>paidCap||freeCap+paidCap!==supply||freeMinted+paidMinted!==minted||maxPaid===0n)throw Error('项目全局额度与发行计数不一致，停止构造');
 const handle=agentHandle(agent).toLowerCase(),id=keccak256(toUtf8Bytes(handle));
 const ownerAbi=new Interface(['function ownerOf(uint256) view returns(address)']);
 const [[owner],eligibility,usedFree,usedPaid]=await Promise.all([read(rpc,registry,ownerAbi,'ownerOf',[BigInt(id)],block),get('eligibility',[w.address,handle]),one('freeUsed',[id]),one('paidUsed',[id])]);
 if(!same(owner,w.address))throw Error('Agent ID 所有者与当前绑定钱包不一致');
 if(eligibility[0].toLowerCase()!==id.toLowerCase())throw Error('项目返回的 Agent ID 与钱包名称不一致');
 if(usedPaid>maxPaid)throw Error('项目付费已用额度超过上限');
 const free=!usedFree&&freeMinted<freeCap?1n:0n,paid=min(positive(maxPaid-usedPaid),positive(paidCap-paidMinted));
 if(eligibility[1]!==free||eligibility[2]!==paid)throw Error('项目 eligibility 与独立额度查询不一致，不能自动打满');
 const notes=['按当前钱包 Agent ID 名称核验；免费与付费入口独立，付款采用合约当前报价'];
 if(freeMinted===freeCap)notes.push('全局免费名额已用完；只打免费不会改为付费');
 else if(usedFree)notes.push('当前 Agent ID 已领取免费名额');
 const state={name:profile.kind,free,paid,txCap:min(maxPaid,500n),token:meta.address,assetKind:'Erc721',inputToken:BNB,block,notes,
  info:{agentId:handle,freeRemaining:String(free),paidRemaining:String(paid),globalFreeRemaining:String(freeCap-freeMinted),globalPaidRemaining:String(paidCap-paidMinted),maxPaidPerAgent:String(maxPaid),freeUsed:usedFree,paidUsed:String(usedPaid),currency:'BNB',block,notes},
  quote:async(n,lane)=>{
   if(lane==='free'&&n!==1n)throw Error('此免费入口每次只领取 1 个 NFT');
   const method=lane==='free'?m.free:m.paid,cost=lane==='free'?0n:await one('quote',[n]);
   if(lane==='paid'&&cost<=0n)throw Error('付费入口未返回有效 BNB 报价');
   const args=abi.getFunction(method).inputs.map(p=>p.type==='string'?handle:n);
   return {cost,out:n,step:{kind:'mint',to:meta.address,value:String(cost),data:abi.encodeFunctionData(method,args)}};
  }
 };
 return state;
}

export async function handleMintPlan(rpc,bridge,intent,meta,budget,w,resolved,profile=recognizeHandleMint(meta)){
 if(!profile)return null;
 if(resolved?.referralHints?.detected&&intent.referral!=='none'&&[2,3].includes(intent.account))throw Error('此字符串 Mint 尚无已核验邀请参数，不能忽略网站邀请规则');
 const s=await handleMintState(rpc,bridge,intent,meta,w,profile);
 if(intent.scope==='free'&&s.free===0n)throw noQuota(s.info.globalFreeRemaining==='0'?'全局免费名额已用完，当前免费可用 0 份；没有改为付费铸造':'当前 Agent ID 已领取免费名额，免费可用 0 份',{quota:s.info});
 if(intent.routeId)throw Error('此 Agent ID 铸造类型按免费 / 付费 / 全部自动选择，请清除旧铸造方式');
 const q=await chooseBatch(s,intent,budget),tx={to:q.step.to,from:w.address,data:q.step.data,value:q.cost};
 await rpc.call(tx,s.block);
 if(!meta.verified&&q.cost>0n){let rejected=false;try{await rpc.call({...tx,value:q.cost-1n},s.block);}catch(e){if(e.executionError||/revert/i.test(e.message))rejected=true;else throw e;}if(!rejected)throw Error('少付 1 wei 仍可执行，尚不能确认实际所需付款');}
 return {kind:'contract',route:'agent-handle:'+q.lane,token:s.token,wallet:w.address,inputToken:BNB,outputToken:s.token,amountIn:String(q.cost),minOutput:String(q.n),quantity:Number(q.n),identity:meta.identity,
  expectedAsset:{token:s.token,kind:'Erc721',amount:String(q.n)},metaVerified:meta.verified,requireNftCredit:true,
  review:['只完成字符串 Agent ID 接口、额度与模拟核验，尚未完成项目安全审计',...(!meta.verified?['当前源码未匹配，按链上接口核验；执行前需核对官方预览']:[]),...s.notes],
  quota:s.info,fill:{continue:q.continue,lane:q.lane,remainingBefore:String(q.remaining)},quote:{cost:String(q.cost),quantity:Number(q.n),block:s.block,currency:'BNB',agentId:s.info.agentId},budgetCurrency:'BNB',steps:[q.step]};
}
