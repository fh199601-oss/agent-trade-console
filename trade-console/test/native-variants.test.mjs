import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {Interface} from 'ethers';import {recognizeMint,adaptiveQuote} from '../lib/adaptive-mint.mjs';
const fixtures=JSON.parse(fs.readFileSync(new URL('./fixtures/native-variants.json',import.meta.url))),wa='0x'+'1'.repeat(40),ref='0x'+'2'.repeat(40);
test('native quote is inferred from msg.value comparison even after the quote getter is renamed',()=>{
 const m=fixtures['agentseal.netlify.app'],r=recognizeMint(m);assert.equal(r.routes.length,1);assert.ok(r.routes[0].quotes.some(q=>q.method==='cost(address,uint256)'));
 const renamed=JSON.parse(JSON.stringify(m).replace(/\bcost\b/g,'ticketFeeToday'));assert.ok(recognizeMint(renamed).routes[0].quotes.some(q=>q.method==='ticketFeeToday(address,uint256)'));
});
test('ref alias and named free/cost tuple preserve referral and free share counts',()=>{
 const r=recognizeMint(fixtures['hirelings.pages.dev']);assert.equal(r.routes.length,1);assert.deepEqual(r.routes[0].roles,['quantity','zero']);const q=r.routes[0].quotes.find(q=>q.method==='quote(address,uint256)');assert.equal(q.index,1);assert.equal(q.free,0);
});
test('verified zero-selection NFT branch constructs one default NFT, without paid add-on or copied uint value',async()=>{
 const m=fixtures['marsplots.pages.dev'],r=recognizeMint(m),route=r.routes[0],i=new Interface(r.abi),calls=[];assert.deepEqual(route.roles,['default-zero','default-false']);assert.equal(route.quantity,false);assert.equal(route.freeEntry,true);
 const rpc=async(method,params)=>{if(method==='eth_estimateGas')return '0x186a0';assert.equal(method,'eth_call');const f=i.parseTransaction(params[0]);if(f.name==='mint'){assert.deepEqual(Array.from(f.args),[0n,false]);assert.equal(params[0].value,'0x0');calls.push(f.args);return i.encodeFunctionResult('mint',[1n]);}const values={mintOpen:true,hasMinted:false,canMint:true,totalMinted:4n,MAX_SUPPLY:10000n,supportsInterface:true};assert.ok(f.name in values,f.name);return i.encodeFunctionResult(f.fragment,[values[f.name]]);};
 const q=await adaptiveQuote({...m,abi:r.abi},route,{address:wa,account:1},1,{tag:'0x64',number:100,timestamp:1000},rpc,ref);assert.equal(q.total.raw,'0');assert.equal(q.expectedAsset.kind,'Erc721');assert.equal(q.expectedAsset.amount,'1');assert.equal(q.limits.walletRemaining,1);assert.ok(calls.length);
 const changed=structuredClone(m);for(const s of Object.values(changed.sources))s.content=s.content.replace('if (cell == 0)','if (cell == 99)');assert.equal(recognizeMint(changed).routes.length,0);
});
test('current wallet revert can quote a no-argument mint only when verified source proves the required-value argument',async()=>{
 const iface=new Interface(['function mint() payable','function supportsInterface(bytes4) view returns(bool)','function ownerOf(uint256) view returns(address)','error Needed(uint256 required,uint256 sent)']);
 const meta={verified:true,address:ref,abi:JSON.parse(iface.formatJson()),sources:{s:{content:'contract NewSale { function mint() external payable { uint256 due = 12; if (msg.value < due) revert Needed(due, msg.value); } }'}}};
 const route=recognizeMint(meta).routes[0];assert.equal(route.revertQuote.name,'Needed');let cost=12n;
 const rpc=async(m,p)=>{if(m==='eth_estimateGas')return '0x186a0';const f=iface.parseTransaction(p[0]);if(f.name==='supportsInterface')return iface.encodeFunctionResult(f.fragment,[true]);if(f.name==='mint'){if(BigInt(p[0].value)<cost)throw Object.assign(Error('execution reverted'),{executionError:true,data:iface.encodeErrorResult('Needed',[cost,BigInt(p[0].value)])});return '0x';}throw Error(f.name);};
 for(const price of [12n,17n]){cost=price;const q=await adaptiveQuote(meta,route,{address:wa},1,{tag:'latest',number:1,timestamp:1},rpc);assert.equal(q.total.raw,String(price));assert.equal(q.freeUnits,0);assert.equal(q.simulated,true);}
 const wrong=structuredClone(meta);wrong.sources.s.content=wrong.sources.s.content.replace('Needed(due, msg.value)','Needed(999, msg.value)');assert.equal(recognizeMint(wrong).routes[0].revertQuote,null);
});
