// Every test process gets synthetic public addresses and an isolated directory.
// Deliberately omit Python/launcher/session configuration: real wallet access
// cannot be bootstrapped by this fixture. No keys or credentials are generated.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-trade-fixtures-'));
process.env.AGENT_TRADE_HOME=dir;
fs.writeFileSync(path.join(dir,'install.json'),JSON.stringify({installationId:'synthetic-test',wallets:[1,2,3,4,5].map(account=>({account,address:'0x'+String(account).repeat(40)}))}));
process.once('exit',()=>fs.rmSync(dir,{recursive:true,force:true}));
