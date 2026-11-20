import test from 'node:test';import assert from 'node:assert/strict';import {parallelWallets} from '../lib/parallel-wallets.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('100 dispatches yield to IO between bursts without waiting for an earlier wallet result',async()=>{
 const slow=deferred(),allStarted=deferred(),seen=[],io=[];setImmediate(()=>io.push(seen.length));
 const pending=parallelWallets(Array.from({length:100},(_,n)=>n),async n=>{seen.push(n);if(seen.length===100)allStarted.resolve();if(n===0)await slow.promise;return n;});
 await allStarted.promise;assert.equal(seen.length,100);assert.ok(io[0]>0&&io[0]<100);slow.resolve();assert.deepEqual(await pending,seen);
});
test('a synchronous or asynchronous failure does not prevent starting other wallets',async()=>{
 for(const asyncError of [false,true]){const seen=[],pending=parallelWallets(Array.from({length:100},(_,n)=>n),n=>{seen.push(n);if(n===2){if(asyncError)return Promise.reject(Error('isolated failure'));throw Error('isolated failure');}return n;});await assert.rejects(pending,/isolated failure/);assert.equal(seen.length,100);}
});
test('small selections do not gain an artificial startup delay',async()=>{const seen=[];const pending=parallelWallets([1,2,3,4],n=>{seen.push(n);return n;});assert.deepEqual(seen,[1,2,3,4]);await pending;});
