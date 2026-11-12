import fs from 'node:fs';
import {keccak256} from 'ethers';
import {Interface,read,same,BNB,ERC20,ZeroAddress,wallet,parseUnits,address,hash,formatUnits} from './common.mjs';
import {codeIdentity} from './discovery.mjs';
import {getJson} from './network.mjs';
import {normalizeAssetInput} from '../public/asset-input.mjs';
import {normalizeMintQuantity} from '../public/mint-quantity.mjs';

// Platform membership is proven on chain. Website lists/names are display data,
// never an authority to replace the factory, call target or token template.
export const STARS=JSON.parse(fs.readFileSync(new URL('./stars-protocol.json',import.meta.url),'utf8'));
export const STARS_TEMPLATE=JSON.parse(fs.readFileSync(new URL('./stars-token-template.json',import.meta.url),'utf8'));
export const STARS_ABI=new Interface([
 'function mint(address token,uint256 shares,address referrer) payable',
 'function identityOf(address token,address wallet) view returns(bytes32)',
 'function quotaOf(address token,bytes32 key) view returns(uint256)',
 'function accounts(address token,bytes32 key) view returns(uint256 used,uint256 invitations,bool seen,bytes32 referrer)',
 'function sales(address token) view returns(address creator,address marketing2,address pool,bool agentRequired,bool launched,uint256 minted)',
 'function SHARE_PRICE() view returns(uint256)', 'function totalSharesOf(address) view returns(uint256)',
 'function tokensPerShareOf(address) view returns(uint256)', 'function launchModes(address) view returns(uint8)',
 'function mintPaused() view returns(bool)', 'function tradingPaused() view returns(bool)',
 ...['owner','registry','marketing1','seeder','quickSeeder','tokenDeployer'].map(k=>`function ${k}() view returns(address)`),
 ...['InvalidIdentity','InvalidSale','InvalidShares','InvalidReferral','QuotaExceeded','Paused'].map(k=>`error ${k}()`),
 'event Minted(address indexed token,address indexed wallet,bytes32 indexed identity,uint256 shares,uint256 totalMinted)',
 'event ReferralBound(address indexed token,bytes32 indexed inviter,bytes32 indexed invitee,address inviterWallet)',
]);
const M=STARS_ABI,C=STARS.config,ZERO_KEY='0x'+'0'.repeat(64),CA=/^0x[0-9a-f]{40}$/i;
export const STARS_PRICE=10n**15n,STARS_UNITS=2666n*10n**18n,STARS_SUPPLY=10n**27n;
const fail=(s,code='STARS_VALIDATION_FAILED')=>Object.assign(Error(s),{code});
const raw=v=>{if(typeof v==='number'&&!Number.isSafeInteger(v))throw fail('模拟整数精度不足');if(!/^-?\d+$/.test(String(v)))throw fail('模拟整数无效');return BigInt(v);};
const min=(...v)=>v.reduce((a,b)=>a<b?a:b);
const inflight=new WeakMap();
function shared(rpc,key,fn){let map=inflight.get(rpc);if(!map)inflight.set(rpc,map=new Map());if(map.has(key))return map.get(key);const task=Promise.resolve().then(fn);map.set(key,task);task.finally(()=>map.delete(key)).catch(()=>{});return task;}
export function parseStarsInput(input){
 let s;try{s=normalizeAssetInput(String(input));}catch{return null;}
 if(CA.test(s))return {token:address(s),explicit:false};
 try{const u=new URL(s);if(u.protocol!=='https:'||!['starsagent.org','www.starsagent.org'].includes(u.hostname)||u.username||u.password||u.port)return null;
  const path=decodeURIComponent(u.pathname).replace(/\/+$/,'')||'/';
  if(path==='/')return {token:null,explicit:true};
  const m=path.match(/^\/token\/(0x[\da-f]{40})$/i);return m?{token:address(m[1]),explicit:true}:null;
 }catch{return null;}
}
export function starsInput(input){const p=parseStarsInput(input);return !!p&&(p.explicit||same(p.token,C.token));}
export function starsError(error){
 let name;try{name=M.parseError(error.data)?.name;}catch{}
 const messages={InvalidIdentity:['本钱包没有有效的 .ai Agent ID，或该 ID 当前不属于此钱包','MINT_INELIGIBLE'],InvalidSale:['该项目不存在或认购已结束','MINT_ENDED'],InvalidShares:['剩余份数或认购金额已变化，请重新预览','NO_QUOTA'],InvalidReferral:['邀请身份无效，将尝试不带邀请重新模拟','MINT_REFERRAL'],QuotaExceeded:['本钱包剩余认购额度不足','NO_QUOTA'],Paused:['平台已暂停当前操作','MINT_PAUSED']};
 if(messages[name])return fail(...messages[name]);return error;
}
export function verifyStarsTokenCode(code,marketing2){
 if(!/^0x[\da-f]+$/i.test(code||'')||(code.length-2)/2!==STARS_TEMPLATE.runtimeLength)throw fail('Stars 代币代码不属于已核验模板','STARS_VERSION_CHANGED');
 const b=Buffer.from(code.slice(2),'hex'),values={};
 for(const [name,slots] of Object.entries(STARS_TEMPLATE.immutableSlots))for(const start of slots){
  const word=b.subarray(start,start+32).toString('hex');if(!/^0{24}[\da-f]{40}$/.test(word))throw fail('Stars 代币不可变参数格式异常');
  const value='0x'+word.slice(-40);if(values[name]&&!same(values[name],value))throw fail('Stars 代币不可变参数不一致');values[name]=value;b.fill(0,start,start+32);
 }
 if(keccak256(b)!==STARS_TEMPLATE.normalizedHash||!same(values.hub,C.factory)||!same(values.router,STARS_TEMPLATE.router)||!same(values.wbnb,STARS_TEMPLATE.wbnb)||same(values.marketing2,ZeroAddress)||marketing2&&!same(values.marketing2,marketing2))throw fail('Stars 代币模板或工厂/计价币/项目收款参数不符','STARS_VERSION_CHANGED');
 return values;
}
export async function verifyStars(rpc){
 return shared(rpc,'protocol',async()=>{
  await rpc.verifyChain();
  const entries=Object.entries(STARS.identities).filter(([k])=>k!=='token'),keys=['owner','registry','marketing1','seeder','quickSeeder','tokenDeployer'];
  const [ids,values]=await Promise.all([Promise.all(entries.map(([,p])=>codeIdentity(rpc,p.target))),Promise.all(keys.map(k=>read(rpc,C.factory,M,k)))]);
  if(ids.some((v,i)=>v.fingerprint!==entries[i][1].fingerprint))throw fail('Stars 工厂或代理实现已变化，需要重新核验','STARS_VERSION_CHANGED');
  if(values.some((v,i)=>!same(v[0],C[keys[i]])))throw fail('Stars 管理员或依赖地址发生变化','STARS_VERSION_CHANGED');
  return {identity:ids[0],protocolIdentities:ids.slice(1)};
 });
}
async function tokenProof(rpc,token,sale){
 return shared(rpc,'token:'+token.toLowerCase(),async()=>{const code=await rpc.getCode(token);verifyStarsTokenCode(code,sale.marketing2);return {target:token,code,implementation:null,fingerprint:hash([keccak256(code),null,null])};});
}
async function saleState(rpc,token){
 return shared(rpc,'sale:'+token.toLowerCase(),async()=>{
  const block=await rpc.getBlockNumber(),get=(k,args=[])=>read(rpc,C.factory,M,k,args,block);
  const [sale,[paused],[price],[total],[units],[mode],[tradingPaused]]=await Promise.all([get('sales',[token]),get('mintPaused'),get('SHARE_PRICE'),get('totalSharesOf',[token]),get('tokensPerShareOf',[token]),get('launchModes',[token]),get('tradingPaused')]);
  if(same(sale.creator,ZeroAddress))throw fail('此 CA 未在 Stars 工厂登记；请输入 Stars 项目代币 CA','STARS_NOT_PROJECT');
  if(![0n,1n].includes(mode)||total!==(mode===1n?30000n:300000n)||units!==(mode===1n?26660n*10n**18n:STARS_UNITS)||price!==STARS_PRICE)throw fail('Stars 模式、价格或每份代币数量不符合已核验规则','STARS_VERSION_CHANGED');
  if(sale.minted>total||!sale.launched&&!same(sale.pool,ZeroAddress))throw fail('Stars 项目认购状态异常');
  return {block,sale,paused,tradingPaused,price,total,units,mode,token};
 });
}
export async function starsState(rpc,w,token=C.token,{saleState:given}={}){
 const s=given||await saleState(rpc,token);if(s.sale.launched||s.sale.minted>=s.total)throw fail('该项目认购已满并开盘，不能继续 Mint','MINT_ENDED');
 if(s.paused)throw fail('Stars 平台已暂停 Mint','MINT_PAUSED');
 const get=(k,args)=>read(rpc,C.factory,M,k,args,s.block);
 let key;try{[key]=await get('identityOf',[token,w.address]);}catch(e){throw starsError(e);}
 if(key===ZERO_KEY)throw fail('本钱包没有有效的认购身份','MINT_INELIGIBLE');
 const [[quota],account,bnb,[balance],[allowance]]=await Promise.all([get('quotaOf',[token,key]),get('accounts',[token,key]),rpc.getBalance(w.address,s.block),read(rpc,token,ERC20,'balanceOf',[w.address],s.block),read(rpc,token,ERC20,'allowance',[w.address,C.factory],s.block)]);
 if(account.used>quota||quota!==50n+account.invitations*50n)throw fail('Stars 额度计算与已核验规则不符');
 return {...s,key,quota,used:account.used,invitations:account.invitations,seen:account.seen,referrer:account.referrer,remaining:min(quota-account.used,s.total-s.sale.minted),walletRemaining:quota-account.used,minted:s.sale.minted,bnb,balance,allowance};
}
export function verifyStarsReferralResponse(web,inviter){
 if(web?.chainId!==56||!same(web.factory,C.factory)||typeof web.identity?.name!=='string'||!/^.{1,128}\.ai$/i.test(web.identity.name)||!same(web.identity?.address,inviter.address))throw fail('官网邀请身份、网络或工厂地址不符','REFERRAL_NOT_VERIFIED');
}
export async function starsReferral(rpc,w,s,intent,{inviter:provided}={}){
 if(intent.referral!=='account1'||w.account===1||s.seen)return null;
 let inviter;try{inviter=provided||wallet(1);}catch{throw fail('未配置 1 号邀请钱包','REFERRAL_UNAVAILABLE');}
 let key;try{[key]=await read(rpc,C.factory,M,'identityOf',[s.token,inviter.address],s.block);}catch{throw fail('1 号钱包不具备有效邀请身份','REFERRAL_UNAVAILABLE');}
 if(key===ZERO_KEY||key===s.key||same(w.address,inviter.address))throw fail('1 号邀请身份与当前钱包重复或无效','REFERRAL_NOT_VERIFIED');
 if(s.referrer!==ZERO_KEY&&s.referrer!==key)throw fail('本钱包已有其他邀请绑定','REFERRAL_NOT_VERIFIED');
 return {address:inviter.address,key,bind:true};
}
async function referralLink(rpc,token,inviter,fetchJson){
 if(!inviter)return {detected:true,status:'unavailable',note:'没有绑定 1 号钱包；其他钱包仍可独立 Mint'};
 try{const [[key],web]=await Promise.all([read(rpc,C.factory,M,'identityOf',[token,inviter.address]),fetchJson(STARS.origin+'/api/referral?wallet='+inviter.address)]);verifyStarsReferralResponse(web,inviter);if(key===ZERO_KEY)throw fail('无有效邀请身份');return {detected:true,status:'ready',bindingVerified:true,bindingRule:'first-paid',url:STARS.origin+'/token/'+token+'?ref='+encodeURIComponent(web.identity.name),note:'其余钱包首次认购使用 1 号链上身份；邀请无效时独立预检'};}
 catch{return {detected:true,status:'unavailable',note:'1 号邀请链接暂不可用；不影响其他钱包独立认购'};}
}
export async function discoverStars(rpc,input,{fetchJson=getJson}={}){
 const p=parseStarsInput(input);if(!p)return null;
 if(!p.token){
  const [,list]=await Promise.all([verifyStars(rpc),fetchJson(STARS.origin+'/api/tokens')]);
  if(list?.configured!==true||list.config?.chainId!==56||!same(list.config.factory,C.factory)||!Array.isArray(list.items))throw fail('Stars 官方项目列表或工厂配置读取异常');
  const unique=[...new Map(list.items.filter(x=>CA.test(x.address)).map(x=>[x.address.toLowerCase(),x])).values()].slice(0,200);
  return {platform:'stars',name:'StarsAgent 发射台',source:STARS.origin+'/',address:null,needsSelection:true,quotas:[],reason:'请选择具体项目。选定后核对链上额度；已开盘项目不能继续 Mint。',candidates:unique.sort((a,b)=>Number(a.launched)-Number(b.launched)).map(x=>({address:address(x.address),field:String(x.name||'Stars 项目').slice(0,80)+' · '+(x.launchMode===1?'Quick':'标准')+' · '+(x.launched?'已开盘':'认购中'),source:STARS.origin+'/token/'+address(x.address)}))};
 }
 const token=p.token;let sale;
 try{sale=await read(rpc,C.factory,M,'sales',[token]);}catch(e){if(!p.explicit&&!same(token,C.token))return null;throw e;}
 if(same(sale.creator,ZeroAddress)){if(!p.explicit&&!same(token,C.token))return null;throw fail('此代币未在 Stars 工厂登记','STARS_NOT_PROJECT');}
 const [,proof,name]=await Promise.all([verifyStars(rpc),tokenProof(rpc,token,sale),read(rpc,token,ERC20,'name').then(v=>v[0]).catch(()=>null)]);
 return {platform:'stars',name:(name||'Stars 项目')+' · Stars',source:STARS.origin+'/token/'+token,address:C.factory,mintContract:C.factory,token,assetKind:'Erc20',sourceVerified:false,needsSelection:false,tokenIdentity:proof,mintRoutes:[{id:'stars:mint',method:'mint(address,uint256,address)',label:'Stars 付费认购',lane:'paid'}]};
}
export async function inspectStars(rpc,resolved,wallets,{fetchJson=getJson}={}){
 if(!resolved.address)return resolved;
 const token=address(resolved.token),[,s]=await Promise.all([verifyStars(rpc),saleState(rpc,token)]);await tokenProof(rpc,token,s.sale);
 const [quotas,referral]=await Promise.all([Promise.all(wallets.map(async w=>{try{const a=await starsState(rpc,w,token,{saleState:s}),n=min(a.remaining,500n);return {...w,paidRemaining:String(a.remaining),freeRemaining:'0',used:String(a.used),invites:String(a.invitations),unitPriceBnb:formatUnits(a.price,18),minted:String(a.minted),totalShares:String(a.total),budgetCurrency:'BNB',fullBudget:{quantity:Number(n),raw:String(n*a.price),scope:'paid'},notes:[s.mode===1n?'Quick 模式：共 30,000 份':'标准模式：共 300,000 份',s.sale.agentRequired?'需要有效 .ai Agent ID':'按钱包地址计算额度']};}catch(e){e=starsError(e);return {...w,paidRemaining:'0',freeRemaining:'0',error:e.message,errorCode:e.code};}})),referralLink(rpc,token,wallets.find(w=>w.account===1),fetchJson)]);
 return {...resolved,budgetPolicy:'stars-fixed-quote',mode:s.mode===1n?'quick':'standard',quotas,referral,at:Date.now()};
}
export async function starsPlan(rpc,intent,w,{balanceFill=false,resolved=null,inviter}={}){
 if(intent.routeId&&intent.routeId!=='stars:mint')throw fail('Stars Mint 入口无效');
 if(intent.scope==='free')throw fail('Stars 只有付费认购，没有免费份额；请选择付费或全部额度','NO_FREE_MINT');
 if(intent.currency!=='BNB')throw fail('Stars 认购使用 BNB，不能直接使用其他付款币');
 const token=resolved?.token||parseStarsInput(intent.asset)?.token;if(!token)throw fail('请先在 Stars 首页选择具体项目，或输入项目链接/代币 CA','MINT_SELECTION_REQUIRED');
 let proof,s;try{[proof,s]=await Promise.all([verifyStars(rpc),starsState(rpc,w,token)]);}catch(e){throw starsError(e);}
 const tokenId=await tokenProof(rpc,token,s.sale);proof={...proof,protocolIdentities:[...proof.protocolIdentities,tokenId]};
 const quantity=normalizeMintQuantity(intent.quantity);let n=quantity==='max'?s.remaining:BigInt(quantity);
 if(s.remaining===0n)throw fail('本钱包当前认购额度已用完','NO_QUOTA');
 if(balanceFill&&quantity==='max')n=min(n,500n,parseUnits(intent.maxBnb,18)/s.price,s.bnb/s.price);
 if(n===0n)throw fail('BNB 余额不足以认购 1 份并预留 Gas','INSUFFICIENT_FUNDS');
 if(n<0n||n>s.remaining||n>500n)throw fail('份数超过本钱包/全局剩余额度或单次 500 份上限','NO_QUOTA');
 const cost=n*s.price,out=n*s.units;
 if(s.minted+n===s.total&&s.tradingPaused)throw fail('本笔将触发开盘，但平台暂停了开盘交易','MINT_PAUSED');
 if(cost>parseUnits(intent.maxBnb,18))throw fail('本次认购费用超过填写的预算','BUDGET_LIMIT');
 if(s.bnb<cost+(balanceFill?0n:parseUnits('0.0005',18)))throw fail('BNB 余额不足本笔认购费用及 Gas','GAS_BALANCE_LOW');
 let referral=await starsReferral(rpc,w,s,intent,{inviter});let step={kind:'mint',to:C.factory,value:String(cost),data:M.encodeFunctionData('mint',[token,n,referral?.address||ZeroAddress])};
 try{await rpc.call({from:w.address,to:step.to,data:step.data,value:cost});}catch(e){throw starsError(e);}
 return {kind:'contract',route:'stars:mint',token,wallet:w.address,inputToken:BNB,outputToken:token,amountIn:String(cost),minOutput:String(out),quantity:Number(n),...proof,metaVerified:false,requireAssetCredit:true,expectedAsset:{token,kind:'Erc20',amount:String(out)},budgetCurrency:'BNB',quota:{remaining:String(s.remaining),used:String(s.used)},referral,
  stars:{key:s.key,used:String(s.used),seen:s.seen,balanceBefore:String(s.balance),allowanceBefore:String(s.allowance),automaticAllowance:s.balance===0n,mode:Number(s.mode),price:String(s.price),units:String(s.units),marketing2:s.sale.marketing2},fill:{continue:false},
  review:['Stars 工厂可升级；首次零持仓 Mint 会自动授予工厂该代币 10 亿枚退款额度，协议升级风险仍需自行评估。'],steps:[step]};
}
// Exact template and asset effects; not a generic allowance bypass.
export function verifyStarsPreview(p,plan,step){
 if(plan.route!=='stars:mint')throw fail('不是 Stars 预览');
 const token=plan.token,tokenId=plan.protocolIdentities?.find(x=>same(x.target,token));
 if(!tokenId||tokenId.implementation||tokenId.beacon||plan.identity?.fingerprint!==STARS.identities.factory.fingerprint||!same(plan.identity.target,C.factory)||!same(plan.outputToken,token)||!same(plan.inputToken,BNB)||step.kind!=='mint'||!same(step.to,C.factory))throw fail('Stars 预览目标或代码指纹不符');
 verifyStarsTokenCode(tokenId.code,plan.stars?.marketing2);
 if(tokenId.fingerprint!==hash([keccak256(tokenId.code),null,null]))throw fail('Stars 代币代码指纹不符');
 const units=plan.stars?.mode===1?26660n*10n**18n:plan.stars?.mode===0?STARS_UNITS:0n;
 const n=BigInt(plan.quantity),args=M.decodeFunctionData('mint',step.data);
 if(!units||raw(plan.stars.price)!==STARS_PRICE||raw(plan.stars.units)!==units||n<1n||n>500n||!same(args[0],token)||args[1]!==n||!same(args[2],plan.referral?.address||ZeroAddress)||M.encodeFunctionData('mint',args).toLowerCase()!==step.data.toLowerCase()||raw(step.value)!==n*STARS_PRICE||raw(plan.amountIn)!==n*STARS_PRICE||raw(plan.minOutput)!==n*units)throw fail('Stars 预览参数不符');
 if(plan.requireAssetCredit!==true||plan.metaVerified!==false||plan.expectedAsset?.kind!=='Erc20'||!same(plan.expectedAsset.token,token)||raw(plan.expectedAsset.amount)!==n*units)throw fail('Stars 预览缺少精确的代币到账检查');
 if(plan.stars.automaticAllowance!==(raw(plan.stars.balanceBefore)===0n))throw fail('Stars 授权前置状态不符');
 const changes=p.simulationResult?.allowanceChanges||[],expected=plan.stars.automaticAllowance&&raw(plan.stars.allowanceBefore)!==STARS_SUPPLY;
 if(changes.length!==(expected?1:0))throw fail('Stars 自动授权变更数量不符');
 for(const c of changes)if(!same(c.owner,plan.wallet)||!same(c.tokenAddress,token)||!same(c.spender,C.factory)||c.tokenType!=='Erc20'||raw(c.preAmount)!==raw(plan.stars.allowanceBefore)||raw(c.postAmount)!==STARS_SUPPLY)throw fail('Stars 自动授权对象或额度不符');
 return true;
}
export async function refreshStarsMint(rpc,plan,intent){
 const fresh=await starsPlan(rpc,{...intent,quantity:plan.quantity},wallet(intent.account),{balanceFill:!!plan.mintFunding?.full,resolved:{token:plan.token}});
 if(fresh.amountIn!==plan.amountIn||fresh.minOutput!==plan.minOutput||JSON.stringify(fresh.stars)!==JSON.stringify(plan.stars)||(!plan.referral?.fallback&&JSON.stringify(fresh.referral)!==JSON.stringify(plan.referral)))throw fail('Stars 额度、邀请或授权前置状态变化，需重新预览');
 return {...fresh,mintFunding:plan.mintFunding,referral:plan.referral?.fallback?{...fresh.referral,fallback:true}:fresh.referral,project:plan.project,resolved:plan.resolved};
}
export function verifyStarsReceipt(receipt,plan){
 let minted=0n,bindings=0;for(const log of receipt.logs||[]){if(!same(log.address,C.factory))continue;let e;try{e=M.parseLog(log);}catch{continue;}
  if(e?.name==='Minted'&&same(e.args.token,plan.token)&&same(e.args.wallet,plan.wallet)&&e.args.identity===plan.stars.key)minted+=e.args.shares;
  if(e?.name==='ReferralBound'&&same(e.args.token,plan.token)&&e.args.invitee===plan.stars.key){if(!plan.referral||e.args.inviter!==plan.referral.key||!same(e.args.inviterWallet,plan.referral.address))throw fail('Stars 回执邀请人与预览不符');bindings++;}
 }
 if(minted!==BigInt(plan.quantity)||bindings!==(plan.referral?.bind?1:0))throw fail('Stars 回执份数或邀请绑定不符');
 return {quantity:String(minted),costBnbRaw:plan.amountIn,referrer:plan.referral?.address||null};
}
