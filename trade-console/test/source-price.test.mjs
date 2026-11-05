import test from 'node:test';import assert from 'node:assert/strict';import {Interface} from 'ethers';
import {nativePriceProgram,evaluateNativePrice} from '../lib/source-price.mjs';
import {recognizeMint,adaptiveQuote} from '../lib/adaptive-mint.mjs';
const source=`contract Example {
 function mintWithBNB() external payable { (uint256 identity, uint256 dollars) = _before(); uint256 cost = quoteBNB(dollars); if(msg.value < cost) revert NotEnough(); }
 function _before() private view returns(uint256 key,uint256 rate) { if(!mintOpen) revert Closed(); key = agentTokenOf(msg.sender); rate = nextPrice(key); }
}`;
const abi=new Interface(['function mintWithBNB() payable','function agentTokenOf(address) view returns(uint256)','function nextPrice(uint256) view returns(uint256)','function quoteBNB(uint256 usd18) view returns(uint256)','function mintOpen() view returns(bool)','function ownerOf(uint256) view returns(address)']),wallet='0x'+'1'.repeat(40),meta={address:'0x'+'2'.repeat(40),verified:true,abi:JSON.parse(abi.formatJson()),sources:{a:{content:source}}};
test('verified native pricing composes wallet identity, USD tier and current native conversion instead of using quantity as USD',async()=>{
 const program=nativePriceProgram(meta,abi.getFunction('mintWithBNB')),reads=[];
 let tier=2000000000000000000n;const read=async(method,args)=>{reads.push([method,args]);if(method.startsWith('agentTokenOf')){assert.equal(args[0],wallet);return [25n];}if(method.startsWith('nextPrice')){assert.equal(args[0],25n);return [tier];}if(method.startsWith('quoteBNB')){assert.equal(args[0],tier);return [tier/700n];}throw Error(method);};
 assert.equal(await evaluateNativePrice(program,{wallet,quantity:1,read}),tier/700n);tier=3000000000000000000n;assert.equal(await evaluateNativePrice(program,{wallet,quantity:1,read}),tier/700n);assert.equal(reads.length,6);
 const route=recognizeMint(meta).routes[0];const q=await adaptiveQuote(meta,route,{address:wallet},1,{tag:'0x1',timestamp:1},async(method,p)=>{
  if(method==='eth_estimateGas')return '0x10000';const f=abi.parseTransaction(p[0]);if(f.name==='mintWithBNB'){if(BigInt(p[0].value)!==tier/700n)throw Object.assign(Error('execution reverted'),{executionError:true});return '0x';}
  return abi.encodeFunctionResult(f.fragment,f.name==='mintOpen'?[true]:await read(f.fragment.format('sighash'),Array.from(f.args)));
 });assert.equal(q.available,true);assert.equal(q.total.raw,String(tier/700n));
});
test('frontend-only source, unknown external calls, conditional mutation and overwritten costs cannot bind a price',()=>{
 assert.equal(nativePriceProgram({...meta,verified:false},abi.getFunction('mintWithBNB')),null);
 for(const text of [source.replace('nextPrice(key)','oracle.nextPrice(key)'),source.replace('rate = nextPrice(key);','if (key > 0) rate = nextPrice(key);'),source.replace('if(msg.value < cost)','cost = 1; if(msg.value < cost)')])assert.equal(nativePriceProgram({...meta,sources:{a:{content:text}}},abi.getFunction('mintWithBNB')),null);
});
test('parentheses in a verified native payment formula preserve arithmetic instead of losing the route',async()=>{
 const a=new Interface(['function mint(uint256 quantity) payable','function price() view returns(uint256)']);
 const m={verified:true,abi:JSON.parse(a.formatJson()),sources:{a:{content:'contract Brand { function mint(uint256 quantity) external payable { uint256 due = (quantity * (price)); require(msg.value == (due)); } }'}}};
 const program=nativePriceProgram(m,a.getFunction('mint'));assert.ok(program);assert.equal(await evaluateNativePrice(program,{wallet,quantity:3,read:async method=>{assert.equal(method,'price()');return [7n];}}),21n);
});
