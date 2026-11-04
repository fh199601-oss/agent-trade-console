import {cpuWalletNonce} from './pow-cpu.mjs';
import {Worker} from 'node:worker_threads';
import {Interface} from 'ethers';
import {BNB,same} from './common.mjs';import {runtimeShape} from './bytecode.mjs';import {chooseBatch,min,positive} from './mint-policy.mjs';
const signatures=['mint(uint256,uint256) payable','powValid(address,uint256) view returns(bool)','usedNonce(address,uint256) view returns(bool)','quoteMint(uint256) view returns(uint256,uint256)','DIFFICULTY() view returns(uint256)','MAX_SUPPLY() view returns(uint256)','MAX_PER_WALLET() view returns(uint256)','mintedBy(address) view returns(uint256)','totalSupply() view returns(uint256)','REGISTRY() view returns(address)','supportsInterface(bytes4) view returns(bool)'];
const abi=new Interface(signatures.map(s=>'function '+s)),registry='0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F',progress=new Map();
export function recognizePowMint(meta){const shape=runtimeShape(meta.runtimeCode);return !meta.proxy&&!shape.delegate&&abi.fragments.every(f=>shape.selectors.has(f.selector))?{kind:'wallet-nonce-pow-nft'}:null;}
export function solveWalletNonce(address,bits,{start='0',budgetMs=8000,preferCpu=true}={}){
 if(!/^0x[0-9a-f]{40}$/i.test(address)||!Number.isInteger(bits)||bits<1||bits>40||!/^\d+$/.test(start)||BigInt(start)>2n**63n||budgetMs<1||budgetMs>10000)throw Error('PoW 参数超出本地计算范围');
 return (async()=>{const accelerated=preferCpu?await cpuWalletNonce(address,bits,{start,budgetMs}):null;if(accelerated)return accelerated;
 return new Promise((resolve,reject)=>{const worker=new Worker(new URL('./pow-worker.mjs',import.meta.url),{workerData:{address,bits,start,budgetMs},execArgv:[]});let done=false;
  const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);worker.terminate();error?reject(error):resolve(result);};
  const timer=setTimeout(()=>finish(Error('PoW 工作线程超时')),budgetMs+2000);worker.once('message',r=>finish(null,r));worker.once('error',e=>finish(e));worker.once('exit',code=>{if(!done)finish(Error('PoW 工作线程提前退出：'+code));});
 });})();
}
export async function powMintState(rpc,intent,meta,w,profile=recognizePowMint(meta)){
 if(!profile)return null;const block=await rpc.getBlockNumber(),get=async(name,args=[])=>{const raw=await rpc.call({to:meta.address,from:w.address,data:abi.encodeFunctionData(name,args)},block),r=abi.decodeFunctionResult(name,raw);if(abi.encodeFunctionResult(name,r).toLowerCase()!==raw.toLowerCase())throw Error('PoW 接口返回不规范');return r.length===1?r[0]:r;};
 const [nft,reg,max,used,cap,minted,bits]=await Promise.all([get('supportsInterface',['0x80ac58cd']),get('REGISTRY'),get('MAX_SUPPLY'),get('mintedBy',[w.address]),get('MAX_PER_WALLET'),get('totalSupply'),get('DIFFICULTY')]);
 if(!nft||!same(reg,registry)||minted>max||cap>500n||cap===0n||bits<1n||bits>24n)throw Object.assign(Error('PoW 身份、难度或发行上限不符合已支持的接口类型'),{code:'MINT_UNSUPPORTED'});
 const remaining=min(positive(cap-used),max-minted),s={name:profile.kind,token:meta.address,assetKind:'Erc721',block,bits:Number(bits),mixed:true,free:0n,paid:0n,txCap:cap,get,info:{block,walletCap:String(cap),walletUsed:String(used),globalRemaining:String(max-minted),difficultyBits:Number(bits)}};
 const gate=new Interface(['function balanceOf(address) view returns(uint256)']);const raw=await rpc.call({to:registry,from:w.address,data:gate.encodeFunctionData('balanceOf',[w.address])},block),held=gate.decodeFunctionResult('balanceOf',raw);if(gate.encodeFunctionResult('balanceOf',held).toLowerCase()!==raw.toLowerCase())throw Error('PoW 身份返回不规范');if(held[0]===0n)throw Object.assign(Error('该钱包没有项目要求的 Agent ID'),{code:'MINT_INELIGIBLE'});
 s.quote=async n=>{const [paid,cost]=await get('quoteMint',[n]);if(paid>n||paid===0n&&cost!==0n||paid>0n&&cost===0n)throw Error('PoW 免费份数与当前报价不一致');return {cost,paid,out:n,step:{kind:'mint',to:meta.address,value:String(cost),data:null}};};
 if(remaining){const q=await s.quote(remaining);s.free=remaining-q.paid;s.paid=q.paid;if(s.free&&(await s.quote(s.free)).cost!==0n)throw Error('PoW 免费额度不是连续可用份额');}
 s.info={...s.info,freeRemaining:String(s.free),paidRemaining:String(s.paid),currency:'BNB',notes:['每笔需要为本钱包计算工作量证明；本地计算有时间上限，不复用其他钱包的 nonce。']};return s;
}
export async function powMintPlan(rpc,intent,meta,budget,w,resolved,profile=recognizePowMint(meta),solver=solveWalletNonce){
 if(!profile)return null;if(resolved.referralHints?.detected&&intent.referral!=='none'&&[2,3].includes(intent.account))throw Object.assign(Error('此 PoW 入口的邀请方式尚未核验'),{code:'REFERRAL_NOT_VERIFIED'});
 if(intent.routeId&&intent.routeId!=='auto:mint(uint256,uint256)')throw Error('PoW 类型的旧入口选择已失效');
 const s=await powMintState(rpc,intent,meta,w,profile),q=await chooseBatch(s,intent,budget),key=[meta.hash||meta.identity?.fingerprint||meta.address,w.address,s.bits].join(':');let cached=progress.get(key)||{next:'0'};
 let nonce=cached.nonce;if(nonce!=null&&await s.get('usedNonce',[w.address,nonce]))nonce=null;
 if(nonce==null){cached=await solver(w.address,s.bits,{start:cached.next});if(progress.size>256)progress.clear();progress.set(key,cached);nonce=cached.nonce;}
 if(nonce==null)throw Object.assign(Error('本轮未找到 PoW nonce；已保存搜索进度，可稍后重新预览，没有提交交易'),{code:'MINT_PROOF_TIMEOUT',details:{attempts:cached.attempts,computeMs:cached.elapsedMs}});
 if(!await s.get('powValid',[w.address,nonce])||await s.get('usedNonce',[w.address,nonce]))throw Object.assign(Error('本钱包的 PoW nonce 未通过链上验证或已使用；不能复用'),{code:'MINT_PROOF_INVALID'});
 q.step.data=abi.encodeFunctionData('mint',[q.n,nonce]);const tx={from:w.address,to:meta.address,value:q.cost,data:q.step.data};await rpc.call(tx,s.block);
 if(q.cost>0n){let failed=false;try{await rpc.call({...tx,value:q.cost-1n},s.block);}catch(e){if(e.executionError||/revert/i.test(e.message))failed=true;else throw e;}if(!failed)throw Error('PoW Mint 少付 1 wei 仍可执行，费用不能核验');}
 return {kind:'contract',route:profile.kind,token:meta.address,wallet:w.address,inputToken:BNB,outputToken:meta.address,amountIn:String(q.cost),minOutput:String(q.n),quantity:Number(q.n),identity:meta.identity,metaVerified:meta.verified,expectedAsset:{token:meta.address,kind:'Erc721',amount:String(q.n)},requireNftCredit:true,requireAssetCredit:true,freshBeforeExecute:true,quota:s.info,proof:{nonce,computeMs:cached.elapsedMs,backend:cached.backend||'javascript',attempts:cached.attempts,validatedAtBlock:s.block},review:['本次为 NFT 铸造；已校验本钱包 PoW，仍须以官方模拟足额到账为准，适配不等于安全审计'],fill:{continue:q.continue,lane:q.lane,remainingBefore:String(q.remaining)},budgetCurrency:'BNB',steps:[q.step]};
}
