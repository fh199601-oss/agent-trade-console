import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {fetch} from 'undici';import {pinnedWebsiteDispatcher,websiteProxy,PublicWebsiteReader} from '../lib/network.mjs';
test('项目读取遵循配置代理和 NO_PROXY，不改变全局配置',()=>{
 const u=new URL('https://mint.example/'),env={HTTPS_PROXY:'http://127.0.0.1:7890',NO_PROXY:'localhost,127.0.0.1,.internal.example'};
 assert.equal(websiteProxy(u,env),env.HTTPS_PROXY);assert.equal(websiteProxy(new URL('https://app.internal.example/'),env),null);
 assert.equal(websiteProxy(u,{...env,NO_PROXY:'*'}),null);assert.equal(websiteProxy(u,{...env,NO_PROXY:'mint.example:8443'}),env.HTTPS_PROXY);
 assert.equal(websiteProxy(u,{...env,NO_PROXY:'mint.example:443'}),null);
});
const ips=[{address:'1.1.1.1',family:4}];
function readerFixture(options={}){const s={lookups:[],pools:[],requests:[],now:0};const reader=new PublicWebsiteReader({lookup:async host=>{s.lookups.push(host);return ips;},now:()=>s.now,proxy:()=>null,dispatcherFactory:(url,pin,proxy)=>{const p={origin:url.origin,pin,proxy,closed:false,close:async()=>{p.closed=true;}};s.pools.push(p);return p;},fetch:async(url,options)=>{s.requests.push({url:String(url),pin:options.dispatcher.pin});return new Response('ok');},...options});return {s,reader};}
test('parallel document reads coalesce DNS and reuse one pinned transport; no response cache',async()=>{
 const {s,reader}=readerFixture();try{assert.deepEqual(await Promise.all(['/','/llms.txt','/app.js'].map(p=>reader.text('https://mint.example'+p))),['ok','ok','ok']);assert.equal(s.lookups.length,1);assert.equal(s.pools.length,1);assert.equal(s.requests.length,3);await reader.text('https://mint.example/');assert.equal(s.requests.length,4);assert.equal(s.pools.length,1);}finally{await reader.close();}assert.ok(s.pools.every(p=>p.closed));
});
test('DNS expiry revalidates; rebinding to a private address is rejected before reuse',async()=>{
 let lookupCount=0;const {s,reader}=readerFixture({lookup:async()=>++lookupCount===1?ips:[{address:'127.0.0.1',family:4}],dnsTtlMs:100});try{await reader.text('https://mint.example/');s.now=101;await assert.rejects(reader.text('https://mint.example/app.js'),/保留网络/);assert.equal(s.requests.length,1);}finally{await reader.close();}
});
test('redirects cannot reach private hosts and failures do not poison DNS cache',async()=>{
 let calls=0,lookups=0;const {reader}=readerFixture({lookup:async host=>{if(++lookups===1)throw Error('temporary DNS');return host==='private.example'?[{address:'10.0.0.1',family:4}]:ips;},fetch:async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://private.example/'}});}});try{await assert.rejects(reader.text('https://mint.example/'),/temporary DNS/);await assert.rejects(reader.text('https://mint.example/'),/保留网络/);assert.equal(calls,1);assert.equal(lookups,3);}finally{await reader.close();}
});
test('VPN fake IPs use independent public resolution, origin/proxy/IP changes never share transports',async()=>{
 let publicLookups=0,proxy=null;const {s,reader}=readerFixture({lookup:async()=>[{address:'198.18.0.1',family:4}],resolvePublic:async()=>{publicLookups++;return ips;},proxy:()=>proxy});try{await reader.text('https://mint.example/');await reader.text('https://other.example/');proxy='http://proxy.example:7890';await reader.text('https://mint.example/a');assert.equal(publicLookups,2);assert.equal(s.pools.length,3);assert.ok(s.pools.every(p=>p.pin[0].address==='1.1.1.1'));}finally{await reader.close();}
});
test('connection pool cap retires idle transports; response sizes and redirects remain bounded',async()=>{
 const {s,reader}=readerFixture({maxPools:1});try{await reader.text('https://mint.example/');await reader.text('https://other.example/');assert.equal(reader.pools.size,1);assert.equal(s.pools[0].closed,true);}finally{await reader.close();}
 const large=readerFixture({fetch:async()=>new Response('a'.repeat(2*1024*1024+1))}).reader;try{await assert.rejects(large.text('https://mint.example/'),/2MB/);}finally{await large.close();}
 let count=0;const loop=readerFixture({fetch:async()=>{count++;return new Response(null,{status:302,headers:{location:'/again'}});}}).reader;try{await assert.rejects(loop.text('https://mint.example/'),/重定向过多/);assert.equal(count,4);}finally{await loop.close();}
});
test('代理 CONNECT 固定已验证公网 IP，不把项目域名交给代理重新解析',async()=>{
 const seen=[];const server=http.createServer();server.on('connect',(req,socket)=>{seen.push({url:req.url,host:req.headers.host});socket.end('HTTP/1.1 502 Test stop\r\nContent-Length: 0\r\n\r\n');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const proxy='http://127.0.0.1:'+server.address().port;
 const dispatcher=pinnedWebsiteDispatcher(new URL('https://rebind.example/'),[{address:'1.1.1.1',family:4}],proxy);
 try{await assert.rejects(fetch('https://rebind.example/',{dispatcher,signal:AbortSignal.timeout(2000)}));assert.deepEqual(seen,[{url:'1.1.1.1:443',host:'1.1.1.1:443'}]);}
 finally{await dispatcher.close();await new Promise(resolve=>server.close(resolve));}
 for(const ip of ['127.0.0.1','192.168.1.1','198.18.0.21','169.254.169.254'])assert.throws(()=>pinnedWebsiteDispatcher(new URL('https://rebind.example/'),[{address:ip,family:4}],proxy),/保留网络地址/);
});
