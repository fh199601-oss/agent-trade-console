import {batchGas,standardBatch,dividendBatch,needsDividendGas,incompatibleGas} from './dividend-gas.mjs';
import {managedDirectory,managedSupported,profileDirectory,publicManagedAddress} from './managed-trigger.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {Transaction,ZeroHash,getAddress,keccak256} from 'ethers';
import {ERC20,read,same,save,load} from '../common.mjs';
import {verifyPreview} from '../engine.mjs';
import {addressRatingReview} from './address-ratings.mjs';
import {randomUUID} from 'node:crypto';
import {describeError} from '../../public/error-message.mjs';
import {FastSaleService,validateFastSettings} from './service.mjs';
import {TAX_BSC_SALE,BscVenue,SALE,saleEvents,TRANSFER_MESSAGE} from './bsc.mjs';
import {TriggerClient} from './trigger-client.mjs';
import {EXECUTE} from './trigger.mjs';

const requestKey=/^[a-zA-Z0-9_-]{1,100}$/;
async function eachWallet(rows,fn){
 let index=0;
 await Promise.all(Array.from({length:Math.min(16,rows.length)},async()=>{
  while(index<rows.length)await fn(rows[index++]);
 }));
}
const activePhase=x=>!x.deletedAt&&!['COMPLETED','REVIEW'].includes(x.status);
const settingsFor=(b,venue,executor)=>validateFastSettings({...b,executor},venue);
const groupAccounts=accounts=>[...accounts].sort((a,b)=>a-b).join(',');
const walletSet=rows=>groupAccounts(rows.map(w=>w.account));
const sameVenue=(a,b)=>['token','pair','quote','source','getter','tokenHash','quoteHash','sourceHash'].every(k=>same(a[k],b[k]))&&a.quoteIdentity===b.quoteIdentity&&a.quoteDecimals===b.quoteDecimals;
const message=e=>describeError(e);
async function credentialAction(action,options){
 const client=new TriggerClient(async()=>{throw Error('本地凭据操作不使用节点');});
 try{return await client.request(action,[],options);}finally{await client.worker.terminate();}
}
export class LiveFastSale extends FastSaleService {
 constructor({rpc,bridge,data,bindings,managedRoot=managedDirectory(),deployment={}}){
  const file=path.join(data,'fast-sale-mainnet-jobs.json'),adapter=new BscVenue(rpc,deployment);
  super({adapter,trigger:{},store:{load:()=>load(file,[]),save:j=>save(file,j)}});
  this.managedRecord=path.join(data,'fast-sale-managed-address.json');
  this.managedRoot=managedRoot;
  const savedTrigger=load(this.managedRecord,null);
  this.managedAddress=savedTrigger?.address||null;
  this.managedAddresses=new Set([...(savedTrigger?.addresses||[]),this.managedAddress].filter(Boolean));
  this.generatedAddress=savedTrigger?.generatedAddress||null;
  if(!this.generatedAddress&&this.managedAddress){
   try{this.generatedAddress=publicManagedAddress(this.managedRoot);}catch{/* A damaged wallet slot is reported when selected. */}
  }
  this.bindings=bindings;this.data=data;this.rpc=rpc;this.bridge=bridge;this.trigger=null;this.walletWork=new Map();this.probes=new Set();this.starting=new Set();
  for(const j of this.jobs){
   for(const r of j.rows){
    if(r.status==='REVIEW'&&r.receipt&&r.message==='代币转账扣费或到账数量异常'){
     r.status='FAILED';r.reason='TRANSFER_MISMATCH';r.message=TRANSFER_MESSAGE;
    }
    if(j.status==='PAUSED'||j.deletedAt)continue;
    if(r.status==='WAIT_AUTH'||r.status==='APPROVAL_PENDING'&&!r.approval||r.status==='REGISTRATION_PENDING'&&!r.registration){
     r.status='FAILED';r.message='服务在提交前重启，此钱包尚未提交';
    }
    if(r.status==='PENDING'&&j.batches.some(b=>b.id===r.batch&&b.status==='PREPARED'))r.status='READY';
   }
  }
  for(const j of this.jobs)if(j.status==='REVIEW'&&j.rows.every(r=>['SOLD','FAILED','SKIPPED','EXPIRED'].includes(r.status)))j.status='COMPLETED';
  for(const j of this.jobs)if(j.status==='REGISTERING'){j.pausedFrom='REGISTERING';j.status='PAUSED';j.message='登记过程中服务重启，请核对原单后恢复';}
  this.persist();
 }
 status(){return {mode:'LIVE',enabled:true,appFreeApprovals:true,appFreeRegistration:true,taxAware:this.adapter.taxAware,managedSupported,privateKeyActions:managedSupported,generatedAddress:this.generatedAddress,managedAddress:this.managedAddress,managedAddresses:[...this.managedAddresses],executor:this.adapter.executor,trigger:this.trigger?.wallet?.address,jobs:this.visibleJobs()};}
 async refreshPastFills(){
  if(this.fillLookup)return this.fillLookup;
  this.fillRetry??=new Map();
  const pending=[];
  for(const j of [...this.jobs].reverse()){
   if(j.deletedAt||!same(j.executor,this.adapter.executor))continue;
   for(const b of j.batches){
    if(b.status!=='CONFIRMED'||!b.hash||this.now()<(this.fillRetry.get(b.hash)||0))continue;
    const rows=j.rows.filter(r=>r.status==='SOLD'&&!r.fill&&r.receipt===b.hash&&r.batch===b.id);
    if(rows.length)pending.push({j,b,rows});
    if(pending.length>=3)break;
   }
   if(pending.length>=3)break;
  }
  if(!pending.length)return;
  this.fillLookup=Promise.all(pending.map(async({j,b,rows})=>{
   this.fillRetry.set(b.hash,this.now()+30000);
   try{
    const original=await this.adapter.followHash(b);
    if(original?.status!=='CONFIRMED')return;
    const outcomes=await this.adapter.outcomes(original.receipt,b.ids,rows,b.hash);
    const [decimals]=Number.isInteger(j.venue.tokenDecimals)?[j.venue.tokenDecimals]:await read(this.rpc,j.asset,ERC20,'decimals').catch(()=>[]);
    if(j.deletedAt)return;
    if(decimals!==undefined&&Number(decimals)<=36)j.venue.tokenDecimals=Number(decimals);
    let updated=false;
    for(const r of rows){
     const fill=outcomes.get(r.plan?.id)?.fill;
     if(fill&&!r.fill&&r.status==='SOLD'&&r.receipt===b.hash){r.fill=fill;updated=true;}
    }
    if(updated)this.persist();
    if(rows.every(r=>r.fill))this.fillRetry.delete(b.hash);
   }catch{/* An unavailable historical receipt can be read again on refresh. */}
  })).finally(()=>{this.fillLookup=null;});
  return this.fillLookup;
 }
 rememberManaged(address,selected){
  const addresses=new Set([...this.managedAddresses,address]);
  save(this.managedRecord,{address:selected,addresses:[...addresses],generatedAddress:this.generatedAddress});this.managedAddresses=addresses;this.managedAddress=selected;
 }
 selectManaged(address){this.rememberManaged(address,address);}
 assertTriggerSelection(address){
  if(this.jobs.some(j=>j.settings?.trigger&&!same(j.settings.trigger,address)&&(
   ['ARMED','PAUSED','WAIT_OPEN_REGISTRATION','REGISTERING'].includes(j.status)||j.batches?.some(b=>['SIGNED','SUBMITTING','PENDING','UNKNOWN'].includes(b.status))))){
   throw Error('已有卖出计划绑定其他触发地址，请使用该地址的原触发钱包');
  }
  if(this.trigger&&!same(this.trigger.wallet.address,address)&&(this.starting.size||this.firing.size||this.preparing.size))throw Error('已有任务正在使用当前触发地址');
 }
 async backup(input,action='backup'){
  if(!managedSupported||!input||Object.keys(input).length!==1||typeof input.address!=='string')throw Error('触发端备份请求无效');
  let address;try{address=getAddress(input.address);}catch{throw Error('触发钱包地址无效');}
  const dir=profileDirectory(this.managedRoot,address);
  if(!['backup','export-key'].includes(action)||!this.managedAddresses.has(address)||publicManagedAddress(dir)!==address)throw Error('请先在本机设置此触发钱包');
  if(this.backingUp||this.importing)throw Error('请先完成本机已打开的钱包窗口');
  this.backingUp=true;
  try{return await credentialAction(action,{dir,address});}finally{this.backingUp=false;}
 }
 async configureKey(action,input){
  const generated=action==='generated';
  if(!managedSupported||(!generated&&action!=='import-key')||!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>generated||k!=='expectedAddress'))throw Error('触发钱包设置请求无效');
  if(this.importing||this.backingUp||this.unlocking||this.managedSetup)throw Error('请先完成当前触发钱包设置');
  let expected=null;
  if(generated){
   expected=this.generatedAddress||publicManagedAddress(this.managedRoot);
   if(!expected){
    // Older installations only recorded the selected address. If its original
    // slot is missing, require that identity rather than silently rotating it.
    const unknown=[...this.managedAddresses].filter(a=>!publicManagedAddress(profileDirectory(this.managedRoot,a)));
    if(unknown.length>1)throw Error('触发钱包原地址记录不完整，请先按地址恢复已有钱包');
    expected=unknown[0]||null;
   }
  }
  else if(input.expectedAddress!=null){try{expected=getAddress(input.expectedAddress);}catch{throw Error('触发钱包地址无效');}}
  this.assertTriggerSelection(expected);
  this.importing=true;
  try{
   const options=generated?{dir:this.managedRoot,create:!expected,expectedAddress:expected}:{root:this.managedRoot,expectedAddress:expected};
   const result=await credentialAction(action,options);
   if(result.cancelled)return {cancelled:true};
   const address=getAddress(result.address);
   if(expected&&!same(address,expected))throw Error('触发钱包地址核验失败');
   if(generated)this.generatedAddress=address;
   this.rememberManaged(address,this.managedAddress);
   this.importing=address;
   try{return await this.setupManaged({expectedAddress:address});}
   catch(e){throw Object.assign(Error('触发钱包已保存在本机，启用失败。'+message(e)),{details:{savedTrigger:address}});}
  }finally{this.importing=null;}
 }
 async unlock({address,keystore,password,remember=false}){
  try{address=getAddress(address);}catch{throw Error('触发地址无效');}if(!keystore||!password)throw Error('请选择触发地址对应的加密 Keystore 并输入密码');
  if(remember===true){
   if(!managedSupported||this.importing||this.unlocking||this.managedSetup)throw Error('本机暂不能导入，请稍后重试');
   this.assertTriggerSelection(address);
   this.importing=address;
   try{
    const dir=profileDirectory(this.managedRoot,address);
    await credentialAction('remember',{dir,address,keystore,password});
    return await this.setupManaged({expectedAddress:address});
   }finally{this.importing=null;}
  }
  return this.connectTrigger({address,keystore,password});
 }
 async setupManaged(input={}){
  if(!managedSupported)throw Error('此系统暂不支持一键设置触发端');
  if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).some(k=>k!=='expectedAddress'))throw Error('触发端设置请求无效');
  let expected=this.managedAddress;
  if(input.expectedAddress){try{expected=getAddress(input.expectedAddress);}catch{throw Error('触发地址无效');}}
  if(!expected&&this.trigger)throw Error('当前已连接其他触发地址，请填写要使用的地址');
  if(this.importing&&!same(this.importing,expected))throw Error('正在导入其他触发钱包');
  this.assertTriggerSelection(expected);
  const dir=profileDirectory(this.managedRoot,expected);
  if(expected&&!same(expected,this.managedAddress)&&publicManagedAddress(dir)!==expected){
   throw Object.assign(Error('首次使用此地址，请点击「导入私钥」，或导入已有的加密备份。'),{code:'TRIGGER_IMPORT_REQUIRED'});
  }
  if(this.trigger&&same(this.trigger.wallet.address,expected)){
   if(!same(this.managedAddress,expected))this.selectManaged(expected);
   return this.status();
  }
  if(this.managedSetup){
   if(this.managedSetup.expected!==expected)throw Error('正在设置不同的触发地址');
   return this.managedSetup.promise;
  }
  const promise=this.connectTrigger({address:expected,managed:{dir,create:!expected,expectedAddress:expected}});
  this.managedSetup={expected,promise};
  try{return await promise;}finally{this.managedSetup=null;}
 }
 async ensureSigner(address){
  if(this.unlocking&&this.trigger&&!same(this.managedSetup?.expected,address))throw Error('触发端正在切换，请在设置完成后开始任务');
  if(!this.trigger&&this.managedAddress&&same(address,this.managedAddress))await this.setupManaged({expectedAddress:address});
  if(!this.trigger||!same(address,this.trigger.wallet?.address))throw Error('请先设置或解锁对应地址的独立触发端');
 }
 async connectTrigger({address,keystore,password,managed}){
  if(this.importing&&!same(this.importing,address))throw Error('正在配置另一个触发钱包');
  if(this.unlocking)throw Error('触发端正在解锁');
  if(this.trigger&&same(this.trigger.wallet?.address,address))return this.status();
  this.assertTriggerSelection(address);
  this.unlocking=true;let client;
  try{
   await this.adapter.identity();
   const rpc=this.rpc;
   client=new TriggerClient(async(method,params)=>{
    if(method!=='eth_sendRawTransaction')return rpc.send(method,params);
    const tx=Transaction.from(params[0]),fn=EXECUTE.parseTransaction({data:tx.data});
    const spec=fn?.name===dividendBatch.method&&this.adapter.dividendGas?dividendBatch:standardBatch;
    if(fn?.name!==spec.method)throw Error('触发交易方法与本机执行合约不符');
    const batch=fn.args[0];
    if(tx.chainId!==56n||!same(tx.to,this.adapter.executor)||(!client.wallet||!same(tx.from,client.wallet.address))||tx.value!==0n||tx.gasLimit!==batchGas(spec,batch.length)||batch.length<1||batch.length>spec.size)throw Error('触发交易签名范围不符');
    const endpoints=rpc.endpoints,url=endpoints?.custom||rpc.url;
    const transport=endpoints?.transport?.fetch?.bind(endpoints.transport)||fetch;
    const res=await transport(url,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(8000),body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    if(!res.ok)throw Error('触发广播响应异常');const payload=await res.json();
    if(payload.error||payload.result!==tx.hash)throw Error('广播结果待核对');return payload.result;
   });
   const options=managed?{managed}:{keystore,password,address};
   if(address){
    const legacy=path.join(this.data,'fast-trigger',address);
    const current=path.join(managed?.dir||profileDirectory(this.managedRoot,address),'journal',address);
    const hasJournal=d=>fs.existsSync(path.join(d,'originals.json'));
    if(hasJournal(legacy)&&hasJournal(current))throw Error('触发地址存在两份原单日志，请先核对');
    options.dir=hasJournal(legacy)||!managed&&!hasJournal(current)?legacy:current;
   }
   const result=await client.init({...options,executor:this.adapter.executor,executorHash:this.adapter.executorHash,payer:this.adapter.payer,chainId:56});
   this.assertTriggerSelection(result.address);
   if(managed){
    const verified=getAddress(result.address);
    if(address&&!same(verified,address))throw Error('触发端地址核验失败');
    this.selectManaged(verified);
   }
   const previous=this.trigger;
   this.trigger=client;
   if(previous)await previous.close().catch(()=>{});
   return this.status();
  }catch(e){
   if(client?.wallet)await client.close().catch(()=>{});
   else if(client)await client.worker.terminate();
   throw e;
  }finally{this.unlocking=false;}
 }
 owns(asset,owner){
  return this.jobs.some(j=>same(j.asset,asset)&&['WAIT_OPEN_REGISTRATION','REGISTERING','ARMED','PAUSED'].includes(j.status)&&j.rows.some(r=>same(r.address,owner)&&!['FAILED','SKIPPED','EXPIRED','SOLD'].includes(r.status)&&(!r.plan||this.now()/1000<=r.plan.deadline)));
 }
 close(){return this.trigger?.close();}
 // Intent is durable before execute. Receipt recovery never calls execute again.
 async walletCall(j,r,field,step,consent){
  if(r[field]||!this.canSubmit(j,field))return;
  if(this.bindings&&!this.bindings().some(w=>w.account===r.account&&same(w.address,r.address)))throw Error('钱包编号的绑定已变化');
  await this.bridge.ready(r.account,{external:true});
  const preview=await this.bridge.call(r.account,['contract-call','preview','--binanceChainId','56','--from',r.address,'--to',step.to,'--value','0','--inputData',step.data]);
  verifyPreview(preview,{wallet:r.address,amountIn:'0'},{...step,value:'0'});
  const ratings=addressRatingReview(preview,j,r,field,step);
  const appConfirmation=typeof preview.requireConfirmation==='boolean'?preview.requireConfirmation:null;
  if(!this.canSubmit(j,field))throw Error('任务已暂停或删除');
  const directOnly=field==='approval'?j.appFreeOnly:(j.registrationAppFreeOnly??j.appFreeOnly);
  if(directOnly&&appConfirmation!==false){
   delete r.ratingReview;
   r.status='SKIPPED';
   const operation=field==='approval'?'授权':'卖出计划登记';
   const code=preview.simulationResult.preCheckCode;
   const detail=typeof code==='string'&&/^[\w.-]{1,64}$/.test(code)?'钱包预检代码 '+code+'。':'';
   r.message=operation+'模拟通过。'+(appConfirmation?'币安要求 App 确认。':'币安未说明能否免 App 确认。')+detail+'已跳过本钱包的'+operation+'。';
   return;
  }
  const digest=JSON.stringify([field,r.address,j.executor,step.to,keccak256(step.data),ratings,appConfirmation]);
  if(ratings&&(!consent||consent.ticket!==r.ratingReview?.ticket||consent.digest!==digest||consent.until<Date.now())){
   r.ratingReview={ticket:randomUUID(),digest,until:Date.now()+120000,ratings,field,appConfirmation};
   r.status=field==='approval'?'APPROVAL_REVIEW':'REGISTRATION_REVIEW';
   r.message='币安模拟通过，仅返回地址评级。请核对下方预览。';return;
  }
  if(consent&&!ratings)throw Error('钱包风险预览已变化，请重新核对本次操作');
  delete r.ratingReview;
  if(!this.canSubmit(j,field))throw Error('任务已停止，该钱包尚未提交');
  const orig=r[field]={requestId:preview.requestId,to:step.to,dataHash:keccak256(step.data),appConfirmation,status:'SUBMITTING'};
  this.persist();
  delete r.message;
  const record=res=>{
   if(res?.orderId)orig.orderId=res.orderId;
   if(res?.txHash)orig.hash=res.txHash;
   if(res?.status==='PENDING_CONFIRMATION')orig.appConfirmation=true;
   orig.status=orig.hash?'PENDING':res?.status==='PENDING_CONFIRMATION'?'PENDING_CONFIRMATION':'UNKNOWN';
   this.persist();
  };
  try{record(await this.bridge.call(r.account,['contract-call','execute','--requestId',preview.requestId],{onLateResponse:late=>{if(late.data)record(late.data);}}));}
  catch(e){orig.status=e.dispatched===false?'NOT_SENT':'UNKNOWN';orig.message=message(e);this.persist();if(orig.status==='NOT_SENT')throw e;}
 }
 async receipt(r,orig){
  if(!orig?.hash)return null;
  const receipt=await this.rpc.send('eth_getTransactionReceipt',[orig.hash]);if(!receipt)return null;
  const tx=await this.rpc.send('eth_getTransactionByHash',[orig.hash]);
  if(!tx||!same(tx.hash,orig.hash)||!same(receipt.transactionHash,orig.hash)||!same(tx.from,r.address)||!same(tx.to,orig.to)||keccak256(tx.input)!==orig.dataHash||BigInt(tx.value)!==0n)throw Error('回执与钱包原单不符');
  if(BigInt(receipt.status)!==1n){orig.status='REVERTED';throw Error('原交易已上链回滚');}
  return receipt;
 }
 async reconcileRow(j,r){
  const owner=r.address;
  if(r.status==='APPROVAL_PENDING'){
   const receipt=await this.receipt(r,r.approval);
   const [allowance]=await read(this.rpc,j.asset,ERC20,'allowance',[owner,this.adapter.executor]);
   if(allowance===BigInt(r.cap)&&(receipt||r.approval)){r.status='AUTHORIZED';r.message='已核实授权额度';}
   else if(receipt){r.status='FAILED';r.message='代币返回的授权额度与本次余额不符';}
  }else if(r.status==='REGISTRATION_PENDING'){
   const receipt=await this.receipt(r,r.registration);if(!receipt)return;
   const e=saleEvents(receipt,'Registered',this.adapter.executor).find(e=>same(e.owner,owner)&&same(e.token,j.asset));
   if(!e)throw Error('登记回执缺少本钱包的授权计划');
   const p=await read(this.rpc,this.adapter.executor,SALE,'plans',[e.id]);
   if(!same(p.owner,owner)||!same(p.trigger,j.settings.trigger)||p.cap!==BigInt(r.planCap||r.cap)||p.minOut!==BigInt(j.settings.minOut)||Number(p.state)!==1)throw Error('登记计划与钱包参数不符');
   r.plan={id:e.id,owner,token:j.asset,cap:String(p.cap),trigger:p.trigger,minOut:String(p.minOut),deadline:Number(p.deadline)};
   r.status=j.settings.source==='after-claim'&&!r.claimHash?'WAIT_CLAIM':'READY';r.message='计划已登记';
  }
 }
 async reconcile(j){
  if(this.probes.has(j.id))return;this.probes.add(j.id);
  try{
   await eachWallet(j.rows.filter(r=>['APPROVAL_PENDING','REGISTRATION_PENDING'].includes(r.status)),async r=>{
    try{await this.reconcileRow(j,r);}catch(e){r.message=message(e);if([r.approval,r.registration].some(o=>o?.status==='REVERTED'))r.status='FAILED';}
   });
   if(j.status==='AUTHORIZING'&&!j.rows.some(r=>['WAIT_AUTH','APPROVAL_PENDING','APPROVAL_REVIEW'].includes(r.status)))j.status=j.rows.some(r=>r.status==='AUTHORIZED')?'AUTHORIZED':'REVIEW';
   if(j.status==='REGISTERING'&&j.rows.some(r=>r.plan)&&this.trigger){j.status='ARMED';}
   if(j.status==='REGISTERING'&&j.rows.every(r=>['SKIPPED','FAILED'].includes(r.status)))j.status='REVIEW';
   if(j.status==='ARMED'&&this.trigger)await this.prepareReady(j);
   this.persist();
  }finally{this.probes.delete(j.id);}
 }
 async enroll({id,asset,wallets,appFreeOnly=false}){
  if(typeof appFreeOnly!=='boolean')throw Error('请选择有效的授权确认方式');
  asset=getAddress(asset);if(typeof id!=='string'||!requestKey.test(id)||!wallets.length||wallets.length>100)throw Error('授权批次或钱包数量无效');
  const existing=this.jobs.find(j=>j.id===id);
  if(existing){if(existing.deletedAt)throw Error('该任务已删除');if(Boolean(existing.appFreeOnly)!==appFreeOnly||!same(existing.asset,asset)||walletSet(existing.rows)!==walletSet(wallets))throw Error('批次钱包或代币已发生变化');return structuredClone(existing);}
  const venue=await this.adapter.verifiedVenue(asset);
  if(venue.blockedReason)throw Error(venue.blockedReason);
  if(this.jobs.some(j=>activePhase(j)&&same(j.asset,asset)&&j.rows.some(r=>!['FAILED','SKIPPED','SOLD','EXPIRED'].includes(r.status)&&wallets.some(w=>same(w.address,r.address)))))throw Error('所选钱包已有此币的授权批次，请查看下方原任务');
  const j={id,asset,appFreeOnly,executor:this.adapter.executor,venue,status:'AUTHORIZING',createdAt:Date.now(),rows:wallets.map(w=>({...w,status:'WAIT_AUTH'})),settings:{},batches:[]};
  this.jobs.push(j);this.persist();
  await this.continueWallets(j,'approval');return structuredClone(j);
 }
 canSubmit(j,field){return !j.deletedAt&&(field==='approval'?j.status==='AUTHORIZING':['REGISTERING','ARMED'].includes(j.status));}
 async confirmRatings({id,asset,field,reviews}){
  const job=this.jobs.find(j=>j.id===id);
  if(!job||!same(asset,job.asset)||!same(job.executor,this.adapter.executor)||!['approval','registration'].includes(field)||!this.canSubmit(job,field)||!Array.isArray(reviews)||!reviews.length||reviews.length>100)throw Error('当前任务不能确认此预览');
  if(this.walletWork.has(id+':'+field))throw Error('正在处理本批钱包，请稍候');
  const consents=new Map();
  for(const {account,ticket} of reviews){
   const row=job.rows.find(r=>r.account===account),review=row?.ratingReview;
   if(!review||review.field!==field||review.ticket!==ticket||row.status!==(field==='approval'?'APPROVAL_REVIEW':'REGISTRATION_REVIEW')||consents.has(account))throw Error('钱包预览已变化，请刷新后核对');
   consents.set(account,review);
  }
  const venue=await this.adapter.verifiedVenue(job.asset);
  if(venue.blockedReason||!sameVenue(venue,job.venue))throw Error('主池或合约已变化，请重新核验');
  if(!this.canSubmit(job,field))throw Error('任务状态已变化');
  await this.continueWallets(job,field,consents);return structuredClone(job);
 }
 async continueWallets(j,field,consents){
  if(needsDividendGas(j.venue)&&!this.adapter.dividendGas)throw Error(incompatibleGas);
  const key=j.id+':'+field;
  if(this.walletWork.has(key))return this.walletWork.get(key);
  const work=(async()=>{
   if(field==='approval')await this.approveRows(j,consents);else await this.registerRows(j,consents);
   await this.reconcile(j);
  })();
  this.walletWork.set(key,work);
  try{await work;}finally{this.walletWork.delete(key);}
 }
 async approveRows(j,consents){
  const asset=j.asset;
  await eachWallet(j.rows.filter(r=>consents? r.status==='APPROVAL_REVIEW'&&consents.has(r.account)&&consents.get(r.account).ticket===r.ratingReview?.ticket : r.status==='WAIT_AUTH'||r.status==='APPROVAL_PENDING'&&!r.approval),async r=>{
   if(!this.canSubmit(j,'approval')||r.approval)return;
   try{
    const [[n],[allowance]]=await Promise.all([read(this.rpc,asset,ERC20,'balanceOf',[r.address]),read(this.rpc,asset,ERC20,'allowance',[r.address,this.adapter.executor])]);
    if(n===0n)throw Error('当前代币余额为零，领取到账后可重新授权');
    if(n>=(1n<<112n))throw Error('余额超出执行合约的数量范围');
    const [previous]=await read(this.rpc,this.adapter.executor,SALE,'active',[r.address,asset]);
    if(previous!==ZeroHash){
     const previousPlan=await read(this.rpc,this.adapter.executor,SALE,'plans',[previous]);
     if(Number(previousPlan.state)===1&&Number(previousPlan.deadline)>=Date.now()/1000&&!(this.adapter.taxAware&&(await read(this.rpc,this.adapter.executor,SALE,'canReplace',[previous,j.venue]))[0]))throw Error('钱包已有未过期的链上代卖计划，请核对原任务');
    }
    if(!this.canSubmit(j,'approval'))return;
    r.cap=String(n);r.attempts=0;
    if(allowance>=n&&allowance<(1n<<112n)){
     delete r.ratingReview;
     r.status='AUTHORIZED';r.message='已核实并复用现有授权，本次计划上限为当前余额。';
    }
    else{
     r.status='APPROVAL_PENDING';await this.walletCall(j,r,'approval',{kind:'approve',to:asset,spender:this.adapter.executor,allowance:r.cap,data:ERC20.encodeFunctionData('approve',[this.adapter.executor,n])},consents?.get(r.account));
    }
   }catch(e){if(!r.approval&&!this.canSubmit(j,'approval'))r.status='WAIT_AUTH';else{r.status='FAILED';r.message=message(e);}}this.persist();
  });
 }
 async start({id,asset,accounts,settings,selectedOnly=false,appFreeOnly}){
  const j=this.jobs.find(x=>x.id===id);
  if(appFreeOnly!==undefined&&typeof appFreeOnly!=='boolean')throw Error('登记确认方式无效');
  const selected=new Set(accounts);
  if(!j||j.deletedAt||!same(asset,j.asset)||!selected.size||selected.size!==accounts.length||accounts.some(n=>!j.rows.some(r=>r.account===n))||!selectedOnly&&selected.size!==j.rows.length)throw Error('代币或选中钱包已改变，请核对授权批次');
  const selectedRows=j.rows.filter(r=>selected.has(r.account));
  const config=settingsFor(settings,j.venue,this.adapter.executor);
  if(['WAIT_OPEN_REGISTRATION','REGISTERING','ARMED'].includes(j.status)){
   if(appFreeOnly!==undefined&&appFreeOnly!==Boolean(j.registrationAppFreeOnly??j.appFreeOnly))throw Error('已开始登记，不能覆盖原批次的 App 确认方式');
   if(JSON.stringify(config)!==JSON.stringify(j.settings)||groupAccounts(j.selectedAccounts||j.rows.map(r=>r.account))!==groupAccounts(accounts))throw Error('已启动任务的钱包或参数不能覆盖');
   return structuredClone(j);
  }
  if(!['AUTHORIZED','AUTHORIZING'].includes(j.status)||j.status==='AUTHORIZING'&&selectedRows.some(r=>r.status==='WAIT_AUTH'||r.status==='APPROVAL_REVIEW')||!selectedRows.some(r=>r.status==='AUTHORIZED'))throw Error('请等待所选钱包授权成功后开始任务');
  if(this.starting.has(id))throw Error('该批次正在处理');
  this.starting.add(id);
  try{
   await this.ensureSigner(config.trigger);await this.trigger.warm();const balance=await this.rpc.send('eth_getBalance',[config.trigger,'latest']);
   const count=selectedRows.filter(r=>r.status==='AUTHORIZED').length;
   const spec=this.adapter.batchSpec(j.venue);
   const gasLimit=600000n*BigInt(Math.ceil(count/spec.size))+spec.gasPerRow*BigInt(count);
   const gasPrice=BigInt(await this.rpc.send('eth_gasPrice',[]));
   if(BigInt(balance)<gasLimit*gasPrice)throw Error('触发地址的 BNB 不足以支付本批卖出的 Gas 上限');
   const v=await this.adapter.verifiedVenue(j.asset);
   if(v.blockedReason)throw Error(v.blockedReason);
   if(!sameVenue(v,j.venue))throw Error('授权后主池或合约已变化，请核对');
   if(j.deletedAt||j.status==='PAUSED')throw Error('任务已停止，尚未登记卖出');
   settingsFor(settings,v,this.adapter.executor);
   j.registrationAppFreeOnly=appFreeOnly??Boolean(j.appFreeOnly);
   j.venue=v;j.settings=config;j.selectedAccounts=[...accounts];j.status=v.registerAfterOpening?'WAIT_OPEN_REGISTRATION':'REGISTERING';
   if(v.registerAfterOpening)j.registrationWaitUntil=this.now()+config.expiryHours*3600000;
   for(const r of j.rows.filter(r=>!selected.has(r.account))){delete r.ratingReview;r.status='SKIPPED';r.message='开始任务时未选中此钱包';}
   for(const r of j.rows.filter(r=>r.status==='APPROVAL_PENDING')){r.status='SKIPPED';r.message='开始时授权尚未确认，未加入本次卖出';}
   this.persist();
   if(j.status==='WAIT_OPEN_REGISTRATION')return structuredClone(j);
   await this.continueWallets(j,'registration');return structuredClone(j);
  }finally{this.starting.delete(id);}
 }
 expireOpeningWait(j){
  if(j.status!=='WAIT_OPEN_REGISTRATION'||this.now()<j.registrationWaitUntil)return false;
  for(const row of j.rows)if(row.status==='AUTHORIZED'){row.status='EXPIRED';row.message='等候开盘已到期，未登记卖出';}
  j.status='COMPLETED';j.message='等候开盘已到期';this.persist();return true;
 }
 registrationReadFailed(asset){
  const reason='主池状态暂时无法核验，正在自动重新读取。';
  for(const j of this.jobs)if(j.status==='WAIT_OPEN_REGISTRATION'&&same(j.asset,asset)&&j.message!==reason){j.message=reason;this.persist();}
 }
 async registerAtOpening(j,snapshot){
  if(j.status!=='WAIT_OPEN_REGISTRATION'||this.expireOpeningWait(j)||this.starting.has(j.id)||!same(snapshot?.token,j.asset))return;
  const changed=()=>{j.status='PAUSED';j.pausedFrom='WAIT_OPEN_REGISTRATION';j.message='主池或合约与开始任务时不一致，已暂停登记。';this.persist();};
  if((snapshot.open||snapshot.registrationReady||snapshot.changed)&&!same(snapshot.pair,j.venue.pair)){changed();return;}
  if(!snapshot.open&&!snapshot.registrationReady){if(j.message){delete j.message;this.persist();}return;}
  if(!this.trigger||!same(this.trigger.wallet?.address,j.settings.trigger))return;
  this.starting.add(j.id);
  try{
   const venue=await this.adapter.verifiedVenue(j.asset);
   if(j.status!=='WAIT_OPEN_REGISTRATION'||this.expireOpeningWait(j))return;
   if(venue.blockedReason||!sameVenue(venue,j.venue)){changed();return;}
   if(venue.marketPending||venue.registerAfterOpening||typeof venue.openAtVerification!=='boolean')return;
   j.venue=venue;j.status='REGISTERING';delete j.message;this.persist();
   await this.continueWallets(j,'registration');
  }finally{this.starting.delete(j.id);}
 }
 async notifyOpening(asset,snapshot){
  const waits=this.jobs.filter(j=>j.status==='WAIT_OPEN_REGISTRATION'&&same(j.asset,asset));
  await Promise.all([super.notifyOpening(asset,snapshot),...waits.map(async j=>{
   await this.registerAtOpening(j,snapshot);
   if(j.status==='ARMED'&&this.adapter.matchesPrimary(j.venue,snapshot)){
    const fresh=await this.adapter.opening(asset);
    await super.notifyOpening(asset,fresh);
   }
  })]);
 }
 async registerRows(j,consents){
  const v=j.venue,config=j.settings;
  await eachWallet(j.rows.filter(r=>(!j.selectedAccounts||j.selectedAccounts.includes(r.account))&&(consents? r.status==='REGISTRATION_REVIEW'&&consents.has(r.account)&&consents.get(r.account).ticket===r.ratingReview?.ticket : r.status==='AUTHORIZED'||r.status==='REGISTRATION_PENDING'&&!r.registration)),async r=>{
   if(!this.canSubmit(j,'registration')||r.registration)return;
   try{
    const [allowance]=await read(this.rpc,j.asset,ERC20,'allowance',[r.address,this.adapter.executor]);
    let cap=BigInt(r.cap),percent=Number(config.percent);
    // The deployed executor accepts quarter increments. For a custom percentage,
    // register the exact quantity selected at task start as a 100% capped sale.
    if(!this.adapter.taxAware&&percent%25!==0){
     const [balance]=await read(this.rpc,j.asset,ERC20,'balanceOf',[r.address]);
     cap=(balance<cap?balance:cap)*BigInt(percent)/100n;percent=100;
     if(!cap)throw Error('当前余额按所填比例折算后不足一个代币最小单位');
    }
    if(allowance<cap)throw Error('授权已减少，请重新授权');
    const units=cap*BigInt(percent)/100n;
    if(!units)throw Error('按此比例可卖数量不足一个最小单位');
    if(v.openAtVerification&&!this.adapter.taxAware){
     const compatible=await this.adapter.transferCompatibility(v,r.address,units);
     const previous=this.jobs.some(h=>same(h.asset,j.asset)&&h.venue?.tokenHash===v.tokenHash&&same(h.venue.pair,v.pair)&&h.rows.some(x=>same(x.address,r.address)&&x.reason==='TRANSFER_MISMATCH'));
     if(compatible===false||compatible===null&&previous)throw Error(compatible===false?'主池转账模拟显示实收与卖出数量不符，当前极速合约不支持；可在快捷交易重新预览。':'此钱包曾因转账实收不符而回滚，本次节点未能核验兼容性；可在快捷交易重新预览。');
    }
    if(!this.canSubmit(j,'registration'))return;
    r.planCap=String(cap);
    const data=SALE.encodeFunctionData('registerSale',[v,cap,config.minOut,config.trigger,same(v.quote,TAX_BSC_SALE.wrapped),percent,config.expiryHours]);
    r.status='REGISTRATION_PENDING';await this.walletCall(j,r,'registration',{kind:'register',to:this.adapter.executor,data},consents?.get(r.account));
   }catch(e){if(!r.registration&&!this.canSubmit(j,'registration'))r.status='AUTHORIZED';else{r.status='FAILED';r.message=message(e);}}this.persist();
  });
 }
 async control(id,action){
  const j=this.jobs.find(x=>x.id===id);
  if(action!=='resume'||j?.status!=='PAUSED'){
   const result=await super.control(id,action);
   if(j&&(j.status==='PAUSED'||j.deletedAt)){
    for(const r of j.rows){
     if(r.status==='APPROVAL_REVIEW'||r.status==='REGISTRATION_REVIEW'){r.status=r.ratingReview?.field==='approval'?'WAIT_AUTH':'AUTHORIZED';delete r.ratingReview;}
     if(r.status==='APPROVAL_PENDING'&&!r.approval)r.status='WAIT_AUTH';
     if(r.status==='REGISTRATION_PENDING'&&!r.registration)r.status='AUTHORIZED';
    }
    this.persist();
   }
   return result;
  }
  const phase=j.pausedFrom||'ARMED';
  if(['ARMED','REGISTERING','WAIT_OPEN_REGISTRATION'].includes(phase))await this.ensureSigner(j.settings.trigger);
  const field=phase==='AUTHORIZING'?'approval':'registration';
  await this.walletWork.get(id+':'+field);
  await super.control(id,action);
  if(phase==='WAIT_OPEN_REGISTRATION'){this.expireOpeningWait(j);return structuredClone(j);}
  if(this.canSubmit(j,field))await this.continueWallets(j,field);
  return structuredClone(j);
 }
}
