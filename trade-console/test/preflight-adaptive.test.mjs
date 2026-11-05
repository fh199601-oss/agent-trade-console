import test from 'node:test';import assert from 'node:assert/strict';import {Interface} from 'ethers';
import {recognizeMint,adaptiveQuote} from '../lib/adaptive-mint.mjs';
import {profiled,snapshot} from '../lib/diagnostics.mjs';
const target='0x'+'1'.repeat(40),wallet={account:1,address:'0x'+'2'.repeat(40)},token='0x'+'3'.repeat(40),block={tag:'0x123',number:291,timestamp:100};
function fixture(priceName='cost'){
 const iface=new Interface(['function mint(uint256 quantity) payable',`function ${priceName}() view returns(uint256)`,'function isPaused() view returns(bool)','function publicSaleActive() view returns(bool)','function canMint(address) view returns(bool)','function maxMintPerWallet() view returns(uint256)','function mintedBy(address) view returns(uint256)','function remaining() view returns(uint256)','function MAX_PER_TX() view returns(uint256)','function tokensPerMint() view returns(uint256)','function token() view returns(address)']);
 const meta={address:target,verified:true,abi:JSON.parse(iface.formatJson()),sources:{a:{content:'contract Mint { function mint(uint256 quantity) external payable { require(quantity > 0); } }'}}};
 let fee=10n,eligible=true,paused=false,active=0,maxActive=0;const calls=[];
 const rpc=async(method,params)=>{calls.push([method,params]);if(method==='eth_estimateGas')return '0x186a0';assert.equal(params[1],block.tag);const f=iface.parseTransaction(params[0]);if(f.name==='mint'){if(BigInt(params[0].value)!==fee*f.args[0])throw Object.assign(Error('execution reverted: exact fee'),{executionError:true});return '0x';}
  active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setImmediate(resolve));active--;
  const values={[priceName]:fee,isPaused:paused,publicSaleActive:true,canMint:eligible,maxMintPerWallet:8n,mintedBy:3n,remaining:100n,MAX_PER_TX:10n,tokensPerMint:1000n,token};return iface.encodeFunctionResult(f.name,[values[f.name]]);
 };
 return {meta,rpc,calls,setFee:v=>fee=v,setEligible:v=>eligible=v,setPaused:v=>paused=v,maxActive:()=>maxActive};
}
test('common cost/mintFee/nextPrice aliases quote current fees and parallelize independent state at one block',async()=>{
 for(const name of ['cost','mintFee','nextPrice']){
  const f=fixture(name),recognized=recognizeMint(f.meta);assert.equal(recognized.routes.length,1);
  const result=await profiled('quote',async()=>{const q=await adaptiveQuote(f.meta,recognized.routes[0],wallet,2,block,f.rpc);return {q,timings:snapshot()};});
  assert.equal(result.q.total.raw,'20');assert.equal(result.q.limits.walletRemaining,5);assert.equal(result.q.expectedAsset.amount,'2000');assert.equal(result.q.available,true);assert.ok(f.maxActive()>=6);assert.ok(result.timings.stages.mintQuoteAndSimulation);
  f.setFee(17n);const fresh=await adaptiveQuote(f.meta,recognized.routes[0],wallet,2,block,f.rpc);assert.equal(fresh.total.raw,'34');
 }
});
test('canMint false or isPaused true prevents a successful generic plan',async()=>{
 const f=fixture(),route=recognizeMint(f.meta).routes[0];f.setEligible(false);await assert.rejects(adaptiveQuote(f.meta,route,wallet,1,block,f.rpc),e=>e.code==='MINT_INELIGIBLE'&&/资格/.test(e.message));
 f.setEligible(true);f.setPaused(true);await assert.rejects(adaptiveQuote(f.meta,route,wallet,1,block,f.rpc),e=>e.code==='MINT_PAUSED'&&/暂停/.test(e.message));
 assert.equal(f.calls.some(([m])=>m==='eth_estimateGas'),false);
});
test('wrong ABI return types and reward registration methods are not accepted as payable mint pricing',()=>{
 const f=fixture();f.meta.abi=f.meta.abi.map(x=>x.name==='cost'?{...x,outputs:[{type:'address',name:''}]}:x);assert.equal(recognizeMint(f.meta).routes.length,0);
 const reward={verified:true,abi:JSON.parse(new Interface(['function registerForRewards()','function claim()']).formatJson()),sources:{}};assert.equal(recognizeMint(reward).routes.length,0);
});
test('unrelated tuple initializers and observed tuple calls do not crash ordinary mint discovery',()=>{
 const f=fixture();f.meta.abi.push(...JSON.parse(new Interface(['function initialize(tuple(address owner,uint256 value) config)','function special(tuple(address to,bytes proof)[] claims)']).formatJson()));
 assert.equal(recognizeMint(f.meta).routes.length,1);const iface=new Interface(f.meta.abi);assert.equal(recognizeMint(f.meta,{observedSelectors:[iface.getFunction('special').selector]}).routes.length,1);
});
test('mintedPerWallet counter limits max quantity and updates after previous mints',async()=>{
 const f=fixture();f.meta.abi=f.meta.abi.map(x=>x.name==='mintedBy'?{...x,name:'mintedPerWallet'}:x);const iface=new Interface(f.meta.abi),old=new Interface(fixture().meta.abi),rpc=async(m,p)=>{
  if(m==='eth_call'&&p[0].data.startsWith(iface.getFunction('mintedPerWallet').selector))return iface.encodeFunctionResult('mintedPerWallet',[6n]);return f.rpc(m,p);
 };const route=recognizeMint(f.meta).routes[0],q=await adaptiveQuote(f.meta,route,wallet,2,block,rpc);assert.equal(q.limits.walletRemaining,2);assert.equal(q.available,true);
});
test('separate free supply and claimed boolean do not consume the paid lane quota',async()=>{
 const iface=new Interface(['function freeMint()','function paidMint() payable','function freeOpen() view returns(bool)','function freeClaimed(address) view returns(bool)','function FREE_SUPPLY() view returns(uint256)','function freeMinted() view returns(uint256)','function PAID_SUPPLY() view returns(uint256)','function paidMinted() view returns(uint256)','function PAID_PRICE() view returns(uint256)','function ownerOf(uint256) view returns(address)']);
 const meta={address:target,verified:true,abi:JSON.parse(iface.formatJson()),sources:{}},routes=recognizeMint(meta).routes;let claimed=false;
 const rpc=async(m,p)=>{if(m==='eth_estimateGas')return '0x10000';const f=iface.parseTransaction(p[0]);if(['freeMint','paidMint'].includes(f.name)){if(f.name==='paidMint'&&BigInt(p[0].value)<5n)throw Object.assign(Error('revert: payment'),{executionError:true});return '0x';}return iface.encodeFunctionResult(f.name,[{freeOpen:true,freeClaimed:claimed,FREE_SUPPLY:100n,freeMinted:99n,PAID_SUPPLY:500n,paidMinted:30n,PAID_PRICE:5n}[f.name]]);};
 const free=routes.find(r=>r.lane==='free'),paid=routes.find(r=>r.lane==='paid');const q=await adaptiveQuote(meta,free,wallet,1,block,rpc);assert.equal(q.limits.walletRemaining,1);assert.equal(q.limits.publicRemaining,1);claimed=true;
 await assert.rejects(adaptiveQuote(meta,free,wallet,1,block,rpc),e=>e.code==='NO_QUOTA');const p=await adaptiveQuote(meta,paid,wallet,1,block,rpc);assert.equal(p.limits.walletRemaining,null);assert.equal(p.limits.publicRemaining,470);assert.equal(p.total.raw,'5');
});
