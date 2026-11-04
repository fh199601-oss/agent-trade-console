import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {percentOf,ROOT,DATA} from '../lib/common.mjs';
import {normalizeAssetInput} from '../public/asset-input.mjs';
import {ReadRpc} from '../support/curve-trader/rpc.mjs';

test('source dependency closure loads without a wallet or external workspace',async()=>{
 const dir=fileURLToPath(new URL('../lib/',import.meta.url));
 for(const name of fs.readdirSync(dir)){
  // Worker entrypoints need their own workerData and are exercised by the engine.
  if(!name.endsWith('.mjs')||name.endsWith('-worker.mjs'))continue;
  await import(new URL('../lib/'+name,import.meta.url));
 }
 await import('../server.mjs');
});
test('runtime is isolated inside this package',()=>assert.equal(DATA,path.join(ROOT,'local/runtime')));
test('sell percentages always apply to remaining units',()=>{
 const sold=percentOf(100n,50);assert.equal(sold,50n);assert.equal(percentOf(100n-sold,50),25n);
});
test('bare domains still normalize',()=>assert.equal(normalizeAssetInput('example.com/mint'),'https://example.com/mint'));
test('read RPC forbids signature and broadcast',async()=>{
 const rpc=new ReadRpc('https://example.com',{fetchImpl:()=>assert.fail('must not use network')});
 await assert.rejects(rpc.send('eth_sendRawTransaction',['0x']),/forbidden/);
 await assert.rejects(rpc.send('eth_sign',[]),/forbidden/);
});
