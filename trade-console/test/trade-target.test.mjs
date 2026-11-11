import test from 'node:test';import assert from 'node:assert/strict';
import {tradeTarget} from '../lib/trade-target.mjs';
import {Engine} from '../lib/engine.mjs';
import {ERC20,bindings,same} from '../lib/common.mjs';
import {BAGENT} from '../lib/bagent.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';

test('trade target preserves full CA even if Mint discovery knows a different issuance contract',()=>{
 assert.equal(tradeTarget(BAGENT.config.token).address,BAGENT.config.token);
 assert.notEqual(tradeTarget(BAGENT.config.token).address,BAGENT.config.mint);
 assert.throws(()=>tradeTarget('https://bagent.club/'),/完整 CA/);
});
test('real buy and sell planning reads the exact requested token, never Mint metadata',async t=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'trade-target-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 for(const side of ['sell','buy']){
  const seen=[];const rpc={verifyChain:async()=>{},call:async tx=>{seen.push(tx.to);assert.ok(same(tx.to,BAGENT.config.token));const f=ERC20.parseTransaction(tx);assert.ok(['decimals','balanceOf'].includes(f.name));throw Error('synthetic stop before quote');}};
  const engine=new Engine({data,rpc,bridge:{ready:async()=>({}),call:()=>assert.fail('no wallet command')},auditFn:async()=>({available:true,level:0}),live:false});
  await assert.rejects(engine.plan({account:bindings()[0].account,asset:BAGENT.config.token,side,percent:'100',amount:'0.1',currency:'BNB',slippageBps:100}),/synthetic stop/);
  assert.equal(seen.length,2);
 }
});
