import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const filename='agent-id-exclusive-token-launches.mjs';

// Integrate an independently installed official tool; do not redistribute it.
// No shell, credential store access, downloads, or execution during discovery.
export function findOpenFourHelper({home=os.homedir(),configFile=path.join(root,'local/install.json')}={}){
 let config={};
 try{config=JSON.parse(fs.readFileSync(configFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('本地可选工具配置无效');}
 const explicit=config.openFourScript;
 if(explicit!==undefined&&(typeof explicit!=='string'||!path.isAbsolute(explicit)||path.basename(explicit)!==filename))throw Error('openFourScript 须为官方只读工具的完整本地路径');
 const candidates=explicit?[explicit]:['.codex','.agents','.claude'].map(folder=>path.join(home,folder,'skills/binance-agentic-wallet/scripts',filename));
 for(const file of candidates){
  try{const s=fs.lstatSync(file);if(s.isFile()&&!s.isSymbolicLink())return file;}
  catch(e){if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')throw Error('无法读取可选工具文件');}
 }
 throw Object.assign(Error('缺少 Open Four 官方只读工具；请按 START_HERE.md 安装后重试此专属内盘路线'),{code:'OPTIONAL_HELPER_MISSING'});
}
