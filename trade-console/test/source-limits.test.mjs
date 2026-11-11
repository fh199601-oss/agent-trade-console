import test from 'node:test';import assert from 'node:assert/strict';
import {Interface,keccak256} from 'ethers';
import {sourceLimitPrograms,evaluateSourceLimits} from '../lib/source-limits.mjs';
import {recognizeMint} from '../lib/adaptive-mint.mjs';import {mintPlan} from '../lib/mint.mjs';import {bindings} from '../lib/common.mjs';
import {createMintQuantityControl} from '../public/mint-quantity.mjs';
const address='0x'+'7'.repeat(40),wallet='0x'+'8'.repeat(40);
const source=`contract NewProject {
 function freeMint(address referrer) external {
  require(!tradingOpen, "sale closed"); require(freeUsed < FREE_COUNT, "free sold out");
  require(!taken[msg.sender], "free already claimed"); freeUsed += 1; taken[msg.sender] = true; _bind(msg.sender,referrer);
 }
 function mint(uint256 shares, address referrer) external payable {
  require(shares > 0); require(paidUsed + shares <= PAID_COUNT, "sold out");
  require(mintedBy[msg.sender] + shares <= BASE_QUOTA + invites[msg.sender], "quota exceeded");
  require(msg.value == shares * SHARE_PRICE); mintedBy[msg.sender] += shares; paidUsed += shares; _bind(msg.sender,referrer);
 }
}`;
const specs=['function freeMint(address referrer)','function mint(uint256 shares,address referrer) payable','function tradingOpen() view returns(bool)','function freeUsed() view returns(uint256)','function FREE_COUNT() view returns(uint256)','function taken(address) view returns(bool)','function paidUsed() view returns(uint256)','function PAID_COUNT() view returns(uint256)','function BASE_QUOTA() view returns(uint256)','function invites(address) view returns(uint256)','function mintedBy(address) view returns(uint256)','function SHARE_PRICE() view returns(uint256)','function TOKENS_PER_SHARE() view returns(uint256)','function decimals() view returns(uint8)','function balanceOf(address) view returns(uint256)'];
function fixture(rename=false){
 const change=s=>rename?s.replaceAll('mintedBy','alreadyTaken').replaceAll('BASE_QUOTA','tierSize').replaceAll('invites','bonusSlots').replaceAll('paidUsed','issuedTickets').replaceAll('PAID_COUNT','saleSize'):s;
 const iface=new Interface(specs.map(change)),runtimeCode='0x'+iface.fragments.map(f=>'63'+f.selector.slice(2)+'14600057').join('')+'00',meta={address,verified:true,abi:JSON.parse(iface.formatJson()),runtimeCode,hash:keccak256(runtimeCode),identity:{target:address,fingerprint:'synthetic'},sources:{source:{content:change(source)}}};
 const s={used:2n,bonus:3n,paidUsed:4n,paidCap:100n,freeUsed:1n,taken:false,failRead:false},seen=[];
 const rpc={getBlockNumber:async()=>123,send:async(method,args)=>{
  if(method==='eth_getBlockByNumber')return {timestamp:'0x64'};
  if(method==='eth_estimateGas')return '0x20000';assert.equal(method,'eth_call');assert.equal(args[1],'0x7b');
  const tx=args[0],f=iface.parseTransaction(tx);seen.push(f.name);
  if(f.name==='mint'||f.name==='freeMint'){
   const n=f.name==='mint'?f.args[0]:1n;assert.equal(f.args[f.name==='mint'?1:0],'0x'+'0'.repeat(40));
   if(f.name==='mint'&&(n>10n+s.bonus-s.used||n>s.paidCap-s.paidUsed||BigInt(tx.value)!==n*10n)||f.name==='freeMint'&&(s.freeUsed>=5n||s.taken||BigInt(tx.value)!==0n))throw Object.assign(Error('execution reverted'),{executionError:true});return '0x';
  }
  const values={tradingOpen:false,freeUsed:s.freeUsed,FREE_COUNT:5n,taken:s.taken,paidUsed:s.paidUsed,PAID_COUNT:s.paidCap,BASE_QUOTA:10n,invites:s.bonus,mintedBy:s.used,SHARE_PRICE:10n,TOKENS_PER_SHARE:1000n,decimals:18n,balanceOf:0n};
  const key=Object.keys(values).find(k=>change(k)===f.name);assert.ok(key,f.name);if(s.failRead&&key==='invites')throw Error('RPC unavailable');return iface.encodeFunctionResult(f.fragment,[values[key]]);
 }};rpc.call=tx=>rpc.send('eth_call',[tx,'0x7b']);
 const plan=i=>mintPlan(rpc,{call:()=>assert.fail('no wallet invocation')},{account:bindings()[0].account,side:'mint',asset:address,scope:'paid',quantity:'max',maxBnb:'0.0000000000000002',referral:'none',...i},address,{source:'https://never-seen.example/'},null,{sourceLoader:async()=>meta,chainLearner:{learn:()=>assert.fail('no history lookup')}});
 return {iface,meta,s,seen,plan};
}
test('remaining allowance comes from source guards, including invitation bonus and current usage, independent of names',async()=>{
 for(const renamed of [false,true]){const f=fixture(renamed),p=await f.plan();assert.equal(p.quantity,11);assert.equal(p.amountIn,'110');assert.equal(p.quota.limits.walletRemaining,11);assert.equal(p.quota.limits.publicRemaining,96);assert.equal(f.seen.filter(n=>n==='mint').length,4,'one-unit + full-bound simulation and one-wei underpayment only');}
});
test('explicit paid quantity is kept and an exhausted free lane advances to paid under the same all-scope budget',async()=>{
 const f=fixture();const manual=await f.plan({quantity:3});assert.equal(manual.quantity,3);assert.equal(manual.amountIn,'30');
 f.s.freeUsed=5n;const all=await f.plan({scope:'all'});assert.equal(all.quantity,11);assert.equal(all.route,'mint:mint(uint256,address)');
 await assert.rejects(f.plan({scope:'free',maxBnb:'0'}),e=>e.code==='NO_QUOTA');
});
test('free caller status, wallet quota, project stock and budget remain distinct; no credit or quota is invented',async()=>{
 const f=fixture(),free=await f.plan({scope:'free',maxBnb:'0'});assert.equal(free.quantity,1);assert.equal(free.amountIn,'0');
 f.s.taken=true;await assert.rejects(f.plan({scope:'free',maxBnb:'0'}),e=>e.code==='NO_QUOTA');
 const small=await f.plan({maxBnb:'0.000000000000000035'});assert.equal(small.quantity,3);assert.equal(small.amountIn,'30');
 f.s.paidUsed=99n;assert.equal((await f.plan()).quantity,1);
 f.s.paidUsed=100n;await assert.rejects(f.plan(),e=>e.code==='NO_QUOTA'&&/库存/.test(e.message));
 f.s.paidUsed=4n;f.s.used=13n;await assert.rejects(f.plan(),e=>e.code==='NO_QUOTA'&&/钱包/.test(e.message));
});
test('RPC failures in proven allowance never become zero quota or guessed paid max',async()=>{
 const f=fixture();f.s.failRead=true;await assert.rejects(f.plan(),/RPC unavailable/);
});
test('source quota extraction rejects unverified, proxy, ambiguous methods and pre-guard writes',()=>{
 const f=fixture(),frag=f.iface.getFunction('mint'),roles=['quantity','zero'];
 for(const m of [{...f.meta,verified:false},{...f.meta,proxy:true},{...f.meta,identity:{implementation:address}},{...f.meta,sources:{a:{content:source},b:{content:source}}}])assert.deepEqual(sourceLimitPrograms(m,frag,roles),[]);
 for(const edit of ['refresh();','if(flag) mintedBy[msg.sender] = 0;','shares = 1;','oracle.touch();']){
  const changed=source.replace('require(shares > 0);',edit+'require(shares > 0);');assert.deepEqual(sourceLimitPrograms({...f.meta,sources:{a:{content:changed}}},frag,roles),[],edit);
 }
});
test('strict guards, aliases, caller-dependent view reads and reversed inequalities derive exact integer bounds',async()=>{
 const abi=new Interface(['function mint(uint256 amount) payable','function capacity() view returns(uint256)','function used(address) view returns(uint256)']);
 for(const guard of ['used[msg.sender] + amount < capacity','capacity > amount + used[msg.sender]','capacity >= (amount + used[msg.sender])']){
  const m={verified:true,abi:JSON.parse(abi.formatJson()),sources:{a:{content:`contract Future {function mint(uint256 amount) external payable {require(${guard});}}`}}};
  const programs=sourceLimitPrograms(m,abi.getFunction('mint'),['quantity']);assert.equal(programs.length,1);
  const result=await evaluateSourceLimits(programs,{wallet,read:async(method,args)=>method==='capacity()'?[10n]:(assert.deepEqual(args,[wallet]),[3n])});assert.equal(result[0].remaining,guard.includes('>=')?7n:6n);
 }
});
test('quantity on both sides, nonlinear quantity and unknown functions do not masquerade as allowance',()=>{
 const f=fixture(),frag=f.iface.getFunction('mint');for(const guard of ['shares <= shares + BASE_QUOTA','shares * shares <= BASE_QUOTA','shares <= oracle.limit(msg.sender)','shares <= block.timestamp']){
  const m={...f.meta,sources:{a:{content:`contract Future {function mint(uint256 shares,address referrer) external payable {require(${guard});}}`}}};assert.deepEqual(sourceLimitPrograms(m,frag,['quantity','zero']),[]);
 }
});
test('the manual-count recovery switches out of max and sends actual numeric text while free/all remain automatic',()=>{
 const elements=new Map(['quantity','mintMax','scope'].map(id=>[id,{value:id==='scope'?'all':'',handlers:{},addEventListener(e,f){this.handlers[e]=f;},setAttribute(){},focus(){this.focused=true;},select(){this.selected=true;}}]));
 const c=createMintQuantityControl({document:{getElementById:id=>elements.get(id)}}),q=elements.get('quantity'),scope=elements.get('scope');assert.equal(c.value(),'max');c.usePaidCount();assert.equal(scope.value,'paid');assert.equal(q.disabled,false);assert.equal(q.focused,true);q.value='3';q.handlers.input();assert.equal(c.value(),'3');q.value='MAX';q.handlers.blur();assert.equal(c.value(),'max');scope.value='free';scope.handlers.change();assert.equal(c.value(),'max');
});
