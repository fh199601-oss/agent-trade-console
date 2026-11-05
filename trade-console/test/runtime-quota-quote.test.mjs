import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface,keccak256} from 'ethers';
import {recognizeMint,adaptiveQuote} from '../lib/adaptive-mint.mjs';
import {mintPlan} from '../lib/mint.mjs';
import {discover} from '../lib/discovery.mjs';

const target='0x'+'12'.repeat(20),token='0x'+'34'.repeat(20),wallet={account:1,address:'0x'+'56'.repeat(20)},block={tag:'0x64',number:100,timestamp:1000};
function fixture({cap='MAX_PER_ADDRESS',used='mintedBy',quoteField='cost',acceptUnderpay=false,unknownCap=false}={}){
 const iface=new Interface(['function mint(uint256 shares) payable',`function ${cap}() view returns(uint256)`,`function ${used}(address account) view returns(uint256)`,'function TOTAL_SHARES() view returns(uint256)','function totalMinted() view returns(uint256)','function MAX_SUPPLY() view returns(uint256)',`function quoteFor(address account,uint256 shares) view returns(uint256 ${quoteField},uint256 tokens,bool freeShare)`,'function quote(uint256 shares) view returns(uint256 cost,uint256 tokens)','function currentPrice() view returns(uint256)','function mintOpen() view returns(bool)']);
 const runtimeCode='0x'+iface.fragments.map(f=>'63'+f.selector.slice(2)+'1461000057').join('')+'00';
 const meta={address:target,hash:keccak256(runtimeCode),runtimeCode,verified:false,abiHints:JSON.parse(iface.formatJson())};let minted=0n,open=true;const calls=[];
 const cost=n=>{let result=0n;for(let j=0n;j<n;j++)if(minted+j>0n)result+=(minted+j+1n)*7n;return result;};
 const rpc={verifyChain:async()=>{},getBlockNumber:async()=>100,call:async tx=>rpc.send('eth_call',[tx,block.tag]),send:async(method,params)=>{
  calls.push({method,...params[0]});if(method==='eth_getBlockByNumber')return {timestamp:'0x3e8'};if(method==='eth_estimateGas')return '0x10000';assert.equal(method,'eth_call');assert.equal(params[1],block.tag);const f=iface.parseTransaction(params[0]);assert.ok(f);
  if(f.name==='mint'){if(!open||f.args[0]+minted>10n||(!acceptUnderpay&&BigInt(params[0].value)!==cost(f.args[0])))throw Object.assign(Error('execution reverted: payment or quota'),{executionError:true});return '0x';}
  if(f.name===cap&&unknownCap)throw Object.assign(Error('execution reverted'),{executionError:true});
  let values=f.name==='quoteFor'?[cost(f.args[1]),1000n*f.args[1],minted===0n]:f.name==='quote'?[999999n*f.args[0],1000n*f.args[0]]:[{[cap]:10n,[used]:minted,TOTAL_SHARES:100n,totalMinted:23n,MAX_SUPPLY:10n**28n,currentPrice:7n,mintOpen:open}[f.name]];
  return iface.encodeFunctionResult(f.fragment,values);
 }};
 const evidence={targets:[{address:target,corroborated:true,fingerprint:meta.hash,assets:[{token,kind:'Erc20',codeHash:'test'}]}],methods:[{target,selector:iface.getFunction('mint').selector,method:'mint(uint256)',usable:true,maxQuantity:1,fingerprint:meta.hash,participants:2,samples:[],output:{token,kind:'Erc20',minPerUnit:'1000'}}]};
 const opts={sourceLoader:async()=>meta,chainLearner:{learn:async()=>evidence}};
 return {meta,rpc,calls,opts,setUsed:n=>minted=n,setOpen:v=>open=v,recognized:()=>recognizeMint(meta)};
}
test('new runtime deployments: quota spelling variants + chain evidence support free max without a domain adapter',async()=>{
 for(const [cap,used]of [['MAX_PER_ADDRESS','mintedBy'],['MAX_MINT_PER_ADDRESS','mintedBy'],['max_per_address','MINTED_BY'],['Max_Per_Wallet','Minted_Per_Wallet']]){
  const f=fixture({cap,used}),intent={account:1,scope:'free',quantity:'max',maxBnb:'0',referral:'none'};
  const p=await mintPlan(f.rpc,{},intent,target,{address:target,abiHints:f.meta.abiHints},null,f.opts);
  assert.equal(p.amountIn,'0');assert.equal(p.quantity,1);assert.equal(p.requireAssetCredit,true);assert.equal(p.quota.limits.walletRemaining,10);assert.equal(p.quota.limits.publicRemaining,77);assert.equal(p.quota.limits.max,1);assert.equal(p.quote.recognition.price,'quoteFor(address,uint256)');
  f.setUsed(1n);await assert.rejects(mintPlan(f.rpc,{},intent,target,{address:target,abiHints:f.meta.abiHints},null,f.opts),e=>e.code==='NO_FREE_MINT');
  const paid=await mintPlan(f.rpc,{}, {...intent,scope:'paid',quantity:1,maxBnb:'0.01'},target,{address:target,abiHints:f.meta.abiHints},null,f.opts);assert.equal(paid.amountIn,'14');assert.equal(paid.quota.limits.walletRemaining,9);
  f.setUsed(10n);await assert.rejects(mintPlan(f.rpc,{},intent,target,{address:target,abiHints:f.meta.abiHints},null,f.opts),e=>e.code==='NO_QUOTA');
 }
});
test('tuple quotes use current wallet and nonlinear total; declared prices cannot bypass underpayment rejection',async()=>{
 const f=fixture(),r=f.recognized(),route={...r.routes[0],observedAsset:{token,kind:'Erc20',minPerUnit:'1000'}};f.setUsed(1n);
 const q=await adaptiveQuote({...f.meta,abi:r.abi},route,wallet,3,block,f.rpc.send);assert.equal(q.total.raw,'63');assert.equal(q.freeUnits,null);assert.equal(q.available,true);assert.equal(q.limits.publicRemaining,77);
 const bad=fixture({acceptUnderpay:true});bad.setUsed(1n);const b=bad.recognized();await assert.rejects(adaptiveQuote({...bad.meta,abi:b.abi},{...b.routes[0],observedAsset:route.observedAsset},wallet,1,block,bad.rpc.send),e=>e.code==='MINT_ADAPTER_INCOMPLETE');
 const currency=fixture({quoteField:'costUsdt'}).recognized();assert.equal(currency.routes[0].quotes.some(q=>q.method==='quoteFor(address,uint256)'),false);
});
test('unavailable quota getters allow bounded free simulation; closed deployments still stop',async()=>{
 const f=fixture({unknownCap:true}),intent={account:1,scope:'free',quantity:'max',maxBnb:'0',referral:'none'};
 const p=await mintPlan(f.rpc,{},intent,target,{address:target,abiHints:f.meta.abiHints},null,f.opts);assert.equal(p.quantity,1);assert.equal(p.amountIn,'0');assert.equal(p.quota.freeProbe.quotaKnown,false);assert.equal(p.requireAssetCredit,true);
 f.setOpen(false);await assert.rejects(mintPlan(f.rpc,{},intent,target,{address:target,abiHints:f.meta.abiHints},null,f.opts),e=>e.code==='MINT_NOT_OPEN');
});
test('transient homepage failure retries one read; permanent errors and repeated outages remain explicit',async()=>{
 for(const [message,recover,expected]of [['fetch failed',true,2],['HTTP 503',false,2],['HTTP 404',false,1]]){
  const url='https://unseen-issue.example/#mint';let reads=0;
  const result=await discover(url,{fetchText:async u=>{if(u!==url)throw Error('HTTP 404');reads++;if(recover&&reads===2)return `<title>Unseen issuer</title><script>const mintAddress="${target}";</script>`;throw Error(message);}});
  assert.equal(reads,expected);assert.equal(result.pageError,recover?null:message);assert.equal(result.address,recover?target:null);
 }
});
