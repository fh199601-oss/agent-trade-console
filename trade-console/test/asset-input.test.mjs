import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAssetInput,mintTradeCA} from '../public/asset-input.mjs';
import {websiteUrl} from '../lib/network.mjs';
import {discover} from '../lib/discovery.mjs';
import {validateIntent,bindings} from '../lib/common.mjs';
const ca='0x0Cbc2C5f9c5Bdac24d98E71Bf173192692050946';
test('Mint sync accepts complete nonzero CAs only, never a URL containing a CA',()=>{
 assert.equal(mintTradeCA(' '+ca+' '),ca);assert.equal(mintTradeCA(ca.toUpperCase()),ca.toUpperCase());
 for(const s of ['',null,'0x123','0x'+'0'.repeat(40),'example.com',`https://flap.sh/apps/corla/mint/${ca}`,`flap.sh/?ca=${ca}`,`CA: ${ca}`])assert.equal(mintTradeCA(s),null);
});
test('裸域名、多级域名、路径和邀请参数补全 HTTPS，保留含义',()=>{
 const cases=[['xxx.com','https://xxx.com/'],[' Moomoo.Cloud/bnbull/ ','https://moomoo.cloud/bnbull/'],['qagent.live','https://qagent.live/'],['www.pixelboyz.shop/mint?ref=abc%2B123#mint','https://www.pixelboyz.shop/mint?ref=abc%2B123#mint'],['//test.example.xyz/path','https://test.example.xyz/path'],['0xabc.fun','https://0xabc.fun/'],['例子.测试/铸造','https://xn--fsqu00a.xn--0zwm56d/%E9%93%B8%E9%80%A0']];
 for(const [input,expected] of cases){assert.equal(normalizeAssetInput(input),expected);assert.equal(websiteUrl(input).href,expected);assert.equal(normalizeAssetInput(expected),expected);}
 assert.equal(normalizeAssetInput(ca),ca);
});
test('域名补全不会放行内部地址、伪协议、凭据或不完整 CA',()=>{
 for(const s of ['','not-a-domain','foo bar.com','javascript:alert(1)','http://example.com','https://user:pass@example.com','example.com:3000','example.com\\@internal','0x123'])assert.throws(()=>normalizeAssetInput(s),s);
 for(const s of ['127.0.0.1','127.1','10.0.0.1','169.254.169.254','secret.local','https://localhost'])assert.throws(()=>websiteUrl(s),s);
});
test('CLI 意图与网页识别入口接受裸域名，与完整 URL 归一为同一输入',async()=>{
 const input={account:bindings()[0].account,side:'mint',asset:'moomoo.cloud/bnbull/?ref=test',scope:'free',quantity:'max',maxBnb:'0'};
 assert.deepEqual(validateIntent(input),validateIntent({...input,asset:'https://moomoo.cloud/bnbull/?ref=test'}));
 const calls=[];await discover('example.com/mint',{fetchText:async u=>{calls.push(String(u));return '<title>Demo mint</title>';}});
 assert.equal(calls[0],'https://example.com/mint');assert.ok(calls.every(u=>u.startsWith('https://example.com/')));
});
