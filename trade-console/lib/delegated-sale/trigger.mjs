import {pinnedBscSale} from './bsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Wallet,Interface,keccak256,getAddress} from 'ethers';

export const EXECUTE=new Interface(['function executeBatch(bytes32[] ids)']);
const eq=(a,b)=>a?.toLowerCase()===b?.toLowerCase();
export const LOCAL_CHAIN=31337;
export function bounded(promise,ms=8000){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('触发节点响应超时；保留原单继续核对')),ms);})]).finally(()=>clearTimeout(timer));}
// Production signing is restricted to the pinned BSC executor and chain ID.
export class FastTrigger {
 constructor({wallet,rpc,executor,executorHash,payer,journal,chainId=LOCAL_CHAIN,now=Date.now}) {
  if(!wallet?.signTransaction||!journal||!rpc)throw Error('触发端缺少本地签名器、节点或原单日志');
  this.wallet=wallet;this.rpc=(method,params)=>bounded(Promise.resolve().then(()=>rpc(method,params)));this.executor=getAddress(executor);this.executorHash=executorHash;
  if(chainId!==LOCAL_CHAIN&&!(chainId===56&&pinnedBscSale(executor,executorHash,payer)))throw Error('实盘签名须使用固定的已核验执行合约');
  this.chainId=chainId;this.journal=journal;this.now=now;this.queue=Promise.resolve();this.flight=new Map();
 }
 async warm() {
   const signerAddress=this.wallet?.address;if(!signerAddress)throw Error('触发端已锁定');
   const [chain,code,nonce,gas]=await Promise.all([
    this.rpc('eth_chainId',[]),this.rpc('eth_getCode',[this.executor,'latest']),
    this.rpc('eth_getTransactionCount',[signerAddress,'pending']),this.rpc('eth_gasPrice',[])]);
   if(Number(BigInt(chain))!==this.chainId)throw Error('极速卖出网络不匹配，禁止实盘签名');
   if(code==='0x'||keccak256(code)!==this.executorHash)throw Error('代卖执行合约代码未通过核验');
   return this.serial(async()=>{
   if(BigInt(gas)<=0n)throw Error('触发端节点未返回可用 Gas 价格');
   if(!eq(this.wallet?.address,signerAddress))throw Error('触发端已锁定或切换');
   const records=this.journal.all();
   for(const r of records){
    if(!eq(r.from,this.wallet.address))throw Error('原单日志属于其他触发者');
    if(eq(r.executor,this.executor))continue;
    throw Error('原单日志属于其他执行合约，请核对本机触发端。');
   }
   this.nonce=Math.max(Number(BigInt(nonce)),...records.filter(r=>Number.isSafeInteger(r.nonce)).map(r=>r.nonce+1));
   this.gasPrice=BigInt(gas);this.warmedAt=this.now();return {ready:true,address:this.wallet.address,chainId:this.chainId};
  });
 }
 serial(fn){const p=this.queue.then(fn);this.queue=p.catch(()=>{});return p;}
 async prepare(id,ids) {
  return this.serial(async()=>{
   if(!/^[a-zA-Z0-9_.:-]{1,160}$/.test(id)||!Array.isArray(ids)||!ids.length||ids.length>64||new Set(ids).size!==ids.length||ids.some(x=>!/^0x[a-fA-F0-9]{64}$/.test(x)))throw Error('触发批次参数无效');
   const data=EXECUTE.encodeFunctionData('executeBatch',[ids]);
   const old=this.journal.get(id);
   if(old){if(!eq(old.executor,this.executor)||old.data!==data)throw Error('同一批次 ID 不能更换钱包计划');return this.public(old);}
   if(this.nonce===undefined)throw Error('触发端尚未完成模拟链核验');
   const row={id,ids,data,from:this.wallet.address,executor:this.executor,status:'PREPARED',createdAt:this.now()};
   // No nonce reservation for unopened projects. Encoding is already complete;
   // local signing at trigger time costs no RPC and cannot block another project.
   this.journal.put(row);return this.public(row);
  });
 }
 public(row){const {raw,data,...safe}=row;return {...safe};}
 async broadcast(id) {
  if(this.flight.has(id))return this.flight.get(id);
  const run=(async()=>{
   const r=await this.serial(async()=>{
    let row=this.journal.get(id);if(!row)throw Error('没有已准备的触发原单');
    if(!eq(row.executor,this.executor))throw Error('此原单属于其他版本的执行合约');
    if(row.status!=='PREPARED')return row;
    if(!this.wallet||this.nonce===undefined||this.now()-this.warmedAt>30000)throw Object.assign(Error('触发端已锁定或预热过期；未提交'),{noDispatch:true});
    const nonce=this.nonce,tx={to:this.executor,data:row.data,value:0n,chainId:this.chainId,nonce,type:0,gasPrice:this.gasPrice,gasLimit:this.chainId===56?600000n+BigInt(row.ids.length)*530000n:14_000_000n};
    const raw=await this.wallet.signTransaction(tx);
    row={...row,raw,hash:keccak256(raw),nonce,status:'SIGNED'};
    this.journal.put(row);this.nonce=nonce+1;return row;
   });
   if(r.status!=='SIGNED')return this.public(r);
   r.status='SUBMITTING';this.journal.put(r);
   try {
    const hash=await this.rpc('eth_sendRawTransaction',[r.raw]);
    if(!eq(hash,r.hash))throw Error('节点返回哈希与本地签名不一致');
    r.status='PENDING';
   }catch{r.status='UNKNOWN';r.message='触发提交状态待核对；保留原哈希，不重新签名';}
   this.journal.put(r);return this.public(r);
  })();this.flight.set(id,run);try{return await run;}finally{this.flight.delete(id);}
 }
 async follow(id) {
  const r=this.journal.get(id);if(!r)throw Error('未找到触发原单');
  if(!r.hash)return this.public(r);
  const receipt=await this.rpc('eth_getTransactionReceipt',[r.hash]);
  if(receipt){r.status=BigInt(receipt.status)===1n?'CONFIRMED':'REVERTED';r.receipt=receipt;this.journal.put(r);}
  return this.public(r);
 }
 lock(){this.wallet=null;this.warmedAt=0;}
}

// Keystore decryption stays local; caller supplies the password only in memory.
// Never accept the Agent wallet's session directory as a signing source.
export async function unlockKeystore(file,password,expectedAddress) {
 const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32768||process.platform!=='win32'&&(stat.mode&0o077)!==0)throw Error('触发端密钥文件须独立保存，并仅允许当前用户读取');
 return decryptKeystore(fs.readFileSync(file,'utf8'),password,expectedAddress);
}
export async function decryptKeystore(raw,password,expectedAddress) {
 if(typeof raw!=='string'||raw.length>32768||typeof password!=='string'||password.length>1024)throw Error('加密 Keystore 输入无效');
 let payload;
 try{payload=JSON.parse(raw);}catch{throw Error('触发端仅接受标准加密 Keystore');}
 const crypto=payload.crypto||payload.Crypto;
 const params=crypto?.kdfparams;
 if(!params||![params.n,params.r,params.p].every(x=>Number.isSafeInteger(x)&&x>0)||params.dklen!==32)throw Error('不支持此加密 Keystore 参数');
 if(payload.version!==3||crypto?.kdf!=='scrypt'||crypto.kdfparams?.n>262144||crypto.kdfparams?.r>8||crypto.kdfparams?.p>4)throw Error('不支持此加密 Keystore 参数');
 let w;try{w=await Wallet.fromEncryptedJson(raw,password);}catch{throw Error('触发端密钥解锁失败，请核对密码');}
 if(!eq(w.address,getAddress(expectedAddress)))throw Error('触发地址与独立签名密钥不一致');
 return w;
}

export class PrivateJournal {
 constructor(dir){
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if(fs.lstatSync(dir).isSymbolicLink()||process.platform!=='win32'&&(fs.statSync(dir).mode&0o077)!==0)throw Error('触发日志目录不能是符号链接');
  this.dir=dir;this.file=path.join(dir,'originals.json');this.lockFile=path.join(dir,'writer.lock');
  const acquire=()=>{const fd=fs.openSync(this.lockFile,'wx',0o600);fs.writeFileSync(fd,String(process.pid));fs.fsyncSync(fd);return fd;};
  try{this.fd=acquire();}catch(e){
   if(e.code!=='EEXIST')throw e;
   const recoverFile=this.lockFile+'.recover';let recovery;
   try{
    recovery=fs.openSync(recoverFile,'wx',0o600);
    const owner=Number(fs.readFileSync(this.lockFile,'utf8'));
    if(!Number.isSafeInteger(owner)||owner<=0)throw Error('未知锁持有者');
    try{process.kill(owner,0);throw Error('进程仍在运行');}catch(err){if(err.code!=='ESRCH')throw err;}
    fs.unlinkSync(this.lockFile);this.fd=acquire();
   }catch{throw Error('触发端日志已被占用，请核对原触发进程');}
   finally{if(recovery!==undefined){fs.closeSync(recovery);fs.unlinkSync(recoverFile);}}
  }
  try{if(fs.existsSync(this.file)&&(fs.lstatSync(this.file).isSymbolicLink()||process.platform!=='win32'&&(fs.statSync(this.file).mode&0o077)!==0))throw Error('原单日志权限不安全');this.rows=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):[];}catch(e){this.close();throw e;}
 }
 all(){return structuredClone(this.rows);}
 get(id){return structuredClone(this.rows.find(x=>x.id===id));}
 put(row){
  const next=this.rows.filter(x=>x.id!==row.id).concat(structuredClone(row));
  const tmp=this.file+'.'+randomUUID()+'.tmp',fd=fs.openSync(tmp,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(next));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(tmp,this.file);this.rows=next;
 }
 close(){if(this.fd!==undefined){fs.closeSync(this.fd);this.fd=undefined;try{fs.unlinkSync(this.lockFile);}catch(e){if(e.code!=='ENOENT')throw e;}}}
}
