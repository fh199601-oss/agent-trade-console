import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {getAddress} from 'ethers';

// Only a public address and a fixed action go on the command line. Private
// input/output uses the child pipes inside a short-lived credential worker.
export async function walletDialog(action,address=null,input=''){
 if(!['backup','import','confirm-export','show'].includes(action))throw Error('触发端窗口操作无效');
 const target=address?getAddress(address):'';
 const file=name=>fileURLToPath(new URL(name,import.meta.url));
 let exe,args;
 if(process.platform==='darwin'){
  exe='/usr/bin/osascript';args=['-l','JavaScript',file('./backup-dialog.js'),action,target];
 }else if(process.platform==='win32'){
  exe=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const script=await fs.readFile(file('./backup-dialog.ps1'),'utf8');
  const command="& { "+script+"\n} '"+action+"' '"+target+"'";
  args=['-NoProfile','-STA','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')];
 }else throw Error('触发端窗口需要 macOS 或 Windows');
 return new Promise((resolve,reject)=>{
  const failed=()=>reject(Error('触发端系统窗口已超时或无法打开，请在本机桌面重试'));
  const child=execFile(exe,args,{timeout:85000,maxBuffer:32768,windowsHide:true},(err,stdout)=>{
   if(err)return failed();
   try{resolve(JSON.parse(stdout.trim()));}catch{failed();}
  });
  child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
