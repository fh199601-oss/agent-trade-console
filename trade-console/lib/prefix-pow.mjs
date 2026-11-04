import {Worker} from 'node:worker_threads';
import {Interface,sha256,concat,toBeHex} from 'ethers';
import {BNB,parseUnits,hash,load,save} from './common.mjs';
import {runtimeShape} from './bytecode.mjs';
import {cpuPrefixNonce} from './pow-cpu.mjs';
import {chooseBatch,min,positive} from './mint-policy.mjs';
import path from 'node:path';
const abi=new Interface(['function mint(uint256 nonce) payable','function workPrefix(address) view returns(bytes)','function checkProof(address,uint256) view returns(bool,uint256)','function quote(address) view returns(uint256)','function DIFFICULTY() view returns(uint256)','function MAX_SUPPLY() view returns(uint256)','function MAX_PER_WALLET() view returns(uint256)','function FREE_PER_WALLET() view returns(uint256)','function PAID_PRICE() view returns(uint256)','function mintedBy(address) view returns(uint256)','function totalMinted() view returns(uint256)','function mintOpen() view returns(bool)','function supportsInterface(bytes4) view returns(bool)']);
const progress=new Map();
export function recognizePrefixPow(meta){const shape=runtimeShape(meta.runtimeCode);return !meta.proxy&&!shape.delegate&&abi.fragments.every(f=>shape.selectors.has(f.selector))?{kind:'sha256-current-wallet-prefix'}:null;}
export async function solvePrefixNonce(prefix,bits,{start='0',budgetMs=8000,preferCpu=true}={}){
 if(!/^0x(?:[0-9a-f]{2}){1,1024}$/i.test(prefix)||!Number.isInteger(bits)||bits<1||bits>40||!/^\d+$/.test(start)||BigInt(start)>2n**63n||!Number.isInteger(budgetMs)||budgetMs<1||budgetMs>10000)throw Error('前缀 PoW 参数超出范围');
 const target=(1n<<BigInt(256-bits))-1n;
 const proof=(preferCpu?await cpuPrefixNonce(prefix,target,{start,budgetMs}):null)||await new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./challenge-pow-worker.mjs',import.meta.url),{workerData:{prefix,target:String(target),start,budgetMs},execArgv:[]});let done=false;
  const finish=(e,r)=>{if(done)return;done=true;clearTimeout(timer);void worker.terminate();e?reject(e):resolve(r);};
  const timer=setTimeout(()=>finish(Error('PoW 工作线程超时')),budgetMs+2000);worker.once('message',r=>finish(null,r));worker.once('error',e=>finish(e));worker.once('exit',c=>{if(!done)finish(Error('PoW 工作线程退出：'+c));});
 });
 if(!/^\d+$/.test(proof.next)||proof.nonce!==null&&(!/^\d+$/.test(proof.nonce)||BigInt(sha256(concat([prefix,toBeHex(BigInt(proof.nonce),32)])))>target))throw Error('前缀 PoW 独立摘要校验失败');return proof;
}
export async function prefixPowState(rpc,meta,w,profile=recognizePrefixPow(meta)){
 if(!profile)return null;const block=await rpc.getBlockNumber();
 const get=async(n,args=[])=>{const raw=await rpc.call({to:meta.address,from:w.address,data:abi.encodeFunctionData(n,args)},block);if(raw.length>4098)throw Error('前缀 PoW 返回过长');const v=abi.decodeFunctionResult(n,raw);if(abi.encodeFunctionResult(n,v).toLowerCase()!==raw.toLowerCase())throw Error('前缀 PoW 返回不规范');return v.length===1?v[0]:v;};
 const [nft,cap,total,walletCap,used,freeCap,paidPrice,price,bits,open]=await Promise.all([get('supportsInterface',['0x80ac58cd']),get('MAX_SUPPLY'),get('totalMinted'),get('MAX_PER_WALLET'),get('mintedBy',[w.address]),get('FREE_PER_WALLET'),get('PAID_PRICE'),get('quote',[w.address]),get('DIFFICULTY'),get('mintOpen')]);
 if(!nft||total>cap||walletCap<1n||walletCap>500n||freeCap>walletCap||bits<1n||bits>40n)throw Object.assign(Error('前缀 PoW 的资产、额度或难度未能核验'),{code:'MINT_ADAPTER_INCOMPLETE'});
 if(!open)throw Object.assign(Error('项目当前未开放铸造'),{code:'MINT_NOT_OPEN'});
 const remaining=min(positive(cap-total),positive(walletCap-used)),free=min(positive(freeCap-used),remaining),paid=remaining-free;
 if(remaining&&price!==(free>0n?0n:paidPrice))throw Object.assign(Error('当前钱包报价与免费 / 付费额度不一致'),{code:'MINT_ADAPTER_INCOMPLETE'});
 return {name:profile.kind,token:meta.address,assetKind:'Erc721',block,get,bits:Number(bits),free,paid,mixed:true,txCap:1n,quote:async n=>{if(n!==1n)throw Error('前缀 PoW 每笔只铸造 1 份');return {cost:price,out:1n,step:{kind:'mint',to:meta.address,value:String(price)}};},info:{freeRemaining:String(free),paidRemaining:String(paid),walletCap:String(walletCap),walletUsed:String(used),globalRemaining:String(cap-total),perTransaction:'1',unitPrice:{raw:String(price),symbol:'BNB'},difficultyBits:Number(bits),currency:'BNB'}};
}
export async function prefixPowPlan(rpc,intent,meta,w,resolved,{profile=recognizePrefixPow(meta),solver=solvePrefixNonce,data}={}){
 if(!profile)return null;
 if(intent.routeId&&intent.routeId!=='auto:mint(uint256)')throw Error('所选 PoW 入口已失效');
 if(resolved.referralHints?.detected&&[2,3].includes(intent.account)&&intent.referral!=='none')throw Object.assign(Error('前缀 PoW 项目的邀请方式尚未核验'),{code:'REFERRAL_NOT_VERIFIED'});
 const s=await prefixPowState(rpc,meta,w,profile),q=await chooseBatch(s,intent,intent.scope==='free'?0n:parseUnits(intent.maxBnb||'0',18)),prefix=await s.get('workPrefix',[w.address]);
 if(!/^0x(?:[0-9a-f]{2}){1,1024}$/i.test(prefix))throw Error('当前钱包 PoW 前缀无效');
 const key=hash([meta.hash||meta.identity?.fingerprint,w.address.toLowerCase(),prefix,s.bits]),file=data?path.join(data,'pow-progress',key+'.json'):null,stored=file?load(file):null;
 const previous=progress.get(key)||(stored?.key===key?stored.proof:null)||{next:'0'};
 const proof=previous.nonce!=null?previous:await solver(prefix,s.bits,{start:previous.next});if(progress.size>256)progress.clear();progress.set(key,proof);if(file)save(file,{key,proof});
 if(proof.nonce==null)throw Object.assign(Error('本钱包前缀 PoW 尚未完成，已保存进度；未提交交易'),{code:'MINT_PROOF_TIMEOUT',details:proof});
 const valid=await s.get('checkProof',[w.address,proof.nonce]);if(valid[0]!==true||valid[1]<BigInt(s.bits))throw Object.assign(Error('当前钱包前缀 PoW 未通过链上核验'),{code:'MINT_PROOF_INVALID'});
 const step={...q.step,data:abi.encodeFunctionData('mint',[proof.nonce])},tx={...step,from:w.address};await rpc.call(tx,s.block);
 if(q.cost>0n){let rejected=false;try{await rpc.call({...tx,value:String(q.cost-1n)},s.block);}catch(e){if(e.executionError||/revert/i.test(e.message))rejected=true;else throw e;}if(!rejected)throw Object.assign(Error('少付 1 wei 仍可执行，当前费用未核验'),{code:'MINT_ADAPTER_INCOMPLETE'});}
 return {kind:'contract',route:profile.kind,token:meta.address,wallet:w.address,inputToken:BNB,outputToken:meta.address,amountIn:String(q.cost),minOutput:'1',quantity:1,identity:meta.identity,metaVerified:meta.verified,expectedAsset:{token:meta.address,kind:'Erc721',amount:'1'},requireNftCredit:true,requireAssetCredit:true,freshBeforeExecute:true,quota:s.info,proof:{...proof,prefix,validatedAtBlock:s.block},review:['已为当前钱包和当前铸造进度计算 PoW，仍需官方模拟证明 NFT 到账'],fill:{continue:q.continue,lane:q.lane,remainingBefore:String(q.remaining)},budgetCurrency:'BNB',steps:[step]};
}
