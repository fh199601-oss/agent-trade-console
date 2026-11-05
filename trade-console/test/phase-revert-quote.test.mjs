import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {Interface} from 'ethers';import {recognizeMint,adaptiveQuote} from '../lib/adaptive-mint.mjs';
const original=JSON.parse(fs.readFileSync(new URL('./fixtures/phase-revert-quote.json',import.meta.url))),wallet={account:1,address:'0x'+'2'.repeat(40)},block={tag:'0x100',timestamp:100};
test('internal helper exact-payment errors provide current per-wallet phase price without scalar price getters',async()=>{
 for(const renamed of [false,true]){
  const meta=structuredClone(original);if(renamed)meta.sources['InkWell.sol'].content=meta.sources['InkWell.sol'].content.replaceAll('_mintBatch','_issueArt').replaceAll('publicPhase','seasonNow').replaceAll('uint256 cost','uint256 totalDue').replaceAll('!= cost','!= totalDue').replaceAll('WrongPayment(cost','WrongPayment(totalDue');
  const r=recognizeMint(meta);assert.equal(r.routes.length,1);const route=r.routes[0],abi=new Interface(meta.abi);assert.deepEqual(route.revertQuote,{name:'WrongPayment',index:0});
  let fee=7n;const reads=[];const rpc=async(method,params)=>{reads.push([method,params]);if(method==='eth_estimateGas')return '0x10000';const f=abi.parseTransaction(params[0]);
   if(f.name==='mintPublic'){const expected=fee*f.args[0],sent=BigInt(params[0].value);if(sent!==expected)throw Object.assign(Error('execution reverted'),{data:abi.encodeErrorResult('WrongPayment',[expected,sent]),executionError:true});return '0x';}
   return abi.encodeFunctionResult(f.fragment,[{paused:false,remainingSupply:100n,supportsInterface:true}[f.name]]);
  };
  const q=await adaptiveQuote(meta,route,wallet,2,block,rpc);assert.equal(q.available,true);assert.equal(q.total.raw,'14');assert.equal(q.expectedAsset.kind,'Erc721');assert.equal(q.expectedAsset.amount,'2');
  fee=11n;assert.equal((await adaptiveQuote(meta,route,wallet,1,block,rpc)).total.raw,'11');assert.ok(reads.some(([m,p])=>m==='eth_call'&&p[0].value==='0xd'));
 }
});
test('eligibility errors, unrelated error arguments, and non-exact payment comparisons cannot become quotes',async()=>{
 const meta=structuredClone(original),abi=new Interface(meta.abi),route=recognizeMint(meta).routes[0];
 await assert.rejects(adaptiveQuote(meta,route,wallet,1,block,async(m,p)=>{if(m==='eth_estimateGas')assert.fail();const f=abi.parseTransaction(p[0]);if(f.name==='mintPublic')throw Object.assign(Error('execution reverted'),{data:abi.encodeErrorResult('NotEligible'),executionError:true});return abi.encodeFunctionResult(f.fragment,[{paused:false,remainingSupply:100n,supportsInterface:true}[f.name]]);}),/NotEligible/);
 for(const [from,to]of [['WrongPayment(cost, msg.value)','WrongPayment(msg.value, msg.value)'],['msg.value != cost','msg.value == cost']]){const changed=structuredClone(meta);changed.sources['InkWell.sol'].content=changed.sources['InkWell.sol'].content.replace(from,to);const routes=recognizeMint(changed).routes;if(from.startsWith('WrongPayment')){assert.equal(routes[0].revertQuote,null);assert.ok(routes[0].sourcePrice);}else assert.equal(routes.length,0);}
});
