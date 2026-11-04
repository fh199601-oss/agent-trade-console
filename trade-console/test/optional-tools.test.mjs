import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {findOpenFourHelper} from '../lib/optional-tools.mjs';

function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'optional-tool-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {home:dir,configFile:path.join(dir,'config.json')};}
test('missing optional tool is explicit and never launches a process',t=>{
 assert.throws(()=>findOpenFourHelper(fixture(t)),{code:'OPTIONAL_HELPER_MISSING'});
});
test('finds recipient-installed helper without running its contents',t=>{
 const options=fixture(t),file=path.join(options.home,'.agents/skills/binance-agentic-wallet/scripts/agent-id-exclusive-token-launches.mjs');
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'throw Error("must not execute during discovery")');
 assert.equal(findOpenFourHelper(options),file);
});
test('custom helper paths must be absolute and name the official tool',t=>{
 const options=fixture(t);fs.writeFileSync(options.configFile,JSON.stringify({openFourScript:'../unexpected.mjs'}));
 assert.throws(()=>findOpenFourHelper(options),/完整本地路径/);
});
test('symlink helper is not accepted',t=>{
 const options=fixture(t),target=path.join(options.home,'source.mjs'),file=path.join(options.home,'agent-id-exclusive-token-launches.mjs');
 fs.writeFileSync(target,'throw Error("never run")');try{fs.symlinkSync(target,file);}catch(e){if(e.code==='EPERM'){t.skip('Symlinks unavailable on this runner');return;}throw e;}fs.writeFileSync(options.configFile,JSON.stringify({openFourScript:file}));
 assert.throws(()=>findOpenFourHelper(options),{code:'OPTIONAL_HELPER_MISSING'});
});
