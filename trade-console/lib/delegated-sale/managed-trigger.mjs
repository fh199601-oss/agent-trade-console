import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {Wallet,getAddress} from 'ethers';

export const managedSupported=['darwin','win32'].includes(process.platform);
export function managedDirectory(){
 const base=process.platform==='darwin'?path.join(os.homedir(),'Library','Application Support'):(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'));
 return path.join(base,'Agent Trade Console','fast-sale-v1');
}
function existingPrivateDir(dir){
 let s;try{s=fs.lstatSync(dir);}catch(e){if(e.code==='ENOENT')return false;throw e;}
 if(!s.isDirectory()||process.platform!=='win32'&&(s.uid!==process.getuid()||(s.mode&0o077)!==0))throw Error('触发端专用目录权限不符合要求');
 return true;
}
function readPrivate(file){
 let s;try{s=fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
 if(!s.isFile()||s.size>4096||process.platform!=='win32'&&(s.uid!==process.getuid()||(s.mode&0o077)!==0))throw Error('触发端本机文件无法核验');
 return fs.readFileSync(file,'utf8');
}
// Write completely before publishing. Never replace another process's identity.
function publish(file,value){
 const tmp=file+'.'+randomUUID()+'.tmp',fd=fs.openSync(tmp,'wx',0o600);
 try{
  try{fs.writeFileSync(fd,value);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{fs.linkSync(tmp,file);}catch(e){if(e.code!=='EEXIST')throw e;}
 }finally{fs.unlinkSync(tmp);}
}
export function publicManagedAddress(dir){
 if(!existingPrivateDir(dir))return null;
 const s=readPrivate(path.join(dir,'address'));if(s===null)return null;
 try{return getAddress(s.trim());}catch{throw Error('触发端原地址记录损坏，请核对本机存储');}
}
// The original generated wallet stays in its original slot. Imported wallets
// have address-derived slots, so selecting one never replaces another key.
export function profileDirectory(root,address){
 if(!address||publicManagedAddress(root)===getAddress(address))return root;
 const profiles=path.join(root,'wallets');existingPrivateDir(profiles);
 return path.join(profiles,getAddress(address).toLowerCase());
}
function native(command,args,input='',options={}){
 return new Promise((resolve,reject)=>{
  const child=execFile(command,args,{maxBuffer:8192,timeout:45000,windowsHide:true,...options},(err,stdout)=>{
   // Child errors may contain stdout or native diagnostics. Never forward them.
   if(err)reject(Error('触发端无法访问系统凭据存储，请核对本机账户的访问权限后重试'));
   else resolve(stdout.trim());
  });
  child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
function macVault(dir){
 const account='profile-'+createHash('sha256').update(fs.realpathSync(dir)).digest('hex').slice(0,32);
 const script=fileURLToPath(new URL('./keychain.js',import.meta.url));
 const invoke=(action,value)=>native('/usr/bin/osascript',['-l','JavaScript',script,action,account],value);
 return {read:async()=>{const v=await invoke('read','');return v==='MISSING'?null:v;},create:value=>invoke('create',value)};
}
function windowsVault(dir){
 const file=path.join(dir,'trigger.dpapi');
 const systemRoot=process.env.SystemRoot||'C:\\Windows',exe=path.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 function dpapi(action,input){
  const code="$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());$out=[System.Security.Cryptography.ProtectedData]::"+action+"($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($out))";
  return native(exe,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],input);
 }
 async function read(){const blob=readPrivate(file);return blob===null?null:Buffer.from(await dpapi('Unprotect',blob),'base64').toString('ascii');}
 return {read,create:async value=>{publish(file,await dpapi('Protect',Buffer.from(value,'ascii').toString('base64')));return read();}};
}
// Called inside the signing worker. The dashboard receives only the public address.
export async function openManagedSigner({dir,create=false,expectedAddress=null},vault,importedWallet){
 if(!vault&&!managedSupported)throw Error('触发端自动配置仅支持 macOS 和 Windows');
 if(importedWallet&&(!expectedAddress||importedWallet.address!==getAddress(expectedAddress)))throw Error('触发端导入的钱包与填写地址不一致');
 fs.mkdirSync(dir,{recursive:true,mode:0o700});const previous=publicManagedAddress(dir);
 if(previous&&expectedAddress&&getAddress(expectedAddress)!==previous)throw Error('触发端已保存的地址与所选地址不一致');
 vault??=process.platform==='darwin'?macVault(dir):windowsVault(dir);
 let secret=await vault.read();
 if(secret===null){
  if(importedWallet&&expectedAddress&&importedWallet.address===getAddress(expectedAddress))secret=await vault.create(importedWallet.privateKey);
  else if(create&&!previous&&!expectedAddress&&!importedWallet)secret=await vault.create(Wallet.createRandom().privateKey);
  else throw Error('触发端原签名信息未找到，请用此地址的加密 Keystore 恢复');
 }
 if(!/^0x[\da-f]{64}$/i.test(secret))throw Error('触发端系统凭据格式无效');
 let wallet;try{wallet=new Wallet(secret);}catch{throw Error('触发端系统凭据无效');}
 if((previous&&wallet.address!==previous)||(expectedAddress&&wallet.address!==getAddress(expectedAddress)))throw Error('触发端系统凭据与原地址不一致');
 if(!previous)publish(path.join(dir,'address'),wallet.address);
 if(publicManagedAddress(dir)!==wallet.address)throw Error('触发端并发设置的地址不一致');
 return wallet;
}
