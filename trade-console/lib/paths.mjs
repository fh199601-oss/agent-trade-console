import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export function localDirectory(root=ROOT,env=process.env,platform=process.platform,home=os.homedir()){
 if(env.AGENT_TRADE_HOME){if(!path.isAbsolute(env.AGENT_TRADE_HOME))throw Error('AGENT_TRADE_HOME 必须是完整路径');return env.AGENT_TRADE_HOME;}
 if(fs.existsSync(path.join(root,'local/install.json')))return path.join(root,'local');
 const base=platform==='win32'?(env.LOCALAPPDATA||path.join(home,'AppData/Local')):platform==='darwin'?path.join(home,'Library/Application Support'):(env.XDG_STATE_HOME||path.join(home,'.local/state'));
 const identity=platform==='win32'?fs.realpathSync(root).toLowerCase():fs.realpathSync(root);
 return path.join(base,'AgentTradeConsole',createHash('sha256').update(identity).digest('hex').slice(0,16));
}
export const LOCAL=localDirectory();
