import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {Interface,keccak256,toUtf8Bytes} from 'ethers';
import {recognizeHandleMint,handleMintState,handleMintPlan} from '../lib/handle-mint.mjs';
import {runtimeShape,executableBytes} from '../lib/bytecode.mjs';
import {bindings,BNB} from '../lib/common.mjs';
import {discover} from '../lib/discovery.mjs';
import {verifyPreview} from '../lib/engine.mjs';
const actual=JSON.parse(fs.readFileSync(new URL('./fixtures/handle-nft-runtime.json',import.meta.url)));
const registry='0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F',w=bindings()[0],profile=recognizeHandleMint(actual),abi=new Interface(profile.abi);
const intent={account:w.account,scope:'free',quantity:'max',maxBnb:'0',referral:'account1'};
function fixture(){
 const state={freeMinted:12n,paidMinted:999n,usedFree:false,usedPaid:0n,owner:w.address,eligibilityMismatch:false,underpay:false,reads:[],txs:[]};
 const id=keccak256(toUtf8Bytes('agent-example'));
 const price=n=>{const first=n<1000n-state.paidMinted?n:1000n-state.paidMinted;return first*500000000000000n+(n-first)*1000000000000000n;};
 const rpc={getBlockNumber:async()=>123,verifyChain:async()=>{},getCode:async()=>actual.runtimeCode,call:async tx=>{
  if(tx.to.toLowerCase()===registry.toLowerCase())return new Interface(['function ownerOf(uint256) view returns(address)']).encodeFunctionResult('ownerOf',[state.owner]);
  const f=abi.parseTransaction({data:tx.data});if(!f)throw Error('Unexpected call');
  state.reads.push(f.name);
  if(['claimFree','paidMint'].includes(f.name)){
   state.txs.push({f,value:BigInt(tx.value||0)});
   if(f.name==='claimFree'){assert.equal(f.args[0],'agent-example');assert.equal(BigInt(tx.value||0),0n);}
   else {assert.equal(f.args[1],'agent-example');if(BigInt(tx.value)<price(f.args[0])&&!state.underpay)throw Object.assign(Error('execution reverted: underpayment'),{executionError:true});}
   return '0x';
  }
  const result={REGISTRY:[registry],supportsInterface:[true],FREE_CAP:[1000n],PAID_CAP:[4000n],freeMinted:[state.freeMinted],paidMinted:[state.paidMinted],MAX_PAID_PER_ID:[20n],MAX_SUPPLY:[5000n],totalSupply:[state.freeMinted+state.paidMinted],freeUsed:[state.usedFree],paidUsed:[state.usedPaid],eligibility:[id,state.eligibilityMismatch?4n:!state.usedFree&&state.freeMinted<1000n?1n:0n,20n-state.usedPaid],quote:[f.name==='quote'?price(f.args[0]):0n],balanceOf:[0n],ownerOf:[w.address]}[f.name];
  if(!result)throw Error('Unexpected '+f.name);
  return abi.encodeFunctionResult(f.name,result);
 }};
 const bridge={call:async(account,args)=>{assert.equal(account,w.account);assert.deepEqual(args,['wallet','agent-id']);return {domain:'agent-example.ai'};}};
 return {state,rpc,bridge};
}
test('编译器元数据哈希中的 F4 不视为代理，真实 DELEGATECALL 仍拒绝',()=>{
 assert.equal(runtimeShape(actual.runtimeCode).delegate,false);
 assert.equal(executableBytes(actual.runtimeCode).length,(actual.runtimeCode.length-2)/2-53);
 const bad='0xf4'+actual.runtimeCode.slice(2);assert.equal(runtimeShape(bad).delegate,true);assert.equal(recognizeHandleMint({...actual,runtimeCode:bad}),null);
 const malformed=actual.runtimeCode.slice(0,-4)+'ffff';assert.equal(executableBytes(malformed).length,(malformed.length-2)/2);assert.equal(runtimeShape(malformed).delegate,true);
 const jumpable=actual.runtimeCode.replace('1220aff4','12205bf4');assert.equal(executableBytes(jumpable).length,(jumpable.length-2)/2);assert.equal(runtimeShape(jumpable).delegate,true);
 assert.equal(runtimeShape('0x63f400000000').delegate,false);
});
test('字符串身份接口按方法组合匹配，支持别名和字符串参数顺序，不绑定域名或 CA',()=>{
 const variants=profile.abi.map(s=>s.replace('claimFree(string)','mintFree(string)').replace('paidMint(uint256,string)','mintPaid(string,uint256)').replace('REGISTRY()','agentRegistry()'));
 const code='0x'+new Interface(variants).fragments.map(f=>'63'+f.selector.slice(2)+'1461000057').join('')+'00';
 const found=recognizeHandleMint({...actual,address:'0x'+'ab'.repeat(20),runtimeCode:code});assert.ok(found);assert.equal(found.methods.paid,'mintPaid(string,uint256)');
 assert.equal(recognizeHandleMint({...actual,runtimeCode:'0x'+code.slice(12)}),null);
});
test('陌生变量 C 的另一网站可识别 NFT Mint，不要求手动猜地址',async()=>{
 const f=fixture();const r=await discover('https://future-robots.example/',{rpc:f.rpc,sourceLoader:async()=>actual,fetchText:async url=>url==='https://future-robots.example/'?`<title>Future robots</title><script>const C="${actual.address}"</script>`:''});
 assert.equal(r.address.toLowerCase(),actual.address.toLowerCase());assert.ok(r.addresses[0].verifiedRoles.includes('mint'));assert.ok(r.addresses[0].verifiedRoles.includes('nft'));
});
test('免费、付费、全部分别构造；跨价格阶梯使用合约总报价',async()=>{
 const f=fixture(),budget=100000000000000000n;
 const free=await handleMintPlan(f.rpc,f.bridge,intent,actual,0n,w,{});assert.equal(free.quantity,1);assert.equal(free.amountIn,'0');assert.equal(free.fill.continue,false);assert.equal(abi.parseTransaction({data:free.steps[0].data}).name,'claimFree');
 const paid=await handleMintPlan(f.rpc,f.bridge,{...intent,scope:'paid'},actual,budget,w,{});assert.equal(paid.quantity,20);assert.equal(paid.amountIn,'19500000000000000');assert.equal(abi.parseTransaction({data:paid.steps[0].data}).name,'paidMint');
 const all=await handleMintPlan(f.rpc,f.bridge,{...intent,scope:'all'},actual,budget,w,{});assert.equal(all.quantity,1);assert.equal(all.fill.continue,true);
 f.state.usedFree=true;f.state.freeMinted++;
 const next=await handleMintPlan(f.rpc,f.bridge,{...intent,scope:'all'},actual,budget,w,{});assert.equal(next.quantity,20);assert.equal(next.fill.continue,false);
});
test('全局免费售罄时明确零额度，只打免费不能落入付费；付费仍受预算限制',async()=>{
 const f=fixture();f.state.freeMinted=1000n;
 const s=await handleMintState(f.rpc,f.bridge,intent,actual,w);assert.equal(s.info.freeRemaining,'0');assert.equal(s.info.paidRemaining,'20');assert.match(s.notes.join(' '),/免费名额已用完/);
 await assert.rejects(handleMintPlan(f.rpc,f.bridge,intent,actual,10000000000000000n,w,{}),e=>e.code==='NO_QUOTA');assert.equal(f.state.txs.length,0);
 const paid=await handleMintPlan(f.rpc,f.bridge,{...intent,scope:'paid'},actual,1600000000000000n,w,{});assert.equal(paid.quantity,2);assert.equal(paid.amountIn,'1500000000000000');
});
test('所有权、eligibility 或付款无法交叉核验时不构造交易',async()=>{
 const f=fixture();f.state.owner='0x'+'a7'.repeat(20);await assert.rejects(handleMintState(f.rpc,f.bridge,intent,actual,w),/所有者/);
 f.state.owner=w.address;f.state.eligibilityMismatch=true;await assert.rejects(handleMintState(f.rpc,f.bridge,intent,actual,w),/独立额度查询不一致/);
 f.state.eligibilityMismatch=false;f.state.underpay=true;await assert.rejects(handleMintPlan(f.rpc,f.bridge,{...intent,scope:'paid',quantity:1},actual,10000000000000000n,w,{}),/少付 1 wei/);
});
test('官方预览必须证明不同 NFT 足额到账，不能用同地址 ERC20 或重复 tokenId 代替',()=>{
 const plan={wallet:w.address,inputToken:BNB,outputToken:actual.address,amountIn:'0',minOutput:'2',requireNftCredit:true},step={kind:'mint',value:'0'};
 const credit={owner:w.address,contractAddress:actual.address,change:1,tokenType:'Erc721',tokenId:'0x01'};
 const p=rows=>({requestId:'mock',simulationResult:{simulationCode:'000000000',balanceChanges:rows}});
 assert.throws(()=>verifyPreview(p([{...credit,tokenType:'Erc20',change:2}]),plan,step),/NFT 足额/);
 assert.throws(()=>verifyPreview(p([credit,credit]),plan,step),/NFT 足额/);
 assert.doesNotThrow(()=>verifyPreview(p([credit,{...credit,tokenId:'0x02'}]),plan,step));
});
