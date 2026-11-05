import test from 'node:test';import assert from 'node:assert/strict';import {boundedPageText} from '../lib/page-text.mjs';
async function* chunks(s,n){const b=Buffer.from(s);for(let i=0;i<b.length;i+=n)yield b.subarray(i,i+n);}
test('large embedded pictures do not hide a footer CA, JS ABI or Unicode metadata',async()=>{
 const html='<title>新项目</title><img src="data:image/png;base64,'+'A'.repeat(3*1024*1024)+'"><script>const abi=["function mint()"];</script><footer>CA: 0x'+'1'.repeat(40)+'</footer>';
 for(const n of [127,65536]){const text=await boundedPageText(chunks(html,n));assert.ok(text.startsWith('<title>新项目'));assert.ok(text.includes('function mint()'));assert.ok(text.endsWith('1'.repeat(40)+'</footer>'));assert.ok(text.length<250);}
});
test('non-image data, unusually large text and raw payloads retain strict bounds',async()=>{
 const text='data:application/json;base64,AAAA';assert.equal(await boundedPageText(chunks(text,1)),text);
 await assert.rejects(boundedPageText(chunks('x'.repeat(1000),64),{maxText:900}),/文本内容超过/);
 await assert.rejects(boundedPageText(chunks('data:image/png;base64,'+'A'.repeat(1000),127),{maxRaw:900}),/原始内容超过/);
});
