import {Worker} from 'node:worker_threads';
// CPU/signing state is isolated from the dashboard's planning and wallet queues.
// Only this fixed worker can request RPC through the supplied local test adapter.
export class TriggerClient {
 constructor(rpc){
  this.pending=new Map();this.seq=0;this.rpc=rpc;
  this.worker=new Worker(new URL('./trigger-worker.mjs',import.meta.url));
  this.worker.on('message',async m=>{
   if(m.rpc){try{const result=await rpc(m.method,m.params);this.worker.postMessage({rpc:m.rpc,result});}catch{this.worker.postMessage({rpc:m.rpc,error:true});}return;}
   const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Object.assign(Error(m.error),{noDispatch:m.noDispatch===true})):p.resolve(m.result);
  });
  this.worker.on('error',()=>this.fail());this.worker.on('exit',()=>this.fail());
 }
 fail(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('独立触发端已退出；只核对原单，不重建签名'));}this.pending.clear();}
 request(action,args=[],options){return new Promise((resolve,reject)=>{
  const timeout=['import-key','export-key'].includes(action)?240000:action==='backup'?160000:action==='generated'||action==='remember'||action==='init'&&options?.managed?110000:15000;
  const id=++this.seq,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('独立触发端响应超时；请核对本机结果'));},timeout);
  this.pending.set(id,{resolve,reject,timer});this.worker.postMessage({id,action,args,options});
 });}
 async init(options){const r=await this.request('init',[],options);this.wallet={address:r.address};return r;}
 warm(){return this.request('warm');}prepare(id,ids){return this.request('prepare',[id,ids]);}
 broadcast(id){return this.request('broadcast',[id]);}follow(id){return this.request('follow',[id]);}
 async close(){try{await this.request('close');}finally{await this.worker.terminate();this.fail();}}
}
