import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {staticDeployments,deploymentIsBsc} from '../lib/static-config.mjs';
import {extractCandidates,discover} from '../lib/discovery.mjs';
const A='0x1111111111111111111111111111111111111111',B='0x2222222222222222222222222222222222222222',C='0x3333333333333333333333333333333333333333';
test('compiled aliases preserve branded mint, token and market roles without executing code',()=>{
 const text=`const a='${A}',b='${B}',c='${C}',d={chainId:56,network:'main',goldMint:a,token:b,rodMarket:c};fetch('/execute');throw Error('must never run');`;
 const rows=extractCandidates(text,'https://new-brand.example/bundle.js');
 assert.ok(rows.some(r=>r.address===A&&r.roles.includes('mint')&&r.priority===4));
 assert.ok(rows.some(r=>r.address===C&&r.roles.includes('market')));assert.ok(rows.some(r=>r.address===B&&r.roles.includes('token')));
});
test('static resolver refuses dynamic calls, reassignment, cycles, getters, spread and computed code',()=>{
 const cases=[`let a='${A}';a=external();const cfg={mint:a}`,`const a=b,b=a,cfg={mint:a}`,`const cfg={get mint(){return '${A}'}}`,`const cfg={mint:evil()}`,`const cfg={...evil,mint:'${A}'}`,`const cfg={[evil()]:'${A}'}`];
 for(const text of cases)assert.deepEqual(staticDeployments(text),[]);
 assert.deepEqual(staticDeployments('a'.repeat(2500001)),[]);
});
test('BSC deployment hints exclude explicit wrong-chain and test deployments',()=>{
 const rows=extractCandidates(`const x='${A}',y='${B}',z='${C}',a={chainId:56,mint:x},b={chainId:97,mint:y},c={chainId:56,network:'test',mint:z}`,'https://site.example/config.js');
 assert.ok(rows.some(r=>r.address===A));assert.ok(rows.every(r=>r.address!==B&&r.address!==C));
});
test('literal member references and nested numeric chain configuration resolve',()=>{
 const rows=staticDeployments(`const addresses={a:'${A}'},cfg={contracts:{56:{mint:addresses.a}}}`);
 assert.ok(rows.some(r=>r.field==='mint'&&r.address===A&&r.chainId===56));
});
test('inline deployment scripts retain semantic roles without executing browser code',()=>{
 const rows=extractCandidates(`<script>const x='${A}',config={chainId:56,presale:x};window.ethereum.request({method:'sendTransaction'})</script>`,'https://another.example/');
 assert.ok(rows.some(r=>r.address===A&&r.priority===4&&r.roles.includes('mint')));
});
test('transient script timeout retries once and local config examples are never fetched',async()=>{
 const base='https://transient.example/',requested=[];let attempts=0;
 const r=await discover(base,{fetchText:async url=>{requested.push(url);if(url===base)return '<script src="/main.js"></script>';if(url.endsWith('/main.js')){if(++attempts===1)throw Error('aborted due to timeout');return `const x='${A}',cfg={mint:x}; const instruction='~/.config/contracts.json';`;}return '';}});
 assert.equal(r.address,A);assert.equal(attempts,2);assert.ok(!requested.some(u=>u.includes('/~/')));
});
test('modulepreload, root imports and two nested route/config chunks are discovered on unrelated domains',async()=>{
 const base='https://unseen.example/',requested=[];
 const content=new Map([[base,'<title>New brand</title><link rel="modulepreload" href="/entry.js">'],[base+'entry.js','import("/routes/mint.js")'],[base+'routes/mint.js','import {cfg} from "../deployment.js"'],[base+'deployment.js',`const a='${A}',cfg={mint:a,chainId:56}`]]);
 const r=await discover(base,{fetchText:async url=>{requested.push(url);return content.get(url)||'';}});
 assert.equal(r.address,A);assert.ok(requested.includes(base+'deployment.js'));assert.ok(r.discovery.documents.includes(base+'routes/mint.js'));
});
test('actual large Vite bundle resolves labels rather than just obfuscated variable names',()=>{
 const file=new URL('../evidence/current-fishing.js',import.meta.url);if(!fs.existsSync(file))return;
 const rows=extractCandidates(fs.readFileSync(file,'utf8'),'https://fishingai.app/assets/index.js');
 assert.ok(rows.some(r=>r.field.startsWith('goldMint · ')&&r.roles.includes('mint')));
 assert.ok(rows.some(r=>r.field.startsWith('rodMarket · ')&&r.roles.includes('market')));
 assert.ok(rows.some(r=>r.field.startsWith('presale · ')&&r.roles.includes('mint')));
});

test('nested network objects and non-string role fields never crash the discovery parser',()=>{
 const text=`const network={name:'bsc'},cfg={network,chainId:56,mint:'${A}'},other={network:{opaque:true},mint:'${B}'},row={name:{zh:'mint'},address:'${C}'}`;
 const rows=staticDeployments(text);assert.doesNotThrow(()=>rows.filter(deploymentIsBsc));assert.ok(rows.filter(deploymentIsBsc).some(r=>r.address===A));assert.ok(!rows.filter(deploymentIsBsc).some(r=>r.address===B));assert.doesNotThrow(()=>extractCandidates(text,'https://new.example/app.js'));
 assert.equal(deploymentIsBsc({chainId:Object.create(null)}),false);
});
