import test from 'node:test';import assert from 'node:assert/strict';
import {tradeTarget} from '../lib/trade-target.mjs';
import {Engine} from '../lib/engine.mjs';
import {ERC20,bindings,same} from '../lib/common.mjs';
const TOKEN='0x'+'12'.repeat(20),MINT='0x'+'34'.repeat(20);
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';

test('trade target preserves full CA even if Mint discovery knows a different issuance contract',()=>{
 assert.equal(tradeTarget(TOKEN).address,TOKEN);
 assert.notEqual(tradeTarget(TOKEN).address,MINT);
 assert.throws(()=>tradeTarget('https://example.com/mint'),/完整 CA/);
});
test('real buy and sell planning reads the exact requested token, never Mint metadata',async t=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'trade-target-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 for(const side of ['sell','buy']){
  const seen=[];const rpc={verifyChain:async()=>{},call:async tx=>{seen.push(tx.to);assert.ok(same(tx.to,TOKEN));const f=ERC20.parseTransaction(tx);assert.ok(['decimals','balanceOf'].includes(f.name));throw Error('synthetic stop before quote');}};
  const engine=new Engine({data,rpc,bridge:{ready:async()=>({}),call:()=>assert.fail('no wallet command')},auditFn:async()=>({available:true,level:0}),live:false});
  await assert.rejects(engine.plan({account:bindings()[0].account,asset:TOKEN,side,percent:'100',amount:'0.1',currency:'BNB',slippageBps:100}),/synthetic stop/);
  assert.equal(seen.length,2);
 }
});
