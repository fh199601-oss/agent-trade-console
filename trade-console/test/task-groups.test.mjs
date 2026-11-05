import test from 'node:test';
import assert from 'node:assert/strict';
import {taskModel,groupTasks,stopTaskMembers} from '../public/task-center.mjs';

const token='0x'+'a'.repeat(40),other='0x'+'b'.repeat(40),mint='0x'+'c'.repeat(40);
const corla=(account,extra={})=>({id:'c'+account,account,name:'Same name',mint,status:'WATCHING',policy:{expectedToken:token,sell:{percent:'50'}},...extra});
test('four wallets collapse into one token row and preserve each original task',()=>{
 const model=taskModel({corla:[4,3,2,1].map(n=>corla(n))}),[group]=model.activeGroups;
 assert.equal(model.activeGroups.length,1);assert.deepEqual(group.wallets,[1,2,3,4]);assert.equal(group.members.length,4);
 assert.equal(group.statusText,'监测开盘');assert.equal(group.policy,'领取后卖出 50%');
});
test('address casing merges, equal names with different contracts never merge',()=>{
 const a=corla(1),b=corla(2,{policy:{expectedToken:token.toUpperCase(),sell:{percent:'50'}}}),c=corla(3,{mint:other,policy:{expectedToken:other}});
 const groups=taskModel({corla:[a,b,c]}).activeGroups;assert.equal(groups.length,2);assert.deepEqual(groups[0].wallets,[1,2]);assert.deepEqual(groups[1].wallets,[3]);
});
test('zero-token rows resolve through one known mint, never through a name or ambiguous token mapping',()=>{
 const unknown=corla(2,{policy:{expectedToken:'0x'+'0'.repeat(40)}});
 assert.equal(taskModel({corla:[corla(1),unknown]}).activeGroups.length,1);
 assert.equal(taskModel({corla:[corla(1),unknown,corla(3,{policy:{expectedToken:other}})]}).activeGroups.length,3);
 assert.equal(taskModel({corla:[corla(1,{mint:null,policy:{}}),corla(2,{mint:null,policy:{}})]}).activeGroups.length,2);
});
test('linked opening children are excluded and standalone same-token tasks share a group',()=>{
 const config={asset:token,accounts:[1,2],percent:'25',slippageBps:5000};
 const model=taskModel({corla:[corla(1,{sellJobId:'child'})],opening:[{id:'child',status:'ARMED',config},{id:'standalone',status:'PAUSED',config}]});
 assert.equal(model.activeGroups.length,1);const [g]=model.activeGroups;
 assert.deepEqual(g.members.map(j=>j.id),['c1','standalone']);assert.deepEqual(g.wallets,[1,2]);assert.equal(g.statusText,'部分暂停');assert.equal(g.policy,'多种任务 · 展开查看');
});
test('stopping a group sends each eligible original ID once, isolates failures and does not retry or touch another token',async()=>{
 const model=taskModel({corla:[corla(1),corla(2),corla(3,{status:'REVIEW'}),corla(4,{status:'DONE'}),corla(5,{mint:other,policy:{expectedToken:other}})]});
 const members=model.activeGroups[0].members,calls=[];
 const results=await stopTaskMembers([...members,...members,{...members[0],id:'done',status:'DONE'}],async(route,body)=>{calls.push([route,body.id]);if(body.id==='c2')throw Error('temporary failure');return {status:'STOPPED'};});
 assert.deepEqual(calls,[['corla-stop','c1'],['corla-stop','c2']]);assert.equal(results.length,2);assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.equal(results[1].task.id,'c2');
});
test('multi-wallet opening task stops through one original endpoint',async()=>{
 const model=taskModel({opening:[{id:'o1',status:'ARMED',config:{asset:token,accounts:[1,2,3,4],percent:'50',slippageBps:5000}}]}),calls=[];
 await stopTaskMembers(model.activeGroups[0].members,async(...args)=>calls.push(args));
 assert.deepEqual(calls,[['opening/stop',{id:'o1'}]]);assert.equal(model.activeGroups[0].wallets.length,4);
});
test('duplicate rows do not duplicate wallets or stop targets',()=>{
 const row=taskModel({corla:[corla(1)]}).active[0];assert.equal(groupTasks([row,row])[0].members.length,1);
});
