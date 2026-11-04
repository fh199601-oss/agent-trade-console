import fs from 'node:fs';import path from 'node:path';import {randomBytes} from 'node:crypto';
import {Interface,keccak256,toUtf8Bytes,ZeroAddress} from 'ethers';
import parser from '@solidity-parser/parser';
import {BNB,USDT,ERC20,same,parseUnits,hash} from './common.mjs';
import {runtimeShape} from './bytecode.mjs';import {chooseBatch,min,positive} from './mint-policy.mjs';

// Interface families, not domain/address allowlists. Novel fee semantics still
// require a separate adapter and the official preview of the current wallet.
const families={
 'priced-token-claim':['claim()','claimed(address)','CLAIM_PRICE()','CLAIM_AMOUNT()','MAX_CLAIMS()','totalClaims()','airdropRemaining()','graduated()','agentId()','decimals()','balanceOf(address)','totalSupply()'],
 'random-token-claim':['claim()','claimShare()','hasClaimed(address)','hasShareClaimed(address)','claimFeeWei()','claimOpen()','claimCount()','claimedAmount(address)','poolRemaining()','token()'],
 'agent-random-token-claim':['claim()','hasClaimed(address)','claimFeeWei()','claimOpen()','claimCount()','poolRemaining()','AGENT_ID()','CLAIM_FEE_USD()','CLAIM_POOL()','BNB_USD_FEED()','balanceOf(address)','totalSupply()','decimals()'],
 'arithmetic-nft':['mint(uint256,uint256)','challengeOf(address)','agentIdOf(address)','agentIdPaidMints(bytes32)','walletPaidMints(address)','hasUsedFree(address)','isFreePhase()','MAX_PAID_PER_WALLET()','MAX_SUPPLY()','totalMinted()','PRICE()','quote(address,uint256)'],
 'commitment-key-nft':['mint(bytes32)','quoteMint(address)','season()','seasonEnd()','seasonOpen()','mintedBy(uint256,address)','MAX_PER_WALLET()','MAX_IRON_PER_SEASON()','nextKeyId()','usedFree(uint256,address)','freeFee()','PRICE()'],
 'trial-key-nft':['mintTrial()','buyKey()','keyNFT()','TRIAL_FEE()','KEY_PRICE()','trialMintedEver(address)','MAX_KEYS_PER_ID()','MAX_PAID_KEYS()','saleActive()','saleClosed()','seasonEnd()'],
 'deferred-subscription':['joinPollen()','buy(uint256)','claim()','agentInfo(address)','phase()','accounts(address)','token()','SHARE()','pollenSlice()','PAID_SHARES()'],
 'erc20-priced-nft':['mint(uint256)','paymentToken()','mintPrice()','MAX_PER_WALLET()','MAX_SUPPLY()','mintedByWallet(address)','minted()','ended()','saleDeadline()','emergencyCancelled()','eligibility()'],
 'bounded-native-token':['mintWithBnb(uint256,uint256,uint256,uint256,uint256)','quoteBnb(uint256)','quote(uint256)','agentOf(address)','mintedById(uint256)','MAX_PER_ID()','MAX_PER_TX()','TOTAL_SHARES()','totalMinted()','MAX_TTL()','retired()','closed()','token()'],
 'signed-quest-nft':['mint((address,uint256,bytes32,uint256,uint256,uint256),bytes)','hashVoucher((address,uint256,bytes32,uint256,uint256,uint256))','agentInfo(address)','mintPaused()','price()','signer()','seedUsed(bytes32)','MAX_SUPPLY()','totalMinted()']
 ,'identity-counter-nft':['mint(uint256,uint256,uint256)','quote(uint256,uint256)','identity()','identityCodeHash()','mintedByIdentity(uint256)','MAX_PER_ID()','MAX_SUPPLY()','totalMinted()','mintPrice()','mintEnabled()','mintEnded()','supportsInterface(bytes4)']
};
const vaultAbi=['mint(address referrer,uint256 minTokensOut) payable','quoteMint(uint256 slippageBps) returns(uint256 bnbCost,uint256 bought,uint256 minTokensOut,uint256 payout)','hasMinted(address) view returns(bool)','ended() view returns(bool)','paused() view returns(bool)','token() view returns(address)','agentNft() view returns(address)','usdt() view returns(address)','mintUsdt() view returns(uint256)','swapUsdt() view returns(uint256)','payoutUsdt() view returns(uint256)'];
const vaultInterface=new Interface(vaultAbi.map(s=>'function '+s));
const vrfAbi=['mintPaid((uint8 expectedOrdinal,uint8 method,uint256 maxAmount,uint256 maxRandomnessFeeWei,uint256 deadline,address inviter)) payable returns(uint256)','quote(address) view returns(bytes32 key,uint8 minted,uint256 price,uint8 remaining)','quoteBNB(uint8) view returns(uint256)','MAX_MINTS() view returns(uint8)','MAX_SUPPLY() view returns(uint256)','totalMinted() view returns(uint256)','paused() view returns(bool)','activated() view returns(bool)','legacy() view returns(address)','legacySupplyAtActivation() view returns(uint256)','estimateRandomnessFee(uint256) view returns(uint256)','agentRegistry() view returns(address)','paymentToken() view returns(address)','balanceOf(address) view returns(uint256)','ownerOf(uint256) view returns(address)'];
const vrfInterface=new Interface(vrfAbi.map(s=>'function '+s));
export function recognizeSpecialMint(meta){
 const shape=runtimeShape(meta.runtimeCode);if(meta.proxy||shape.delegate)return null;
 if(vaultInterface.fragments.every(f=>shape.selectors.has(f.selector)))return {kind:'native-swap-vault',abi:meta.verified?meta.abi:vaultAbi.map(s=>'function '+s)};
 if(vrfInterface.fragments.every(f=>shape.selectors.has(f.selector)))return {kind:'ordinal-vrf-nft',abi:meta.verified?meta.abi:vrfAbi.map(s=>'function '+s)};
 if(!meta.verified)return null;
 const abi=new Interface(meta.abi),matches=Object.entries(families).filter(([,methods])=>methods.every(s=>{const f=abi.getFunction(s);return f&&shape.selectors.has(f.selector);}));
 if(matches.length!==1)return null;
 if(matches[0][0]==='arithmetic-nft'){
  const code=Object.values(meta.sources||{}).map(s=>s.content).join('\n').replace(/\s/g,'');
  if(!code.includes('return(a*b)+bytes(handle).length;')||!code.includes('stringmemoryhandle=agentIdOf(wallet);'))return null;
 }
 if(matches[0][0]==='identity-counter-nft'){
  // Reviewed quote/ownership/counter/batch body, independent of address,
  // constructor prices, supply and website. Comments cannot satisfy the proof.
  let matched=false;for(const source of Object.values(meta.sources||{}))try{parser.visit(parser.parse(source.content),{ContractDefinition(c){const f=c.subNodes.filter(n=>n.type==='FunctionDefinition'&&n.body&&['mint','quote','_identityOwner','_mintBatch'].includes(n.name));if(f.length===4&&hash(f.sort((a,b)=>a.name.localeCompare(b.name)).map(f=>({name:f.name,parameters:f.parameters,body:f.body})))==='e96767988bc081846c8188d742c4f19eef27df5e7693aebd1ea25439b09cbac6')matched=true;}});}catch{}if(!matched)return null;
 }
 return {kind:matches[0][0],abi:meta.abi};
}
function stop(code,message,details){throw Object.assign(Error(message),{code,details});}
export async function specialMintState(rpc,intent,meta,w,profile=recognizeSpecialMint(meta)){
 if(!profile)return null;
 const abi=new Interface(profile.abi),block=await rpc.getBlockNumber(),rawBlock=await rpc.send('eth_getBlockByNumber',['0x'+block.toString(16),false]),now=BigInt(rawBlock.timestamp);
 const call=async(to,iface,name,args=[])=>{const raw=await rpc.call({from:w.address,to,data:iface.encodeFunctionData(name,args)},block),r=iface.decodeFunctionResult(name,raw);if(iface.encodeFunctionResult(name,r).toLowerCase()!==raw.toLowerCase())throw Error('接口返回格式不规范：'+name);return r.length===1?r[0]:r;};
 const get=(name,args=[])=>call(meta.address,abi,name,args),readMany=names=>Promise.all(names.map(n=>typeof n==='string'?get(n):get(...n)));
 const s={name:profile.kind,token:meta.address,assetKind:'Erc721',free:0n,paid:0n,txCap:1n,inputToken:BNB,block,abi,get,call,info:{block,currency:'BNB'}};
 const step=(name,args,cost)=>({kind:'mint',to:meta.address,data:abi.encodeFunctionData(name,args),value:String(s.inputToken===BNB?cost:0n)});
 const nft=async()=>{if(!await get('supportsInterface',['0x80ac58cd']))throw Error('NFT 接口核验失败');};
 if(profile.kind==='identity-counter-nft'){
  const [registry,registryHash,open,ended,cap,max,total,price]=await readMany(['identity','identityCodeHash','mintEnabled','mintEnded','MAX_PER_ID','MAX_SUPPLY','totalMinted','mintPrice']);
  if(ended||total>=max)stop('MINT_ENDED','基础铸造已结束');if(!open)stop('MINT_NOT_OPEN','基础铸造暂未开放');
  if(!same(registry,'0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F')||keccak256(await rpc.getCode(registry,block))!==registryHash)stop('MINT_STATE','项目身份注册合约或代码校验不一致');
  const regAbi=new Interface(['function handleOf(address) view returns(string)','function ownerOf(uint256) view returns(address)']);
  const handle=await call(registry,regAbi,'handleOf',[w.address]);if(!handle||handle.length>256)stop('MINT_INELIGIBLE','当前钱包没有有效的 Agent ID');const id=BigInt(keccak256(toUtf8Bytes(handle)));
  const [owner,used]=await Promise.all([call(registry,regAbi,'ownerOf',[id]),get('mintedByIdentity',[id])]);if(!same(owner,w.address))stop('MINT_INELIGIBLE','当前钱包不是 Agent ID 所有者');await nft();
  const room=min(positive(cap-used),positive(max-total));s.free=used===0n&&room>0n?1n:0n;s.paid=room-s.free;s.mixed=true;s.txCap=cap;s.info.agentId=handle;
  s.info.notes=['基础免费 / 付费铸造已适配；额外修复奖励仍需官网给当前钱包签发的凭证'];
  s.quote=async n=>{const cost=await get('quote',[id,n]);if(cost!==(n-(s.free>0n?1n:0n))*price)throw Error('身份报价与免费份数不一致');return {cost,out:n,step:step('mint',[id,n,used],cost)};};
 }else if(['random-token-claim','agent-random-token-claim'].includes(profile.kind)){
  const gated=profile.kind==='agent-random-token-claim';
  const [open,used,fee,remaining]=await readMany(['claimOpen',['hasClaimed',[w.address]],'claimFeeWei','poolRemaining']),token=gated?meta.address:await get('token');
  if(used||remaining===0n)stop('NO_QUOTA','当前钱包基础领取额度已用完或池子为空');if(!open)stop('MINT_NOT_OPEN','领取入口当前未开放');
  if(gated&&await call(await get('AGENT_ID'),ERC20,'balanceOf',[w.address])===0n)stop('MINT_INELIGIBLE','当前钱包没有项目要求的 Agent ID');
  s.token=token;s.assetKind='Erc20';s.free=fee===0n?1n:0n;s.paid=fee>0n?1n:0n;s.info.deferredUse='随机数量领取：模拟到账数量不保证下一区块相同；这里只构造基础领取，不自动执行分享奖励';s.quote=async()=>({cost:fee,out:1n,step:step('claim',[],fee)});
 }else if(profile.kind==='priced-token-claim'){
  const [done,used,price,amount,cap,total,remaining,registry]=await readMany(['graduated',['claimed',[w.address]],'CLAIM_PRICE','CLAIM_AMOUNT','MAX_CLAIMS','totalClaims','airdropRemaining','agentId']);
  if(done||total>=cap)stop('MINT_ENDED','领取阶段已结束，后续买卖走交易入口');if(used)stop('NO_QUOTA','当前钱包已经领取');if(await call(registry,ERC20,'balanceOf',[w.address])===0n)stop('MINT_INELIGIBLE','当前钱包没有项目要求的 Agent ID');if(amount<=0n||remaining<amount)stop('NO_QUOTA','领取池剩余数量不足');
  s.assetKind='Erc20';s.free=price===0n?1n:0n;s.paid=price>0n?1n:0n;s.quote=async()=>({cost:price,out:amount,step:step('claim',[],price)});
 }else if(profile.kind==='arithmetic-nft'){
  const [challenge,handle,freePhase,usedFree,cap,max,total,price,used]=await readMany([['challengeOf',[w.address]],['agentIdOf',[w.address]],'isFreePhase',['hasUsedFree',[w.address]],'MAX_PAID_PER_WALLET','MAX_SUPPLY','totalMinted','PRICE',['walletPaidMints',[w.address]]]);
  if(!handle)stop('MINT_INELIGIBLE','当前钱包没有项目要求的 Agent ID');await nft();
  const idUsed=await get('agentIdPaidMints',[keccak256(toUtf8Bytes(handle))]),answer=challenge[1]*challenge[2]+BigInt(toUtf8Bytes(handle).length),stock=positive(max-total);
  s.free=freePhase&&!usedFree?min(1n,stock):0n;s.paid=freePhase?0n:min(positive(cap-used),positive(cap-idUsed),stock);s.txCap=cap;
  s.quote=async(n,lane)=>{const cost=lane==='free'?0n:price*n;return {cost,out:n,step:step(lane==='free'?'mintFree':'mintPaid',lane==='free'?[answer]:[n,answer],cost)};};
 }else if(profile.kind==='commitment-key-nft'){
  const [paused,open,end,season,cap,max,total,next,quoted]=await readMany(['paused','seasonOpen','seasonEnd','season','MAX_PER_WALLET','MAX_IRON_PER_SEASON','minted','nextKeyId',['quoteMint',[w.address]]]);
  if(paused)stop('MINT_PAUSED','合约已暂停铸造');if(!open||now>=end)stop('MINT_ENDED','本期钥匙铸造已结束');await nft();
  const used=await get('mintedBy',[season,w.address]),room=min(positive(cap-used),positive(max-total));
  s.free=quoted[0]===0n?min(1n,room):0n;s.paid=room-s.free;s.mixed=true;s.commitmentKey=hash([meta.identity.fingerprint,w.address,String(season),String(next)]);
  s.quote=async n=>({cost:quoted[0],out:n,step:null});s.info.deferredUse='铸造钥匙后开门需要另行使用本地保存的秘密；本次不执行开门或销毁钥匙';
 }else if(profile.kind==='trial-key-nft'){
  const [active,closed,end,token,trialFee,price,trialUsed,cap,max]=await readMany(['saleActive','saleClosed','seasonEnd','keyNFT','TRIAL_FEE','KEY_PRICE',['trialMintedEver',[w.address]],'MAX_KEYS_PER_ID','MAX_PAID_KEYS']);
  if(closed||now>=end)stop('MINT_ENDED','钥匙发售阶段已结束');if(!active)stop('MINT_NOT_OPEN','钥匙发售尚未开放');
  const nftAbi=new Interface(['function paidBalanceOf(address) view returns(uint256)','function paidMinted() view returns(uint256)','function supportsInterface(bytes4) view returns(bool)']);
  const [held,minted,isNft]=await Promise.all([call(token,nftAbi,'paidBalanceOf',[w.address]),call(token,nftAbi,'paidMinted'),call(token,nftAbi,'supportsInterface',['0x80ac58cd'])]);if(!isNft)throw Error('钥匙 NFT 接口未核验');s.token=token;
  s.routes=[{id:'special:mintTrial',label:'体验钥匙（按链上费用）',method:'mintTrial()'},{id:'special:buyKey',label:'正式钥匙',method:'buyKey()'}];
  const trial=intent.routeId==='special:mintTrial'||intent.scope==='free';s.free=trial&&!trialUsed&&trialFee===0n?1n:0n;s.paid=trial?trialUsed?0n:1n:min(positive(cap-held),positive(max-minted));
  s.quote=async n=>({cost:trial?trialFee:price,out:n,step:step(trial?'mintTrial':'buyKey',[],trial?trialFee:price)});s.info.trialFee=String(trialFee);
 }else if(profile.kind==='deferred-subscription'){
  const [phase,agent,token,price,share]=await readMany(['phase',['agentInfo',[w.address]],'token','price','SHARE']);s.token=token;s.assetKind='Erc20';
  s.info.workflow={kind:'subscribe-then-claim',phase:Number(phase),paidShares:String(agent[2]),registered:agent[3],claimed:agent[4],claimable:String(agent[7]),price:String(price),tokensPerShare:String(share)};
  if(phase===0n)stop('MINT_NOT_OPEN','认购尚未开放',s.info);
  if(phase===2n||phase===4n)stop('MINT_ENDED','认购已结束，尚未进入可领取阶段',s.info);
  if(phase===3n){if(agent[7]===0n)stop('NO_QUOTA','项目已开盘，本钱包没有可领取份额',s.info);s.free=1n;s.quote=async()=>({cost:0n,out:agent[7],step:step('claim',[],0n)});}
  else {if(!agent[0])stop('MINT_INELIGIBLE','当前钱包没有项目要求的 Agent ID',s.info);stop('DEFERRED_MINT_REQUIRED','该类型先登记或付费认购，开盘后另行领取；当前不能作为即时到账 Mint 执行', {...s.info,workflowSteps:[{method:'joinPollen()',value:'0',alreadyDone:agent[3]},{method:'buy(uint256)',unitPrice:String(price),remaining:String(agent[6])},{method:'claim()',requires:'launched() = true'}]});}
 }else if(profile.kind==='erc20-priced-nft'){
  const [ended,cancelled,deadline,token,price,cap,max,used,total]=await readMany(['ended','emergencyCancelled','saleDeadline','paymentToken','mintPrice','MAX_PER_WALLET','MAX_SUPPLY',['mintedByWallet',[w.address]],'minted']);
  if(ended||cancelled||deadline>0n&&now>=deadline)stop('MINT_ENDED','本期发售已结束');if(!same(token,USDT))stop('MINT_UNSUPPORTED','该付费 NFT 使用的付款币尚未支持');await nft();
  s.inputToken=USDT;s.info.currency='USDT';s.txCap=cap;const room=min(positive(cap-used),positive(max-total));s.free=price===0n?room:0n;s.paid=price>0n?room:0n;s.quote=async n=>({cost:price*n,out:n,step:step('mint',[n],price*n)});
 }else if(profile.kind==='bounded-native-token'){
  const [retired,closed,paused,agent,cap,txCap,max,total,token,ttl]=await readMany(['retired','closed','paused',['agentOf',[w.address]],'MAX_PER_ID','MAX_PER_TX','TOTAL_SHARES','totalMinted','token','MAX_TTL']);
  if(retired||closed)stop('MINT_ENDED','铸造阶段已关闭');if(paused)stop('MINT_PAUSED','合约已暂停铸造');if(agent===0n)stop('MINT_INELIGIBLE','当前钱包没有项目要求的 Agent ID');
  s.token=token;s.assetKind='Erc20';s.txCap=txCap;s.paid=min(positive(cap-await get('mintedById',[agent])),positive(max-total));
  s.quote=async n=>{const [quote,bnb]=await Promise.all([get('quote',[n]),get('quoteBnb',[n])]);if(bnb[0]!==quote[0]||bnb[1]<=0n||bnb[1]>bnb[2])throw Error('原生币报价与计价币报价不一致');const cost=bnb[1],out=quote[1]*BigInt(10000-(intent.slippageBps??100))/10000n;if(out<=0n)throw Error('最低到账为零');return {cost,out,step:step('mintWithBnb',[n,quote[0],cost,out,now+min(ttl,300n)],cost)};};
 }else if(profile.kind==='native-swap-vault'){
  const [ended,paused,used,token,reg,pay,swap,payout]=await readMany(['ended','paused',['hasMinted',[w.address]],'token','agentNft','usdt','swapUsdt','payoutUsdt']);
  if(ended)stop('MINT_ENDED','合约发售已结束');if(paused)stop('MINT_PAUSED','合约已暂停铸造');if(!same(pay,USDT)||swap===0n||payout===0n)throw Error('Vault 计价参数未核验');
  if(await call(reg,ERC20,'balanceOf',[w.address])===0n)stop('MINT_INELIGIBLE','当前钱包没有项目要求的 Agent ID');s.token=token;s.assetKind='Erc20';s.paid=used?0n:1n;
  s.quote=async()=>{const q=await get('quoteMint',[intent.slippageBps??100]);if(q[0]<=0n||q[2]<=0n||q[2]>q[1]||q[3]!==q[1]*payout/swap)throw Error('Vault 报价不一致');const out=q[2]*payout/swap;return {cost:q[0],out,step:step('mint',[ZeroAddress,q[2]],q[0])};};
 }else if(profile.kind==='ordinal-vrf-nft'){
  const [paused,active,old,frozen,q,max,total,cap,payment,reg,gas]=await readMany(['paused','activated','legacy','legacySupplyAtActivation',['quote',[w.address]],'MAX_SUPPLY','totalMinted','MAX_MINTS','paymentToken','agentRegistry']).then(async a=>[...a,BigInt(await rpc.send('eth_gasPrice',[]))]);
  if(paused)stop('MINT_PAUSED','合约已暂停铸造');if(!active)stop('MINT_NOT_OPEN','新版合约尚未激活');if(!same(payment,USDT)||q[1]+q[3]!==cap||total>max||gas<=0n)throw Error('顺序铸造接口参数不一致');
  const [oldPaused,oldTotal,fee,agent]=await Promise.all([call(old,abi,'paused'),call(old,abi,'totalMinted'),get('estimateRandomnessFee',[gas]),call(reg,ERC20,'balanceOf',[w.address])]);
  if(!oldPaused||oldTotal!==frozen)throw Error('旧版合约尚未冻结，不能确定累计额度');if(!agent)stop('MINT_INELIGIBLE','当前钱包没有项目要求的 Agent ID');if(!q[3]||total===max)stop('NO_QUOTA','本钱包或项目额度已用完');
  if(fee<=0n)throw Error('随机数费用无效');const cost=q[2]===0n?0n:await get('quoteBNB',[q[1]+1n]);
  s.free=0n;s.paid=min(q[3],max-total);s.info.randomnessFee=String(fee);s.info.ordinal=Number(q[1]+1n);s.info.cardPriceBnb=String(cost);
  // Full current randomness fee is explicit Mint spending, never zero-budget Gas.
  // Older sponsored variants may allow zero; do not infer sponsorship by address.
  s.quote=async n=>({cost:cost+fee,out:n,step:step('mintPaid',[[q[1]+1n,cost?2:0,cost,fee,now+300n,ZeroAddress]],cost+fee)});
 }else if(profile.kind==='signed-quest-nft'){
  const [paused,agent,max,total,price]=await readMany(['mintPaused',['agentInfo',[w.address]],'MAX_SUPPLY','totalMinted','price']);
  if(paused)stop('MINT_PAUSED','合约已暂停铸造');if(!agent[0])stop('MINT_INELIGIBLE','当前钱包没有项目要求的 Agent ID');if(agent[3]===0n||total>=max)stop('NO_QUOTA','本钱包或项目额度已用完');
  const proof=intent.siteProof,required=['agent','index','seed','attempts','solveSecs','deadline','signature'];
  if(!proof)stop('SITE_PROOF_REQUIRED','已识别签名凭证 Mint：需要当前钱包完成官网任务后取得未过期 voucher；可通过 siteProof 传入，不能复制其他钱包凭证',{adapter:profile.kind,price:String(price),walletRemaining:String(agent[3]),index:String(agent[2]),required});
  if(!same(proof.agent,w.address)||BigInt(proof.index)!==agent[2]||BigInt(proof.deadline)<now||BigInt(proof.attempts)<1n||BigInt(proof.attempts)>65535n||BigInt(proof.solveSecs)>4294967295n||BigInt(proof.seed)===0n||await get('seedUsed',[proof.seed]))stop('SITE_PROOF_INVALID','官网凭证的钱包、当前序号、期限或题目已失效；需获取当前钱包的新凭证');
  await nft();s.free=price===0n?1n:0n;s.paid=price>0n?1n:0n;s.info.walletRemaining=String(agent[3]);s.info.proofBoundToWallet=true;
  // The contract itself validates the current signer (including ERC1271) in
  // eth_call below. Never treat a decoded voucher or another user's tx as proof.
  s.quote=async n=>({cost:price,out:n,step:step('mint',[required.slice(0,6).map(k=>proof[k]),proof.signature],price)});
 }
 s.info={...s.info,freeRemaining:String(s.free),paidRemaining:String(s.paid),assetKind:s.assetKind};return s;
}
export async function specialMintPlan(rpc,intent,meta,w,resolved,{data,profile=recognizeSpecialMint(meta)}={}){
 if(!profile)return null;const s=await specialMintState(rpc,intent,meta,w,profile);
 if(intent.referral!=='none'&&[2,3].includes(intent.account)&&resolved.referralHints?.detected)stop('REFERRAL_NOT_VERIFIED','该流程的邀请身份尚未核验，未静默忽略邀请');
 if(s.routes&&intent.scope!=='free'&&!intent.routeId)stop('MINT_ROUTE_REQUIRED','请选择体验钥匙或正式钥匙',{routes:s.routes});
 if(s.routes&&intent.routeId&&!s.routes.some(r=>r.id===intent.routeId))stop('MINT_ROUTE_REQUIRED','该入口选择已失效',{routes:s.routes});
 const budget=parseUnits(s.inputToken===USDT?intent.maxUsdt||'0':intent.maxBnb||'0',18),q=await chooseBatch(s,intent,budget);
 let commitment;
 if(s.commitmentKey){
  if(!data)throw Error('未配置本地秘密保存目录，无法创建可用的钥匙');
  const dir=path.join(data,'mint-secrets');fs.mkdirSync(dir,{recursive:true,mode:0o700});const file=path.join(dir,s.commitmentKey+'.json');
  let saved;try{saved=JSON.parse(fs.readFileSync(file));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!saved){const secret='0x'+randomBytes(32).toString('hex');saved={secret,commitment:keccak256(secret),wallet:w.address,target:meta.address};fs.writeFileSync(file,JSON.stringify(saved),{flag:'wx',mode:0o600});}
  if(!same(saved.wallet,w.address)||!same(saved.target,meta.address)||keccak256(saved.secret)!==saved.commitment)throw Error('本地钥匙秘密记录不匹配');
  commitment={id:s.commitmentKey,hash:saved.commitment};q.step={kind:'mint',to:meta.address,data:s.abi.encodeFunctionData('mint',[saved.commitment]),value:String(q.cost)};
 }
 const steps=[];if(s.inputToken===USDT){const allowance=await s.call(USDT,ERC20,'allowance',[w.address,meta.address]);if(allowance<q.cost)steps.push({kind:'approve',to:USDT,value:'0',data:ERC20.encodeFunctionData('approve',[meta.address,q.cost]),spender:meta.address,allowance:String(q.cost)});}
 if(!steps.length)await rpc.call({from:w.address,to:q.step.to,data:q.step.data,value:BigInt(q.step.value)},s.block);
 return {kind:'contract',route:s.name,wallet:w.address,token:s.token,inputToken:s.inputToken,outputToken:s.token,amountIn:String(q.cost),minOutput:String(q.out),quantity:Number(q.n),identity:meta.identity,metaVerified:meta.verified,expectedAsset:{token:s.token,kind:s.assetKind,amount:String(q.out)},requireAssetCredit:true,requireNftCredit:s.assetKind==='Erc721',freshBeforeExecute:true,quota:s.info,commitment,review:[s.info.deferredUse||'按当前钱包、当前报价构造，适配不代表安全审计'],fill:{continue:q.continue,lane:q.lane,remainingBefore:String(q.remaining)},budgetCurrency:s.info.currency,steps:[...steps,q.step]};
}
