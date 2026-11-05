import {hash,wallet,same,read,ERC20,ZeroAddress,percentOf} from './common.mjs';
import {CORLA_MINT} from './corla.mjs';
const ended=new Set(['DONE','STOPPED','COMPLETED','CANCELLED','EXPIRED','DELETED']);
const pending=new Set(['PENDING','SUBMITTING','SUBMISSION_UNKNOWN','RECEIPT_REVIEW','READY_TO_CONTINUE','APPROVAL_CONFIRMED']);
const validAddress=a=>/^0x[\da-f]{40}$/i.test(a||'')&&!same(a,ZeroAddress);
export class TaskEnrollment{
 constructor({engine,corla,opening,rpc,now=Date.now,binding=wallet}){Object.assign(this,{engine,corla,opening,rpc,now,binding});this.inflight=new Map();}
 recent(){
  const groups=new Map();let count=0;
  for(const o of this.engine.list()){
   if(o.intent?.side!=='mint'||o.simulationOnly!==false||o.createdAt<this.now()-30*86400000||!o.plan||!o.steps?.some(e=>e.status==='CONFIRMED'&&e.step?.kind==='mint'))continue;
   const p=o.plan,corla=p.route==='corla:mint';if(!corla&&(p.expectedAsset?.kind!=='Erc20'||p.route==='corla:claim'||p.route==='corla:refund'||!o.steps.some(e=>e.status==='CONFIRMED'&&BigInt(e.received||0)>0n)))continue;
   if(corla&&!o.steps.some(e=>e.status==='CONFIRMED'&&e.settlement?.kind==='subscription'))continue;
   let w;try{w=this.binding(o.intent.account);}catch{continue;}if(!same(w.address,p.wallet))continue;
   const asset=corla?p.subscription?.mint||p.identity?.target:p.outputToken;if(!validAddress(asset))continue;
   const id=(corla?'claim:':'sell:')+asset.toLowerCase();
   if(!groups.has(id)){if(groups.size>=30)continue;groups.set(id,{id,name:o.project?.name||p.project?.name||'Mint 项目',kind:corla?'corla':'opening',asset,mint:corla?asset:null,orders:new Map(),createdAt:o.createdAt});}
   const g=groups.get(id);if(!g.orders.has(w.account))g.orders.set(w.account,o);if(++count>=200)break;
  }
  return [...groups.values()];
 }
 existing(g,account,token){
  const c=this.corla.list().find(j=>j.account===account&&same(j.mint,g.mint)&&!ended.has(j.status));
  const s=validAddress(token)&&this.opening.list().find(j=>same(j.config.asset,token)&&j.config.accounts.includes(account)&&!ended.has(j.status));
  return c?{kind:'corla',id:c.id}:s?{kind:'opening',id:s.id}:null;
 }
 async inspect(g,accounts=[...g.orders.keys()]){
  let token=g.asset,proof,row,phase,snapshot;
  if(g.kind==='corla'){
   row=await this.corla.client.locate(g.mint,{explicit:true});if(!row||!same(row.record.mint,g.mint))throw Error('Corla 项目登记未核验');
   proof=await this.corla.client.verify(row,{fresh:true});const [,status]=await this.corla.client.get(g.mint,CORLA_MINT,'getMintState');phase=Number(status);token=row.record.expectedToken;
   if(![1,2].includes(phase))throw Error(phase===3?'项目已经开盘，请使用领取或手动交易入口':'项目已结束或处于退款阶段');
  }else{snapshot=await this.opening.detector.scan(token,{currency:'AUTO'});if(snapshot.open)throw Error('项目已经开盘，请使用快捷交易');if(snapshot.partial)throw Error('池子状态查询不完整，请稍后刷新');}
  const wallets=await Promise.all(accounts.map(async account=>{
   const o=g.orders.get(account),w=this.binding(account);if(!o||!same(w.address,o.plan.wallet))throw Error('钱包或历史认购记录已变化');
   const existing=this.existing(g,account,token);if(existing)return {account,available:false,existing,reason:'已有任务，可在“修改”中调整卖出设置'};
   if(this.engine.list().some(x=>x.intent?.account===account&&pending.has(x.status)&&same(x.plan?.outputToken,token)))return {account,available:false,reason:'该代币有待核对原单'};
   if(g.kind==='corla'){
    if(proof.identity?.fingerprint!==o.plan.identity?.fingerprint||proof.factoryIdentity?.fingerprint!==o.plan.protocolIdentities?.[0]?.fingerprint)throw Error('项目合约身份与认购时不一致');
    const [participated,,,claimed,refunded]=await this.corla.client.get(g.mint,CORLA_MINT,'getUserInfo',[w.address]);
    return {account,available:!!participated&&!claimed&&!refunded,reason:!participated?'没有当前认购份额':claimed?'已经领取':refunded?'已经退款':null};
   }
   const [balance]=await read(this.rpc,token,ERC20,'balanceOf',[w.address]);return {account,available:balance>0n,reason:balance>0n?null:'当前没有该代币持仓'};
  }));return {id:g.id,name:g.name,kind:g.kind,asset:validAddress(token)?token:g.asset,mint:g.mint,phase,createdAt:g.createdAt,wallets,proof};
 }
 async candidates(){
  const groups=this.recent(),projects=[];
  for(let n=0;n<groups.length;n+=4)projects.push(...await Promise.all(groups.slice(n,n+4).map(async g=>{try{const {proof,...p}=await this.inspect(g);return p;}catch(e){return {id:g.id,name:g.name,kind:g.kind,asset:g.asset,wallets:[],unavailable:e.message};}})));
  return {projects,checkedAt:this.now()};
 }
 add(input){
  if(input?.confirmed!==true||Object.keys(input).some(k=>!['confirmed','requestId','candidateId','action','accounts','percent'].includes(k))||typeof input.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestId)||typeof input.candidateId!=='string'||!['claim','claim-sell','sell'].includes(input.action)||!Array.isArray(input.accounts)||!input.accounts.length||input.accounts.length>200||input.accounts.some(a=>!Number.isInteger(a)||a<1)||new Set(input.accounts).size!==input.accounts.length)throw Error('请选择项目、钱包和自动任务，并点击确认添加');
  if(!this.engine.live)throw Error('模拟环境只允许检查，不启动实盘任务');
  const percent=String(input.percent??'50');percentOf(100000000n,percent);const payload={candidateId:input.candidateId,accounts:[...input.accounts].sort(),action:input.action,percent},fingerprint=hash(payload),key=input.requestId;
  if(this.inflight.has(key)){const old=this.inflight.get(key);if(old.fingerprint!==fingerprint)throw Error('同一请求不能更改任务设置');return old.promise;}
  const promise=this.create({...input,percent},fingerprint);this.inflight.set(key,{fingerprint,promise});promise.finally(()=>this.inflight.delete(key)).catch(()=>{});return promise;
 }
 async create(input,fingerprint){
  const g=this.recent().find(g=>g.id===input.candidateId);if(!g)throw Error('未找到最近 30 天的真实 Mint 到账记录');
  if(g.kind==='corla'&&input.action==='sell'||g.kind==='opening'&&input.action!=='sell')throw Error('该项目的自动任务类型不匹配');
  const refs=input.accounts.map(account=>({account,id:'late-'+hash([input.requestId,g.id,account]).slice(0,32)})),manager=g.kind==='corla'?this.corla:this.opening,results=[],newRefs=[];
  for(const r of refs){if(!g.orders.has(r.account))throw Error('所选钱包没有该项目的确认记录');const old=manager.jobs.get(r.id);if(old){if(old.lateRequestHash!==fingerprint)throw Error('请求 ID 与原任务设置不符');results.push({...r,created:false,duplicate:true,status:old.status});}else newRefs.push(r);}
  if(!newRefs.length)return {results,created:0};
  const current=await this.inspect(g,newRefs.map(r=>r.account));
  for(const ref of newRefs){try{
   if(manager.closed)throw Error('服务正在停止，请刷新后再添加任务');
   const ready=current.wallets.find(w=>w.account===ref.account);if(!ready?.available)throw Error(ready?.reason||'当前不能添加');
   const o=g.orders.get(ref.account),w=this.binding(ref.account);if(!same(w.address,o.plan.wallet))throw Error('钱包绑定已变化');
   if(this.existing(g,ref.account,current.asset))throw Error('已有相同钱包项目任务，请修改原任务');
   const authorization='用户在本地看板确认补建任务：'+g.name+'；钱包 '+ref.account+'；'+(input.action==='claim'?'开盘自动领取全部，不卖出':input.action==='claim-sell'?'开盘领取全部后按当前持仓卖出 '+input.percent+'%，固定滑点 50%':'检测到开盘后按当前持仓卖出 '+input.percent+'%，固定滑点 50%');
   let job;
   if(g.kind==='corla'){
    // This is an explicit NEW task. Never change the historical Mint intent or
    // execute unfinished subscription batches merely to enable a later claim.
    job={id:ref.id,parents:[o.id],account:ref.account,wallet:w.address,mint:g.mint,name:g.name,identity:current.proof.identity,protocolIdentities:[current.proof.factoryIdentity],policy:{autoClaim:true,mint:g.mint,expectedToken:same(current.asset,g.mint)?ZeroAddress:current.asset,sell:input.action==='claim-sell'?{percent:input.percent,slippageBps:5000,currency:'AUTO'}:null},status:'WATCHING',createdAt:this.now(),attempts:0,lateRequestHash:fingerprint,authorization,message:'用户补建任务：监测开盘，不追加认购'};
    manager.jobs.set(ref.id,job);try{manager.persist();}catch(e){manager.jobs.delete(ref.id);throw e;}manager.schedule();
   }else{
    const check=await this.opening.check({asset:current.asset,accounts:[ref.account],percent:input.percent,slippageBps:5000,currency:'AUTO'});
    if(check.snapshot.open||check.snapshot.partial)throw Error('开盘状态已变化，请刷新项目列表');
    if(this.existing(g,ref.account,current.asset))throw Error('已有相同钱包项目任务');
    this.opening.checks.delete(check.id);check.id=ref.id;this.opening.checks.set(ref.id,check);
    job=this.opening.arm(ref.id,{confirmed:true,late:{requestHash:fingerprint,name:g.name,parent:o.id}});
   }
   results.push({...ref,created:true,status:job.status});
  }catch(e){results.push({...ref,created:false,message:e.message});}}
  return {results,created:results.filter(r=>r.created).length};
 }
}
