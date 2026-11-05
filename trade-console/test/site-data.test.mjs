import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {publicDataLinks,siteAccess,discoveryFailure} from '../lib/site-data.mjs';
import {discover,extractCandidates} from '../lib/discovery.mjs';
import {detectReferralHints,resolveReferral} from '../lib/referral.mjs';
import {wallet} from '../lib/common.mjs';
const base='https://another-project.example/';
const A='0x1111111111111111111111111111111111111111';
test('public status on another chain cannot nominate a BSC mint target',async()=>{
 assert.deepEqual(extractCandidates(JSON.stringify({data:{chainId:1,contracts:{mint:A}}}),base+'api/v1/status'),[]);
 assert.ok(extractCandidates(JSON.stringify({data:{chainId:56,contracts:{mint:A}}}),base+'api/v1/status').length);
 const r=await discover(base,{fetchText:async()=>JSON.stringify({data:{chainId:1,contracts:{mint:A}}})});assert.equal(r.address,null);assert.equal(r.addresses.length,0);
});
// Self-contained synthetic frontend; no captured session/site files.
const samples={
 'page.html':'<script src="/app.js"></script><script src="/aw-ui.js"></script>',
 'app.js':'fetch("/config/shitcoin-mint.json");fetch("/api/public/mint/snapshot?quantity=1");fetch("/api/mint/snapshot");validAddress(s.token);validAddress(s.mint);',
 'aw.js':'if(wallet.connected) fetch("/api/aw/login");const link="?ref="+wallet.address;',
 'config.json':'{"chainId":56}', 'public-snapshot.json':'{"quantity":1}'
};
const source=name=>samples[name];
const rows=[{url:base,text:source('page.html')},{url:base+'app.js',text:source('app.js')},{url:base+'aw-ui.js',text:source('aw.js')}];
test('late Next chunks and explicitly public prefixed status resources reveal deployments on an unfamiliar domain',async()=>{
 const requested=[];
 const r=await discover(base,{fetchText:async url=>{requested.push(url);
  if(url===base)return Array.from({length:14},(_,i)=>`<script src="/_next/static/chunks/${i}.js"></script>`).join('');
  if(url.endsWith('/10.js'))return 'async function client(path){return fetch(`/api/v2${path}`)}';
  if(url.endsWith('/13.js'))return '(0,x.useResource)("/status",!1,{}); (0,x.useResource)("/launch/quote",false); (0,x.useResource)("/me/free-mint");';
  if(url===base+'api/v2/status')return JSON.stringify({status:true,data:{chainId:56,contracts:{mint:A}}});return '';
 }});
 assert.equal(r.address,A);assert.ok(requested.includes(base+'api/v2/status'));
 assert.ok(!requested.some(u=>/\/launch\/quote|\/me\/free-mint/.test(u)));
 const ambiguous=[{url:base,text:'fetch(`/api/v1${p}`); fetch(`/api/v2${p}`); useResource("/status",false);'}];
 assert.deepEqual(publicDataLinks(ambiguous,base),[]);
});
test('外置部署 JSON 和公开快照按网页引用加载，跨站与登录/写入接口不跟随',()=>{
 const links=publicDataLinks(rows,base);assert.ok(links.includes(base+'config/shitcoin-mint.json'));assert.ok(links.includes(base+'api/public/mint/snapshot?quantity=1'));assert.equal(links.length,2);
 const risky={url:base,text:'"https://evil.example/config.json" "/api/aw/login" "/api/mint/prepare" "/api/mint/execute" "/api/session" "/api/mint/snapshot?quantity=1" "/api/public/mint/snapshot?redirect=http://127.0.0.1/" "http://127.0.0.1/config.json" "/api/config.json?token=secret"'};
 assert.deepEqual(publicDataLinks([risky],base),[]);
});
test('陌生域名和外置配置路径仍可识别合约，不执行网页脚本',async()=>{
 const requested=[];
 const r=await discover(base,{fetchText:async u=>{requested.push(u);if(u===base)return '<title>New project</title><script src="/bundle.js"></script>';if(u===base+'bundle.js')return 'const CFG="/deployment/new-brand.json";fetch(CFG);throw Error("never run");';if(u===base+'deployment/new-brand.json')return JSON.stringify({chainId:56,mintContractAddress:A});return '';}});
 assert.equal(r.address,A);assert.ok(requested.includes(base+'deployment/new-brand.json'));
});
test('独立前端换域名仍识别登录后公开目标类型，不再要求点不存在的候选',async()=>{
 const map=new Map([...rows,{url:base+'config/shitcoin-mint.json',text:source('config.json')},{url:base+'api/public/mint/snapshot?quantity=1',text:source('public-snapshot.json')}].map(r=>[r.url,r.text]));
 const requested=[];const r=await discover(base+'#faq',{fetchText:async u=>{requested.push(u);return map.get(u.replace('#faq',''))||'';}});
 assert.equal(r.address,null);assert.equal(r.candidates.length,0);assert.equal(r.needsSelection,false);assert.equal(r.access.kind,'site-session-targets');assert.equal(r.failure.code,'SITE_SESSION_REQUIRED');assert.doesNotMatch(r.reason,/多个合约|选择候选/);
 assert.ok(!requested.some(u=>/\/api\/(?:aw|session|mint\/prepare|mint\/snapshot)/.test(u)));
 const ref=await resolveReferral({}, {},r,{});assert.equal(ref.url,base+'?ref='+wallet(1).address);assert.equal(ref.bindingVerified,false);
});
test('URL 编码不等于邀请码；只有明确地址生产表达式才可生成未绑定的邀请链接',async()=>{
 for(const expression of ['encodeURIComponent(walletAddress)','encodeURI(account.address)','String(wallet.address)']){
  const hints=detectReferralHints([{url:base,text:'const inviteUrl=`'+base+'?sponsor=${'+expression+'}`;'}],base);
  assert.equal(hints.templates[0].kind,'address');
  const ref=await resolveReferral({}, {},{source:base+'#faq',referralHints:hints},{});assert.equal(new URL(ref.url).searchParams.get('sponsor'),wallet(1).address);assert.equal(ref.bindingVerified,false);
 }
 for(const expression of ['encodeURIComponent(inviteCode)','encodeURIComponent(api.code)','arbitraryValue']){
  const hints=detectReferralHints([{url:base,text:'const link=`?ref=${'+expression+'}`;'}],base);
  const ref=await resolveReferral({}, {},{source:base,referralHints:hints},{});assert.equal(ref.url,null);
 }
});
test('公开报价不是个人额度，网络失败、无地址、登录要求和多候选保留不同原因',()=>{
 assert.equal(siteAccess([{url:base,text:'fetch("/api/mint/snapshot")'}],base),null);
 assert.equal(discoveryFailure({addresses:[],candidates:[],pageError:'Timeout'}).code,'WEBSITE_UNAVAILABLE');
 assert.equal(discoveryFailure({addresses:[],candidates:[]}).code,'CONTRACT_NOT_PUBLISHED');
 assert.equal(discoveryFailure({addresses:[{}],candidates:[]}).code,'MINT_NOT_VERIFIED');
 assert.equal(discoveryFailure({addresses:[{},{}],candidates:[{},{}]}).code,'CONTRACT_SELECTION_REQUIRED');
});
test('Mint markdown links and nested deployment objects work across renamed brands without following agent jobs',async()=>{
 const fetched=[],mint='0x2222222222222222222222222222222222222222',treasury='0x3333333333333333333333333333333333333333';
 const r=await discover(base+'chronicle',{fetchText:async url=>{fetched.push(url);if(url===base+'chronicle')return '<title>Renamed NFT</title>';if(url===base+'llms.txt')return '[Mint](/agent/mint.md) [Machine contract configuration](/agent/brand.json) [Daily agent actions](/agent/chronicle.md) [foreign](https://evil.example/mint.md)';if(url===base+'agent/brand.json')return JSON.stringify({contracts:{randomName:{address:mint,name:'Brand Pass',role:'NFT; mint here'},vault:{address:treasury,role:'treasury'}}});return '';}});
 assert.equal(r.address,mint);assert.ok(fetched.includes(base+'agent/brand.json'));assert.ok(fetched.includes(base+'agent/mint.md'));assert.ok(!fetched.some(u=>/chronicle.md|evil.example/.test(u)));
});
