import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {Interface} from 'ethers';import {extractCandidates,discover} from '../lib/discovery.mjs';import {classifyAddresses,labelRoles,mergeCandidates} from '../lib/address-roles.mjs';import {recognizeSpecialMint} from '../lib/special-mint.mjs';
const A='0x1111111111111111111111111111111111111111',B='0x2222222222222222222222222222222222222222',C='0x3333333333333333333333333333333333333333',REG='0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F';
const erc20=['function balanceOf(address) view returns(uint256)','function transfer(address,uint256) returns(bool)','function allowance(address,address) view returns(uint256)','function decimals() view returns(uint8)','function totalSupply() view returns(uint256)'];
const mint=['function publicMint(uint256) payable','function token() view returns(address)','function treasury() view returns(address)'];
test('unknown marketplace field names are separated by existing-NFT owner and transfer data flow',async()=>{
 const f=fake({[A]:{abi:['function mint(uint256) payable']},[B]:{abi:['function buy(uint256 tokenId) payable'],sources:{s:{content:'contract Shop { function buy(uint256 tokenId) external payable { address seller = nft.ownerOf(tokenId); nft.safeTransferFrom(seller, msg.sender, tokenId); } }'}}}});
 const r=await classifyAddresses(f.rpc,[A,B].map(address=>({address,roles:[],priority:0})),f.loader);assert.equal(r.address,A);const market=r.addresses.find(r=>r.address===B);assert.ok(market.verifiedRoles.includes('market'));assert.ok(!market.verifiedRoles.includes('mint'));assert.equal(f.writes(),0);
});
test('secondary NFT market and V3 position manager are not public issuance, mixed collection remains mintable',async()=>{
 const market=['function buy(uint256) payable','function listingOf(uint256) view returns(address,uint256)','function list(uint256,uint256)'];
 const f=fake({[A]:{abi:market},[B]:{abi:['function mint((uint256,uint256)) payable','function positions(uint256) view returns(uint256)','function increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256)) payable']},[C]:{abi:[...market,'function mint(bytes32) payable']}});
 const result=await classifyAddresses(f.rpc,[A,B,C].map(address=>({address,priority:3,roles:[],source:'page'})),f.loader);assert.equal(result.address,C);assert.ok(result.addresses.find(r=>r.address===A).verifiedRoles.includes('market'));assert.ok(result.addresses.find(r=>r.address===B).verifiedRoles.includes('router'));assert.ok(!result.addresses.find(r=>r.address===C).methods.includes('buy(uint256)'));assert.deepEqual(labelRoles('NONFUNGIBLE_POSITION_MANAGER'),['router']);
});
test('version selection requires activated successor, paused predecessor and matching frozen supply',async()=>{
 const m=JSON.parse(fs.readFileSync(new URL('./fixtures/special-families.json',import.meta.url)))['ordinal-vrf-nft'],abi=new Interface(recognizeSpecialMint(m).abi);
 for(const [active,paused,supply,expected]of [[true,true,20n,B],[false,true,20n,null],[true,false,20n,null],[true,true,21n,null]]){
  const rpc={verifyChain:async()=>{},getCode:async()=>m.runtimeCode,call:async tx=>{const f=abi.parseTransaction(tx);const values={legacy:A,activated:active,legacySupplyAtActivation:20n,totalMinted:supply,paused};if(!(f.name in values))throw Error('Not part of fixture');return abi.encodeFunctionResult(f.fragment,[values[f.name]]);}};
  const result=await classifyAddresses(rpc,[A,B].map(address=>({address,roles:[],priority:3})),async(_,a)=>a===B?{...m,address:a}:{address:a,verified:true,abi:['function mint() payable'],sources:{}});assert.equal(result.address,expected);
 }
});
function fake(spec){let writes=0;const rpc={verifyChain:async()=>{},getCode:async a=>spec[a.toLowerCase()]?.eoa?'0x':'0x6000',call:async t=>{const s=spec[t.to.toLowerCase()];const abi=new Interface(s.abi),f=abi.parseTransaction({data:t.data}).fragment;if(!['view','pure'].includes(f.stateMutability)){writes++;throw Error('write forbidden');}return abi.encodeFunctionResult(f,[s.values?.[f.name]]);}};
 const loader=async(r,a)=>{const s=spec[a.toLowerCase()];if(!s)throw Error('Unavailable ABI');return {address:a,verified:true,abi:s.abi,sources:s.sources};};return {rpc,loader,writes:()=>writes};}
test('inline minter/owner guards exclude token-internal issuance from public mint candidates',async()=>{
 for(const guard of ['if(msg.sender != MINTER) revert OnlyMinter();','require(msg.sender == owner);','require(msg.sender == engine, "not engine");','require(msg.sender == forgeCore, "only ForgeCore");']){
  const f=fake({[A]:{abi:['function mint(address to,uint256 amount)',...erc20],sources:{s:{content:`contract Token { function mint(address to,uint256 amount) external { ${guard} } }`}}},[B]:{abi:['function mint(uint256) payable']}});
  const r=await classifyAddresses(f.rpc,[A,B].map(address=>({address,priority:3,roles:[],source:'page'})),f.loader);assert.equal(r.address,B);assert.ok(!r.addresses.find(r=>r.address===A).verifiedRoles.includes('mint'));
 }
});
test('multiple verified entries skip automatic history scans that cannot resolve a genuine product choice',async()=>{
 const f=fake({[A]:{abi:['function mint() payable']},[B]:{abi:['function mint() payable']}});
 const r=await discover('https://two-products.example/',{rpc:f.rpc,sourceLoader:f.loader,chainFallback:true,chainLearner:{learn:async()=>{throw Error('unnecessary history scan');}},fetchText:async url=>url.endsWith('/')?`const mintContract='${A}',presale='${B}'`:''});
 assert.equal(r.address,null);assert.equal(r.candidates.length,2);
});
test('explicit mint deployments are verified before unrelated bundled addresses consume the read budget',async()=>{
 const f=fake({[A]:{abi:['function mint() payable']}});let reads=0;const loader=async(...args)=>{reads++;return f.loader(...args);};
 const r=await classifyAddresses(f.rpc,[{address:A,priority:4,roles:['mint']},{address:B,priority:0,roles:[]},{address:C,priority:0,roles:[]}],loader);
 assert.equal(r.address,A);assert.equal(reads,1);assert.ok(r.addresses.find(r=>r.address===B).deferred);assert.equal(r.candidates.length,0);
});
test('HTML official-contract rows survive unrelated addresses and remain chain verified on new domains',async()=>{
 const f=fake({[A]:{abi:['function mint() payable']},[B]:{abi:erc20},[C]:{eoa:true}});
 const html=Array.from({length:25},(_,i)=>'0x'+(i+100).toString(16).padStart(40,'0')).join(' ')+`<table><tr><th>Official contract</th><td><a href="https://bscscan.com/address/${A}">${A}</a></td></tr><tr><td>Token CA</td><td>${B}</td></tr></table><dl><dt>金库地址</dt><dd>${C}</dd></dl>`;
 const rows=extractCandidates(html,'https://unseen-project.example/');assert.equal(rows.find(r=>r.address===A).priority,3);assert.ok(rows.find(r=>r.address===C).roles.includes('treasury'));
 const result=await discover('https://unseen-project.example/',{rpc:f.rpc,sourceLoader:f.loader,fetchText:async u=>u.endsWith('/')?html:''});assert.equal(result.address,A);assert.equal(f.writes(),0);
});
test('HTML label boundaries retain two competing entries and do not label later sections',async()=>{
 const rows=extractCandidates(`<table><tr><td>Mint contract</td><td>${A}</td></tr><tr><td>Mint address</td><td>${B}</td></tr></table><p>${C}</p>`,'https://new.example/');assert.equal(rows.some(r=>r.address===C),false);
 const f=fake({[A]:{abi:['function mint() payable']},[B]:{abi:['function mint() payable']}});assert.equal((await classifyAddresses(f.rpc,rows,f.loader)).address,null);
});
test('不同命名、大小写、下划线、中文归一；Mint 和 Token 可以同地址',()=>{for(const label of ['COIN','TOKEN_ADDRESS','tokenAddress','代币合约'])assert.deepEqual(labelRoles(label),['token']);assert.deepEqual(labelRoles('Mint_Contract_Address'),['mint']);const rows=extractCandidates(`window.X={COIN:"${A}", TREASURY:"${B}"};\n| mint + ERC-20 Coin | \`${A}\` |`,'https://brand.example/');const merged=mergeCandidates(rows);assert.equal(merged.length,2);assert.deepEqual(new Set(merged[0].roles),new Set(['mint','token']));assert.deepEqual(merged[1].roles,['treasury']);});
test('从实际部署的 ABI 和 token()/treasury() 自动分开入口、代币、收款地址',async()=>{const f=fake({[A]:{abi:mint,values:{token:B,treasury:C}},[B]:{abi:erc20},[C]:{eoa:true}});const r=await classifyAddresses(f.rpc,[{address:A,priority:0,field:'未知名称',source:'x'},{address:C,priority:0,field:'DEPLOYER',source:'x',roles:['treasury']}],f.loader);assert.equal(r.address,A);assert.equal(r.token,B);assert.equal(r.addresses.find(x=>x.address===C).kind,'wallet');assert.ok(r.addresses.find(x=>x.address===B).verifiedRoles.includes('token'));assert.equal(f.writes(),0);});
test('身份注册被网站误标成 Mint 时也不能成为铸造候选',async()=>{const f=fake({[A]:{abi:['function mintFree()']}});const r=await classifyAddresses(f.rpc,[{address:REG,priority:9,roles:['mint'],field:'mint',source:'x'},{address:A,priority:0,field:'未知字段',source:'x'}],f.loader);assert.equal(r.address,A);assert.equal(r.candidates.some(c=>c.address.toLowerCase()===REG.toLowerCase()),false);});
test('陌生名称的图像合约通过 ABI 归类，NFT 自带图像方法仍是 NFT',async()=>{const art=['function imageDataURI() view returns(string)','function tokenURI(uint256) view returns(string)'];const f=fake({[A]:{abi:['function mintFree()']},[B]:{abi:art},[C]:{abi:[...art,'function ownerOf(uint256) view returns(address)','function balanceOf(address) view returns(uint256)']}});const r=await classifyAddresses(f.rpc,[A,B,C].map(address=>({address,priority:0,field:'unknown',source:'x'})),f.loader);assert.equal(r.address,A);assert.ok(r.addresses.find(x=>x.address===B).verifiedRoles.includes('art'));assert.deepEqual(r.addresses.find(x=>x.address===C).verifiedRoles,['nft']);assert.equal(r.candidates.some(x=>x.address===B),false);assert.equal(f.writes(),0);});
test('多个真实 Mint 入口仍需区分，不能凭顺序任选',async()=>{const f=fake({[A]:{abi:['function mintFree()']},[B]:{abi:['function publicMint(uint256) payable']}});const r=await classifyAddresses(f.rpc,[A,B].map(a=>({address:a,priority:3,source:'x',field:'minter'})),f.loader);assert.equal(r.address,null);assert.equal(r.needsSelection,true);assert.equal(r.candidates.length,2);});
test('无法核验的同优先级入口保留歧义，不能用成功的那一个替代',async()=>{const f=fake({[A]:{abi:['function mintFree()']}});const r=await classifyAddresses(f.rpc,[A,B].map(a=>({address:a,priority:3,source:'x',field:'minter'})),f.loader);assert.equal(r.address,null);});
test('完整网页识别不执行脚本、不截断 bytes32，只保留地址证据',async()=>{const f=fake({[A]:{abi:[...erc20,'function mintFree()']}});const fetchText=async u=>u.endsWith('config.js')?`window.other_name={COIN:'${A}'}; throw new Error('never execute');`:`<p>hash 0x${'a'.repeat(64)}</p>`;const r=await discover('https://unknown-brand.example/',{rpc:f.rpc,fetchText,sourceLoader:f.loader});assert.equal(r.address,A);assert.equal(r.addresses.length,1);assert.equal(f.writes(),0);});
test('独立部署配置识别六类角色，不是六个等价 Mint 候选',()=>{const text=JSON.stringify({TOKEN:A,REGISTRY:REG,TREASURY:B,ORACLE:C,ART:'0x'+'44'.repeat(20),MULTICALL:'0x'+'55'.repeat(20)});const r=mergeCandidates(extractCandidates(text,'https://moomoo.cloud/bnbull/config.js'));assert.equal(r.length,6);for(const role of ['token','registry','treasury','oracle','art','multicall'])assert.ok(r.some(x=>x.roles.includes(role)),role);});

test('陌生变量名位于外部脚本中，仍能通过 ABI 找出入口',async()=>{const f=fake({[A]:{abi:['function mintFounding(bytes32 proof)']}});const fetchText=async u=>u==='https://new-brand.example/'?'<script src="app.js"></script>':u.endsWith('app.js')?`const SOMETHING_UNUSUAL="${A}";`:' ';const r=await discover('https://new-brand.example/',{rpc:f.rpc,fetchText,sourceLoader:f.loader});assert.equal(r.address,A);assert.equal(f.writes(),0);});
test('只允许项目方调用的 mint 和 NFT 市场 buy 不冒充公众打新入口',async()=>{const f=fake({[A]:{abi:['function mint(address to,uint256 amount)',...erc20],sources:{'T.sol':{content:'pragma solidity ^0.8.0; contract T { modifier onlyMinter(){_;} function mint(address to,uint256 amount) external onlyMinter {} }'}}},[B]:{abi:['function buy(uint256 tokenId,uint256 price) payable']},[C]:{abi:['function mintFounding(bytes32 proof)']}});const r=await classifyAddresses(f.rpc,[{address:A,field:'token',roles:['token'],priority:1,source:'x'},{address:B,field:'market',roles:['market'],priority:0,source:'x'},{address:C,field:'city',roles:['mint'],priority:3,source:'x'}],f.loader);assert.equal(r.address,C);assert.equal(r.addresses.find(x=>x.address===A).verifiedRoles.includes('mint'),false);assert.equal(r.candidates.some(x=>x.address===B),false);});
test('自定义权限修饰器按源码区分发售入口与仅供内部调用的 NFT 铸造函数',async()=>{
 for(const modifier of ['onlySale','viaHatchery','projectGate'])for(const condition of ['require(msg.sender == sale, "not sale");','if (msg.sender != sale) revert NotSale();']){
  const f=fake({[A]:{abi:['function mintEgg(address to,uint8 gen)','function ownerOf(uint256) view returns(address)','function balanceOf(address) view returns(uint256)'],sources:{'Egg.sol':{content:`pragma solidity ^0.8.0; contract Egg { address sale; error NotSale(); modifier ${modifier}(){ ${condition} _; } function mintEgg(address to,uint8 gen) external ${modifier} {} }`}}},[B]:{abi:['function mint(uint256 count,uint256 maxPayable) payable']}});
  const r=await classifyAddresses(f.rpc,[{address:A,roles:['nft'],priority:3},{address:B,roles:['mint'],priority:3}],f.loader);assert.equal(r.address,B);assert.deepEqual(r.addresses.find(x=>x.address===A).verifiedRoles,['nft']);assert.equal(r.candidates.some(x=>x.address===A),false);
 }
 const f=fake({[A]:{abi:['function mint(uint256 count)'],sources:{'Public.sol':{content:'pragma solidity ^0.8.0; contract Public { bool open; modifier projectGate(){ require(open); _; } function mint(uint256 count) external projectGate {} }'}}}});
 assert.equal((await classifyAddresses(f.rpc,[{address:A,roles:['mint'],priority:3}],f.loader)).address,A);
});
test('adjacent Contract/Call hints resolve arbitrary branded mint contracts before generic sale labels',async()=>{
 const f=fake({[A]:{abi:['function freeMint()']},[B]:{abi:['function buy() payable']}});
 for(const brand of ['OilRig (AORIG)','Moon Hatchery','全新项目']){
  const html=`<script>const ADDR={opaque:'${A}',sale:'${B}'};</script><pre>\nContract: ${brand} ${A}\nCall: freeMint() — value 0\n</pre>`;
  const r=await discover('https://unseen-brand.example/',{rpc:f.rpc,sourceLoader:f.loader,fetchText:async u=>u.endsWith('/')?html:''});assert.equal(r.address,A);assert.ok(r.addresses.find(r=>r.address===A).evidence.some(e=>e.kind==='documented-call'));assert.equal(f.writes(),0);
 }
});
test('documented methods must match deployed ABI; duplicate current mint declarations remain ambiguous',async()=>{
 const f=fake({[A]:{abi:['function freeMint()']},[B]:{abi:['function buy() payable']}});
 const html=`<script>const mintContract='${A}';</script>\nContract: False Hint ${B}\nCall: freeMint()\n`;
 const r=await discover('https://mismatch.example/',{rpc:f.rpc,sourceLoader:f.loader,fetchText:async u=>u.endsWith('/')?html:''});assert.equal(r.address,A);assert.equal(r.addresses.find(r=>r.address===B).priority,0);
 const g=fake({[A]:{abi:['function freeMint()']},[B]:{abi:['function freeMint()']}});
 const doc=`\nContract: Product One ${A}\nCall: freeMint()\nContract: Product Two ${B}\nCall: freeMint()\n`;
 const both=await discover('https://two-new-products.example/',{rpc:g.rpc,sourceLoader:g.loader,fetchText:async u=>u.endsWith('/')?doc:''});assert.equal(both.address,null);assert.equal(both.needsSelection,true);
 assert.equal(extractCandidates(`\nContract: ${A}\nToken: ${B}\nCall: freeMint()`, 'https://boundaries.example/').some(r=>r.method),false);
});

test('adjacent visible labels distinguish mint, token, treasury and router across unseen hosts, order and aliases',async()=>{
 const D='0x4444444444444444444444444444444444444444';
 for(const host of ['never-seen.example','new.sale.example'])for(const labels of [['铸造合约','代币合约','金库地址','Router'],['Mint Contract','Token CA','Treasury','交易路由']])for(const reverse of [false,true]){
  const blocks=[[labels[0],A],[labels[1],B],[labels[2],C],[labels[3],D]];if(reverse)blocks.reverse();
  for(const footer of [false,true]){
   const html=blocks.map(([label,a])=>footer?`<span class="footer-title">${label}</span><code>${a}</code><div><a href="https://bscscan.com/address/${a}">BscScan</a></div>`:`<div class="contract"><span>${label}</span><a href="https://bscscan.com/address/${a}"><code>${a.slice(0,8)}…</code><span>BscScan</span></a><button data-copy="${a}">复制</button></div>`).join('');
   const rows=mergeCandidates(extractCandidates(`<footer>${html}</footer>`,'https://'+host+'/'));
   assert.deepEqual(rows.find(r=>r.address===A).roles,['mint']);assert.deepEqual(rows.find(r=>r.address===B).roles,['token']);assert.deepEqual(rows.find(r=>r.address===C).roles,['treasury']);assert.deepEqual(rows.find(r=>r.address===D).roles,['router']);
   const f=fake({[A]:{abi:['function mint(uint256 quantity,address referrer) payable']},[B]:{abi:erc20},[C]:{eoa:true},[D]:{abi:[]}});
   assert.equal((await classifyAddresses(f.rpc,rows.flatMap(r=>r.hints.map(h=>({...h,address:r.address}))),f.loader)).address,A);
  }
 }
});
test('unsupported but explicitly labelled minter must not silently fall back to the token',async()=>{
 const f=fake({[A]:{abi:['function join(bytes proof)']},[B]:{abi:erc20}}),rows=extractCandidates(`<div><span>铸造合约</span><code>${A}</code><span>代币合约</span><code>${B}</code></div>`,'https://unseen.example/');
 const r=await classifyAddresses(f.rpc,rows,f.loader);assert.equal(r.address,null);assert.equal(r.needsSelection,true);
});
test('HTML labels do not span multiple candidate addresses, scripts or unrelated sections',()=>{
 const html=`<label>Mint contract</label><div>${A} ${B}</div><section><span>说明</span><code>${C}</code></section><script>const x='${B}'; const label='Mint contract';</script>`;
 const rows=extractCandidates(html,'https://unseen.example/');assert.equal(rows.some(r=>r.roles.includes('mint')),false);
});
test('runtime mint(quantity,address) selector resolves the minter without scanning token transfer history',async()=>{
 const iface=new Interface(['function mint(uint256,address)','function referrerOf(address) view returns(address)']),code='0x'+iface.fragments.map(f=>'63'+f.selector.slice(2)+'1461000057').join('');
 const f=fake({[B]:{abi:erc20}}),rpc={...f.rpc,getCode:async a=>a===A?code:f.rpc.getCode(a)},loader=async(r,a)=>a===A?{address:A,runtimeCode:code,verified:false}:f.loader(r,a);let history=0;
 const result=await discover('https://brand-new.example/',{rpc,sourceLoader:loader,chainFallback:true,chainLearner:{learn:async()=>{history++;throw Error('wrong fallback');}},fetchText:async url=>url.endsWith('/')?`<div><span>Mint Contract</span><a href="https://bscscan.com/address/${A}">BscScan</a></div><div><span>Token Contract</span><code>${B}</code></div>`:''});
 assert.equal(result.address,A);assert.equal(history,0);
});
