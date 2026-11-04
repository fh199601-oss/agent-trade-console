import path from 'node:path';
import {Interface,keccak256,ZeroAddress} from 'ethers';
import {Rpc} from './network.mjs';
import {DATA,address,hash,load,save,same} from './common.mjs';
import {runtimeShape} from './bytecode.mjs';
import {recognizeMint} from './adaptive-mint.mjs';
import {recognizeGuardedIdMint} from './guarded-id-mint.mjs';
import {recognizeDirectTokenMint} from './direct-token-mint.mjs';
import {recognizeSocialSale} from './social-sale.mjs';
import {recognizeSourceSale} from './source-sale.mjs';
import {measure,count} from './diagnostics.mjs';

export const TRANSFER='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ADDRESS=/^0x[0-9a-f]{40}$/i,WORD=/^0x[0-9a-f]{64}$/i,HEX=/^0x(?:[0-9a-f]{2})*$/i;
const excluded=new Set(['registry','treasury','oracle','art','multicall','router','factory','pool','market','payment','implementation']);
const stock=new WeakMap();
const registry='0x60b9262456de011f7d15a54cdd8c48baaa8b022f';
const forbiddenSeeds=new Set([registry,'0xca11bde05977b3631167028862be2a173976ca11','0x55d398326f99059ff775485246999027b3197955','0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c','0xca143ce32fe78f1f7019d7d551a6402fc5350c73','0x10ed43c718714eb63d5aa57b78b54704e256024e']);
const tag=n=>'0x'+n.toString(16),number=v=>{const n=Number(BigInt(v));if(!Number.isSafeInteger(n)||n<0)throw Error('区块编号无效');return n;};
const topicAddress=t=>WORD.test(t||'')&&/^0x0{24}/i.test(t)?'0x'+t.slice(-40):null;
export function chainSeeds(rows){return [...new Set(rows.filter(r=>ADDRESS.test(r.address||'')&&r.hasCode!==false&&!forbiddenSeeds.has(r.address.toLowerCase())&&!r.verifiedRoles?.some(x=>excluded.has(x))).sort((a,b)=>(b.priority||0)-(a.priority||0)).map(r=>r.address.toLowerCase()))].slice(0,6);}

// Successful transfer events are observations, not authorization or ABI proof.
// Only zero-address issuance to the transaction sender counts as a mint sample.
export function mintReceiptSample(tx,receipt,header,head,{inventoryIssuer=null,inventoryToken=inventoryIssuer}={}){
 if(!tx||!receipt||!header||!WORD.test(tx.hash||'')||!same(receipt.transactionHash,tx.hash)||BigInt(receipt.status||0)!==1n)return null;
 if(!ADDRESS.test(tx.from||'')||!ADDRESS.test(tx.to||'')||!same(tx.from,receipt.from)||!same(tx.to,receipt.to)||!HEX.test(tx.input||'')||tx.input.length<10||tx.input.length>8202)return null;
 const block=number(receipt.blockNumber);if(block>head-3||!same(receipt.blockHash,header.hash)||!same(tx.blockHash,header.hash)||number(tx.blockNumber)!==block||number(header.number)!==block)return null;
 const assets=new Map(),seen=new Set();
 for(const log of receipt.logs||[]){
  if(log.removed||!same(log.transactionHash,tx.hash)||!same(log.blockHash,header.hash)||number(log.blockNumber)!==block||!ADDRESS.test(log.address||''))continue;
  const key=String(log.logIndex);if(seen.has(key))continue;seen.add(key);
  const inventory=inventoryIssuer&&same(inventoryIssuer,tx.to)&&same(log.address,inventoryToken)&&same(topicAddress(log.topics?.[1]),inventoryIssuer)&&log.topics?.length===3;
  if(!same(log.topics?.[0],TRANSFER)||!(same(topicAddress(log.topics[1]),ZeroAddress)||inventory)||!same(topicAddress(log.topics[2]),tx.from))continue;
  const kind=log.topics.length===4&&WORD.test(log.topics[3])&&log.data==='0x'?'Erc721':log.topics.length===3&&WORD.test(log.data)?'Erc20':null;if(!kind)continue;
  const amount=kind==='Erc721'?1n:BigInt(log.data);if(amount<=0n)continue;
  const token=address(log.address),k=token.toLowerCase()+kind,row=assets.get(k)||{token,kind,amount:0n,ids:new Set(),issuance:inventory?'verified-sale-inventory':'zero-address'};
  if(kind==='Erc721'){if(row.ids.has(log.topics[3]))continue;row.ids.add(log.topics[3]);}row.amount+=amount;assets.set(k,row);
 }
 if(!assets.size)return null;
 return {txHash:tx.hash,block,blockHash:header.hash,from:address(tx.from),target:address(tx.to),selector:tx.input.slice(0,10).toLowerCase(),inputBytes:(tx.input.length-2)/2,value:String(BigInt(tx.value||0)),assets:[...assets.values()].map(({ids,...a})=>({...a,amount:String(a.amount),...(a.kind==='Erc721'?{tokenIds:[...ids].map(v=>String(BigInt(v)))}:{})})),input:tx.input};
}

// Some non-transferable collections omit ERC165. An event alone is not enough:
// verify each minted ID's owner and the recipient balance at its issuance block.
// The current-wallet official preview must still confirm typed NFT credits.
export async function receiptNftProof(rpc,asset,sample,code,readAt=(tx,block)=>rpc.call(tx,block)){
 const abi=new Interface(['function supportsInterface(bytes4) view returns(bool)','function ownerOf(uint256) view returns(address)','function balanceOf(address) view returns(uint256)','function tokenURI(uint256) view returns(string)']);
 try{if(await rpc.call({to:asset.token,data:abi.encodeFunctionData('supportsInterface',['0x80ac58cd'])})===abi.encodeFunctionResult('supportsInterface',[true]))return 'erc165';}catch{}
 const shape=runtimeShape(code),ids=asset.tokenIds;
 if(shape.delegate||!['ownerOf','balanceOf','tokenURI'].every(n=>shape.selectors.has(abi.getFunction(n).selector))||!Array.isArray(ids)||!ids.length||ids.length>16||new Set(ids).size!==ids.length||BigInt(ids.length)!==BigInt(asset.amount))return null;
 const checked=async(method,args)=>{const raw=await readAt({to:asset.token,data:abi.encodeFunctionData(method,args)},sample.block),value=abi.decodeFunctionResult(method,raw);if(abi.encodeFunctionResult(method,value)!==raw)throw Error('历史收藏品接口返回格式不规范');return value[0];};
 const [balance,owners]=await Promise.all([checked('balanceOf',[sample.from]),Promise.all(ids.map(id=>checked('ownerOf',[id])))]);
 return balance>=BigInt(ids.length)&&owners.every(owner=>same(owner,sample.from))?'historical-owner-and-balance':null;
}

// Cache only receipt identities and interface evidence. Never persist someone
// else's calldata, signatures/proofs, or payment amounts as execution defaults.
export class ChainLearner{
 constructor(rpc,{logRpc=null,archiveRpc=null,data=DATA,scanBlocks=8192,now=Date.now,maxElapsedMs=12000,maxReceipts=100}={}){
  this.rpc=rpc;this.logRpc=logRpc||new Rpc(process.env.BSC_LOG_RPC_URL||'https://bsc-rpc.publicnode.com',{timeoutMs:3500});
  this.archiveRpc=archiveRpc;this.usePublicArchive=logRpc===null;
  this.dir=path.join(data,'chain-mint-evidence');this.scanBlocks=Math.min(32768,Math.max(64,scanBlocks));this.now=now;this.maxElapsedMs=maxElapsedMs;this.maxReceipts=Math.min(100,Math.max(1,Math.floor(maxReceipts)));this.pending=new Map();this.misses=new Map();
 }
 async learn(rows,{sourceLoader,force=false}={}){
  const seeds=chainSeeds(rows);if(!seeds.length)return {status:'no-address',methods:[],targets:[],note:'网页没有提供可核验的候选地址，无法只凭域名反查链上 Mint。'};
  if(typeof sourceLoader!=='function')throw Error('链上学习需要当前代码核验入口');
  const key=hash([56,seeds.sort()]);if(this.pending.has(key)){count('chainLearningCoalesced');return this.pending.get(key);}
  const miss=this.misses.get(key);if(!force&&miss?.until>this.now()){count('chainLearningNegativeCacheHits');return {...miss.value,cached:true};}
  const task=measure('chainLearning',async()=>{
   const deadline=this.now()+(force?Math.max(30000,this.maxElapsedMs):this.maxElapsedMs);
   const first=await this.inspect(seeds,key,sourceLoader,force,this.scanBlocks,deadline);
   const wider=force?2000000:500000;
   if(this.now()<deadline&&['observed','no-samples'].includes(first.status)&&(force&&first.scan?.found<this.maxReceipts||!first.targets.some(t=>t.corroborated))&&this.scanBlocks<wider){
    // Quiet/new-to-us projects often have no recent mints. An indexed issuance
    // topic search reaches older records without scanning hundreds of batches
    // of secondary transfers. Still bounded by time and 100 checked receipts.
    const expanded=await this.inspect(seeds,key,sourceLoader,true,wider,deadline,true);
    // Retain already verified evidence if the wider scan is rate-limited.
    if(expanded.targets.some(t=>t.corroborated)||expanded.methods.length>=first.methods.length)return {...expanded,expanded:true};
    return {...first,partial:true,note:first.note+' 扩大到 '+wider+' 区块的回查未获得更多可核验记录。'};
   }
   return first;
  }).catch(e=>({chainId:56,seeds,at:this.now(),status:'unavailable',methods:[],targets:[],note:'链上样本读取未完成：'+e.message}));
  this.pending.set(key,task);try{const value=await task;if(!value.methods.length){this.misses.set(key,{until:this.now()+15000,value});if(this.misses.size>100)this.misses.delete(this.misses.keys().next().value);}else this.misses.delete(key);return value;}finally{this.pending.delete(key);}
 }
 async inspect(seeds,key,sourceLoader,force,scanBlocks=this.scanBlocks,deadline=Infinity,issuanceOnly=false){
  const file=path.join(this.dir,key+'.json'),metas=new Map(),headers=new Map(),codes=new Map();
  const meta=async a=>{const k=a.toLowerCase();if(!metas.has(k))metas.set(k,sourceLoader(this.rpc,a));return metas.get(k);};
  const header=async b=>{if(!headers.has(b))headers.set(b,this.rpc.send('eth_getBlockByNumber',[tag(b),false]));return headers.get(b);};
  const code=async(a,b)=>{const k=a.toLowerCase()+':'+b;if(!codes.has(k))codes.set(k,this.rpc.getCode(a,b).catch(async e=>{
   if(b==='latest'||!/missing trie|historical|pruned|archive|state.*unavailable|HTTP (?:403|429|5\d\d)|timeout/i.test(e.message))throw e;
   try{return await this.logRpc.getCode(a,b);}catch(logError){
    if(!this.archiveRpc&&this.usePublicArchive)this.archiveRpc=new Rpc(process.env.BSC_ARCHIVE_RPC_URL||'https://bsc-mainnet.public.blastapi.io',{timeoutMs:4000});
    if(!this.archiveRpc)throw Error('historical RPC unavailable: '+logError.message);
    try{await this.archiveRpc.verifyChain();return await this.archiveRpc.getCode(a,b);}catch(last){throw Error('historical RPC unavailable: '+last.message);}
   }
  }));return codes.get(k);};
  const historicalCall=async(tx,block)=>{
   try{return await this.rpc.call(tx,block);}catch(e){
    if(!/missing trie|historical|pruned|archive|state.*unavailable|HTTP (?:403|429|5\d\d)|timeout/i.test(e.message))throw e;
    try{return await this.logRpc.call(tx,block);}catch(last){
     if(!this.archiveRpc&&this.usePublicArchive)this.archiveRpc=new Rpc(process.env.BSC_ARCHIVE_RPC_URL||'https://bsc-mainnet.public.blastapi.io',{timeoutMs:4000});
     if(!this.archiveRpc)throw Error('historical RPC unavailable: '+last.message);
     await this.archiveRpc.verifyChain();return this.archiveRpc.call(tx,block);
    }
   }
  };
  const freshTarget=async t=>{const m=await meta(t.address);if(m.identity?.implementation||m.proxy||runtimeShape(m.runtimeCode).delegate||m.hash!==t.fingerprint)return false;return true;};
  await this.rpc.verifyChain();
  let cached;try{cached=load(file);}catch{}
  if(!force&&cached?.schema===7&&cached.at<=this.now()&&this.now()-cached.at<300000&&cached.targets.length){
   const valid=await Promise.all(cached.targets.map(freshTarget));
   const blocks=await Promise.all(cached.methods.flatMap(m=>m.samples).map(async s=>same((await header(s.block))?.hash,s.blockHash)));
   const assetCodes=await Promise.all((cached.assetCodes||[]).map(async a=>keccak256(await code(a.token,'latest'))===a.codeHash));
   if(valid.every(Boolean)&&blocks.every(Boolean)&&assetCodes.every(Boolean)){count('chainLearningCacheHits');return {...cached,cached:true,note:cached.note+' 已复核缓存的代码版本和样本区块。'};}
  }
  await this.logRpc.verifyChain();
  const head=Math.min(await this.rpc.getBlockNumber(),await this.logRpc.getBlockNumber()),to=Math.max(0,head-3),from=Math.max(0,to-scanBlocks+1),ranges=[];
  const span=issuanceOnly?50000:2048;
  for(let end=to;end>=from;end-=span)ranges.push([Math.max(from,end-span+1),end]);
  const logs=[],errors=[];let budgetExhausted=false;
  const withinBudget=()=>{if(this.now()<deadline)return true;budgetExhausted=true;return false;};
  // Provider limits are bounded; a disabled log endpoint is never treated as
  // evidence that nobody minted. No global block scan or background monitor.
  for(let i=0;i<ranges.length;i+=2){
   if(!withinBudget())break;
   const results=await Promise.allSettled(ranges.slice(i,i+2).map(async([a,b])=>{const v=await this.logRpc.send('eth_getLogs',[{address:seeds,fromBlock:tag(a),toBlock:tag(b),...(issuanceOnly?{topics:[TRANSFER,'0x'+'0'.repeat(64)]}:{})}]);if(!Array.isArray(v))throw Error('日志响应格式无效');return v.filter(l=>seeds.some(s=>same(s,l.address))&&!l.removed&&WORD.test(l.transactionHash||'')&&(!issuanceOnly||same(l.topics?.[0],TRANSFER)&&same(topicAddress(l.topics?.[1]),ZeroAddress))).slice(-4096);}));
   for(const r of results)if(r.status==='fulfilled')logs.push(...r.value);else errors.push(r.reason.message);
   if(errors.length===results.length&&!logs.length)break;
   if(new Set(logs.map(l=>l.transactionHash)).size>=this.maxReceipts)break;
  }
  const hashes=[...new Set(logs.sort((a,b)=>number(b.blockNumber)-number(a.blockNumber)||number(b.transactionIndex||0)-number(a.transactionIndex||0)).map(l=>l.transactionHash))],chosen=hashes.slice(0,this.maxReceipts);
  // Within the same latest-100 window, inspect issuance-looking receipts first.
  // Transfer-heavy collections no longer spend the entire bounded lookup time
  // on resales before reaching a mint. This is scheduling only, never proof.
  const issuance=new Set(logs.filter(l=>same(l.topics?.[0],TRANSFER)&&same(topicAddress(l.topics?.[1]),ZeroAddress)).map(l=>l.transactionHash));
  chosen.sort((a,b)=>Number(issuance.has(b))-Number(issuance.has(a)));
  const samples=[],scan={limit:this.maxReceipts,found:hashes.length,selected:chosen.length,checked:0,successful:0,accepted:0,rejected:0,reasons:{}};
  const reject=reason=>{scan.reasons[reason]=(scan.reasons[reason]||0)+1;return null;};
  for(let i=0;i<chosen.length;i+=4){
   if(!withinBudget())break;
   const results=await Promise.allSettled(chosen.slice(i,i+4).map(async h=>{
    const [tx,receipt]=await Promise.all([this.rpc.getTransaction(h),this.rpc.getTransactionReceipt(h)]);scan.checked++;if(!receipt||!tx)return reject('missing_receipt');
    const blockHeader=await header(number(receipt.blockNumber));let s=mintReceiptSample(tx,receipt,blockHeader,head),m;
    if(BigInt(receipt.status||0)===1n&&same(tx.hash,receipt.transactionHash)&&same(receipt.blockHash,blockHeader.hash))scan.successful++;
    // Some issuance sales pre-mint their inventory. Only a reviewed source-body
    // family can prove those transfers are distribution; ordinary transfers,
    // swaps and withdrawals still never become mint samples.
    if(!s&&receipt.logs?.some(l=>seeds.some(a=>same(a,l.address))&&same(topicAddress(l.topics?.[1]),tx.to))){
     m=await meta(tx.to);const family=recognizeSocialSale(m),iface=family?new Interface(m.abi):null;
     if(family?.kind==='identity-voucher-sale'&&['mint','claimFreeWithVoucher'].some(n=>iface.getFunction(n)?.selector===tx.input?.slice(0,10)))s=mintReceiptSample(tx,receipt,blockHeader,head,{inventoryIssuer:tx.to});
     const inferred=recognizeSourceSale(m);
     if(!s&&inferred?.inventory&&inferred.selector===tx.input?.slice(0,10)){
      const abi=new Interface(m.abi),raw=await this.rpc.call({to:tx.to,data:abi.encodeFunctionData(inferred.token.method)}),decoded=abi.decodeFunctionResult(inferred.token.method,raw);
      if(abi.encodeFunctionResult(inferred.token.method,decoded).toLowerCase()===raw.toLowerCase())s=mintReceiptSample(tx,receipt,blockHeader,head,{inventoryIssuer:tx.to,inventoryToken:decoded[0]});
     }
    }
    if(!s)return reject('not_verified_issuance');
    // A fetched receipt must actually include an event from a requested seed.
    if(!receipt.logs.some(l=>seeds.some(a=>same(a,l.address))))return reject('unrelated_receipt');
    if(forbiddenSeeds.has(s.target.toLowerCase()))return reject('support_contract');
    m??=await meta(s.target);const shape=runtimeShape(m.runtimeCode);
    if(m.identity?.implementation||m.proxy||shape.delegate||!shape.selectors.has(s.selector))return reject('unverified_dispatch');
    if(keccak256(await code(s.target,s.block))!==keccak256(m.runtimeCode))return reject('historical_code_changed');
    const eligible=[];
    for(const a of s.assets){
     const current=await code(a.token,'latest'),old=await code(a.token,s.block);if(current==='0x'||keccak256(current)!==keccak256(old))continue;
     const assetShape=runtimeShape(current);if(assetShape.delegate)continue;
     if(a.kind==='Erc721'){
      const proof=await receiptNftProof(this.rpc,a,s,current,historicalCall);if(!proof)continue;a.interfaceProof=proof;
     }else{
      const erc=new Interface(['function decimals() view returns(uint8)','function totalSupply() view returns(uint256)','function balanceOf(address) view returns(uint256)','function transfer(address,uint256) returns(bool)','function allowance(address,address) view returns(uint256)']);
      if(!erc.fragments.every(f=>assetShape.selectors.has(f.selector)))continue;
      const raw=await this.rpc.call({to:a.token,data:erc.encodeFunctionData('decimals')}),v=erc.decodeFunctionResult('decimals',raw);if(erc.encodeFunctionResult('decimals',v)!==raw||v[0]>36n)continue;
     }
     eligible.push({...a,codeHash:keccak256(current)});
    }
    if(!eligible.length)return reject('asset_not_verified');
    let fn=null,args=null,runtimeQuantity=false;try{
     const known=m.verified?null:recognizeMint(m),abi=new Interface(m.verified?m.abi:known.abi);
     const parsed=abi.parseTransaction({data:s.input,value:BigInt(s.value)});
     const route=known?.routes.find(r=>abi.getFunction(r.method)?.selector===s.selector);
     runtimeQuantity=!!route&&route.roles.length===1&&route.roles[0]==='quantity'&&parsed?.args[0]>0n&&parsed.args[0]<=500n;
     if(m.verified||runtimeQuantity){fn=parsed?.fragment;if(fn&&abi.encodeFunctionData(fn,parsed.args).toLowerCase()===s.input.toLowerCase())args=parsed.args;else fn=null;}
    }catch{}
    const guarded=fn&&recognizeGuardedIdMint(m)?.routes.find(r=>r.selector===s.selector),direct=fn&&recognizeDirectTokenMint(m),directMatch=direct&&fn.format('sighash')===direct.methods.paid;
    const social=fn&&recognizeSocialSale(m),socialPaid=social&&['mint','mintWithBnb'].includes(fn.name);
    const socialFree=social&&['freeMint','claimFreeWithVoucher'].includes(fn.name);
    const inferred=fn&&recognizeSourceSale(m),inferredMatch=inferred&&inferred.selector===s.selector;
    const roles=guarded?.roles||(inferredMatch?inferred.roles.map(r=>r==='zero'?'referrer':r):socialPaid?fn.inputs.map((p,i)=>i===0?'quantity':p.type==='address'?'referrer':'cost'):socialFree?fn.name==='freeMint'?['task','id','signature']:['id','usernameHash','postIdHash','deadline','signature']:directMatch?fn.inputs.map(p=>p.type==='string'?'label':'quantity'):null),quantityIndex=roles?.indexOf('quantity');
    const quantity=roles&&args[quantityIndex]>0n&&args[quantityIndex]<=500n?String(args[quantityIndex]):fn?.inputs.length===1&&/^uint\d*$/.test(fn.inputs[0].type)&&/^_?(?:q|qty|quantity|amount|count|n|shares|cards|tokens|numTokens|num|numberOfTokens|mintAmount|mints)$/i.test(fn.inputs[0].name)&&args[0]>0n&&args[0]<=500n?String(args[0]):null;
    const {input,...safe}=s;return {...safe,assets:eligible,fingerprint:m.hash,sourceVerified:!!m.verified,runtimeQuantity,method:fn?.format('sighash')||null,quantity,requiresSiteProof:!!socialFree,construction:inferredMatch?inferred.kind:guarded?'guarded-agent-id-quote':social?social.kind:directMatch?direct.kind:null,parameterRoles:roles};
   }));
   for(const r of results)if(r.status==='fulfilled'&&r.value){samples.push(r.value);scan.accepted++;}else{scan.rejected++;if(r.status==='rejected'){reject(/archive|historical|pruned|missing trie/i.test(r.reason.message)?'historical_rpc_unavailable':'query_failed');errors.push(r.reason.message);}}
  }
  const grouped=new Map();for(const s of samples){const k=s.target.toLowerCase()+s.selector;const list=grouped.get(k)||[];list.push(s);grouped.set(k,list);}
  const methods=[];
  for(const list of grouped.values()){
   const first=list[0],participants=new Set(list.map(s=>s.from.toLowerCase())).size;
   const shared=first.assets.filter(a=>list.every(s=>s.assets.some(b=>same(a.token,b.token)&&a.kind===b.kind)));
   // Prefer the NFT as a mint receipt when it also awards a separate ERC20.
   const nfts=shared.filter(a=>a.kind==='Erc721'),output=nfts.length===1?nfts[0]:shared.length===1?shared[0]:null;
   const q=list.every(s=>s.quantity!==null),noArgs=list.every(s=>s.inputBytes===4);
   let perUnit=null;if(output){const amounts=list.map(s=>BigInt(s.assets.find(a=>same(a.token,output.token)&&a.kind===output.kind).amount)),units=list.map(s=>q?BigInt(s.quantity):1n);if(amounts.every((a,i)=>a%units[i]===0n)){const ratios=amounts.map((a,i)=>a/units[i]);if(ratios.every(r=>r===ratios[0]))perUnit=String(ratios[0]);}}
   // Unverified known mint(uint256) dispatch may only learn a one-unit call
   // observed for two participants. Never reinterpret unknown calldata words,
   // extrapolate to bulk quantities, or derive payment from sample tx.value.
   const runtimeOne=q&&list.every(s=>s.runtimeQuantity)&&new Set(list.filter(s=>s.quantity==='1').map(s=>s.from.toLowerCase())).size>=2;
   const usable=participants>=2&&!!output&&(!!perUnit||first.construction==='guarded-agent-id-quote')&&(noArgs||(first.sourceVerified||runtimeOne)&&q);
   methods.push({target:first.target,selector:first.selector,method:first.method,sourceVerified:first.sourceVerified,maxQuantity:runtimeOne?1:null,fingerprint:first.fingerprint,participants,noArgs,quantity:q,usable,requiresSiteProof:first.requiresSiteProof,construction:first.construction,parameterRoles:first.parameterRoles,output:output?{token:output.token,kind:output.kind,minPerUnit:perUnit}:null,assets:shared.map(({amount,...a})=>a),
    reason:first.requiresSiteProof?'已核验免费签名接口；需要当前钱包的官网凭证，历史签名不可重放':participants<2?'尚不足两个不同参与者的成功样本':!output?'到账资产存在歧义':first.construction==='guarded-agent-id-quote'?'已识别身份＋实时报价＋起始编号＋最低到账＋截止时间；以本钱包重新构造':first.construction==='agent-direct-erc20'&&perUnit?'已核验身份名称＋份数的直接 ERC20 付款接口；本钱包重新查询报价、额度与授权，未复用历史身份或凭证':!noArgs&&first.sourceVerified&&!q?'已找到成功 Mint，但尚未核验各参数含义（身份、签名、证明或业务参数），不能照抄 calldata':!perUnit?'样本到账数量不一致，不能推定份数':!noArgs&&!((first.sourceVerified||runtimeOne)&&q)?'参数需要签名、证明、身份或其他业务含义，不能照抄 calldata':'已核验成功样本；本钱包仍须重新查询报价、额度和官方模拟',
    samples:list.map(({txHash,block,blockHash,from,value,inputBytes,quantity,assets})=>({txHash,block,blockHash,from,value,inputBytes,quantity,assets}))});
  }
  const targets=[];
  for(const target of [...new Set(methods.map(m=>m.target))]){
   const mm=methods.filter(m=>same(m.target,target)),m=await meta(target),assets=mm.flatMap(x=>x.assets),participants=new Set(mm.flatMap(x=>x.samples.map(s=>s.from.toLowerCase()))).size;
   let linked=seeds.some(a=>same(a,target));
   if(!linked&&participants>=2){
    const known=['token','TOKEN','mintToken','rewardToken','coin','asset','nft','collection','pass','receipt'].map(n=>'function '+n+'() view returns(address)');
    const sourceGetters=m.verified?new Interface(m.abi).fragments.filter(f=>f.type==='function'&&['view','pure'].includes(f.stateMutability)&&!f.inputs.length&&f.outputs.length===1&&f.outputs[0].type==='address'):[];
    const getters=new Interface([...known,...sourceGetters]),shape=runtimeShape(m.runtimeCode);
    const candidates=[...new Map(getters.fragments.filter(f=>shape.selectors.has(f.selector)).map(f=>[f.selector,f])).values()].slice(0,16);
    const links=await Promise.allSettled(candidates.map(async f=>{const raw=await this.rpc.call({to:target,data:getters.encodeFunctionData(f)}),[v]=getters.decodeFunctionResult(f,raw);return getters.encodeFunctionResult(f,[v])===raw&&seeds.some(a=>same(a,v))&&assets.some(a=>same(a.token,v));}));
    linked=links.some(r=>r.status==='fulfilled'&&r.value);
   }
   targets.push({address:target,fingerprint:m.hash,participants,linked,corroborated:linked&&participants>=2,assets:[...new Map(assets.map(a=>[a.token,a])).values()]});
  }
  const value={schema:7,chainId:56,status:methods.length?'observed':budgetExhausted?'time-budget':errors.length?'unavailable':'no-samples',at:this.now(),range:{from,to,head},issuanceOnly,scan,seeds,targets,methods,assetCodes:[...new Map(methods.flatMap(m=>m.assets).map(a=>[a.token,{token:a.token,codeHash:a.codeHash}])).values()],partial:budgetExhausted||!!errors.length||hashes.length>chosen.length,budgetExhausted,errors:errors.slice(0,3),note:(budgetExhausted?'自动链上回查达到时间预算，已保留核验结果；可用深度识别继续扩大回查。':'')+(issuanceOnly?'按零地址发行事件索引扩大检索；':'')+'在最近 '+scanBlocks+' 个区块内选取最近记录、优先核验发行事件，最多核验 '+this.maxReceipts+' 笔，实际已查 '+scan.checked+' 笔，成功回执 '+scan.successful+' 笔，可核验铸造样本 '+scan.accepted+' 笔；范围外或无事件的交易不在本次检索内，没有样本不代表无人铸造。历史付款和额度不作为本次报价，未复制他人签名、证明或邀请。'};
  if(methods.length)save(file,value);return value;
 }
}
export function learnerFor(rpc){if(!stock.has(rpc))stock.set(rpc,new ChainLearner(rpc));return stock.get(rpc);}
