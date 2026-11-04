import {Worker} from 'node:worker_threads';import {Interface,sha256,solidityPacked} from 'ethers';
import path from 'node:path';import {hash,load,save} from './common.mjs';import {cpuChallengeNonce} from './pow-cpu.mjs';
import {BNB} from './common.mjs';import {runtimeShape} from './bytecode.mjs';import {solveWalletNonce} from './pow-mint.mjs';
import {recognizePrefixPow,prefixPowState,prefixPowPlan} from './prefix-pow.mjs';
const shaAbi=['mint(uint256 nonce)','challengeOf(address) view returns(bytes32)','verify(address,uint256) view returns(bool)','currentTarget() view returns(uint256)','difficultyBits() view returns(uint256)','mintedBy(address) view returns(uint256)','MAX_PER_WALLET() view returns(uint256)','MAX_SUPPLY() view returns(uint256)','totalMinted() view returns(uint256)','mintOpen() view returns(bool)','supportsInterface(bytes4) view returns(bool)'];
const keccakAbi=['mint(uint256 nonce)','PUBLIC_SUPPLY() view returns(uint256)','publicMinted() view returns(uint256)','difficultyBits() view returns(uint256)','hasMinted(address) view returns(bool)','supportsInterface(bytes4) view returns(bool)'];
const progress=new Map();
export function recognizeChallengePow(meta){const prefix=recognizePrefixPow(meta);if(prefix)return prefix;const shape=runtimeShape(meta.runtimeCode);if(meta.proxy||shape.delegate)return null;for(const [kind,list]of [['sha256-wallet-challenge',shaAbi],['keccak-wallet-single',keccakAbi]]){const abi=new Interface(list.map(s=>'function '+s));if(abi.fragments.every(f=>shape.selectors.has(f.selector)))return {kind,abi:list.map(s=>'function '+s)};}return null;}
export async function challengePowState(rpc,meta,w,profile=recognizeChallengePow(meta)){
 if(profile?.kind==='sha256-current-wallet-prefix')return prefixPowState(rpc,meta,w,profile);
 if(!profile)return null;const abi=new Interface(profile.abi),block=await rpc.getBlockNumber(),get=async(n,args=[])=>{const raw=await rpc.call({to:meta.address,from:w.address,data:abi.encodeFunctionData(n,args)},block),r=abi.decodeFunctionResult(n,raw);if(abi.encodeFunctionResult(n,r).toLowerCase()!==raw.toLowerCase())throw Error('PoW 接口返回不规范');return r[0];};
 const sha=profile.kind==='sha256-wallet-challenge';
 const [nft,max,total,bits,cap,used,open]=await Promise.all([get('supportsInterface',['0x80ac58cd']),get(sha?'MAX_SUPPLY':'PUBLIC_SUPPLY'),get(sha?'totalMinted':'publicMinted'),get('difficultyBits'),sha?get('MAX_PER_WALLET'):1n,sha?get('mintedBy',[w.address]):get('hasMinted',[w.address]).then(v=>v?1n:0n),sha?get('mintOpen'):true]);
 if(!nft||total>max||bits<1n||bits>40n||cap>500n)throw Error('PoW 接口或难度超出支持范围');if(!open)throw Object.assign(Error('铸造尚未开放'),{code:'MINT_NOT_OPEN'});
 const remaining=cap>used&&max>total?(cap-used<max-total?cap-used:max-total):0n;
 const s={name:profile.kind,token:meta.address,assetKind:'Erc721',abi,get,block,bits:Number(bits),remaining,info:{freeRemaining:String(remaining),paidRemaining:'0',difficultyBits:Number(bits),globalRemaining:String(max-total),perTransaction:'1',currency:'BNB'}};
 if(sha&&remaining){[s.challenge,s.target]=await Promise.all([get('challengeOf',[w.address]),get('currentTarget')]);if(s.target<1n||s.target>1n<<255n)throw Error('PoW 目标值无效');}return s;
}
export async function solveChallengeNonce(address,challenge,target,{start='0',budgetMs=8000,preferCpu=true}={}){
 if(!/^0x[0-9a-f]{40}$/i.test(address)||!/^0x[0-9a-f]{64}$/i.test(challenge)||BigInt(target)<1n||BigInt(target)>=1n<<256n||!/^\d+$/.test(start)||BigInt(start)>2n**63n||budgetMs<1||budgetMs>10000)throw Error('PoW 输入无效');
 const accelerated=preferCpu?await cpuChallengeNonce(address,challenge,target,{start,budgetMs}):null;
 const result=accelerated||await new Promise((resolve,reject)=>{const worker=new Worker(new URL('./challenge-pow-worker.mjs',import.meta.url),{workerData:{address,challenge,target:String(target),start,budgetMs},execArgv:[]});let done=false;const finish=(e,r)=>{if(done)return;done=true;clearTimeout(timer);worker.terminate();e?reject(e):resolve(r);};const timer=setTimeout(()=>finish(Error('PoW 工作线程超时')),budgetMs+2000);worker.once('message',r=>finish(null,r));worker.once('error',e=>finish(e));worker.once('exit',c=>{if(!done)finish(Error('PoW 工作线程退出：'+c));});});
 if(result.nonce!==null&&BigInt(sha256(solidityPacked(['address','bytes32','uint256'],[address,challenge,result.nonce])))>BigInt(target))throw Error('PoW 独立校验失败');return result;
}
export async function challengePowPlan(rpc,intent,meta,w,resolved,{profile=recognizeChallengePow(meta),solver=solveChallengeNonce,data}={}){
 if(profile?.kind==='sha256-current-wallet-prefix')return prefixPowPlan(rpc,intent,meta,w,resolved,{profile,data});
 if(!profile)return null;const s=await challengePowState(rpc,meta,w,profile);
 if(intent.scope==='paid'||s.remaining===0n)throw Object.assign(Error('当前所选类型可用额度为 0'),{code:'NO_QUOTA',details:s.info});
 if(intent.quantity!=='max'&&BigInt(intent.quantity)>s.remaining)throw Error('份数超过当前钱包额度');
 if(resolved.referralHints?.detected&&[2,3].includes(intent.account)&&intent.referral!=='none')throw Object.assign(Error('PoW 项目的邀请方式未核验'),{code:'REFERRAL_NOT_VERIFIED'});
 const key=[meta.hash,w.address,s.challenge||'',s.target||s.bits].join(':'),file=data?path.join(data,'pow-progress',hash(key)+'.json'):null;
 const stored=file?load(file):null,previous=progress.get(key)||(stored?.key===key?stored.proof:null)||{next:'0'};
 const proof=previous.nonce!==null&&previous.nonce!==undefined?previous:profile.kind==='sha256-wallet-challenge'?await solver(w.address,s.challenge,s.target,{start:previous.next}):await solveWalletNonce(w.address,s.bits,{start:previous.next});if(progress.size>256)progress.clear();progress.set(key,proof);
 if(file)save(file,{key,proof});
 if(proof.nonce===null)throw Object.assign(Error('当前钱包工作量证明尚未完成，已保存搜索进度；未提交交易'),{code:'MINT_PROOF_TIMEOUT',details:{...s.info,computeMs:proof.elapsedMs,attempts:proof.attempts,next:proof.next,backend:proof.backend}});
 if(profile.kind==='sha256-wallet-challenge'&&!await s.get('verify',[w.address,proof.nonce]))throw Object.assign(Error('本钱包 PoW 证明已失效'),{code:'MINT_PROOF_INVALID'});
 const step={kind:'mint',to:meta.address,data:s.abi.encodeFunctionData('mint',[proof.nonce]),value:'0'};await rpc.call({...step,from:w.address},s.block);
 return {kind:'contract',route:profile.kind,wallet:w.address,token:meta.address,inputToken:BNB,outputToken:meta.address,amountIn:'0',minOutput:'1',quantity:1,identity:meta.identity,metaVerified:meta.verified,expectedAsset:{token:meta.address,kind:'Erc721',amount:'1'},requireNftCredit:true,requireAssetCredit:true,freshBeforeExecute:true,quota:s.info,proof,review:['本钱包工作量证明已核验，仍以官方 NFT 到账模拟为准'],fill:{continue:s.remaining>1n&&(intent.quantity==='max'||intent.quantity>1),lane:'free',remainingBefore:String(s.remaining)},budgetCurrency:'BNB',steps:[step]};
}
