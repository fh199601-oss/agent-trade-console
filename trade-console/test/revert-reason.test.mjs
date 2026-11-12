import test from 'node:test';import assert from 'node:assert/strict';import {Interface} from '../lib/common.mjs';import {diagnoseRevert} from '../lib/revert-reason.mjs';
const abi=new Interface(['error Error(string)','error InsufficientOutputAmount()']);
const tx={from:'0x'+'11'.repeat(20),to:'0x'+'22'.repeat(20),input:'0x12345678',gas:'0x40000',value:'0x0'},receipt={status:'0x0',gasUsed:'0x20000',blockNumber:'0x100'};
test('historical revert diagnostics use only original transaction in preceding block',async()=>{
 let calls=0;const rpc={call:async(t,b)=>{calls++;assert.deepEqual(t,{from:tx.from,to:tx.to,data:tx.input,gas:tx.gas,value:tx.value});assert.equal(b,255);throw Object.assign(Error('execution reverted'),{data:abi.encodeErrorResult('Error',['Too little received'])});}};
 const r=await diagnoseRevert(rpc,tx,receipt);assert.equal(calls,1);assert.equal(r.kind,'slippage');assert.match(r.message,/前一区块回放/);assert.match(r.message,/最低到账/);
});
test('unknown reasons stay unknown, exact gas exhaustion and custom slippage are distinguished',async()=>{
 assert.equal(await diagnoseRevert({call:async()=>{throw Error('missing trie node');}},tx,receipt),null);
 const r=await diagnoseRevert({call:()=>assert.fail('receipt already proves gas exhausted')},tx,{...receipt,gasUsed:tx.gas});assert.equal(r.kind,'gas_limit');
 const s=await diagnoseRevert({call:async()=>{throw {data:abi.encodeErrorResult('InsufficientOutputAmount',[])};}},tx,receipt);assert.equal(s.kind,'slippage');
 assert.equal(await diagnoseRevert({call:()=>assert.fail('no replay of success')},tx,{...receipt,status:'0x1'}),null);
});
