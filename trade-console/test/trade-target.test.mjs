import test from 'node:test';import assert from 'node:assert/strict';
import {tradeTarget} from '../lib/trade-target.mjs';
import {Engine} from '../lib/engine.mjs';
import {ERC20,bindings,same,ZeroAddress} from '../lib/common.mjs';
import * as flap from '../support/curve-trader/adapters/flap.mjs';import * as gang from '../support/curve-trader/adapters/gang.mjs';
import {GANG_ENTRY,GANG_ABI} from '../lib/gang-modern.mjs';
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
  const seen=[],registered=[];const zero=p=>p.baseType==='tuple'?p.components.map(zero):p.type==='address'?ZeroAddress:p.type==='bool'?false:p.type==='bytes32'?'0x'+'0'.repeat(64):0n;
  const rpc={verifyChain:async()=>{},call:async tx=>{
   assert.ok(!same(tx.to,BAGENT.config.mint),'never query the issuance contract as a trade target');
   if(same(tx.to,BAGENT.config.token)){seen.push(tx.to);const f=ERC20.parseTransaction(tx);assert.ok(['decimals','balanceOf'].includes(f.name));throw Error('synthetic stop before quote');}
   // Buys now overlap public registry reads. They must query this exact token,
   // and must not reinterpret its known Mint contract as the traded asset.
   const pad=gang.PADS.find(p=>same(p.address,tx.to)),abi=same(tx.to,GANG_ENTRY)?GANG_ABI:same(tx.to,flap.portal)?flap.portalAbi:pad?.kind==='soft'?gang.SOFT_ABI:pad?.id==='s'?gang.S_ABI:gang.V2_ABI;
   const f=abi.parseTransaction(tx);assert.ok(same(f.args[0],BAGENT.config.token));registered.push(tx.to);return abi.encodeFunctionResult(f.name,f.fragment.outputs.map(zero));
  }};
  const engine=new Engine({data,rpc,bridge:{ready:async()=>({}),call:()=>assert.fail('no wallet command')},auditFn:async()=>({available:true,level:0}),live:false});
  await assert.rejects(engine.plan({account:bindings()[0].account,asset:BAGENT.config.token,side,percent:'100',amount:'0.1',currency:'BNB',slippageBps:100}),/synthetic stop/);
  await new Promise(r=>setImmediate(r));assert.equal(seen.length,2);assert.equal(registered.length,side==='buy'?7:0);
 }
});
