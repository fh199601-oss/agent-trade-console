import test from 'node:test';import assert from 'node:assert/strict';import {Interface,FunctionFragment} from 'ethers';
import {publishedAbiHints} from '../lib/abi-hints.mjs';import {recognizeMint,adaptiveQuote} from '../lib/adaptive-mint.mjs';
const dispatch=abi=>'0x'+abi.fragments.filter(f=>f.type==='function').map(f=>'63'+f.selector.slice(2)+'14600057').join('')+'00';
const address='0x'+'1'.repeat(40),wallet={account:1,address:'0x'+'2'.repeat(40)},block={number:42,tag:'0x2a',timestamp:100};
function fixture(){
 const iface=new Interface(['function mint(uint256 quantity) payable','function quote(address wallet,uint256 quantity) view returns(uint256 bnbCost,uint256 usdtCost,uint256 mintable)','function ownerOf(uint256) view returns(address)','function balanceOf(address) view returns(uint256)','function supportsInterface(bytes4) view returns(bool)','function isMintOpen() view returns(bool)']);
 const raw={address,verified:false,runtimeCode:dispatch(iface),abiHints:publishedAbiHints([{url:'https://new.invalid/config.json',text:iface.formatJson()}])},r=recognizeMint(raw),meta={...raw,abi:r.abi},calls=[];let opened=true,underpay=false;
 const rpc=async(m,p)=>{calls.push([m,p]);if(m==='eth_estimateGas')return '0x10000';const tx=iface.parseTransaction(p[0]);if(tx.name==='mint'){if(BigInt(p[0].value)!==tx.args[0]*11n&&!underpay)throw Object.assign(Error('revert: cost'),{executionError:true});return '0x';}return iface.encodeFunctionResult(tx.name,tx.name==='quote'?[tx.args[1]*11n,123n,4n]:[tx.name==='isMintOpen'?opened:true]);};
 return {raw,r,meta,rpc,calls,setOpen:v=>opened=v,setUnderpay:v=>underpay=v};
}
test('published JSON, inline and external JS ABI literals are data, never executable code',()=>{
 globalThis.abiHintsExecuted=false;const fn='function quote(address,uint256) view returns(uint256 bnbCost,uint256 usdtCost,uint256 mintable)';
 for(const row of [{url:'https://x.invalid/a.json',text:JSON.stringify({abi:[fn]})},{url:'https://x.invalid/a.js',text:`globalThis.abiHintsExecuted=true;const abi=[${JSON.stringify(fn)}];`},{url:'https://x.invalid/',text:`<script>const abi=[${JSON.stringify(fn)}];throw Error('not executed')</script>`}]){const result=publishedAbiHints([row]);assert.equal(result.length,1);assert.equal(result[0].outputs.length,3);}
 assert.equal(globalThis.abiHintsExecuted,false);delete globalThis.abiHintsExecuted;
});
test('conflicting published signatures are discarded; dynamic constructors and getters are not executed',()=>{
 const result=publishedAbiHints([{url:'https://x.invalid/a.js',text:`const a={type:'function',name:'quote',inputs:[{type:'uint256',name:'quantity'}],outputs:[{type:'uint256',name:'bnbCost'}],stateMutability:'view'};const b={...a,get name(){throw Error('executed')}};`},{url:'https://x.invalid/b.json',text:JSON.stringify(['function quote(uint256 quantity) view returns(uint256 usdtCost)'])}]);assert.equal(result.length,0);
});
test('unverified multi-field quote preserves runtime restrictions and exact native payment simulation',async()=>{
 const f=fixture();assert.equal(f.r.routes.length,1);assert.equal(f.r.routes[0].runtime,true);const q=await adaptiveQuote(f.meta,f.r.routes[0],wallet,2,block,f.rpc);assert.equal(q.total.raw,'22');assert.equal(q.expectedAsset.kind,'Erc721');assert.equal(q.recognition.level,'runtime');
 f.setUnderpay(true);await assert.rejects(adaptiveQuote(f.meta,f.r.routes[0],wallet,1,block,f.rpc),/少付 1 wei/);
});
test('frontend cannot introduce a write method or relabel a quantity as somebody else’s identity',()=>{
 const f=fixture();f.raw.abiHints.push(...JSON.parse(new Interface(['function destroy(address recipient)','function mint(uint256 agentTokenId)']).formatJson()));const r=recognizeMint(f.raw);assert.equal(r.routes.length,1);assert.deepEqual(r.routes[0].roles,['quantity']);assert.equal(r.routes.some(x=>x.method.startsWith('destroy')),false);
 const unknown={...f.raw,runtimeCode:'0x00'};assert.equal(recognizeMint(unknown).routes.length,0);
});
test('runtime zero-fee NFT candidate requires an NFT interface and still simulates the caller',async()=>{
 const abi=new Interface(['function mint(uint256 quantity)','function ownerOf(uint256) view returns(address)','function balanceOf(address) view returns(uint256)','function supportsInterface(bytes4) view returns(bool)']),raw={address,verified:false,runtimeCode:dispatch(abi),abiHints:JSON.parse(abi.formatJson())},r=recognizeMint(raw);assert.equal(r.routes.length,1);assert.equal(r.routes[0].zeroOnly,true);
 let accepted=false;const rpc=async(m,p)=>{if(m==='eth_estimateGas')return '0x10000';const t=abi.parseTransaction(p[0]);if(t.name==='supportsInterface')return abi.encodeFunctionResult(t.name,[true]);assert.equal(p[0].from,wallet.address);assert.equal(BigInt(p[0].value),0n);accepted=true;return '0x';};
 const q=await adaptiveQuote({...raw,abi:r.abi},r.routes[0],wallet,1,block,rpc);assert.equal(q.total.raw,'0');assert.equal(q.expectedAsset.amount,'1');assert.equal(accepted,true);
 const noNft=recognizeMint({address,verified:false,runtimeCode:dispatch(new Interface(['function mint(uint256) payable']))});assert.equal(noNft.routes.length,0);
});
test('closed-state failure is reported before quote decoding or gas estimation',async()=>{
 const f=fixture();f.setOpen(false);await assert.rejects(adaptiveQuote(f.meta,f.r.routes[0],wallet,1,block,f.rpc),e=>e.code==='MINT_NOT_OPEN');assert.equal(f.calls.some(([m,p])=>m==='eth_estimateGas'||p[0].data.startsWith(FunctionFragment.from('quote(address,uint256)').selector)),false);
});
test('unseen native price getter spellings require actual dispatch and exact payment, not just a website label',async()=>{
 for(const name of ['mintUnitPriceWei','unit_price_bnb']){
  const abi=new Interface(['function mint(uint256 quantity) payable',`function ${name}() view returns(uint256)`,'function supportsInterface(bytes4) view returns(bool)','function ownerOf(uint256) view returns(address)','function balanceOf(address) view returns(uint256)']);
  const raw={address,verified:false,runtimeCode:dispatch(abi),abiHints:JSON.parse(abi.formatJson())},r=recognizeMint(raw);assert.deepEqual(r.routes[0].units,[name+'()']);
  const rpc=async(m,p)=>{if(m==='eth_estimateGas')return '0x10000';const f=abi.parseTransaction(p[0]);if(f.name==='mint'){if(BigInt(p[0].value)!==3n*f.args[0])throw Object.assign(Error('execution reverted'),{executionError:true});return '0x';}return abi.encodeFunctionResult(f.fragment,[f.name===name?3n:true]);};
  assert.equal((await adaptiveQuote({...raw,abi:r.abi},r.routes[0],wallet,1,block,rpc)).total.raw,'3');
  raw.runtimeCode=dispatch(new Interface(abi.fragments.filter(f=>f.name!==name)));assert.equal(recognizeMint(raw).routes[0].units.length,0);
 }
 const abi=new Interface(['function mint(uint256) payable','function mintUnitPriceUSDT() view returns(uint256)']);const r=recognizeMint({address,verified:false,runtimeCode:dispatch(abi),abiHints:JSON.parse(abi.formatJson())});assert.equal(r.routes.length,0);
});
