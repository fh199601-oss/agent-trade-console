import test from 'node:test';import assert from 'node:assert/strict';
import {Interface,keccak256} from 'ethers';
import {publishedMintCalls} from '../lib/frontend-mint.mjs';
import {recognizeMint} from '../lib/adaptive-mint.mjs';
import {mintPlan} from '../lib/mint.mjs';import {discover} from '../lib/discovery.mjs';
import {bindings} from '../lib/common.mjs';import {verifyPreview} from '../lib/engine.mjs';
import {addressReferral} from '../lib/referral.mjs';
const A='0x'+'1'.repeat(40),B='0x'+'2'.repeat(40),T='0x'+'3'.repeat(40),base='https://unseen.example/';
const ABI=['function claimFree()','function mint(uint256 shares,address referrer,uint256 maxCost) payable','function mintWithBnb(uint256 shares,address referrer,uint256 maxCost) payable','function costOf(uint256) view returns(uint256)','function USER_SHARE() view returns(uint256)','function token() view returns(address)','function FREE_SHARES() view returns(uint256)','function FREE_PER_WALLET() view returns(uint256)','function freeMinted() view returns(uint256)','function freeClaimed(address) view returns(bool)','function freeClaimedCount(address) view returns(uint256)','function PAID_PER_WALLET() view returns(uint256)','function paidMintedCount(address) view returns(uint256)','function totalMinted() view returns(uint256)','function TOTAL_SHARES() view returns(uint256)','function MAX_PER_TX() view returns(uint256)','function opened() view returns(bool)','function paused() view returns(bool)','function quotaOf(uint256) view returns(uint256)','function mintedCount(uint256) view returns(uint256)'];
const iface=new Interface(ABI),abiJSON=iface.formatJson();
const app=`(function(){const CFG={chainId:56,something:'${A}'};function abi(){return window.CARD_ABI||{};}let w=null;
function connect(){const a=abi();w=ready?new ethers.Contract(CFG.something,a.mint,signer):null;}
async function free(){await w.claimFree();}async function paid(){await w.mint(qty,ref,maxCost,{value:cost});}
function disconnect(){w=null;}})();`;
const rows=[{url:base+'abi.js',text:`window.CARD_ABI={mint:${abiJSON}};`},{url:base+'app.js',text:app}];
const extract=text=>publishedMintCalls([{url:base+'app.js',text}]);
test('IIFE-scoped config, lazy contract assignment and external ABI bind actual free/paid calls on an unseen domain',()=>{
 const calls=publishedMintCalls(rows);assert.deepEqual(calls.map(c=>c.method),['claimFree()','mint(uint256,address,uint256)']);assert.ok(calls.every(c=>c.address===A&&c.source===base+'app.js'));
 const renamed=publishedMintCalls(rows.map(r=>({...r,url:r.url.replace('unseen.example','other.example'),text:r.text.replaceAll('something','unusualDeployment').replaceAll('CARD_ABI','OTHER_ABI')})));assert.deepEqual(renamed.map(c=>c.method),calls.map(c=>c.method));
});
test('viem direct and member writeContract calls bind literal config without running the frontend',()=>{
 for(const invoke of ['writeContract(config,','client.writeContract(','writeContractAsync(']){
  globalThis.frontendExecuted=false;const c=extract(`const abi=${abiJSON};globalThis.frontendExecuted=true;${invoke}{address:'${A}',abi,functionName:'claimFree'});`);
  assert.equal(c.length,1);assert.equal(c[0].address,A);assert.equal(globalThis.frontendExecuted,false);delete globalThis.frontendExecuted;
 }
 assert.equal(extract(`client.writeContract({chainId:1,address:'${A}',abi:${abiJSON},functionName:'claimFree'});`).length,0);
});
test('ES modules resolve only already-fetched same-origin literal imports, including renamed and namespace exports',()=>{
 const config={url:base+'config.js',text:`const C='${A}';export {C as deployed};export const mintABI=${abiJSON};export default {address:C};`};
 for(const text of [
  `import {deployed as addr,mintABI as abi} from './config.js';const c=new ethers.Contract(addr,abi,s);c.claimFree();`,
  `import * as cfg from './config.js';const c=new ethers.Contract(cfg.deployed,cfg.mintABI,s);c.claimFree();`,
  `import cfg,{mintABI} from './config.js';const c=new ethers.Contract(cfg.address,mintABI,s);c.claimFree();`
 ])assert.equal(publishedMintCalls([config,{url:base+'app.js',text}])[0].address,A);
 const script={url:base+'app.js',text:`import {deployed,mintABI} from './missing.js';const c=new ethers.Contract(deployed,mintABI,s);c.claimFree();`};assert.equal(publishedMintCalls([config,script]).length,0);
});
test('web3 ABI-first constructor and methods.send bind the intended Mint call without sending',()=>{
 const c=extract(`const c=new web3.eth.Contract(${abiJSON},'${A}');c.methods.claimFree().send({from:account});`);assert.equal(c.length,1);assert.equal(c[0].method,'claimFree()');
});
test('classic script tags share literal config and ABI across files, regardless of fetch completion order',()=>{
 const page={url:base,text:'<script src="config.js"></script><script src="abi.js"></script><script src="app.js"></script>'};
 const cfg={url:base+'config.js',text:`const DEPLOY=Object.freeze({target:'${A}'});`},abi={url:base+'abi.js',text:`const ABI=${abiJSON};`},app={url:base+'app.js',text:'const c=new x(DEPLOY.target,ABI,s);c.claimFree();'};
 for(const order of [[page,cfg,abi,app],[app,abi,cfg,page]])assert.equal(publishedMintCalls(order)[0].address,A);
 const modulePage={...page,text:page.text.replaceAll('<script ','<script type="module" ')};
 assert.equal(publishedMintCalls([modulePage,cfg,abi,app]).length,0,'module scripts must not leak lexical bindings');
 assert.equal(publishedMintCalls([cfg,abi,app]).length,0,'unreferenced config files do not share globals');
 const mutation={url:base+'change.js',text:`const alias=DEPLOY;alias.target='${B}';`};
 assert.equal(publishedMintCalls([mutation,app,abi,cfg,{...page,text:page.text+'<script src="change.js"></script>'}]).length,0);
});
test('minified imported transaction helper binds the caller target instead of unrelated treasury or presale addresses',()=>{
 const helpers={url:base+'chunk.js',text:`const cfg={nft:'${A}',presale:'${B}',vault:'${T}'};const abis={nft:['function mint(uint256 quantity) payable','function costFor(address wallet,uint256 quantity) view returns(uint256)']};async function a(kind,target,method,args=[],value=0n){return(await new z(target,abis[kind],signer)[method](...args,{value})).wait()}export {cfg as c,a as x};`};
 const page={url:base+'entry.js',text:`import{c as f,x as w}from './chunk.js';async function go(n){await w('nft',f.nft,'mint',[n],price);}`};
 const calls=publishedMintCalls([page,helpers]);assert.equal(calls.length,1);assert.equal(calls[0].address,A);assert.equal(calls[0].method,'mint(uint256)');
 const abi=new Interface(['function mint(uint256 quantity) payable','function costFor(address wallet,uint256 quantity) view returns(uint256)']);
 const runtimeCode='0x'+abi.fragments.map(f=>'63'+f.selector.slice(2)+'14600057').join('')+'00';
 const route=recognizeMint({address:A,verified:false,runtimeCode,frontendCalls:calls}).routes[0];assert.equal(route.method,'mint(uint256)');assert.equal(route.quotes[0].method,'costFor(address,uint256)');
});
test('wallet-specific costFor quote reaches a simulated paid plan, enforcing payment and the current-wallet discount',async()=>{
 const abi=new Interface(['function mint(uint256 quantity) payable','function costFor(address wallet,uint256 quantity) view returns(uint256)','function supportsInterface(bytes4) view returns(bool)','function balanceOf(address) view returns(uint256)','function ownerOf(uint256) view returns(address)','function MAX_PER_WALLET() view returns(uint256)','function mintedBy(address) view returns(uint256)']);
 const frontendCalls=extract(`const c=new z('${A}',${abi.formatJson()},s);c.mint(q,{value:cost});`),runtimeCode='0x'+abi.fragments.map(f=>'63'+f.selector.slice(2)+'14600057').join('')+'00';
 const meta={address:A,runtimeCode,verified:false,hash:keccak256(runtimeCode),identity:{target:A,fingerprint:'fresh-fixture'},frontendCalls};
 const owner=bindings()[0];let used=0n,underpay=false;const seen=[];
 const rpc={getBlockNumber:async()=>123,send:async(method,params)=>{
  if(method==='eth_getBlockByNumber')return {timestamp:'0x64'};if(method==='eth_estimateGas')return '0x20000';assert.equal(method,'eth_call');
  const tx=params[0],f=abi.parseTransaction(tx);seen.push(f.name);
  if(f.name==='mint'){const cost=(f.args[0]-(used===0n?1n:0n))*10n;if(f.args[0]>3n-used||BigInt(tx.value)!==cost&&!underpay)throw Object.assign(Error('execution reverted'),{executionError:true});return '0x';}
  if(f.name==='costFor'){assert.equal(f.args[0].toLowerCase(),owner.address.toLowerCase());return abi.encodeFunctionResult(f.signature,[(f.args[1]-(used===0n?1n:0n))*10n]);}
  const value={supportsInterface:true,MAX_PER_WALLET:3n,mintedBy:used,balanceOf:used,ownerOf:owner.address}[f.name];assert.notEqual(value,undefined,f.name);return abi.encodeFunctionResult(f.signature,[value]);
 }};rpc.call=tx=>rpc.send('eth_call',[tx,'0x7b']);
 const plan=()=>mintPlan(rpc,{}, {account:owner.account,side:'mint',asset:base,quantity:2,scope:'all',maxBnb:'1',maxUsdt:'0',referral:'none'},A,{address:A,source:base,frontendCalls},null,{sourceLoader:async()=>meta,chainLearner:{learn:async()=>{throw Error('unexpected history scan');}}});
 const p=await plan();assert.equal(p.quantity,2);assert.equal(p.amountIn,'10');assert.equal(p.expectedAsset.kind,'Erc721');assert.equal(p.steps[0].to.toLowerCase(),A);assert.ok(seen.includes('costFor'));
 used=1n;assert.equal((await plan()).amountIn,'20');underpay=true;await assert.rejects(plan(),/少付 1 wei/);
});
test('literal config aliases, spreads and JSON config bind viem writes without evaluating website functions',()=>{
 for(const config of [`{address:'${A}',abi:${abiJSON}}`,`Object.freeze({address:'${A}',abi:${abiJSON}})`,`JSON.parse(${JSON.stringify(JSON.stringify({address:A,abi:ABI}))})`]){
  const c=extract(`const base=${config};const config={...base,functionName:'claimFree'};client.writeContract(config);`);assert.equal(c.length,1);assert.equal(c[0].address,A);
 }
 assert.equal(extract(`const base={address:'${A}',abi:${abiJSON}};client.writeContract({...base,address:'${B}',functionName:'claimFree'});`)[0].address,B);
});
test('unknown dynamic address or chain values cannot crash all website discovery',()=>{
 for(const extra of [`address:dynamic()`,`address:'${A}',chainId:dynamic()`,`address:'${A}',chain:{id:dynamic()}`])assert.deepEqual(extract(`client.writeContract({${extra},abi:${abiJSON},functionName:'claimFree'});`),[]);
 const c=extract(`const cfg={target:dynamic(),chainId:dynamic()};const c=new x(cfg.target,${abiJSON},s);c.claimFree();const ok=new y('${A}',${abiJSON},s);ok.claimFree();`);assert.equal(c.length,1);assert.equal(c[0].address,A);
});
test('helper parameter writes, aliased mutations, unknown imports and recursion never invent executable targets',()=>{
 for(const body of [`target=dynamic();`,`target='${B}';`,`const x=target;x.address='${B}';`,`target.address=dynamic();`]){
  const object=body.includes('.address'),arg=object?`{address:'${A}'}`:`'${A}'`,target=object?'target.address':'target';
  assert.equal(extract(`function tx(target){${body}const c=new z(${target},${abiJSON},s);c.claimFree()}tx(${arg});`).length,0,body);
 }
 assert.equal(extract(`function tx(target){tx(target)}tx('${A}');`).length,0);
 assert.equal(extract(`import {x} from './missing.js';x('${A}','claimFree');`).length,0);
 const calls=extract(`function tx(target='${A}'){const c=new z(target,${abiJSON},s);c.claimFree()}tx();`);assert.equal(calls.length,1);assert.equal(calls[0].address,A);
});
test('ambiguous contract assignment, mutated address, dynamic loader and shadowed config do not nominate a target',()=>{
 const prefix=`const CFG={chainId:56,target:'${A}'};const abi=${abiJSON};`;
 for(const body of [
  `let c=new ethers.Contract(CFG.target,abi,s);c=new ethers.Contract('${B}',abi,s);c.claimFree();`,
  `CFG.target=dynamic();const c=new ethers.Contract(CFG.target,abi,s);c.claimFree();`,
  `const alias=CFG;alias.target='${B}';const c=new ethers.Contract(CFG.target,abi,s);c.claimFree();`,
  `const c=new ethers.Contract(fetchAddress(),abi,s);c.claimFree();`,
  `function callback({CFG}){const c=new ethers.Contract(CFG.target,abi,s);c.claimFree();}`,
  `function callback(){if(x){var CFG=dynamic();}const c=new ethers.Contract(CFG.target,abi,s);c.claimFree();}`,
  `function getABI(){touchWallet();return abi;}const c=new ethers.Contract(CFG.target,getABI(),s);c.claimFree();`
 ])assert.equal(extract(prefix+body).length,0,body);
 assert.equal(extract(prefix.replace('chainId:56','chainId:1')+`const c=new ethers.Contract(CFG.target,abi,s);c.claimFree();`).length,0);
 assert.equal(publishedMintCalls([...rows,{url:base+'other.js',text:'window.CARD_ABI.mint=loadUntrusted();'}]).length,0);
});
test('read-only methods, unrelated writes and ambiguous overloads are not frontend Mint entries',()=>{
 for(const [abi,call]of [[['function mint() view returns(uint256)'],'c.mint()'],[['function approve(address,uint256)'],'c.approve(account,1)'],[['function mint()','function mint(uint256)'],'c.mint(1)']])assert.equal(extract(`const c=new ethers.Contract('${A}',${JSON.stringify(abi)},s);${call};`).length,0);
 assert.equal(extract(`const c=new ethers.Contract('${A}',${JSON.stringify(['function mint()','function mint(uint256)'])},s);c['mint(uint256)'](1);`)[0].method,'mint(uint256)');
});
test('native payment follows the actual same-contract quote through async wrappers, never a different quantity or contract',()=>{
 const abi=new Interface(['function mint(uint256 quantity) payable','function quoteTicket(uint256 qty) view returns(uint256)','function bnbQuote(uint256 usd) view returns(uint256)']);
 const script=(priceArg='n',priceAddress=A)=>`const abi=${abi.formatJson()};const read=new ethers.Contract('${priceAddress}',abi,p);const c=new ethers.Contract('${A}',abi,s);async function costFor(n){if(!read)throw Error('missing');return read.quoteTicket(${priceArg});}async function buy(qty){const cost=await costFor(qty);await c.mint(qty,{value:cost});}`;
 const calls=extract(script());assert.equal(calls[0].price.method,'quoteTicket(uint256)');
 const runtimeCode='0x'+abi.fragments.map(f=>'63'+f.selector.slice(2)+'14600057').join('')+'00';const r=recognizeMint({address:A,verified:false,runtimeCode,frontendCalls:calls});assert.deepEqual(r.routes[0].quotes.map(q=>q.method),['quoteTicket(uint256)']);
 assert.equal(extract(script('1'))[0].price,undefined);assert.equal(extract(script('n',B))[0].price,undefined);
 assert.equal(extract(script('arbitrary(n)'))[0].price,undefined);
});
test('unverified address referral requires actual URL-address flow into the bound Mint argument, not ABI labels alone',()=>{
 const source=(value='ref',extra='')=>`const ZERO='0x${'0'.repeat(40)}';const c=new ethers.Contract('${A}',${abiJSON},s);function getReferrer(){try{const p=new URLSearchParams(location.search);const v=p.get('ref');if(v)return ethers.getAddress(v);}catch(e){}return ZERO;}function mint(qty){const incoming=getReferrer();const ref=incoming!==ZERO?incoming:ZERO;c.mint(qty,${value},cost,{value:cost});${extra}}`;
 const f=fixture(),frontendCalls=extract(source()),meta={...f.meta,frontendCalls},route=recognizeMint(meta).routes.find(r=>r.method.startsWith('mint('));assert.equal(frontendCalls[0].referral[0].index,1);
 const p=addressReferral(meta,route,{account:2,referral:'account1'});assert.equal(p.callValue,bindings()[0].address);assert.equal(p.bindingVerified,false);assert.equal(p.parameterEvidence,'frontend-query-address');
 for(const text of [source('api.referrer'),source().replace('return ethers.getAddress(v)','return remoteLookup(v)'),source('ref','c.mint(qty,api.referrer,cost,{value:cost});'),source().replace("p.get('ref')","p.get('beneficiary')")]){
  const calls=extract(text),m={...f.meta,frontendCalls:calls},r=recognizeMint(m).routes.find(r=>r.method.startsWith('mint('));assert.throws(()=>addressReferral(m,r,{account:2,referral:'account1'}),/源码未核验/);
 }
 assert.throws(()=>addressReferral({...meta,address:B},route,{account:2,referral:'account1'}),/源码未核验/);
});
function fixture(){
 const frontendCalls=publishedMintCalls(rows),runtimeCode='0x'+iface.fragments.map(f=>'63'+f.selector.slice(2)+'14600057').join('')+'00';
 const meta={address:A,runtimeCode,verified:false,hash:keccak256(runtimeCode),identity:{target:A,fingerprint:'fixture'},frontendCalls};
 const s={freeUsed:0n,freeSold:3n,paidUsed:0n,opened:false,paused:false,allowUnderpay:false};const seen=[];
 const rpc={getBlockNumber:async()=>123,send:async(method,params)=>{
  if(method==='eth_getBlockByNumber')return {timestamp:'0x64'};if(method==='eth_estimateGas')return '0x20000';assert.equal(method,'eth_call');assert.equal(params[1],'0x7b');
  const tx=params[0],f=iface.parseTransaction(tx);seen.push(f.name);
  if(f.name==='claimFree'||f.name==='mint'){
   const qty=f.name==='claimFree'?1n:f.args[0];if(s.opened||s.paused||f.name==='claimFree'&&(s.freeUsed>=1n||s.freeSold>=100n)||f.name==='mint'&&(qty>10n-s.paidUsed||BigInt(tx.value)!==qty*10n&&!s.allowUnderpay))throw Object.assign(Error('execution reverted'),{executionError:true});return '0x';
  }
  assert.notEqual(f.name,'mintWithBnb','unused alias must never be simulated');
  const v={FREE_SHARES:100n,FREE_PER_WALLET:1n,freeMinted:s.freeSold,freeClaimed:s.freeUsed>0n,freeClaimedCount:s.freeUsed,PAID_PER_WALLET:10n,paidMintedCount:s.paidUsed,totalMinted:20n,TOTAL_SHARES:1000n,MAX_PER_TX:10n,opened:s.opened,paused:s.paused,token:T,USER_SHARE:1000n,costOf:f.name==='costOf'?f.args[0]*10n:0n};
  assert.ok(Object.hasOwn(v,f.name),f.name);return iface.encodeFunctionResult(f.signature,[v[f.name]]);
 }};rpc.call=tx=>rpc.send('eth_call',[tx,'0x7b']);
 const intent={account:bindings()[0].account,side:'mint',asset:base,quantity:'max',scope:'free',maxBnb:'0',referral:'none'};
 const plan=i=>mintPlan(rpc,{}, {...intent,...i},A,{address:A,source:base,frontendCalls},null,{sourceLoader:async()=>meta,chainLearner:{learn:async()=>{throw Error('unexpected history scan');}}});
 return {s,rpc,meta,seen,plan};
}
test('deployed selectors and target binding remain mandatory, frontend ABI never grants arbitrary parameter support',()=>{
 const {meta}=fixture(),r=recognizeMint(meta);assert.deepEqual(r.routes.map(x=>[x.method,x.lane]),[['claimFree()','free'],['mint(uint256,address,uint256)','paid']]);
 assert.ok(recognizeMint({...meta,address:B}).routes.every(r=>!r.frontend));
 assert.equal(recognizeMint({...meta,runtimeCode:'0x00'}).routes.length,0);
 const signed=new Interface(['function mint(uint256 quantity,bytes signature)']);const calls=extract(`const c=new ethers.Contract('${A}',${signed.formatJson()},s);c.mint(1,sig);`);
 assert.equal(recognizeMint({...meta,runtimeCode:'0x63'+signed.fragments[0].selector.slice(2)+'1460005700',frontendCalls:calls}).routes.length,0);
});
test('new site-bound Mint names reach discovery and a simulated plan without a domain adapter or history',async()=>{
 const abi=new Interface(['function mintCollectible(uint256 quantity)','function supportsInterface(bytes4) view returns(bool)','function ownerOf(uint256) view returns(address)','function balanceOf(address) view returns(uint256)']);
 const runtimeCode='0x'+abi.fragments.map(f=>'63'+f.selector.slice(2)+'14600057').join('')+'00',meta={address:A,runtimeCode,verified:false,hash:keccak256(runtimeCode),identity:{target:A,fingerprint:'fresh-name'}};
 const script=`const c=new minified('${A}',${abi.formatJson()},s);c.mintCollectible(qty);`;
 const rpc={verifyChain:async()=>{},getCode:async()=>runtimeCode,getBlockNumber:async()=>123,send:async(method,params)=>{
  if(method==='eth_getBlockByNumber')return {timestamp:'0x64'};if(method==='eth_estimateGas')return '0x20000';assert.equal(method,'eth_call');
  const f=abi.parseTransaction(params[0]);if(f.name==='mintCollectible'){if(f.args[0]>2n)throw Object.assign(Error('execution reverted'),{executionError:true});return '0x';}
  if(f.name==='supportsInterface')return abi.encodeFunctionResult(f.signature,[true]);throw Error('getter unavailable');
 }};rpc.call=tx=>rpc.send('eth_call',[tx,'latest']);
 const sourceLoader=async()=>meta,project=await discover(base+'novel/',{rpc,corlaRouting:false,sourceLoader,fetchText:async u=>u===base+'novel/'?`<script>${script}</script>`:''});
 assert.equal(project.address.toLowerCase(),A);assert.ok(project.addresses.find(r=>r.primary).verifiedRoles.includes('mint'));
 const p=await mintPlan(rpc,{}, {account:bindings()[0].account,side:'mint',asset:base,quantity:1,scope:'free',maxBnb:'0',maxUsdt:'0',referral:'none'},A,project,null,{sourceLoader,chainLearner:{learn:async()=>{throw Error('history must not run');}}});
 assert.equal(abi.parseTransaction(p.steps[0]).name,'mintCollectible');assert.equal(p.amountIn,'0');assert.equal(p.expectedAsset.kind,'Erc721');
 assert.equal(recognizeMint({...meta,abiHints:JSON.parse(abi.formatJson())}).routes.length,0,'ABI listing without a bound call is not sufficient');
 for(const signature of ['mintCollectible(uint256 tokenId)','mintCollectible(address recipient)','mintCollectible(uint256 quantity,bytes signature)']){
  const badAbi=new Interface(['function '+signature]),f=badAbi.fragments[0],calls=extract(`const c=new x('${A}',${badAbi.formatJson()},s);c.mintCollectible(v);`);
  assert.equal(recognizeMint({...meta,runtimeCode:'0x63'+f.selector.slice(2)+'1460005700',frontendCalls:calls}).routes.length,0,signature);
 }
});
test('site-bound executable entry bypasses read-only family blocker and selects current wallet free or paid max',async()=>{
 const f=fixture(),free=await f.plan();assert.equal(free.quantity,1);assert.equal(free.amountIn,'0');assert.equal(free.steps[0].data,iface.encodeFunctionData('claimFree'));assert.equal(free.expectedAsset.amount,'1000');
 const paid=await f.plan({scope:'paid',maxBnb:'0.0000000000000001'});assert.equal(paid.quantity,10);assert.equal(paid.amountIn,'100');assert.equal(paid.quota.limits.walletRemaining,10);assert.equal(iface.parseTransaction(paid.steps[0]).name,'mint');
 f.s.paidUsed=7n;assert.equal((await f.plan({scope:'paid',maxBnb:'1'})).quantity,3);
 const all=await f.plan({scope:'all',maxBnb:'1'});assert.equal(all.amountIn,'0');assert.equal(all.fill.continue,true);
 f.s.freeUsed=1n;const next=await f.plan({scope:'all',maxBnb:'1'});assert.equal(next.quantity,3);assert.equal(next.amountIn,'30');
 assert.ok(!f.seen.includes('mintWithBnb'));
 assert.throws(()=>verifyPreview({requestId:'mock',simulationResult:{simulationCode:'000000000',balanceChanges:[]}},paid,paid.steps[0]),/到账/);
});
test('ended, exhausted free quota, insufficient budget and invalid price remain distinct from missing adapters',async()=>{
 const f=fixture();f.s.opened=true;await assert.rejects(f.plan(),e=>e.code==='MINT_ENDED');f.s.opened=false;
 f.s.freeSold=100n;await assert.rejects(f.plan(),e=>e.code==='NO_QUOTA');f.s.freeSold=3n;
 await assert.rejects(f.plan({scope:'paid',maxBnb:'0'}),/预算/);
 f.s.allowUnderpay=true;await assert.rejects(f.plan({scope:'paid',maxBnb:'1'}),/少付 1 wei/);
});
test('discovery promotes actual site call target over unrelated Mint-looking config, retaining chain inspection',async()=>{
 const f=fixture(),gets=[];const rpc={verifyChain:async()=>{},getCode:async a=>{gets.push(a.toLowerCase());return a.toLowerCase()===A?f.meta.runtimeCode:'0x00';},call:async()=>{throw Error('unsupported getter');}};
 const result=await discover(base,{rpc,corlaRouting:false,sourceLoader:async(_,a)=>({...f.meta,address:a}),fetchText:async u=>u===base?`<script src="abi.js"></script><script src="app.js"></script><script>const MINT='${B}';</script>`:rows.find(r=>r.url===u)?.text||''});
 assert.equal(result.address.toLowerCase(),A);assert.equal(result.frontendCalls.length,2);assert.ok(gets.includes(A));assert.match(result.addresses.find(r=>r.primary).field,/网页实际调用/);
 assert.ok(!gets.includes(B),'unrelated lower-priority config must not delay the actual Mint call');
 const ambiguous=await discover(base+'two/',{rpc:{...rpc,getCode:async()=>f.meta.runtimeCode},corlaRouting:false,sourceLoader:async(_,a)=>({...f.meta,address:a}),fetchText:async u=>u===base+'two/'?`<script>const abi=${abiJSON};const a=new c('${A}',abi,s),b=new c('${B}',abi,s);a.claimFree();b.claimFree();</script>`:''});
 assert.equal(ambiguous.address,null,'equal-priority actual calls remain ambiguous');
 assert.equal(ambiguous.addresses.filter(r=>r.verifiedRoles.includes('mint')).length,2);
});
