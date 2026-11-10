import test from 'node:test';import assert from 'node:assert/strict';
import {RpcTransport} from '../lib/rpc-transport.mjs';
const url='https://private.example/v3/SYNTHETIC_SECRET?key=SYNTHETIC_KEY';
const ips=[{address:'8.8.8.8',family:4}],fake=[{address:'198.18.1.2',family:4}];
function fixture(t,overrides={}){
 let now=1000;const seen={dns:[],lookups:0,pins:[],requests:[],closed:0};
 const transport=new RpcTransport({now:()=>now,lookup:async host=>{seen.lookups++;return fake;},resolvePublic:async host=>{seen.dns.push(host);return {ips,ttlMs:1000};},proxy:()=> 'http://proxy.example',dispatcherFactory:(u,a,p)=>{seen.pins.push({host:u.hostname,ips:a,proxy:p});return {close:async()=>{seen.closed++;}};},fetchImpl:async(u,o)=>{seen.requests.push({url:u,options:o});return {ok:true,json:async()=>({result:'0x38'})};},...overrides});
 t.after(()=>transport.close());return {transport,seen,advance:n=>now+=n};
}
test('fake IP uses public hostname resolution, original private URL and proxy remain unchanged',async t=>{
 const h=fixture(t),opts={method:'POST',body:'synthetic'};await h.transport.fetch(url,opts);await h.transport.fetch(url,opts);
 assert.deepEqual(h.seen.dns,['private.example']);assert.equal(h.seen.lookups,1);assert.equal(h.seen.pins.length,1);assert.equal(h.seen.pins[0].proxy,'http://proxy.example');
 assert.ok(h.seen.requests.every(r=>r.url===url&&r.options.body==='synthetic'&&r.options.dispatcher));
 assert.ok(!JSON.stringify(h.seen.dns).includes('SECRET'));h.advance(1001);await h.transport.fetch(url,opts);assert.equal(h.seen.lookups,2);
});
test('ordinary DNS and custom local RPC routing are not replaced',async t=>{
 for(const address of ['8.8.8.8','127.0.0.1','192.168.1.1']){
  const h=fixture(t,{lookup:async()=>[{address,family:4}]});await h.transport.fetch(url,{});assert.equal(h.seen.dns.length,0);assert.equal(h.seen.pins.length,0);assert.equal(h.seen.requests[0].options.dispatcher,undefined);
 }
});
test('DoH cannot redirect a private RPC API key to local, fake, empty or non-IPv4 addresses',async t=>{
 for(const bad of [[],[{address:'127.0.0.1',family:4}],[{address:'198.18.1.1',family:4}],[{address:'10.0.0.1',family:4}],[{address:'::1',family:6}]]){
  const h=fixture(t,{resolvePublic:async()=>({ips:bad})});await assert.rejects(h.transport.fetch(url,{}),/public addresses/);assert.equal(h.seen.requests.length,0);
 }
});
test('concurrent requests share DNS resolution and cancellation never flushes a healthy pin',async t=>{
 let release;const gate=new Promise(r=>release=r);let resolving=0;
 const h=fixture(t,{resolvePublic:async()=>{resolving++;await gate;return {ips};}}),a=new AbortController();
 const first=h.transport.fetch(url,{signal:a.signal}),second=h.transport.fetch(url,{});a.abort(Error('cancelled'));release();
 await assert.rejects(first,/cancelled/);await second;assert.equal(resolving,1);assert.equal(h.seen.requests.length,1);await h.transport.fetch(url,{});assert.equal(resolving,1);
});
test('network failure expires DNS cache, but an aborted hedge leaves shared DNS usable',async t=>{
 let failure=true;const h=fixture(t,{fetchImpl:async(u,o)=>{if(failure)throw Error('reset');return {ok:true};}});
 await assert.rejects(h.transport.fetch(url,{}));assert.equal(h.transport.cache.size,0);failure=false;await h.transport.fetch(url,{});assert.equal(h.seen.dns.length,2);
 const c=new AbortController();h.transport.fetchImpl=async()=>{c.abort(Error('lost race'));throw c.signal.reason;};await assert.rejects(h.transport.fetch(url,{signal:c.signal}),/race/);assert.equal(h.transport.cache.size,1);
});
test('DoH bootstrap pins a public IP while retaining HTTPS certificate validation and never includes RPC secrets',async t=>{
 const h=fixture(t);h.transport.resolvePublic=h.transport.resolveDns.bind(h.transport);let request;
 h.transport.fetchImpl=async(u,o)=>{if(u.startsWith('https://cloudflare-dns.com/')){request={url:u,options:o};return {ok:true,json:async()=>({Status:0,Answer:[{type:1,data:'8.8.8.8',TTL:60}]})};}return {ok:true};};
 await h.transport.fetch(url,{});const u=new URL(request.url);assert.equal(u.searchParams.get('name'),'private.example');assert.ok(!request.url.includes('SECRET'));assert.equal(request.options.redirect,'error');assert.ok(request.options.dispatcher);
});
test('transport shutdown releases pools and prevents late DNS from opening a new RPC connection',async t=>{
 let release;const gate=new Promise(r=>release=r);const h=fixture(t,{resolvePublic:async()=>{await gate;return {ips};}});
 const request=h.transport.fetch(url,{});await new Promise(r=>setImmediate(r));await h.transport.close();release();await assert.rejects(request,/closed/);assert.equal(h.seen.requests.length,0);assert.equal(h.seen.pins.length,0);
});
