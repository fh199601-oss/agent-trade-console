import fs from 'node:fs';
import {keccak256} from 'ethers';
import {Interface,address,read,same,BNB,USDT,ERC20,ZeroAddress,parseUnits,formatUnits} from './common.mjs';
import {codeIdentity} from './discovery.mjs';
import {binanciansInput} from '../public/binancians-input.mjs';
export const BINANCIANS=JSON.parse(fs.readFileSync(new URL('./binancians-protocol.json',import.meta.url),'utf8'));
export const BINANCIANS_FACTORY=new Interface(BINANCIANS.factoryAbi),BINANCIANS_MINT=new Interface(BINANCIANS.mintAbi);
const F=BINANCIANS_FACTORY,M=BINANCIANS_MINT,T=new Interface(['function minter() view returns(address)','function factory() view returns(address)']);
const fail=(code,message,details)=>Object.assign(Error(message),{code,details});
const minimum=(...v)=>v.reduce((a,b)=>a<b?a:b),positive=v=>v>0n?v:0n;
const clients=new WeakMap();
export const binanciansClient=rpc=>{if(!clients.has(rpc))clients.set(rpc,new BinanciansClient(rpc));return clients.get(rpc);};
export class BinanciansClient{
 constructor(rpc,{root=BINANCIANS,identity=codeIdentity,now=Date.now}={}){Object.assign(this,{rpc,root,identity,now});this.cache=new Map();this.pending=new Map();}
 async cached(key,ms,work){const old=this.cache.get(key);if(old?.until>this.now())return old.value;if(this.pending.has(key))return this.pending.get(key);
  const task=work().then(value=>{if(ms){if(this.cache.size>=256)this.cache.delete(this.cache.keys().next().value);this.cache.set(key,{value,until:this.now()+ms});}return value;});this.pending.set(key,task);try{return await task;}finally{this.pending.delete(key);}}
 get(to,abi,name,args=[],block='latest'){return read(this.rpc,to,abi,name,args,block);}
 async factory(){return this.cached('factory',5000,async()=>{
  const r=this.root;await this.rpc.verifyChain();const [identity,hub,values]=await Promise.all([this.identity(this.rpc,r.factory),this.identity(this.rpc,r.hub),Promise.all(['mintTemplate','tokenTemplate','registrar','eventHub','router','wrappedNative','usdt'].map(k=>this.get(r.factory,F,k)))]);
  const expected=[r.mintTemplate,r.tokenTemplate,r.registrar,r.hub,r.router,r.wrappedNative,r.usdt];
  if(identity.fingerprint!==r.factoryFingerprint||hub.fingerprint!==r.hubFingerprint||values.some((v,n)=>!same(v[0],expected[n])))throw fail('BINANCIANS_VERSION_CHANGED','币安人发射台工厂或模板已变化，需要重新核验');
  return [identity,hub];
 });}
 async locate(ca,{explicit=false}={}){
  ca=address(ca);return this.cached('locate:'+ca+':'+explicit,5000,async()=>{
   // A code prefix is only a fast hint. Registry, token and implementation are
   // cross-checked below before accepting either a Mint CA or a token CA.
   const code=await this.rpc.getCode(ca),impl=/^0x363d3d373d3d3d363d73([\da-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(code)?.[1],r=this.root;
   if(!impl||![r.mintTemplate,r.tokenTemplate].some(a=>same(a,'0x'+impl))){if(explicit)throw fail('BINANCIANS_NOT_FOUND','该地址不是当前已核验的币安人发射台项目；请检查项目链接');return null;}
   const isMint=same('0x'+impl,r.mintTemplate),[token]=isMint?await this.get(r.factory,F,'mintToToken',[ca]):[ca];
   if(same(token,ZeroAddress))throw fail('BINANCIANS_NOT_FOUND','该 Mint 未登记在币安人发射台工厂');
   const [record]=await this.get(r.factory,F,'getProject',[token]);const row={token:address(token),...record.toObject()};
   if(same(row.mint,ZeroAddress)||isMint&&!same(row.mint,ca))throw fail('BINANCIANS_NOT_FOUND','项目地址与工厂登记不一致');
   await this.verify(row);return row;
  });
 }
 async verify(row){return this.cached('verify:'+row.mint,5000,async()=>{
  const r=this.root,[protocol,identity,tokenIdentity,[registered],[mapped],values,tokenValues]=await Promise.all([
   this.factory(),this.identity(this.rpc,row.mint),this.identity(this.rpc,row.token),this.get(r.factory,F,'isMint',[row.mint]),this.get(r.factory,F,'mintToToken',[row.mint]),
   Promise.all(['token','factory','hub','registrar','router','quote','nativePayment'].map(k=>this.get(row.mint,M,k))),Promise.all(['minter','factory'].map(k=>this.get(row.token,T,k)))]);
  const expected=[row.token,r.factory,r.hub,r.registrar,r.router,row.quote];
  if(!registered||!same(mapped,row.token)||!same(identity.implementation,r.mintTemplate)||keccak256(identity.implementationCode||'0x')!==r.mintHash||!same(tokenIdentity.implementation,r.tokenTemplate)||keccak256(tokenIdentity.implementationCode||'0x')!==r.tokenHash||values.slice(0,6).some((v,i)=>!same(v[0],expected[i]))||values[6][0]!==row.nativePayment||!same(tokenValues[0][0],row.mint)||!same(tokenValues[1][0],r.factory))throw fail('BINANCIANS_NOT_VERIFIED','项目工厂登记、Mint 模板或到账代币不匹配');
  if(row.nativePayment?!same(row.quote,r.wrappedNative):!same(row.quote,r.usdt))throw fail('BINANCIANS_PAYMENT_UNSUPPORTED','该平台付款币尚未核验');
  return {identity,protocolIdentities:[...protocol,tokenIdentity]};
 });}
 describe(row,source){return {platform:'binancians',name:row.name+' · 币安人 LaunchPad',source:source||this.root.origin+'/project/'+row.mint,address:row.mint,mintContract:row.mint,token:row.token,assetKind:'Erc20',candidates:[],addresses:[
  {address:row.mint,name:row.name,primary:true,roles:['mint'],verifiedRoles:['mint'],roleLabels:['Mint / 项目入口'],evidence:[{label:'已核验工厂登记与 Mint 模板'}]},
  {address:row.token,name:row.symbol,primary:false,roles:['token'],verifiedRoles:['token'],roleLabels:['到账代币 CA'],evidence:[{label:'工厂和 Mint 合约一致指向该代币'}]}],mintRoutes:[{id:'binancians:mint',method:'mint(uint256,address,uint256,uint256)',label:'Agent ID 付费 Mint'}]};}
 async state(row,w){
  await this.verify(row);const block=await this.rpc.getBlockNumber();
  const fields=['totalMinted','TOTAL_SHARES','MAX_PER_TX','opened','paused','refunding'];
  const [values,[id,valid]]=await Promise.all([Promise.all(fields.map(k=>this.get(row.mint,M,k,[],block))),this.get(row.mint,M,'agentOf',[w.address],block)]);
  const [minted,total,perTx,opened,paused,refunding]=values.map(v=>v[0]);
  if(total<=0n||minted>total||perTx!==10n)throw fail('BINANCIANS_TERMS_CHANGED','平台份额参数异常，需要重新核验');
  const [[quota],[used]]=valid?await Promise.all([this.get(row.mint,M,'quotaOf',[id],block),this.get(row.mint,M,'mintedCount',[id],block)]):[[0n],[0n]];
  const remaining=minimum(positive(quota-used),total-minted);let errorCode,error;
  if(refunding){errorCode='MINT_ENDED';error='项目已进入退款阶段，不能继续 Mint';}
  else if(paused){errorCode='MINT_PAUSED';error='项目方暂停了 Mint';}
  else if(!valid){errorCode='MINT_INELIGIBLE';error='该钱包没有当前项目认可的有效 Agent ID；钱包已登录不等于持有有效 Agent ID';}
  else if(!remaining){errorCode='NO_QUOTA';error='本钱包或项目剩余 Mint 额度为 0';}
  const currency=row.nativePayment?'BNB':'USDT',info={available:!error,error,errorCode,opened,stateLabel:refunding?'退款阶段':paused?'已暂停':opened?'已开盘 · 仍可 Mint':'Mint 中',freeRemaining:'0',paidRemaining:String(error?0n:remaining),walletRemaining:String(positive(quota-used)),globalRemaining:String(total-minted),maxPerTransaction:String(perTx),agentEligible:valid,agentId:String(id),currency,budgetCurrency:currency,paymentDecimals:18,paymentToken:row.nativePayment?BNB:USDT,notes:['该平台为付费 Mint，代币在 Mint 时直接到账；开盘后无需另行领取。']};
  return {row,w,block,id,remaining,perTx,minted,total,info};
 }
 quote(s,n){return this.cached('quote:'+s.row.mint+':'+s.block+':'+n,2000,async()=>{const [cost,out]=await this.get(s.row.mint,M,'previewMint',[n],s.block);if(cost<=0n||out<=0n)throw fail('BINANCIANS_QUOTE_INVALID','平台未返回有效的付费报价与到账数量');return {cost,out};});}
 async fullCost(s,n){
  if(n<=s.perTx)return (await this.quote(s,n)).cost;
  // previewMint is limited to ten. Sum the public per-share prices for larger
  // fills and cross-check the same indices against the first complete batch.
  const prices=[];for(let start=1n;start<=n;start+=10n){const count=minimum(10n,n-start+1n);prices.push(...await Promise.all(Array.from({length:Number(count)},(_,i)=>this.get(s.row.mint,M,'priceOf',[s.minted+start+BigInt(i)],s.block).then(v=>v[0]))));}
  if(prices.some(p=>p<=0n)||prices.slice(0,Number(s.perTx)).reduce((a,b)=>a+b,0n)!==(await this.quote(s,s.perTx)).cost)throw fail('BINANCIANS_QUOTE_INVALID','分份价格与链上批量报价不一致，请重新核验');return prices.reduce((a,b)=>a+b,0n);
 }
 async referral(row,wallets){const inviter=wallets.find(w=>w.account===1);if(!inviter)return {detected:true,status:'needs-adapter',url:null,note:'未配置 1 号邀请钱包'};
  const [id,valid]=await this.get(row.mint,M,'agentOf',[inviter.address]);return {detected:true,account:1,address:inviter.address,appliesTo:[2,3],bindingVerified:true,valueKind:'address',url:valid?this.root.origin+'/project/'+row.mint+'?ref='+inviter.address:null,status:valid?'ready':'inactive',agentId:String(id),note:valid?'1 号地址作为 referrer；每项目首次 Mint 可增加邀请人额度。':'1 号没有有效 Agent ID，当前无法获得邀请额度。'};
 }
}
export async function discoverBinancians(rpc,input,{client=binanciansClient(rpc)}={}){
 const hint=binanciansInput(input);if(!hint)return null;if(!hint.address)throw fail('BINANCIANS_PROJECT_REQUIRED','已识别币安人发射台，请输入具体项目详情网址或 Mint / 代币 CA');
 const row=await client.locate(hint.address,{explicit:hint.explicit});return row?client.describe(row,hint.source):null;
}
export async function inspectBinancians(rpc,resolved,wallets,{client=binanciansClient(rpc)}={}){
 const row=await client.locate(resolved.address,{explicit:true});const [quotas,referral]=await Promise.all([Promise.all(wallets.map(async w=>{try{
  const s=await client.state(row,w),lots=minimum(s.remaining,500n),cost=s.info.error||!lots?0n:await client.fullCost(s,lots),unit=s.info.error?null:await client.quote(s,1n);
  return {...w,...s.info,adapter:'binancians',unitPrice:unit?{raw:String(unit.cost),formatted:formatUnits(unit.cost,18),symbol:s.info.currency}:null,fullBudget:{quantity:Number(s.info.error?0n:lots),raw:String(cost),block:s.block}};
 }catch(e){return {...w,error:e.message,errorCode:e.code};}})),client.referral(row,wallets)]);
 return {...resolved,...client.describe(row,resolved.source),quotas,referral,needAiDeep:false,at:Date.now()};
}
export async function binanciansPlan(rpc,intent,w,resolved,{client=binanciansClient(rpc),wallets=[],officialPreview=false}={}){
 if(intent.routeId&&intent.routeId!=='binancians:mint')throw fail('MINT_ROUTE_INVALID','币安人发射台请使用付费 Mint 入口');
 const row=await client.locate(resolved.address,{explicit:true}),[s,proof]=await Promise.all([client.state(row,w),client.verify(row)]);
 if(s.info.error)throw fail(s.info.errorCode,s.info.error,{quota:s.info});
 if(intent.scope==='free')throw fail('NO_FREE_MINT','此项目没有免费份额；Agent ID 提供的是付费 Mint 资格，请选择付费或全部额度。',{quota:s.info});
 if(intent.quoteToken!==undefined)throw fail('MINT_ROUTE_INVALID','本平台使用 BNB / USDT 预算');
 const requested=intent.quantity==='max'?minimum(s.remaining,500n):BigInt(intent.quantity);
 if(requested>s.remaining)throw fail('NO_QUOTA','指定份数超过本钱包或项目剩余额度',{quota:s.info});
 const budget=parseUnits(row.nativePayment?intent.maxBnb:intent.maxUsdt||'0',18);let n=minimum(requested,s.perTx),q=await client.quote(s,n);
 if(q.cost>budget){if(intent.quantity!=='max')throw fail('BUDGET_LIMIT','预算不足以完成本次 Mint');let lo=0n,hi=n;while(lo<hi){const mid=(lo+hi+1n)/2n;if((await client.quote(s,mid)).cost<=budget)lo=mid;else hi=mid-1n;}n=lo;if(!n)throw fail('BUDGET_LIMIT','预算不足以 Mint 1 份；请选择付款额度并核对预算');q=await client.quote(s,n);}
 if(intent.quantity!=='max'&&await client.fullCost(s,requested)>budget)throw fail('BUDGET_LIMIT','预算不足以完成指定的全部份数');
 let referrer=ZeroAddress;const referral=await client.referral(row,wallets);
 if(intent.referral!=='none'&&[2,3].includes(w.account)){
  if(referral.status!=='ready'||same(referral.address,w.address))throw fail('REFERRAL_UNAVAILABLE','1 号邀请身份未通过核验，请刷新或明确关闭邀请');referrer=referral.address;
 }
 const steps=[],input=row.nativePayment?BNB:USDT;
 if(row.nativePayment){if(await rpc.getBalance(w.address,s.block)<q.cost)throw fail('BUDGET_LIMIT','BNB 余额不足以支付本次 Mint（Gas 另计）');}
 else{const [[balance],[allowance]]=await Promise.all([read(rpc,USDT,ERC20,'balanceOf',[w.address],s.block),read(rpc,USDT,ERC20,'allowance',[w.address,row.mint],s.block)]);if(balance<q.cost)throw fail('BUDGET_LIMIT','USDT 余额不足以支付本次 Mint');if(allowance<q.cost)steps.push({kind:'approve',to:USDT,value:'0',spender:row.mint,allowance:String(q.cost),data:ERC20.encodeFunctionData('approve',[row.mint,q.cost])});}
 const min=q.out*BigInt(10000-intent.slippageBps)/10000n;if(min<=0n)throw fail('BINANCIANS_QUOTE_INVALID','最低到账必须大于 0');
 const step={kind:'mint',to:row.mint,value:row.nativePayment?String(q.cost):'0',data:M.encodeFunctionData('mint',[n,referrer,q.cost,min])};
 if(!officialPreview&&!steps.length)await rpc.call({to:step.to,data:step.data,from:w.address,value:BigInt(step.value)},s.block);
 return {kind:'contract',route:'binancians:mint',token:row.token,wallet:w.address,inputToken:input,outputToken:row.token,amountIn:String(q.cost),minOutput:String(min),quantity:Number(n),...proof,metaVerified:false,requireAssetCredit:true,expectedAsset:{token:row.token,kind:'Erc20',amount:String(min)},budgetCurrency:s.info.currency,budgetDecimals:18,budgetToken:input,quota:s.info,referral:{...referral,callValue:referrer},fill:{continue:n<requested&&q.cost<budget,quotaRemaining:String(s.remaining)},review:['币安人发射台付费 Mint；每笔最多 10 份，代币直接到账。后续批次重查额度和报价，累计费用不超过本次预算。','平台适配不代表项目已完成安全审计。'],steps:[...steps,step]};
}
