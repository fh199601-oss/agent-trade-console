import path from 'node:path';
import {openManagedSigner} from './managed-trigger.mjs';
import {backupManaged} from './backup.mjs';
import {importTriggerKey,revealTriggerKey} from './private-key.mjs';
import {parentPort} from 'node:worker_threads';
import {FastTrigger,PrivateJournal,unlockKeystore,decryptKeystore} from './trigger.mjs';
let trigger,journal,seq=0;const reads=new Map();
const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;reads.set(id,{resolve,reject});parentPort.postMessage({rpc:id,method,params});});
parentPort.on('message',async m=>{
 if(m.rpc){const p=reads.get(m.rpc);if(p){reads.delete(m.rpc);m.error?p.reject(Error('触发端节点请求失败')):p.resolve(m.result);}return;}
 try {
  let result;
  if(m.action==='backup'){
   result=await backupManaged(m.options);
  }else if(m.action==='import-key'){
   result=await importTriggerKey(m.options);
  }else if(m.action==='export-key'){
   result=await revealTriggerKey(m.options);
  }else if(m.action==='generated'){
   const wallet=await openManagedSigner(m.options);result={address:wallet.address};
  }else if(m.action==='remember'){
   const {dir,address,keystore,password}=m.options;
   const wallet=await decryptKeystore(keystore,password,address);
   await openManagedSigner({dir,expectedAddress:address},undefined,wallet);
   result={address:wallet.address};
  }else if(m.action==='init'){
   if(trigger)throw Error('触发端已初始化');
   const {file,password,address,executor,executorHash,payer,dir,keystore,chainId,managed}=m.options;
   const wallet=managed?await openManagedSigner(managed):keystore?await decryptKeystore(keystore,password,address):await unlockKeystore(file,password,address);m.options.password='';
   journal=new PrivateJournal(dir||path.join(managed.dir,'journal',wallet.address));
   try{trigger=new FastTrigger({wallet,rpc,executor,executorHash,payer,journal,chainId});result=await trigger.warm();}
   catch(e){trigger?.lock();journal.close();journal=null;trigger=null;throw e;}
  }else{
   if(!trigger)throw Error('触发端尚未解锁');
   if(m.action==='close'){trigger.lock();journal?.close();parentPort.postMessage({id:m.id,result:true});return;}
   if(!['warm','prepare','broadcast','follow','lock'].includes(m.action))throw Error('触发端操作不允许');
   result=await trigger[m.action](...(m.args||[]));
  }
  parentPort.postMessage({id:m.id,result});
 }catch(e){parentPort.postMessage({id:m.id,noDispatch:e.noDispatch===true,error:'触发端'+({backup:'备份',remember:'导入',init:'解锁',warm:'预热',prepare:'准备',broadcast:'广播',follow:'核对',lock:'锁定',close:'关闭'}[m.action]||'请求')+'失败；'+(/^(触发|极速|代卖|原单|同一|没有|未找到|不支持此加密)/.test(e.message||'')?e.message:'请核对独立密钥、合约和原单日志')});}
});
process.on('exit',()=>journal?.close());
