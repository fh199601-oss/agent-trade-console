import {Interface} from 'ethers';
import {createHash} from 'node:crypto';
import parser from '@solidity-parser/parser';
import {BNB,formatUnits} from './common.mjs';
import {runtimeShape} from './bytecode.mjs';
import {chooseBatch,min,positive} from './mint-policy.mjs';

const phaseAbi=['mintPublic(uint256) payable','supportsInterface(bytes4) view returns(bool)','phasePrice(uint8) view returns(uint256)','phaseTimes(uint8) view returns(uint64,uint64)','maxPerWallet(uint8) view returns(uint256)','mintedBy(address,uint8) view returns(uint256)','isPhaseOpen(uint8) view returns(bool)','isAgent(address) view returns(bool)','paused() view returns(bool)','supplyClosed() view returns(bool)','maxSupply() view returns(uint256)','totalMinted() view returns(uint256)'];
const receiveAbi=['PRESALE_BNB() view returns(uint256)','PRESALE_TOKEN() view returns(uint256)','MAX_SHARES() view returns(uint256)','TOTAL_SHARES() view returns(uint256)','purchased(address) view returns(uint256)','mintedShares() view returns(uint256)','finished() view returns(bool)','startTime() view returns(uint256)','LP_TOKEN() view returns(uint256)','BURN_TOKEN() view returns(uint256)','NFT() view returns(address)','balanceOf(address) view returns(uint256)'];
// Reviewed receive-body AST, not an address or a website allowlist. This permits
// clones with different deployments/prices, but not arbitrary payable receivers.
const receiveBodyHash='b242fab169c4fc13352775c5265819d9c3ac499b61d800398556058eafa2b486';
function compatible(meta,signatures,shape){
 const actual=new Interface(meta.abi),wanted=new Interface(signatures.map(s=>'function '+s));
 return wanted.fragments.every(f=>{const a=actual.getFunction(f.format('sighash'));return a&&shape.selectors.has(f.selector)&&a.outputs.map(p=>p.type).join(',')===f.outputs.map(p=>p.type).join(',')&&(a.stateMutability===f.stateMutability||['view','pure'].includes(a.stateMutability)&&['view','pure'].includes(f.stateMutability));});
}
export function recognizeVerifiedSale(meta){
 if(!meta.verified||meta.proxy)return null;const shape=runtimeShape(meta.runtimeCode);if(shape.delegate)return null;
 const phase=compatible(meta,phaseAbi,shape),receive=compatible(meta,receiveAbi,shape);if(!phase&&!receive)return null;
 const matches=[];
 for(const s of Object.values(meta.sources||{}))try{if(!/(?:function\s+mintPublic\s*\(|receive\s*\()/.test(s.content))continue;const tree=parser.parse(s.content);parser.visit(tree,{ContractDefinition(contract){
  for(const n of contract.subNodes||[]){
   if(receive&&n.type==='FunctionDefinition'&&n.isReceiveEther&&createHash('sha256').update(JSON.stringify(n.body)).digest('hex')===receiveBodyHash)matches.push({kind:'native-receive-sale',abi:receiveAbi});
   if(!phase||n.type!=='FunctionDefinition'||n.name!=='mintPublic'||n.parameters?.length!==1||n.body?.statements.length!==1)continue;
   const call=n.body.statements[0].expression,p=call?.arguments?.[0],qty=call?.arguments?.[1];
   if(call?.type!=='FunctionCall'||call.expression?.name!=='_phaseMint'||call.arguments.length!==2||p?.type!=='MemberAccess'||p.memberName!=='Public'||qty?.name!==n.parameters[0].name)continue;
   const enums=contract.subNodes.filter(e=>e.type==='EnumDefinition'&&e.name===p.expression?.name);if(enums.length!==1)continue;
   const index=enums[0].members.findIndex(e=>e.name==='Public');if(index>=0&&index<=255)matches.push({kind:'phase-public-nft',phase:index,abi:phaseAbi});
  }
 }});}catch{}
 return matches.length===1?matches[0]:null;
}
export async function verifiedSaleState(rpc,intent,meta,w,profile=recognizeVerifiedSale(meta)){
 if(!profile)return null;const abi=new Interface(profile.abi.map(s=>'function '+s)),block=await rpc.getBlockNumber();
 const get=async(name,args=[])=>{const raw=await rpc.call({to:meta.address,data:abi.encodeFunctionData(name,args)},block),r=abi.decodeFunctionResult(name,raw);if(abi.encodeFunctionResult(name,r).toLowerCase()!==raw.toLowerCase())throw Error('发售接口返回不规范：'+name);return r.length===1?r[0]:r;};
 const s={name:profile.kind,token:meta.address,block,inputToken:BNB,free:0n,paid:0n,txCap:500n,notes:[],info:{block,currency:'BNB'}};
 const stop=(code,message)=>{s.blocked=message;s.blockedCode=code;};let cost,units,remaining;
 if(profile.kind==='phase-public-nft'){
  const p=profile.phase;
  const [nft,price,times,cap,used,open,agent,paused,closed,max,minted,rawBlock]=await Promise.all([get('supportsInterface',['0x80ac58cd']),get('phasePrice',[p]),get('phaseTimes',[p]),get('maxPerWallet',[p]),get('mintedBy',[w.address,p]),get('isPhaseOpen',[p]),get('isAgent',[w.address]),get('paused'),get('supplyClosed'),get('maxSupply'),get('totalMinted'),rpc.send('eth_getBlockByNumber',['0x'+block.toString(16),false])]);
  if(!nft||minted>max)throw Error('公开阶段 NFT 发行计数不一致');
  const now=BigInt(rawBlock.timestamp),[start,end]=times;
  if(closed||end>0n&&now>=end)stop('MINT_ENDED','公开铸造阶段已结束');
  else if(paused)stop('MINT_PAUSED','合约当前暂停');
  else if(!open)stop('MINT_NOT_OPEN',start>now?'公开铸造尚未开始':'公开铸造尚未开放（白名单资格不能代替公开阶段）');
  else if(!agent)stop('MINT_INELIGIBLE','该钱包不满足 Agent ID 资格');
  remaining=min(positive(cap-used),max-minted);cost=price;units=1n;s.assetKind='Erc721';
  s.info={...s.info,phase:p,phaseName:'Public',startTime:String(start),endTime:String(end),walletCap:String(cap),walletUsed:String(used),globalRemaining:String(max-minted)};
  s.quote=async n=>({cost:n*cost,out:n,step:{kind:'mint',to:meta.address,value:String(n*cost),data:abi.encodeFunctionData('mintPublic',[n])}});
 }else{
  const [price,output,cap,total,used,sold,finished,start,reservedLp,reservedBurn,registry,inventory]=await Promise.all([get('PRESALE_BNB'),get('PRESALE_TOKEN'),get('MAX_SHARES'),get('TOTAL_SHARES'),get('purchased',[w.address]),get('mintedShares'),get('finished'),get('startTime'),get('LP_TOKEN'),get('BURN_TOKEN'),get('NFT'),get('balanceOf',[meta.address])]);
  if(price<=0n||output<=0n||sold>total)throw Error('原生币发售价格或库存无效');
  const gate=new Interface(['function balanceOf(address) view returns(uint256)']);
  const raw=await rpc.call({to:registry,data:gate.encodeFunctionData('balanceOf',[w.address])},block),held=gate.decodeFunctionResult('balanceOf',raw);if(gate.encodeFunctionResult('balanceOf',held).toLowerCase()!==raw.toLowerCase())throw Error('身份接口返回不规范');
  if(finished)stop('MINT_ENDED','原生币发售铸造阶段已结束');else if(held[0]===0n)stop('MINT_INELIGIBLE','该钱包没有项目要求的 Agent ID');
  const stock=min(total-sold,positive(inventory-(start===0n?reservedLp+reservedBurn:0n))/output);
  remaining=min(positive(cap-used),stock);cost=price;units=output;s.assetKind='Erc20';
  s.info={...s.info,walletCap:String(cap),walletUsed:String(used),globalRemaining:String(stock)};
  s.quote=async n=>({cost:n*cost,out:n*units,step:{kind:'mint',to:meta.address,value:String(n*cost),data:'0x'}});
  s.notes.push('此类型向已核验发售合约发送精确 BNB 金额，calldata 为空；必须由官方模拟证明代币足额到账。');
 }
 s.free=cost===0n?remaining:0n;s.paid=cost>0n?remaining:0n;
 s.info={...s.info,unitPriceBnb:formatUnits(cost,18),freeRemaining:String(s.free),paidRemaining:String(s.paid),blocked:s.blocked,errorCode:s.blockedCode};return s;
}
export async function verifiedSalePlan(rpc,intent,meta,budget,w,resolved,profile=recognizeVerifiedSale(meta)){
 if(!profile)return null;
 if(resolved.referralHints?.detected&&intent.referral!=='none'&&[2,3].includes(intent.account))throw Object.assign(Error('此发售入口的邀请绑定尚未核验'),{code:'REFERRAL_NOT_VERIFIED'});
 if(intent.routeId&&intent.routeId!=='mintPublic(uint256)')throw Error('此发售类型与旧的 Mint 入口选择不一致，请重新识别');
 const s=await verifiedSaleState(rpc,intent,meta,w,profile);if(s.blocked)throw Object.assign(Error(s.blocked),{code:s.blockedCode,details:s.info});
 const q=await chooseBatch(s,intent,budget);await rpc.call({to:meta.address,from:w.address,data:q.step.data,value:q.cost},s.block);
 return {kind:'contract',route:profile.kind,token:meta.address,wallet:w.address,inputToken:BNB,outputToken:meta.address,amountIn:String(q.cost),minOutput:String(q.out),quantity:Number(q.n),identity:meta.identity,metaVerified:true,requireAssetCredit:true,requireNftCredit:s.assetKind==='Erc721',freshBeforeExecute:true,expectedAsset:{token:meta.address,kind:s.assetKind,amount:String(q.out)},review:['已匹配公开发售接口；适配不等于项目安全审计',...s.notes],quota:s.info,fill:{continue:q.continue,lane:q.lane,remainingBefore:String(q.remaining)},budgetCurrency:'BNB',steps:[q.step]};
}
