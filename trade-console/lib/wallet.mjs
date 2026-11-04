import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {ROOT,wallet,same,load} from './common.mjs';
let seq=0;
export class Wallets{
 constructor(){this.workers=new Map();this.queues=new Map();this.readyCache=new Map();this.readyInflight=new Map();this.warmInflight=new Map();this.foregroundEpoch=new Map();this.timings=[];}
 worker(account){
  if(this.workers.has(account))return this.workers.get(account);
  wallet(account);
  const process=spawn(load(path.join(ROOT,'local/install.json')).python,[path.join(ROOT,'wallet_bridge.py'),String(account)],{cwd:ROOT,stdio:['pipe','pipe','pipe']});
  let readyResolve,readyReject;
  const state={process,pending:new Map(),ready:new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;})};this.workers.set(account,state);
  const readyTimer=setTimeout(()=>{readyReject(Object.assign(Error('钱包启动超时，未提交命令'),{dispatched:false}));process.kill('SIGTERM');},15000);
  state.ready.finally(()=>clearTimeout(readyTimer)).catch(()=>{});
  process.stderr.on('data',()=>{}); // Docker notices never contain actionable trade results.
  createInterface({input:process.stdout}).on('line',line=>{
   let r;try{r=JSON.parse(line,(k,v,c)=>typeof v==='number'&&!Number.isSafeInteger(v)&&/^-?\d+$/.test(c?.source||'')?c.source:v);}catch{return;}
   if(r.ready===true){readyResolve();return;}
   const p=state.pending.get(r.id);if(!p)return;state.pending.delete(r.id);clearTimeout(p.timer);
   if(r.result?.success===true)p.resolve(r.result.data);else p.reject(Object.assign(Error(r.result?.error?.message||'钱包响应无效'),{code:r.result?.error?.code,errorName:r.result?.error?.name,responseReceived:true,dispatched:r.result?.error?.commandDispatched!==false}));
  });
  const fail=()=>{readyReject(Object.assign(Error('钱包常驻进程未就绪'),{dispatched:false}));this.workers.delete(account);this.readyCache.delete(account);for(const p of state.pending.values()){clearTimeout(p.timer);p.reject(Object.assign(Error('钱包进程退出，提交状态需核对'),{dispatched:true}));}state.pending.clear();};
  process.on('exit',fail);process.on('error',fail);return state;
 }
 call(account,args,options={}){
  const queuedAt=Date.now();if(!options.background)this.foregroundEpoch.set(account,(this.foregroundEpoch.get(account)||0)+1);
  const epoch=this.foregroundEpoch.get(account)||0;
  if(options.background&&this.queues.has(account))return Promise.reject(Object.assign(Error('只读预热让位于当前操作'),{code:'WARM_YIELDED',dispatched:false}));
  const prior=this.queues.get(account)||Promise.resolve();
  const op=prior.catch(()=>{}).then(async()=>{if(options.background&&(this.foregroundEpoch.get(account)||0)!==epoch)throw Object.assign(Error('只读预热让位于当前操作'),{code:'WARM_YIELDED',dispatched:false});const w=this.worker(account);await w.ready;return new Promise((resolve,reject)=>{
   const start=Date.now(),id=String(++seq);
   const timer=setTimeout(()=>{w.pending.delete(id);reject(Object.assign(Error('钱包响应超时；仅核对原单，不重新提交'),{dispatched:true}));},120000);
   w.pending.set(id,{timer,resolve:v=>{this.timings.push({account,operation:args.slice(0,2).join(' '),ms:Date.now()-start,queueMs:start-queuedAt,totalMs:Date.now()-queuedAt});if(this.timings.length>1000)this.timings.splice(0,this.timings.length-1000);resolve(v);},reject});
   w.process.stdin.write(JSON.stringify({id,args:args.includes('--json')?args:[...args,'--json'],...(options.readOnlyTimeoutMs?{readOnlyTimeoutMs:options.readOnlyTimeoutMs}:{}),...(options.background?{background:true}:{})})+'\n',e=>{if(e){clearTimeout(timer);w.pending.delete(id);reject(Object.assign(e,{dispatched:false}));}});
  });});this.queues.set(account,op);op.finally(()=>{if(this.queues.get(account)===op)this.queues.delete(account);}).catch(()=>{});return op;
 }
 async ready(account,{external=false,force=false}={}){
  const expected=wallet(account).address,c=this.readyCache.get(account);
  const checkExternal=result=>{if(external&&(!result.devMode?.enabled||!(Date.parse(result.devMode.expiresAt)>Date.now())))throw Error('请在币安 App → Agentic Wallet → 设置中启用 Developer Mode');return result;};
  if(!force&&c&&c.validUntil>Date.now()&&same(expected,c.address))return checkExternal(c);
  if(this.readyInflight.has(account))return checkExternal(await this.readyInflight.get(account));
  const pending=this.checkReady(account,expected);this.readyInflight.set(account,pending);
  try{return checkExternal(await pending);}catch(e){if(e.code==='WALLET_READINESS_INVALID')this.readyCache.delete(account);throw e;}finally{if(this.readyInflight.get(account)===pending)this.readyInflight.delete(account);}
 }
 async checkReady(account,expected,call=this.call.bind(this)){
  const invalid=message=>Object.assign(Error(message),{code:'WALLET_READINESS_INVALID'});
  const status=await call(account,['wallet','status']);if(status.status!=='CONNECTED')throw invalid(`${account} 号钱包未连接，请走官方 App 登录`);
  const addresses=await call(account,['wallet','address']);const rows=addresses.addresses?.filter(x=>String(x.binanceChainId)==='56');
  if(rows?.length!==1||!same(rows[0].address,expected))throw invalid('钱包地址与绑定不一致');
  const s=await call(account,['wallet','settings']);const session=Date.parse(s.sessionExpireTime);
  if(!Number.isFinite(session)||session<=Date.now())throw invalid('钱包会话已过期');
  const result={account,address:expected,status:'CONNECTED',sessionExpireTime:s.sessionExpireTime,inactiveSignOutTime:s.inactiveSignOutTime,maxSigninDuration:s.maxSigninDuration,devMode:s.devMode,checkedAt:Date.now(),validUntil:Math.min(Date.now()+60000,session)};
  this.readyCache.set(account,result);return result;
 }
 async warm(account){
  if(this.queues.has(account)||this.readyInflight.has(account))return null;
  if(this.warmInflight.has(account))return this.warmInflight.get(account);
  const epoch=this.foregroundEpoch.get(account)||0,expected=wallet(account).address;
  const call=(a,args)=>{
   if((this.foregroundEpoch.get(account)||0)!==epoch)throw Object.assign(Error('只读预热让位于当前操作'),{code:'WARM_YIELDED'});
   return this.call(a,args,{background:true,readOnlyTimeoutMs:1000});
  };
  const task=(async()=>{const cached=this.readyCache.get(account);try{
   // Refresh the complete check before expiry, while foreground ready() can
   // still use the original valid cache. Keepalive never extends that cache.
   if(cached?.validUntil>Date.now()+15000&&same(cached.address,expected)){
    const status=await call(account,['wallet','status']);
    if(status.status!=='CONNECTED')throw Object.assign(Error('钱包会话未连接'),{code:'WALLET_READINESS_INVALID'});
    return cached; // No TTL extension from a keepalive or transport timeout.
   }
   return await this.checkReady(account,expected,call);
  }catch(e){
   if(e.code==='WALLET_READINESS_INVALID'){this.readyCache.delete(account);throw e;}
   // A failed optional background read is not a revoked session. Foreground
   // ready() still enforces the original expiry and complete address/settings.
   return null;
  }})();this.warmInflight.set(account,task);
  try{return await task;}finally{if(this.warmInflight.get(account)===task)this.warmInflight.delete(account);}
 }
 close(){for(const w of this.workers.values())w.process.stdin.end();}
}
