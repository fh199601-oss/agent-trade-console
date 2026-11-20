// Policy and dialog data-flow tests. No wallet transport, RPC or browser.
import test from 'node:test';import assert from 'node:assert/strict';
import {validateIntent,bindings} from '../lib/common.mjs';
import {createTaskDialogs} from '../public/task-center.mjs';
import {HIGH_FEE_PPM} from '../lib/trade-fees.mjs';
import {findLowFeeSell} from '../lib/sell-fee-search.mjs';
const asset='0x'+'1'.repeat(40),account=bindings()[0].account;
test('99% is a sell limit, never an increased fee threshold or buy permission',()=>{
 const i={account,asset,side:'sell',percent:'100',slippageBps:9900};assert.equal(validateIntent(i).slippageBps,9900);
 assert.throws(()=>validateIntent({...i,slippageBps:9901}));assert.throws(()=>validateIntent({...i,side:'buy',amount:'1'}));assert.equal(HIGH_FEE_PPM,500000);
 assert.equal(validateIntent({account,asset,side:'mint',scope:'free',quantity:1,maxBnb:'0',autoClaim:true,claimSell:{slippageBps:9900}}).claimSell.slippageBps,9900);
});
test('same-pool recovery never falls through to a different fee-search venue',async()=>{
 assert.equal(await findLowFeeSell({plan:{recovery:{samePool:true}}},{planFn:()=>assert.fail('cannot change recovery pool')}),null);
});
function ui(){
 const elements=new Map(),requests=[],doc={getElementById(id){if(!elements.has(id))elements.set(id,{value:'',checked:false,disabled:false,hidden:false,listeners:new Map(),addEventListener(k,fn){this.listeners.set(k,fn);},showModal(){this.open=true;},close(){this.open=false;}});return elements.get(id);}};
 const dialogs=createTaskDialogs({document:doc,notify(){},onSaved:async()=>{},api:async(path,body)=>{requests.push({path,body});return {changed:body.tasks.length,results:body.tasks.map(t=>({...t,changed:true}))};}});
 const member=(id,bps)=>({kind:'opening',id,revision:1,config:{percent:'100',slippageBps:bps}});
 return {dialogs,requests,get:id=>doc.getElementById(id),member};
}
test('task dialog preserves a saved 99%, submits an explicit 90%, and rejects invalid input locally',async()=>{
 const h=ui();h.dialogs.edit([h.member('one',9900)],'test');assert.equal(h.get('taskEditSlippage').value,'99');h.get('taskEditSlippage').value='90';await h.get('saveTaskEdit').listeners.get('click')();assert.equal(h.requests[0].body.settings.slippageBps,9000);
 h.dialogs.edit([h.member('one',9900)],'test');h.get('taskEditSlippage').value='100';await h.get('saveTaskEdit').listeners.get('click')();assert.equal(h.requests.length,1);assert.match(h.get('taskEditMessage').textContent,/0–99/);
});
test('mixed task slippage left blank preserves each original instead of silently overwriting it',async()=>{
 const h=ui();h.dialogs.edit([h.member('one',5000),h.member('two',9900)],'mixed');assert.equal(h.get('taskEditSlippage').value,'');await h.get('saveTaskEdit').listeners.get('click')();assert.equal(Object.hasOwn(h.requests[0].body.settings,'slippageBps'),false);
});
