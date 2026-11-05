import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Interface,keccak256,toUtf8Bytes} from 'ethers';
import {recognizeGuardedIdMint,guardedIdMintState,guardedIdMintPlan,guardedIdReferral} from '../lib/guarded-id-mint.mjs';
import {runtimeShape} from '../lib/bytecode.mjs';import {ChainLearner,TRANSFER} from '../lib/chain-learning.mjs';
import {mintPlan} from '../lib/mint.mjs';import {Engine,verifyPreview} from '../lib/engine.mjs';import {bindings,BNB} from '../lib/common.mjs';import {resolveReferral} from '../lib/referral.mjs';
const meta=JSON.parse(fs.readFileSync(new URL('./fixtures/guarded-id-runtime.json',import.meta.url))),abi=new Interface(meta.abi),profile=recognizeGuardedIdMint(meta),ws=bindings(),w=ws[0];
const registry='0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F',reg=new Interface(['function handleOf(address) view returns(string)','function ownerOf(uint256) view returns(address)']);
const price=2000000000000000n,tokens=50000000n*10n**18n,hex=n=>'0x'+BigInt(n).toString(16),word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'guarded-id-test-'));
const intent={account:1,side:'mint',scope:'free',quantity:'max',maxBnb:'0',asset:meta.address,referral:'account1',slippageBps:100};
const ids=ws.map(w=>BigInt(keccak256(toUtf8Bytes('fixture'+w.account))));
function fixture(){
 const s={minted:617n,freeMinted:300n,freeCap:300n,cap:10000n,txCap:10n,quota:10n,used:0n,claimed:false,firstPaid:false,cost:price,out:tokens,wrongOwner:false,badQuote:false,quoteError:false,txs:[],blocks:[],block:10000};
 const rpc={verifyChain:async()=>{},getBlockNumber:async()=>s.block,getCode:async()=>meta.runtimeCode,send:async(m,p)=>{assert.equal(m,'eth_getBlockByNumber');return {number:p[0],hash:word(BigInt(p[0])+20000n),timestamp:hex(1000)};},call:async(tx,block)=>{
  s.blocks.push(block);if(tx.to.toLowerCase()===registry.toLowerCase()){const f=reg.parseTransaction(tx);if(f.name==='handleOf'){const a=ws.find(w=>w.address.toLowerCase()===f.args[0].toLowerCase());return reg.encodeFunctionResult(f.name,['fixture'+a.account]);}return reg.encodeFunctionResult(f.name,[s.wrongOwner?registry:ws[ids.findIndex(id=>id===f.args[0])].address]);}
  const f=abi.parseTransaction(tx);assert.ok(f);
  const free=s.freeMinted<s.freeCap&&!s.claimed?1n:0n;
  if(f.name==='quoteFor'){if(s.quoteError)throw Error('oracle rejected');const n=f.args[1];return abi.encodeFunctionResult(f.name,[(n-free)*s.cost,n*s.out,free+(s.badQuote?1n:0n),n-free]);}
  if(f.name==='mint'||f.name==='mintWithInviter'){
   s.txs.push({tx,args:f.args,method:f.name});assert.equal(f.args[0],ids[ws.findIndex(w=>w.address===tx.from)]);assert.equal(f.args[2],s.minted+1n);assert.ok(f.args[3]>0n);assert.equal(f.args[4],1180n);assert.equal(BigInt(tx.value),(f.args[1]-free)*s.cost);
   if(f.name==='mintWithInviter'){assert.equal(f.args[5],ids[0]);assert.ok(!s.firstPaid&&BigInt(tx.value)>0n);}return '0x';
  }
  const v={idCollection:registry,totalMinted:s.minted,MAX_SHARES:s.cap,MAX_PER_TX:s.txCap,FREE_SHARES:s.freeCap,freeMinted:s.freeMinted,quotaOf:s.quota,mintedById:s.used,freeClaimed:s.claimed,firstPaid:s.firstPaid,decimals:18n,totalSupply:s.minted*s.out};
  assert.ok(f.name in v,f.name);return abi.encodeFunctionResult(f.name,[v[f.name]]);
 }};return {s,rpc};
}
test('verified dynamic-ID family recognizes actual deployed dispatcher and roles, not a domain/address allowlist',()=>{
 assert.equal(profile.kind,'guarded-agent-id-quote');assert.deepEqual(profile.routes[0].roles,['id','quantity','start','minimum','deadline']);
 assert.ok(runtimeShape(meta.runtimeCode).selectors.has(abi.getFunction('idCollection').selector));
 const alternate=structuredClone(meta);alternate.address='0x'+'12'.repeat(20);alternate.abi=alternate.abi.map(f=>f.type==='function'?{...f,inputs:f.inputs.map(p=>({...p,name:({quantity:'qty',id:'agentId',minTokens:'minAmountOut',expectedStart:'startIndex',deadline:'expiry',inviterId:'referrerId'})[p.name]||p.name}))}:f);
 for(const [a,b]of Object.entries({quantity:'qty',id:'agentId',minTokens:'minAmountOut',expectedStart:'startIndex',deadline:'expiry',inviterId:'referrerId'}))alternate.sources['IMARS.sol'].content=alternate.sources['IMARS.sol'].content.replace(new RegExp('\\b'+a+'\\b','g'),b);
 assert.ok(recognizeGuardedIdMint(alternate));
 assert.equal(recognizeGuardedIdMint({...meta,verified:false}),null);assert.equal(recognizeGuardedIdMint({...meta,proxy:true}),null);assert.equal(recognizeGuardedIdMint({...meta,sources:{}}),null);
});
test('source guards are required; a matching ABI cannot invent identity, deadline, minimum or free-policy semantics',()=>{
 for(const [a,b]of [['block.timestamp > deadline','block.timestamp < deadline'],['issued < minTokens','issued < 1'],['idCollection.ownerOf(id) != msg.sender','idCollection.ownerOf(id) == msg.sender'],['freeMinted < FREE_SHARES','freeMinted > FREE_SHARES'],['freeUnits = _hasFree(id) ? 1 : 0','freeUnits = _hasFree(id) ? 2 : 0']]){
  const changed=structuredClone(meta);changed.sources['IMARS.sol'].content=changed.sources['IMARS.sol'].content.replace(a,b);assert.equal(recognizeGuardedIdMint(changed),null,a);
 }
});
test('IMARS exhausted shared free pool is NO_QUOTA with current paid price, never a fallback payment',async()=>{
 const {s,rpc}=fixture(),state=await guardedIdMintState(rpc,intent,meta,w);assert.equal(state.free,0n);assert.equal(state.info.paidRemaining,'10');
 await assert.rejects(mintPlan(rpc,{},intent,meta.address,{},null,{sourceLoader:async()=>meta}),e=>e.code==='NO_QUOTA'&&/300\/300/.test(e.message)&&e.details.quota.paidPriceBnb==='0.002');assert.equal(s.txs.length,0);
});
test('fresh paid quote uses own ID, current start, positive minimum, chain deadline and budget; wrappers never replay sample input',async()=>{
 const {s,rpc}=fixture(),p=await guardedIdMintPlan(rpc,{...intent,scope:'paid',quantity:'max'},meta,2n*price,w,{});assert.equal(p.quantity,2);assert.equal(p.amountIn,String(2n*price));assert.equal(p.quote.expectedStart,'618');assert.equal(p.minOutput,String(2n*tokens*99n/100n));assert.equal(p.freshBeforeExecute,true);
 s.minted++;s.out/=2n;s.cost*=2n;const next=await guardedIdMintPlan(rpc,{...intent,scope:'paid',quantity:1},meta,2n*price,w,{});assert.equal(next.quote.expectedStart,'619');assert.equal(next.amountIn,String(2n*price));assert.notEqual(next.steps[0].data,p.steps[0].data);assert.ok(s.blocks.every(b=>b===s.block));
 await assert.rejects(guardedIdMintPlan(rpc,{...intent,scope:'paid',quantity:1},meta,0n,w,{}),e=>e.code==='BUDGET_LIMIT');
});
test('free, paid and all preserve distinct scope; invitations apply only to first paid transaction for wallets 2/3',async()=>{
 const {s,rpc}=fixture();s.freeMinted=299n;const i={...intent,account:2};
 const free=await guardedIdMintPlan(rpc,i,meta,10n*price,ws[1],{});assert.equal(free.amountIn,'0');assert.equal(free.quantity,1);assert.equal(s.txs.at(-1).method,'mint');assert.equal(free.referral.active,false);
 await assert.rejects(guardedIdMintPlan(rpc,{...i,scope:'paid'},meta,10n*price,ws[1],{}),/不能单独执行付费/);
 const all=await guardedIdMintPlan(rpc,{...i,scope:'all'},meta,9n*price,ws[1],{});assert.equal(all.quantity,10);assert.equal(all.quote.freeUnits,'1');assert.equal(all.quote.paidUnits,'9');assert.equal(s.txs.at(-1).method,'mintWithInviter');assert.equal(all.referral.linkValue,String(ids[0]));
 s.freeMinted=300n;s.firstPaid=true;const again=await guardedIdMintPlan(rpc,{...i,scope:'paid',quantity:1},meta,price,ws[1],{});assert.equal(s.txs.at(-1).method,'mint');assert.equal(again.referral.active,false);
});
test('inviter link uses verified ID and website URL transport, no fixed ref formatting',async()=>{
 const {rpc}=fixture(),s=await guardedIdMintState(rpc,intent,meta,w),prior=await guardedIdReferral(rpc,meta,s);
 const r=await resolveReferral(rpc,{}, {source:'https://other.example/mint',referralHints:{templates:[{transport:'query',key:'inviterId',kind:'unknown',score:1,path:'/mint'}]}},meta,prior);
 assert.equal(new URL(r.url).searchParams.get('inviterId'),String(ids[0]));assert.equal(r.bindingVerified,true);
});
test('wrong owner, inconsistent quote, RPC/oracle failure and exhausted stock stop before a transaction is constructed',async()=>{
 const {s,rpc}=fixture();s.wrongOwner=true;await assert.rejects(guardedIdMintState(rpc,intent,meta,w),/所有权/);s.wrongOwner=false;s.badQuote=true;await assert.rejects(guardedIdMintState(rpc,intent,meta,w),/不一致/);s.badQuote=false;s.quoteError=true;await assert.rejects(guardedIdMintState(rpc,intent,meta,w),/oracle/);s.quoteError=false;s.minted=s.cap;await assert.rejects(guardedIdMintPlan(rpc,intent,meta,0n,w,{}),e=>e.code==='NO_QUOTA');assert.equal(s.txs.length,0);
});
test('successful history decodes multi-parameter quantities, records parameter roles and permits current quote construction',async()=>{
 const {rpc}=fixture(),txs=new Map(),receipts=new Map();
 for(let i=0;i<2;i++){
  const b=9990+i,hash=word(100+i),from=ws[i].address,input=abi.encodeFunctionData('mint',[ids[i],i+1,600,1,999999]);
  const tx={hash,to:meta.address,from,input,value:hex(price*BigInt(i+1)),blockNumber:hex(b),blockHash:word(b+20000)};
  const log={address:meta.address,topics:[TRANSFER,word(0),word(from)],data:word(tokens*BigInt(i+1)),transactionHash:hash,blockNumber:tx.blockNumber,blockHash:tx.blockHash,logIndex:'0x0'};
  txs.set(hash,tx);receipts.set(hash,{transactionHash:hash,to:tx.to,from,status:'0x1',blockNumber:tx.blockNumber,blockHash:tx.blockHash,logs:[log]});
 }
 rpc.getTransaction=async h=>txs.get(h);rpc.getTransactionReceipt=async h=>receipts.get(h);
 const send=rpc.send;rpc.send=(m,p)=>m==='eth_getLogs'?Promise.resolve([...receipts.values()].flatMap(r=>r.logs)):send(m,p);
 const learner=new ChainLearner(rpc,{logRpc:rpc,data:temp(),scanBlocks:64}),e=await learner.learn([{address:meta.address}],{sourceLoader:async()=>meta});assert.equal(e.methods.length,1);const method=e.methods[0];assert.equal(method.usable,true);assert.equal(method.construction,profile.kind);assert.equal(method.output.minPerUnit,String(tokens));assert.deepEqual(method.samples.map(s=>s.quantity).sort(),['1','2']);assert.deepEqual(method.parameterRoles,profile.routes[0].roles);assert.equal('input' in method.samples[0],false);
});
test('official preview must prove ERC20 credit and reject wrong token, zero output, excess debit and authority changes',async()=>{
 const {rpc}=fixture(),plan=await guardedIdMintPlan(rpc,{...intent,scope:'paid',quantity:1},meta,price,w,{}),step=plan.steps[0];
 const preview=changes=>({requestId:'test',simulationResult:{simulationCode:'000000000',balanceChanges:changes}}),credit={owner:w.address,contractAddress:meta.address,tokenType:'Erc20',change:String(tokens)};
 assert.doesNotThrow(()=>verifyPreview(preview([credit]),plan,step));assert.throws(()=>verifyPreview(preview([{...credit,contractAddress:registry}]),plan,step),/最低/);assert.throws(()=>verifyPreview(preview([{...credit,change:'0'}]),plan,step),/最低/);assert.throws(()=>verifyPreview(preview([credit,{owner:w.address,contractAddress:BNB,change:String(-2n*price)}]),plan,step),/超出/);
});
test('dynamic mint always rebuilds before submit, never uses old official request; worsening terms stop without submitting (mock wallet)',async()=>{
 for(const worse of [false,true]){
  let plans=0,previews=0,submits=0,request;
  const planFn=async()=>({kind:'contract',route:'fixture',freshBeforeExecute:true,wallet:w.address,token:meta.address,inputToken:BNB,outputToken:meta.address,amountIn:'1',minOutput:plans++&&worse?'9':'10',quantity:1,metaVerified:true,review:[],steps:[{kind:'mint',to:meta.address,value:'1',data:'0x'+plans.toString().padStart(8,'0')} ]});
  const bridge={ready:async()=>{},call:async(a,args)=>{if(args[1]==='preview')return {requestId:'request-'+(++previews),simulationResult:{simulationCode:'000000000',balanceChanges:[]}};assert.equal(args[1],'execute');submits++;request=args[3];return {txHash:word(123)};}};
  const engine=new Engine({rpc:{},bridge,data:temp(),live:true,planFn});engine.observeContract=async(o,e)=>{e.status='CONFIRMED';};
  await engine.prepare({...intent,scope:'paid',quantity:1,maxBnb:'0.01'},'dynamic');const result=await engine.execute('dynamic',{authorization:'fixture only',acknowledgeReview:true});assert.equal(plans,2);assert.equal(submits,worse?0:1);if(!worse){assert.equal(request,'request-2');assert.equal(previews,2);}else assert.equal(result.status,'BLOCKED');
 }
});
test('shared-counter submissions serialize across wallets, recheck after confirmation and suppress queued duplicate (mock wallet)',async()=>{
 let active=0,maxActive=0,completed=0,submits=0;const requested=[];
 const planFn=async i=>({kind:'contract',route:'fixture',freshBeforeExecute:true,wallet:ws[i.account-1].address,token:meta.address,inputToken:BNB,outputToken:meta.address,amountIn:'1',minOutput:'10',quantity:1,metaVerified:true,review:[],steps:[{kind:'mint',to:meta.address,value:'1',data:word(completed)}]});
 const bridge={ready:async()=>{},call:async(a,args)=>{if(args[1]==='preview')return {requestId:'account-'+a+'-start-'+completed,simulationResult:{simulationCode:'000000000',balanceChanges:[]}};assert.equal(args[1],'execute');active++;maxActive=Math.max(maxActive,active);requested.push(args[3]);submits++;return {txHash:word(a)};}};
 const engine=new Engine({rpc:{},bridge,data:temp(),live:true,planFn});engine.observeContract=async(o,e)=>{await new Promise(r=>setTimeout(r,10));active--;completed++;e.status='CONFIRMED';};
 for(const account of [1,2])await engine.prepare({...intent,account,scope:'paid',quantity:1,maxBnb:'0.01'},'shared-'+account);
 const r=await Promise.all([1,2,1].map(a=>engine.execute('shared-'+a,{authorization:'mock only',acknowledgeReview:true})));
 assert.equal(maxActive,1);assert.equal(submits,2);assert.deepEqual(requested,['account-1-start-0','account-2-start-1']);assert.equal(r[2].duplicateSuppressed,true);
});
test('unknown prior submission blocks the next wallet on the same guarded contract (mock wallet)',async()=>{
 let submits=0;const planFn=async i=>({kind:'contract',freshBeforeExecute:true,wallet:ws[i.account-1].address,token:meta.address,amountIn:'1',minOutput:'1',quantity:1,metaVerified:true,review:[],steps:[{kind:'mint',to:meta.address,value:'1',data:'0x'}]});
 const bridge={ready:async()=>{},call:async(a,args)=>{if(args[1]==='preview')return {requestId:'p'+a,simulationResult:{simulationCode:'000000000',balanceChanges:[]}};submits++;throw Object.assign(Error('timeout'),{dispatched:true});}};
 const engine=new Engine({rpc:{},bridge,data:temp(),live:true,planFn});for(const account of [1,2])await engine.prepare({...intent,account,scope:'paid',quantity:1,maxBnb:'0.01'},'uncertain-'+account);
 const opts={authorization:'mock only',acknowledgeReview:true};assert.equal((await engine.execute('uncertain-1',opts)).status,'SUBMISSION_UNKNOWN');await assert.rejects(engine.execute('uncertain-2',opts),/待核对原单/);assert.equal(submits,1);
});
test('an AND guard or disabled referral branch is not treated as the verified role mapping',()=>{
 const changed=structuredClone(meta);changed.sources['IMARS.sol'].content=changed.sources['IMARS.sol'].content.replace('expectedStart != first || block.timestamp > deadline','expectedStart != first && block.timestamp > deadline');assert.equal(recognizeGuardedIdMint(changed),null);
 const ref=structuredClone(meta);ref.sources['IMARS.sol'].content=ref.sources['IMARS.sol'].content.replace('deadline,true,inviterId','deadline,false,inviterId');assert.ok(!recognizeGuardedIdMint(ref).routes.some(r=>r.roles.includes('inviter')));
});
