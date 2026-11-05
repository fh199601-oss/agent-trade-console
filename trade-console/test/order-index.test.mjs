import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {OrderIndex} from '../lib/order-index.mjs';import {save} from '../lib/common.mjs';
import {orderSummary} from '../lib/order-summary.mjs';import {statusLabel,totalTimeLabel,projectLabel,needsRoute} from '../public/review-model.mjs';
const fixture=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'order-index-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,index:new OrderIndex(dir)};};
test('index observes external atomic writes, same-size edits, deletion and new pending orders',t=>{
 const {dir,index}=fixture(t),file=path.join(dir,'a.json'),o={id:'a',status:'PENDING',intent:{account:1},createdAt:1};save(file,o);assert.equal(index.find(r=>r.status==='PENDING').id,'a');
 save(file,{...o,status:'SETTLED'});assert.equal(index.find(r=>r.status==='PENDING'),undefined);const stamp=fs.statSync(file).mtime;
 fs.writeFileSync(file,JSON.stringify({...o,status:'PENDING'}));fs.utimesSync(file,stamp,stamp);assert.equal(index.find(r=>r.status==='PENDING').id,'a');
 save(path.join(dir,'b.json'),{...o,id:'b',createdAt:2});assert.equal(index.list(1)[0].id,'b');fs.unlinkSync(file);assert.equal(index.list().length,1);
});
test('callers cannot mutate cached orders; corrupt external files fail closed',t=>{
 const {dir,index}=fixture(t),file=path.join(dir,'a.json');save(file,{id:'a',createdAt:1,status:'PENDING',plan:{value:1}});const row=index.list()[0];row.plan.value=999;assert.equal(index.list()[0].plan.value,1);index.find(()=>true).status='CONFIRMED';assert.equal(index.find(()=>true).status,'PENDING');
 fs.writeFileSync(file,'{');assert.throws(()=>index.find(()=>true));
});
test('compact history preserves visible status, total timing, route choice and original-order tracking',()=>{
 for(const status of ['PENDING','CONFIRMED','BLOCKED','PREPARED']){const o={id:'stable',status,intent:{account:1,side:'mint',asset:'https://new.example',siteProof:{signature:'not needed in list'}},createdAt:100,timing:{prepareMs:80,toConfirmedMs:220},orderId:'original-order',txHash:'original-hash',plan:{resolved:{name:'Example'},steps:[{kind:'approve',data:'0x'+'12'.repeat(10000)}]},error:{code:'MINT_ROUTE_REQUIRED',message:'choose',details:{routes:[{id:'route'}],chainLearning:{large:'x'.repeat(10000)}}}};const brief=orderSummary(o);assert.equal(statusLabel(brief),statusLabel(o));assert.equal(totalTimeLabel(brief,500),totalTimeLabel(o,500));assert.equal(projectLabel(brief),projectLabel(o));assert.equal(needsRoute(brief),needsRoute(o));assert.equal(brief.orderId,o.orderId);assert.equal(brief.intent.siteProof,undefined);assert.equal(brief.plan.steps[0].data,undefined);assert.ok(JSON.stringify(brief).length<1000);}
});
