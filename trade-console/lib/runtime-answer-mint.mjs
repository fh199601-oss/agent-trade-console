import {Interface} from 'ethers';
import {BNB} from './common.mjs';import {runtimeShape} from './bytecode.mjs';
import {probeFreeBatch} from './free-mint-probe.mjs';
const ABI=new Interface(['function mint(uint256 quantity,uint256 code)','function quote(address,uint256) view returns(uint256 freeQty,uint256 paidQty,uint256 usdtCost)','function checkAnswer(address,uint256,uint256) view returns(bool)','function mintedBy(address) view returns(uint256)','function MAX_PER_WALLET() view returns(uint256)','function MAX_SUPPLY() view returns(uint256)','function totalMinted() view returns(uint256)','function mintActive() view returns(bool)','function isAgent(address) view returns(bool)','function supportsInterface(bytes4) view returns(bool)']);
const fail=(code,message,details)=>Object.assign(Error(message),{code,details});
export function recognizeRuntimeAnswerMint(meta,resolved){
 const p=resolved?.mintPuzzle;if(!p||p.kind!=='wallet-counter-answer'||!Number.isInteger(p.hexDigits)||p.hexDigits<1||p.hexDigits>40||!/^\d{1,12}$/.test(p.factor)||BigInt(p.factor)<=0n||meta.verified||meta.proxy||meta.identity?.implementation)return null;
 const shape=runtimeShape(meta.runtimeCode);if(shape.delegate||!['mint','quote','checkAnswer','mintedBy','mintActive','isAgent','supportsInterface'].every(n=>shape.selectors.has(ABI.getFunction(n).selector)))return null;
 return {...p,kind:'runtime-wallet-counter-free-nft',shape};
}
export async function runtimeAnswerState(rpc,intent,meta,w,resolved,profile=recognizeRuntimeAnswerMint(meta,resolved)){
 if(!profile)return null;const block=await rpc.getBlockNumber(),cache=new Map();
 const get=(name,args=[])=>{const key=name+args.join(',');if(!cache.has(key))cache.set(key,(async()=>{const raw=await rpc.call({to:meta.address,from:w.address,data:ABI.encodeFunctionData(name,args)},block),f=ABI.getFunction(name);if(raw.length!==2+64*f.outputs.length)throw fail('MINT_ADAPTER_INCOMPLETE','链上报价字段数量与公开接口不一致');return ABI.decodeFunctionResult(f,raw);})());return cache.get(key);};
 const [[active],[eligible],[nft],[used],cap,total,minted]=await Promise.all([get('mintActive'),get('isAgent',[w.address]),get('supportsInterface',['0x80ac58cd']),get('mintedBy',[w.address]),...['MAX_PER_WALLET','MAX_SUPPLY','totalMinted'].map(n=>profile.shape.selectors.has(ABI.getFunction(n).selector)?get(n).then(r=>r[0]):null)]);
 if(!active)throw fail('MINT_NOT_OPEN','当前 NFT 铸造未开放');if(!eligible)throw fail('MINT_INELIGIBLE','当前钱包没有该项目要求的 Agent ID');if(!nft)throw fail('MINT_ADAPTER_INCOMPLETE','未核验 NFT 到账接口');
 const remaining=cap===null?null:cap>used?cap-used:0n,stock=total===null||minted===null?null:total>minted?total-minted:0n;
 if(remaining===0n||stock===0n)throw fail('NO_QUOTA',remaining===0n?'本钱包额度已用完':'项目已售罄');
 const known=remaining!==null,probe=known?[remaining,stock??remaining,500n].reduce((a,b)=>a<b?a:b):1n;
 const [free,paid,cost]=await get('quote',[w.address,probe]);if(free+paid!==probe||free>0n&&paid===0n&&cost!==0n||paid>0n&&cost===0n)throw fail('MINT_ADAPTER_INCOMPLETE','免费/付费数量与当前报价不一致');
 const info={block,currency:'USDT',freeRemaining:known?String(free):free?'至少 1（未核验上限）':'0',paidRemaining:known?String(paid):null,walletRemaining:remaining===null?null:String(remaining),freeOnlySupported:true,notes:['个人算术参数按本钱包重算，并由链上 checkAnswer 校验；当前仅开放零付款 NFT 路径，付费需另行适配。']};
 return {name:'runtime-wallet-counter-free-nft',token:meta.address,assetKind:'Erc721',info,free,known,used,stock,block,get,profile};
}
export async function runtimeAnswerPlan(rpc,intent,meta,w,resolved,profile=recognizeRuntimeAnswerMint(meta,resolved)){
 if(!profile)return null;
 if(intent.routeId&&!['runtime-wallet-counter-free-nft','mint(uint256,uint256)'].includes(intent.routeId))throw fail('MINT_ROUTE_CHANGED','所选入口与当前已核验的免费铸造入口不一致，请重新识别');
 const s=await runtimeAnswerState(rpc,intent,meta,w,resolved,profile);
 if(intent.scope!=='free')throw fail('MINT_ADAPTER_INCOMPLETE','此算术参数类型当前只适配零付款 NFT；付费 USDT 路径尚未核验',{quota:s.info});
 if(resolved.referralHints?.detected&&intent.referral!=='none'&&[2,3].includes(intent.account))throw fail('REFERRAL_NOT_VERIFIED','此入口没有邀请参数，不能忽略未核验的邀请码绑定');
 const simulate=async quantity=>{
  const n=BigInt(quantity),[free,paid,cost]=await s.get('quote',[w.address,n]);if(free!==n||paid!==0n||cost!==0n)throw fail('FREE_PROBE_REJECTED','本次报价不再是零付款');
  const answer=BigInt('0x'+w.address.slice(-profile.hexDigits))+BigInt(profile.factor)*(s.used+n),[valid]=await s.get('checkAnswer',[w.address,n,answer]);if(!valid)throw fail('MINT_ADAPTER_INCOMPLETE','公开算术规则未通过本钱包链上校验；不会套用他人答案');
  const step={kind:'mint',to:meta.address,value:'0',data:ABI.encodeFunctionData('mint',[n,answer])};await rpc.call({to:meta.address,from:w.address,data:step.data,value:0n},s.block);return {quantity:Number(n),cost:0n,step,simulated:true};
 };
 let q,probe=null;
 if(intent.quantity==='max'&&!s.known){const found=await probeFreeBatch({quote:simulate,cap:Number(s.stock===null||s.stock>10n?10n:s.stock)});q=found.quote;probe=found.probe;}
 else {const n=intent.quantity==='max'?s.free:BigInt(intent.quantity);if(n<=0n||n>s.free)throw fail('NO_QUOTA','本次份数超过已核验零付款额度',{quota:s.info});q=await simulate(Number(n));}
 const n=q.quantity,step=q.step;
 return {kind:'contract',route:s.name,token:meta.address,wallet:w.address,inputToken:BNB,outputToken:meta.address,amountIn:'0',minOutput:String(n),quantity:n,identity:meta.identity,metaVerified:false,requireNftCredit:true,freshBeforeExecute:true,expectedAsset:{token:meta.address,kind:'Erc721',amount:String(n)},quota:{...s.info,...(probe?{freeProbe:probe}:{})},budgetCurrency:'BNB',fill:{continue:!!probe,lane:'free',...(probe?{probe:true}:{})},review:['源码未核验；公开算术仅作参数候选，须通过当前钱包零付款模拟和 NFT 足额到账核验。'],steps:[step]};
}
