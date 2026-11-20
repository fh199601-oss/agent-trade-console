import fs from 'node:fs/promises';
import path from 'node:path';
import {walletDialog} from './native-dialog.mjs';
import {getAddress} from 'ethers';
import {openManagedSigner} from './managed-trigger.mjs';

export async function backupManaged({dir,address},dialog=addr=>walletDialog('backup',addr),vault){
 address=getAddress(address);
 const choice=await dialog(address);
 if(choice.cancelled)return {cancelled:true};
 if(choice.error==='mismatch')throw Error('触发端两次备份密码不一致');
 if(typeof choice.password!=='string'||choice.password.length<12||choice.password.length>1024)throw Error('触发端备份密码需要 12 至 1024 个字符');
 if(typeof choice.file!=='string'||!path.isAbsolute(choice.file)||!choice.file.toLowerCase().endsWith('.json'))throw Error('触发端备份文件需要使用 .json 扩展名');
 const wallet=await openManagedSigner({dir,expectedAddress:address},vault);
 const encrypted=await wallet.encrypt(choice.password);
 let handle;
 try{handle=await fs.open(choice.file,'wx',0o600);}
 catch(e){throw Error(e.code==='EEXIST'?'触发端备份文件已存在，请选用新的文件名':'触发端备份位置无法写入');}
 try{await handle.writeFile(encrypted);await handle.sync();}
 catch{await handle.close();await fs.unlink(choice.file).catch(()=>{});throw Error('触发端加密备份写入失败');}
 await handle.close();return {saved:true,address};
}
