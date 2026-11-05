import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createServer} from '../server.mjs';
test('external top-level dashboard links open while APIs and embedded pages stay protected',async()=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'console-navigation-'));let writes=0;
 const app=createServer({data,rpc:{},bridge:{close(){}},engine:{list:()=>[],running:new Set(),run:()=>{writes++;return {};}}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 const headers={'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document',origin:'https://outside.example'};
 // Native fetch controls sec-fetch-mode. Use http.request to model real
 // browser navigation metadata without the fetch implementation rewriting it.
 const {request}=await import('node:http');
 const get=(pathname,extra={},method='GET')=>new Promise((resolve,reject)=>{
  const req=request(base+pathname,{method,headers:{...headers,...extra}},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}));});req.on('error',reject);req.end();
 });
 try{
  const page=await get('/');assert.equal(page.status,200);assert.match(page.headers['content-type'],/text\/html/);assert.match(page.headers['content-security-policy'],/frame-ancestors 'none'/);
  assert.equal((await get('/api/bootstrap')).status,400);
  assert.equal((await get('/api/run',{'content-type':'application/json','x-console-token':app.token},'POST')).status,400);
  assert.equal((await get('/',{'sec-fetch-dest':'iframe'})).status,400);
  assert.equal((await get('/',{'sec-fetch-mode':'cors'})).status,400);
  assert.equal((await get('/',{host:'evil.example'})).status,400);
  assert.equal(writes,0);
 }finally{await new Promise(r=>app.server.close(r));fs.rmSync(data,{recursive:true,force:true});}
});
