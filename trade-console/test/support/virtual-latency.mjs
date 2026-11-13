// Deterministic latency comparisons: CI CPU scheduling is not RPC latency.
// Only the caller's isolated test clock changes; production deadlines stay intact.
import assert from 'node:assert/strict';
import {setImmediate as yieldTurn} from 'node:timers/promises';
export function virtualLatency(t){
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
 return async promise=>{
  let done=false,value,error;
  Promise.resolve(promise).then(v=>{value=v;done=true;},e=>{error=e;done=true;});
  for(let elapsed=0;!done&&elapsed<=30000;elapsed+=5){
   await yieldTurn();
   if(!done)t.mock.timers.tick(5);
  }
  assert.ok(done,'simulated workflow exceeded 30 seconds');
  if(error)throw error;
  return value;
 };
}
