import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {saveDurable} from '../lib/durable-write.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
const fixture=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'durable-journal-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
test('100 journals publish complete reservations before yielding and wait for their own durable flush',async t=>{
 const dir=fixture(t),flushes=[],closed=[];const io={...fs,fsync:(fd,cb)=>flushes.push({fd,cb}),closeSync:fd=>{closed.push(fd);fs.closeSync(fd);}};let complete=0;
 const pending=Array.from({length:100},(_,n)=>saveDurable(path.join(dir,n+'.json'),{id:n,status:'SUBMITTING',requestId:'synthetic-'+n},{io,closeBeforePublish:false}).then(()=>{complete++;}));
 assert.equal(flushes.length,100);assert.equal(complete,0);
 for(let n=0;n<100;n++){const f=path.join(dir,n+'.json');assert.equal(JSON.parse(fs.readFileSync(f)).requestId,'synthetic-'+n);if(process.platform!=='win32')assert.equal(fs.statSync(f).mode&0o777,0o600);}
 for(const f of flushes.slice(1))f.cb();await tick();assert.equal(complete,99);assert.equal(closed.length,99);flushes[0].cb();await Promise.all(pending);assert.equal(complete,100);assert.equal(closed.length,100);assert.equal(fs.readdirSync(dir).filter(n=>n.endsWith('.tmp')).length,0);
});
test('durability error is propagated and the visible original reservation is retained',async t=>{
 const dir=fixture(t),file=path.join(dir,'original.json');let closed=false;
 await assert.rejects(saveDurable(file,{status:'SUBMITTING',requestId:'original'},{closeBeforePublish:false,io:{...fs,fsync:(fd,cb)=>cb(Object.assign(Error('disk flush failed'),{code:'EIO'})),closeSync:fd=>{closed=true;fs.closeSync(fd);}}}),e=>e.code==='EIO');
 assert.equal(closed,true);assert.equal(JSON.parse(fs.readFileSync(file)).requestId,'original');assert.equal(fs.readdirSync(dir).length,1);
});
test('rename failure preserves the earlier journal and cleans incomplete temporary files',async t=>{
 const dir=fixture(t),file=path.join(dir,'order.json');fs.writeFileSync(file,JSON.stringify({status:'PENDING'}));
 await assert.rejects(saveDurable(file,{status:'CONFIRMED'},{io:{...fs,renameSync:()=>{throw Error('synthetic rename failed');}}}),/rename failed/);
 assert.equal(JSON.parse(fs.readFileSync(file)).status,'PENDING');assert.equal(fs.readdirSync(dir).length,1);
});
test('100 asynchronous transitions preserve the original until durable and do not wait for one slow file',async t=>{
 const dir=fixture(t);let release,flushStarted;const gate=new Promise(r=>release=r),started=new Promise(r=>flushStarted=r);t.after(()=>release());
 const io={promises:{...fs.promises,open:async(file,...args)=>{const h=await fs.promises.open(file,...args);if(path.basename(file).startsWith('0.json.')){const sync=h.sync.bind(h);h.sync=async()=>{flushStarted();await gate;await sync();};}return h;}}};
 const values=Array.from({length:100},(_,n)=>({id:n,status:'CONFIRMED',nested:{amount:n}}));let complete=0;
 for(let n=0;n<100;n++)fs.writeFileSync(path.join(dir,n+'.json'),JSON.stringify({id:n,status:'PENDING'}));
 const writes=values.map((v,n)=>saveDurable(path.join(dir,n+'.json'),v,{io,publishImmediately:false}).then(()=>{complete++;}));
 values[0].nested.amount=999;await started;assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'0.json'))).status,'PENDING');
 await Promise.all(writes.slice(1));assert.equal(complete,99);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'0.json'))).status,'PENDING');release();await writes[0];
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'0.json'))).nested.amount,0);assert.equal(complete,100);
 for(let n=0;n<100;n++){const f=path.join(dir,n+'.json');assert.equal(JSON.parse(fs.readFileSync(f)).status,'CONFIRMED');if(process.platform!=='win32')assert.equal(fs.statSync(f).mode&0o777,0o600);}
 assert.equal(fs.readdirSync(dir).length,100);
});
test('failed asynchronous flush leaves the earlier pending original and removes the temporary file',async t=>{
 const dir=fixture(t),file=path.join(dir,'original.json');fs.writeFileSync(file,JSON.stringify({status:'PENDING',txHash:'synthetic-original'}));
 const io={promises:{...fs.promises,open:async(...args)=>{const h=await fs.promises.open(...args);h.sync=async()=>{throw Object.assign(Error('synthetic disk failure'),{code:'EIO'});};return h;}}};
 await assert.rejects(saveDurable(file,{status:'CONFIRMED'},{io,publishImmediately:false}),e=>e.code==='EIO');
 assert.deepEqual(JSON.parse(fs.readFileSync(file)),{status:'PENDING',txHash:'synthetic-original'});assert.deepEqual(fs.readdirSync(dir),['original.json']);
});

test('a flushed shared snapshot cannot overwrite a newer pause; publish check and rename are atomic',async t=>{
 const dir=fixture(t),file=path.join(dir,'tasks.json');let release,started,revision=0;
 const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);t.after(()=>release());
 const io={...fs,fsync:(fd,cb)=>{started();void gate.then(()=>fs.fsync(fd,cb));}};
 const pending=saveDurable(file,{status:'TRACKING',commit:'original'},{io,publishImmediately:false,canPublish:()=>revision===0});await ready;
 await saveDurable(file,{status:'PAUSED',commit:'original'});revision++;release();assert.equal(await pending,false);
 assert.deepEqual(JSON.parse(fs.readFileSync(file)),{status:'PAUSED',commit:'original'});assert.deepEqual(fs.readdirSync(dir),['tasks.json']);
 let checked=false;await saveDurable(file,{status:'CONFIRMED'},{io:{...fs,renameSync:(a,b)=>{assert.equal(checked,true);fs.renameSync(a,b);}},publishImmediately:false,canPublish:()=>{checked=true;return true;}});assert.equal(JSON.parse(fs.readFileSync(file)).status,'CONFIRMED');
});

test('closed-handle publication flushes before replacement and preserves the original on a failed flush',async t=>{
 const file=path.join(fixture(t),'original.json'),events=[];
 fs.writeFileSync(file,JSON.stringify({state:'READY'}));
 const io={...fs,fsyncSync(fd){events.push('flush');fs.fsyncSync(fd);},closeSync(fd){events.push('close');fs.closeSync(fd);},renameSync(src,dst){events.push('publish');fs.renameSync(src,dst);}};
 await assert.rejects(saveDurable(file,{state:'SUBMITTING'},{closeBeforePublish:true,io:{...io,fsyncSync(){throw Error('flush refused');}}}),/flush refused/);
 assert.equal(JSON.parse(fs.readFileSync(file)).state,'READY');
 events.length=0;
 await saveDurable(file,{state:'SUBMITTING'},{io,closeBeforePublish:true});
 assert.deepEqual(events,['flush','close','publish']);assert.equal(JSON.parse(fs.readFileSync(file)).state,'SUBMITTING');
});
