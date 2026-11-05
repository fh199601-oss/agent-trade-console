// Corla's factory registry is the authority for membership. Website text, token
// suffixes and successful third-party calls alone never authorize a target.
import fs from 'node:fs';
import {Interface,keccak256,ZeroAddress,randomBytes,hexlify} from 'ethers';
import {address,BNB,USDT,ERC20,read,same,parseUnits,formatUnits} from './common.mjs';
import {codeIdentity} from './discovery.mjs';
import {corlaHint} from '../public/corla-input.mjs';
export const CORLA=JSON.parse(fs.readFileSync(new URL('./corla-protocol.json',import.meta.url),'utf8'));
export const CORLA_FACTORY=new Interface(CORLA.factoryAbi);
export const CORLA_MINT=new Interface([...CORLA.mintAbi,...CORLA.errors]);
const TRANSFER=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const fail=(code,message,details)=>Object.assign(Error(message),{code,details});
async function simulateCorla(rpc,step,w,block){try{return await rpc.call({to:step.to,from:w.address,value:BigInt(step.value),data:step.data},block);}catch(e){
 if(/insufficient funds|insufficient balance/i.test(e.message))throw fail('BUDGET_LIMIT','当前钱包 BNB 余额不足以支付本次认购费用和 Gas');
 let name;try{name=CORLA_MINT.parseError(e.data)?.name;}catch{}
 if(name==='NothingToRefund')throw fail('NO_QUOTA','当前钱包没有可退款的 Corla 份额');
 const errors={AlreadyMinted:['NO_QUOTA','钱包认购额度已用完，请刷新额度'],WrongPhase:['MINT_ENDED','项目阶段已变化，当前不能认购'],AgentIdRequired:['MINT_INELIGIBLE','当前钱包没有此项目要求的 Agent ID'],AgentIdentityUnavailable:['MINT_INELIGIBLE','项目当前无法核验 Agent ID'],NotWhitelisted:['MINT_INELIGIBLE','当前钱包不在项目白名单内'],NothingToClaim:['NO_QUOTA','当前钱包没有可领取的份额'],NoAvailableLaunchSalt:['CORLA_SALT','开盘候选已失效，请重新预览'],TransferFailed:['CORLA_PAYMENT_FAILED','付款币转入数量不符合合约要求（可能有转账税）'],SafeERC20FailedOperation:['CORLA_PAYMENT_FAILED','付款币合约拒绝转账，请检查余额和授权']};
 if(errors[name])throw fail(...errors[name]);throw e;
}}
const clients=new WeakMap(),cloneImpl=code=>/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(code)?.[1];
// Display and order RPC queues are separate. Share the public address index;
// legacy zero-token entries are refreshed after launch. Quotas are never shared.
const registry={records:new Map(),counts:new Map()};
export const corlaClient=rpc=>{if(!clients.has(rpc))clients.set(rpc,new CorlaClient(rpc));return clients.get(rpc);};
export function corlaInput(input){
 const hint=corlaHint(input);return hint?{...hint,address:hint.address?address(hint.address):null}:null;
}
export class CorlaClient{
 constructor(rpc,{factories=CORLA.factories,identity=codeIdentity,now=Date.now}={}){Object.assign(this,{rpc,factories,identity,now});this.pending=new Map();this.cache=new Map();this.records=factories===CORLA.factories?registry.records:new Map();this.counts=factories===CORLA.factories?registry.counts:new Map();}
 async cached(key,ttl,work){const v=this.cache.get(key);if(ttl&&v&&v.until>this.now())return v.value;if(this.pending.has(key))return this.pending.get(key);
  const task=work().then(value=>{if(ttl){if(this.cache.size>=512)this.cache.delete(this.cache.keys().next().value);this.cache.set(key,{value,until:this.now()+ttl});}return value;});this.pending.set(key,task);try{return await task;}finally{this.pending.delete(key);}}
 get(to,abi,name,args=[],block='latest'){return read(this.rpc,to,abi,name,args,block);}
 async factory(root,fresh=false){return this.cached('factory:'+root.address,fresh?0:15000,async()=>{
  await this.rpc.verifyChain();const [identity,[impl],code]=await Promise.all([this.identity(this.rpc,root.address),this.get(root.address,CORLA_FACTORY,'mintImplementation'),this.rpc.getCode(root.mintImplementation)]);
  if(identity.fingerprint!==root.fingerprint||!same(impl,root.mintImplementation)||keccak256(code)!==root.mintImplementationHash)throw fail('CORLA_VERSION_CHANGED','Corla 工厂或实现已更新，当前版本需重新核验；不会改走历史重放');
  return identity;
 });}
 remember(root,record){const row={root,record};this.records.set(record.mint.toLowerCase(),row);if(!same(record.expectedToken,ZeroAddress))this.records.set(record.expectedToken.toLowerCase(),row);return row;}
 async directory(root){return this.cached('directory:'+root.address,1200,async()=>{
  const [,[count]]=await Promise.all([this.factory(root),this.get(root.address,CORLA_FACTORY,'deploymentCount')]);const old=this.counts.get(root.address)||0n;
  // This is the platform deployment table, not transaction-history replay.
  // Read only new entries on subsequent lookups. Bound a cold scan explicitly.
  if(count>10000n)throw fail('CORLA_DIRECTORY_LIMIT','平台项目目录超过单次上限，请直接输入 Mint 合约地址');
  if(count<old)throw fail('CORLA_REGISTRY_CHANGED','Corla 工厂项目计数回退，需要重新核验');
  const jobs=[];for(let start=old;start<count;start+=100n){const n=count-start>100n?100n:count-start;jobs.push([start,n]);}
  for(let i=0;i<jobs.length;i+=4)await Promise.all(jobs.slice(i,i+4).map(async([start,n])=>{const [rows]=await this.get(root.address,CORLA_FACTORY,'getDeployments',[start,n]);if(BigInt(rows.length)!==n)throw fail('CORLA_REGISTRY_CHANGED','Corla 目录返回不完整');for(const r of rows)this.remember(root,r.toObject());}));
  this.counts.set(root.address,count);
  const unresolved=[...new Set([...this.records.values()].filter(r=>r.root===root&&same(r.record.expectedToken,ZeroAddress)))];
  await Promise.all(unresolved.map(async row=>{const [expected]=await this.get(row.record.mint,CORLA_MINT,'expectedToken');if(!same(expected,ZeroAddress))await this.verify(row,{fresh:true});}));
  return count;
 });}
 async locate(ca,{explicit=false}={}){
  ca=address(ca);const cached=this.records.get(ca.toLowerCase());if(cached)return cached;
  return this.cached('locate:'+ca,0,async()=>{
   const suffix=ca.toLowerCase().endsWith('7777');let currentError;
   // New predicted token CAs need not have bytecode yet. Try the current
   // factory first and return a match without waiting for legacy registries.
   if(suffix){try{await this.directory(this.factories[0]);}catch(e){currentError=e;}const found=this.records.get(ca.toLowerCase());if(found)return found;}
   const code=await this.rpc.getCode(ca),impl=cloneImpl(code);
   // Current Corla deployments also use beacon proxies, not only EIP-1167
   // clones. Ask the reviewed factories directly; verify code only for a hit.
   const roots=impl?this.factories.filter(r=>same(r.mintImplementation,'0x'+impl)):code&&code!=='0x'&&code.length<1600?this.factories:[];
   if(roots.length){const found=await firstMatch(roots.map(async root=>{const [index]=await this.get(root.address,CORLA_FACTORY,'deploymentIndexPlusOne',[ca]);if(!index)return null;const [,[record]]=await Promise.all([this.factory(root),this.get(root.address,CORLA_FACTORY,'deployment',[index-1n])]);if(!same(record.mint,ca))throw fail('CORLA_REGISTRY_CHANGED','工厂登记与 Mint 地址不一致');return this.remember(root,record.toObject());}));if(found)return found;}
   if(!explicit&&!ca.toLowerCase().endsWith('7777'))return null;
   // The predicted token may not be deployed yet. Consult official factories,
   // never substitute the token address for the subscription contract.
   const found=await firstMatch(this.factories.filter((_,i)=>!suffix||i>0).map(async r=>{await this.directory(r);return this.records.get(ca.toLowerCase());}));if(found)return found;
   if(currentError)throw currentError;
   return null;
  });
 }
 async verify(row,{fresh=false}={}){
  const {root,record}=row;return this.cached('verify:'+record.mint,fresh?0:10000,async()=>{
   const [factoryIdentity,identity,[mapped],[index],[expected]]=await Promise.all([this.factory(root,fresh),this.identity(this.rpc,record.mint),this.get(root.address,CORLA_FACTORY,'mintForLaunchSalt',[record.launchSalt]),this.get(root.address,CORLA_FACTORY,'deploymentIndexPlusOne',[record.mint]),this.get(record.mint,CORLA_MINT,'expectedToken')]);
   if(!same(mapped,record.mint)||!index||!same(identity.implementation,root.mintImplementation)||keccak256(identity.implementationCode||'0x')!==root.mintImplementationHash)throw fail('CORLA_NOT_VERIFIED','Corla 工厂登记或代理实现不匹配');
   if(!same(expected,record.expectedToken)){
    // Unlocked legacy deployments populate their token once, at launch.
    // Re-read the same factory row; no other registration field may change.
    const [live]=await this.get(root.address,CORLA_FACTORY,'deployment',[index-1n]),next=live.toObject();
    const immutable=['mint','creator','mintSalt','launchSalt','configurationHash','createdAt','fundingDeadline','totalLots','pricePerLot'];
    if(!same(record.expectedToken,ZeroAddress)||same(expected,ZeroAddress)||!same(next.expectedToken,expected)||immutable.some(k=>String(next[k]).toLowerCase()!==String(record[k]).toLowerCase()))throw fail('CORLA_NOT_VERIFIED','Corla 开盘代币与原工厂登记不匹配');
    row.record=next;this.remember(root,next);
   }
   return {identity,factoryIdentity};
  });
 }
 async terms(row){return this.cached('terms:'+row.record.mint,10000,async()=>{
  const [,[params]]=await Promise.all([this.verify(row),this.get(row.record.mint,CORLA_MINT,'getCreationParams')]);const p=params.toObject(true),r=row.record;
  if(p.terms.totalLots!==r.totalLots||p.terms.pricePerLot!==r.pricePerLot||p.terms.maxMintsPerWallet<1n||p.terms.maxMintsPerWallet>r.totalLots||r.pricePerLot<=0n)throw fail('CORLA_TERMS_CHANGED','Corla 链上条款与登记不一致');return p;
 });}
 async payment(quote){if(same(quote,ZeroAddress))return {symbol:'BNB',decimals:18,budgetCurrency:'BNB'};if(same(quote,USDT))return {symbol:'USDT',decimals:18,budgetCurrency:'USDT'};
  return this.cached('payment:'+quote,10000,async()=>{const [[decimals],symbol,identity]=await Promise.all([read(this.rpc,quote,ERC20,'decimals'),read(this.rpc,quote,ERC20,'symbol').then(r=>r[0]).catch(()=>quote),this.identity(this.rpc,quote)]);
   if(decimals>36n)throw fail('CORLA_PAYMENT_UNSUPPORTED','付款币精度超过支持范围');return {symbol:String(symbol).slice(0,40),decimals:Number(decimals),budgetCurrency:'QUOTE',identity};
  });
 }
 async describe(row,source){const p=await this.terms(row),{record:r,root}=row;
  const role=(a,field,kind,primary=false)=>({address:a,field,roles:[kind],verifiedRoles:[kind],roleLabels:[kind==='mint'?'Corla 认购合约':kind==='factory'?'Corla 官方工厂':'开盘后代币 CA'],primary,evidence:[{kind:'corla-registry',role:kind,label:'官方工厂登记及实现指纹核验'}]});
  return {address:r.mint,mintContract:r.mint,token:same(r.expectedToken,ZeroAddress)?null:r.expectedToken,assetKind:'Erc20',name:p.launch.name+' · Corla',source:source||'用户输入 CA',platform:'corla',fastPath:true,corla:{factory:root.address,resolverKey:r.launchSalt,settlement:'subscription-then-claim'},addresses:[role(r.mint,'Mint','mint',true),role(root.address,'Factory','factory'),...(!same(r.expectedToken,ZeroAddress)?[role(r.expectedToken,'Token','token')]:[])],candidates:[],referral:{status:'not-detected',url:null,reason:'Corla 当前认购接口没有钱包邀请参数'},discovery:{strategy:'corla-factory-registry',historySkipped:true,documents:[CORLA.source]},needAiDeep:false};
 }
 async catalog(source){const root=this.factories[0];await this.directory(root);const rows=[...this.records.values()].filter((r,i,a)=>r.root===root&&a.findIndex(x=>same(x.record.mint,r.record.mint))===i).sort((a,b)=>Number(b.record.createdAt-a.record.createdAt)).slice(0,12);
  const projects=await Promise.all(rows.map(async row=>{const p=await this.terms(row);return {address:row.record.mint,name:p.launch.name,roleLabels:[p.launch.name+' · Corla'],source:`https://flap.sh/apps/corla/mint/${same(row.record.expectedToken,ZeroAddress)?row.record.mint:row.record.expectedToken}`};}));
  return {address:null,platform:'corla',fastPath:true,name:'Corla Mint 发射台',source,reason:'已识别 Corla 发射台。请选择具体项目，或粘贴项目详情链接 / Mint 合约地址。',needsSelection:true,candidates:projects,quotas:[],referral:{status:'not-detected'},needAiDeep:false,discovery:{strategy:'corla-factory-registry',historySkipped:true}};
 }
 async state(row,w){
  const {record:r}=row;
  // Mutable reads share a block and overlap immutable identity/terms checks.
  // No state/eligibility cache survives a call to state().
  const [p,{block,values}]=await Promise.all([this.terms(row),(async()=>{const block=await this.rpc.getBlockNumber(),get=(n,args=[])=>this.get(r.mint,CORLA_MINT,n,args,block);return {block,values:await Promise.all([get('getMintState'),get('getUserInfo',[w.address]),get('walletMintCount',[w.address]),get('getAgentStatus',[w.address]),Number(row.root.version)>=5?get('lockedLaunchVersion'):Promise.resolve([0n]),Number(row.root.version)>=5?get('refundMintVersion'):Promise.resolve([0n]),get('token')])};})()]);
  const [[minted,status],[participated,claimable,refundable,didClaim,didRefund,whitelistAllowed],[used],[agentOnly,eligible],[locked],[refundVersion],[actualToken]]=values;
  const total=p.terms.totalLots,max=BigInt(p.terms.maxMintsPerWallet);if(minted>total||BigInt(used)>max||![0n,1n].includes(BigInt(locked)))throw fail('CORLA_STATE','Corla 额度或开盘模式数据异常');
  const open=status===1n||status===5n&&refundVersion===1n,remaining=[total-minted,max-BigInt(used)].reduce((a,b)=>a<b?a:b);
  let error=null,errorCode=null;
  if(!open){error=status===3n?'项目已开盘，认购结束；已有份额请领取代币':status===4n||status===5n?'认购已结束，当前为退款阶段':'项目当前不可认购';errorCode='MINT_ENDED';}
  else if(!remaining){error='当前钱包或全局认购额度已用完';errorCode='NO_QUOTA';}
  else if(agentOnly&&!eligible){error='此项目仅限 Agent ID 钱包，当前钱包资格未通过';errorCode='MINT_INELIGIBLE';}
  else if(!whitelistAllowed){error='当前处于白名单阶段，本钱包不在白名单内';errorCode='MINT_INELIGIBLE';}
  if(status===3n){if(same(actualToken,ZeroAddress))throw fail('CORLA_STATE','已开盘项目未返回代币地址');if(!same(actualToken,row.record.expectedToken)){await this.verify(row,{fresh:true});if(!same(actualToken,row.record.expectedToken))throw fail('CORLA_NOT_VERIFIED','开盘代币未与工厂登记一致');}}
  const quote=p.launch.quoteToken,payment=await this.payment(quote),currency=payment.budgetCurrency;
  const info={block,status:Number(status),stateLabel:status===1n?'认购中':status===3n?'已开盘 · 可领取':status===5n&&refundVersion===1n?'退款期 · 仍可认购':'认购结束',available:!error,freeRemaining:'0',paidRemaining:String(error?0n:remaining),walletRemaining:String(max-BigInt(used)),globalRemaining:String(total-minted),globalTotal:String(total),globalMinted:String(minted),maxPerTransaction:'1',unitPrice:{formatted:formatUnits(r.pricePerLot,payment.decimals),raw:String(r.pricePerLot),symbol:payment.symbol},currency:payment.symbol,budgetCurrency:currency,paymentToken:quote,paymentDecimals:payment.decimals,agentOnly,agentEligible:eligible,whitelistAllowed,claimable:String(claimable),refundable:String(refundable),error,errorCode,notes:['Corla 为付费份额认购，每笔 1 份；募满开盘后另行领取代币。'+(status===5n&&refundVersion===1n?'当前版本允许退款期继续认购。':'')]};
  Object.assign(info,{participated,didClaim,didRefund});
  return {row,p,block,minted,status,used:BigInt(used),remaining,locked:locked===1n,quote,currency,payment,agentOnly,eligible,claimable,refundable,didRefund,actualToken,info};
 }
 async claimState(row,w){
  const block=await this.rpc.getBlockNumber(),get=(name,args=[])=>this.get(row.record.mint,CORLA_MINT,name,args,block);
  const [[,status],[participated,claimable,,didClaim],[actualToken]]=await Promise.all([get('getMintState'),get('getUserInfo',[w.address]),get('token')]);
  if(status!==3n)throw fail(status===4n||status===5n?'CORLA_REFUND_ONLY':'CORLA_CLAIM_NOT_OPEN',status===4n||status===5n?'项目当前处于退款阶段，尚不能领取代币':'项目尚未开盘，继续等待领取开放',{phase:String(status),block});
  if(didClaim)throw fail('CORLA_ALREADY_CLAIMED','本钱包已领取过该项目，请检查持仓',{block});
  if(claimable<=0n)throw fail('NO_QUOTA',participated?'本钱包当前可领取数量为 0':'本钱包没有该项目的认购份额',{block,reason:participated?'empty':'no-allocation'});
  if(same(actualToken,ZeroAddress))throw fail('CORLA_STATE','已开盘项目未返回代币地址');
  if(!same(actualToken,row.record.expectedToken)){await this.verify(row,{fresh:true});if(!same(actualToken,row.record.expectedToken))throw fail('CORLA_NOT_VERIFIED','开盘代币未与工厂登记一致');}
  return {block,claimable,actualToken,info:{block,status:Number(status),stateLabel:'已开盘 · 可领取',claimable:String(claimable),participated,didClaim}};
 }
 async salts(s){
  if(s.locked||!s.agentOnly&&s.minted+1n<s.p.terms.totalLots)return [];
  // A local candidate set can serve successive lots of the same project. The
  // current mint is still simulated; an occupied candidate is rebuilt below.
  const {root,record}=s.row;return this.cached('salts:'+record.mint,30000,async()=>{
   const [[portal],[initHash],[fp],[fh]]=await Promise.all([this.get(record.mint,CORLA_MINT,'portal'),this.get(record.mint,CORLA_MINT,'tokenInitCodeHash'),this.get(root.address,CORLA_FACTORY,'portal'),this.get(root.address,CORLA_FACTORY,'tokenInitCodeHash')]);
   if(!same(portal,fp)||initHash!==fh)throw fail('CORLA_SALT','Corla 开盘参数与工厂不一致');
   let cursor=BigInt(hexlify(randomBytes(32)));const found=[],end=this.now()+9000;
   for(let n=0;n<2000000&&found.length<3;n++,cursor=(cursor+1n)%(1n<<256n)){
    if(this.now()>end)throw fail('CORLA_SALT_TIMEOUT','旧版 Corla 开盘候选计算超时，请重新预览');
    if(n%2048===0)await new Promise(r=>setImmediate(r));const candidate='0x'+cursor.toString(16).padStart(64,'0');
    if(keccak256('0xff'+portal.slice(2)+candidate.slice(2)+initHash.slice(2)).endsWith('7777')&&(await this.get(root.address,CORLA_FACTORY,'isLaunchSaltAvailable',[candidate]))[0])found.push(candidate);
   }if(found.length<3)throw fail('CORLA_SALT','未找到可用的旧版开盘参数');return found;
  });
 }
}
// Return the first verified hit; a slow unrelated factory must not delay it.
// All misses/errors must settle before declaring that no registration exists.
async function firstMatch(tasks){if(!tasks.length)return null;return new Promise((resolve,reject)=>{let left=tasks.length,found=false,errors=[];for(const task of tasks)Promise.resolve(task).then(row=>{if(row){found=true;resolve(row);}},e=>errors.push(e)).finally(()=>{if(!--left&&!found){if(errors.length)reject(errors[0]);else resolve(null);}});});}
export async function discoverCorla(rpc,input,{client=rpc?corlaClient(rpc):null}={}){const hint=corlaInput(input);if(!rpc||!hint)return null;
 if(!hint.address)return client.catalog(hint.source);
 const row=await client.locate(hint.address,{explicit:hint.explicit});if(!row){if(hint.explicit)throw fail('CORLA_NOT_FOUND','已识别 Corla 链接，但该地址不在已核验的工厂目录；请确认是项目详情链接或 Mint 合约地址');return null;}
 return client.describe(row,hint.source);
}
export async function inspectCorla(rpc,resolved,wallets){const client=corlaClient(rpc),row=await client.locate(resolved.address,{explicit:true});if(!row)throw fail('CORLA_NOT_FOUND','Corla 项目登记未找到');
 const quotas=await Promise.all(wallets.map(async w=>{try{return {...w,...(await client.state(row,w)).info,adapter:'corla'};}catch(e){return {...w,error:e.message,errorCode:e.code};}}));
 return {...resolved,...await client.describe(row,resolved.source),quotas,mintRoutes:[{id:'corla:mint',method:'Corla 份额认购',label:'认购份额（付费）'},{id:'corla:claim',method:'Corla 开盘后领取',label:'领取已认购代币（不再认购）'},{id:'corla:refund',method:'Corla 退款',label:'退回本钱包可退款的认购费用'}],needAiDeep:false};
}
export async function corlaPlan(rpc,intent,w,resolved,{client=corlaClient(rpc),officialPreview=false}={}){
 const row=await client.locate(resolved.address,{explicit:true});if(!row)throw fail('CORLA_NOT_FOUND','Corla 项目未登记');
 if(intent.routeId&&!['corla:mint','corla:claim','corla:refund'].includes(intent.routeId))throw fail('MINT_ROUTE_INVALID','Corla 请使用专用认购、领取或退款入口');
 const claim=intent.routeId==='corla:claim';
 const [s,proof]=await Promise.all([claim?client.claimState(row,w):client.state(row,w),client.verify(row)]),{record:r,root}=row;
 if(intent.routeId==='corla:refund'){
  if(s.refundable<=0n||s.didRefund)throw fail('NO_QUOTA','当前钱包没有可退回的 Corla 认购费用',{quota:s.info});
  const native=s.currency==='BNB',output=native?BNB:s.quote,step={kind:'mint',to:r.mint,value:'0',data:CORLA_MINT.encodeFunctionData('refund')};await simulateCorla(rpc,step,w,s.block);
  return {kind:'contract',route:'corla:refund',token:output,wallet:w.address,inputToken:output,outputToken:output,amountIn:'0',minOutput:String(s.refundable),quantity:1,identity:proof.identity,protocolIdentities:[proof.factoryIdentity,...(s.payment.identity?[s.payment.identity]:[])],metaVerified:false,requireAssetCredit:true,requireRefundCredit:true,expectedAsset:{token:output,kind:native?'Native':'Erc20',amount:String(s.refundable)},redemption:{protocol:'corla',mint:r.mint,amount:String(s.refundable)},quota:s.info,review:['仅退回当前钱包可退款费用 '+formatUnits(s.refundable,s.payment.decimals)+' '+s.payment.symbol+'，不会新增认购或授权；Gas 另计。'],steps:[step]};
 }
 // The engine's mandatory official preview proves the exact full claim credit.
 // Standalone planners still simulate with eth_call; never skip both.
 if(claim){const step={kind:'mint',to:r.mint,value:'0',data:CORLA_MINT.encodeFunctionData('claim')};if(!officialPreview)await simulateCorla(rpc,step,w,s.block);
  return {kind:'contract',route:'corla:claim',token:s.actualToken,wallet:w.address,inputToken:BNB,outputToken:s.actualToken,amountIn:'0',minOutput:String(s.claimable),quantity:1,identity:proof.identity,protocolIdentities:[proof.factoryIdentity],metaVerified:false,requireAssetCredit:true,expectedAsset:{token:s.actualToken,kind:'Erc20',amount:String(s.claimable)},quota:s.info,review:['领取本钱包已认购份额对应的代币，不会新增付费认购。'],steps:[step]};}
 if(s.info.error)throw fail(s.info.errorCode,s.info.error,{quota:s.info});
 if(intent.scope==='free')throw fail('NO_FREE_MINT','Corla 此项目没有免费额度；单份 '+(s.info.unitPrice?.formatted||r.pricePerLot)+' '+s.info.currency+'。请自行选择付费 / 全部并设置预算。',{quota:s.info});
 if(s.currency==='QUOTE'&&(!same(intent.quoteToken,s.quote)||intent.maxQuote===undefined))throw fail('BUDGET_LIMIT','请明确本项目 '+s.payment.symbol+' 的每钱包预算及付款币 CA；不会使用 BNB / USDT 预算代替',{quota:s.info});
 if(intent.quoteToken&&!same(intent.quoteToken,s.quote))throw fail('CORLA_PAYMENT_CHANGED','本次预算绑定的付款币与项目不一致');
 const budget=parseUnits(s.currency==='BNB'?intent.maxBnb:s.currency==='USDT'?intent.maxUsdt||'0':intent.maxQuote,s.payment.decimals);if(budget<r.pricePerLot)throw fail('BUDGET_LIMIT','本钱包预算不足以认购 1 份（'+formatUnits(r.pricePerLot,s.payment.decimals)+' '+s.payment.symbol+'）',{quota:s.info});
 if(intent.quantity!=='max'&&BigInt(intent.quantity)>s.remaining)throw fail('NO_QUOTA','指定份数超过本钱包或全局剩余额度',{quota:s.info});
 if(intent.quantity!=='max'&&BigInt(intent.quantity)*r.pricePerLot>budget)throw fail('BUDGET_LIMIT','预算不足以完成指定份数',{quota:s.info});
 let target=[s.remaining,budget/r.pricePerLot,BigInt(intent.quantity==='max'?500:intent.quantity)].reduce((a,b)=>a<b?a:b);
 const steps=[],native=s.currency==='BNB';
 if(native){const balance=await rpc.getBalance(w.address,s.block);if(balance<r.pricePerLot)throw fail('BUDGET_LIMIT','BNB 余额不足以认购 1 份（Gas 另计）');if(intent.quantity!=='max'&&balance<BigInt(intent.quantity)*r.pricePerLot)throw fail('BUDGET_LIMIT','BNB 余额不足以完成指定份数（Gas 另计）');if(balance/r.pricePerLot<target)target=balance/r.pricePerLot;}
 if(!native){const [[balance],[allowance],[mappedQuote]]=await Promise.all([read(rpc,s.quote,ERC20,'balanceOf',[w.address],s.block),read(rpc,s.quote,ERC20,'allowance',[w.address,root.address],s.block),read(rpc,root.address,CORLA_FACTORY,'quoteTokenFor',[r.launchSalt],s.block)]);
  if(!same(mappedQuote,s.quote))throw fail('CORLA_PAYMENT_CHANGED','工厂付款币与项目条款不一致');if(balance<r.pricePerLot)throw fail('BUDGET_LIMIT',s.payment.symbol+' 余额不足以认购 1 份');
  if(intent.quantity!=='max'&&balance<BigInt(intent.quantity)*r.pricePerLot)throw fail('BUDGET_LIMIT',s.payment.symbol+' 余额不足以完成指定份数');
  if(balance/r.pricePerLot<target)target=balance/r.pricePerLot;const allowanceForRun=target*r.pricePerLot;
  if(allowance<r.pricePerLot){if(allowance>0n)steps.push({kind:'approve',to:s.quote,spender:root.address,allowance:'0',value:'0',data:ERC20.encodeFunctionData('approve',[root.address,0n])});steps.push({kind:'approve',to:s.quote,spender:root.address,allowance:String(allowanceForRun),value:'0',data:ERC20.encodeFunctionData('approve',[root.address,allowanceForRun])});}
 }
 const salts=await client.salts(s);
 const step={kind:'mint',to:native?r.mint:root.address,value:native?String(r.pricePerLot):'0',data:native?CORLA_MINT.encodeFunctionData('mint(bytes32[])',[salts]):CORLA_FACTORY.encodeFunctionData('mintQuote',[r.launchSalt,salts])};
 // The engine always obtains and verifies an official wallet simulation.
 // Locked launches have no ephemeral salts to repair, so do not simulate the
 // same call twice. Standalone read-only planning retains eth_call by default.
 if(!steps.length&&!(officialPreview&&s.locked))try{await simulateCorla(rpc,step,w,s.block);}catch(e){
  if(e.code!=='CORLA_SALT')throw e;
  // Only retry a read-only simulation. Never repeat a dispatched transaction.
  client.cache.delete('salts:'+r.mint);const fresh=await client.salts(s);
  step.data=native?CORLA_MINT.encodeFunctionData('mint(bytes32[])',[fresh]):CORLA_FACTORY.encodeFunctionData('mintQuote',[r.launchSalt,fresh]);await simulateCorla(rpc,step,w,await rpc.getBlockNumber());
 }
 const afterMint=intent.autoClaim===false?null:{autoClaim:true,sell:intent.claimSell||null,mint:r.mint,expectedToken:r.expectedToken};
 return {kind:'contract',route:'corla:mint',afterMint,token:same(r.expectedToken,ZeroAddress)?r.mint:r.expectedToken,wallet:w.address,inputToken:native?BNB:s.quote,outputToken:same(r.expectedToken,ZeroAddress)?r.mint:r.expectedToken,amountIn:String(r.pricePerLot),minOutput:'0',quantity:1,identity:proof.identity,protocolIdentities:[proof.factoryIdentity,...(s.payment.identity?[s.payment.identity]:[])],metaVerified:false,subscription:{protocol:'corla',mint:r.mint,walletCountBefore:String(s.used)},expectedAsset:null,budgetCurrency:s.currency,budgetDecimals:s.payment.decimals,budgetToken:s.quote,quota:s.info,fill:{targetQuantity:Number(target),quotaRemaining:String(s.remaining),continue:target>1n},review:['按当前额度、余额和费用预算，本次最多认购 '+target+' 份，认购费用 '+formatUnits(target*r.pricePerLot,s.payment.decimals)+' '+s.payment.symbol+'（Gas 另计）；逐份确认并重查剩余额度。',afterMint?'认购确认后持续监测 Corla 开盘，自动领取全部可领代币（Gas 另计）；服务重启暂停，需手动恢复。'+(afterMint.sell?'到账后按当时总持仓卖出 '+afterMint.sell.percent+'%，滑点 '+afterMint.sell.slippageBps/100+'%，到账 '+afterMint.sell.currency+(afterMint.sell.gasLimit===undefined?'':'，卖出 Gas 上限 '+afterMint.sell.gasLimit)+'；必要时仅授权本次数量。':'不自动卖出。'):'本次为 Corla 份额认购，成功后记录认购凭证；募满开盘后需手动领取代币。','平台适配不代表该项目已完成安全审计。',...(steps.length?['先预览本次份额所需的精确 '+s.payment.symbol+' 授权（最多 '+target+' 份），供后续逐份使用；不会无限授权。授权后仍须通过认购模拟。']:[])],steps:[...steps,step]};
}
export function corlaReceipt(receipt,plan){
 const logs=(receipt.logs||[]).filter(l=>same(l.address,plan.subscription.mint)).flatMap(l=>{try{const x=CORLA_MINT.parseLog(l);return x?.name==='Minted'&&same(x.args.account,plan.wallet)?[x]:[];}catch{return [];}});
 if(logs.length!==1||logs[0].args.mintedLots<=0n)throw fail('CORLA_RECEIPT','交易成功但未找到唯一的本钱包 Corla 认购凭证，需核对原单');
 return {kind:'subscription',lots:'1',globalMintedLots:String(logs[0].args.mintedLots),assetPendingClaim:true};
}
export function corlaRefundReceipt(receipt,plan){
 const logs=(receipt.logs||[]).filter(l=>same(l.address,plan.redemption.mint)).flatMap(l=>{try{const x=CORLA_MINT.parseLog(l);return x?.name==='Refunded'&&same(x.args.account,plan.wallet)?[x]:[];}catch{return [];}});
 if(logs.length!==1||logs[0].args.amount!==BigInt(plan.redemption.amount))throw fail('CORLA_RECEIPT','退款回执未证明本钱包足额退款，需要核对原单');
 if(plan.expectedAsset.kind==='Erc20'){
  const transfers=(receipt.logs||[]).filter(l=>same(l.address,plan.outputToken)).flatMap(l=>{try{const x=TRANSFER.parseLog(l);return x?.name==='Transfer'&&same(x.args.to,plan.wallet)&&same(x.args.from,plan.redemption.mint)?[x.args.value]:[];}catch{return [];}});
  if(transfers.reduce((a,b)=>a+b,0n)<BigInt(plan.minOutput))throw fail('CORLA_RECEIPT','退款代币实际到账不足，需要核对原单');
 }
 return {kind:'refund',amount:plan.redemption.amount,token:plan.outputToken};
}
