import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Engine} from '../lib/engine.mjs';
import {PAP,PAP_ABI,papInput,papPlan,refreshPapMint,papState,inspectPap,validatePapDeployment,verifyPap} from '../lib/pap.mjs';
import {Interface,ZeroAddress,BNB,bindings} from '../lib/common.mjs';
import {corlaBudget,refreshMintBudget} from '../public/corla-budget.mjs';
const code=JSON.parse(fs.readFileSync(new URL('./fixtures/pap-runtime.json',import.meta.url)));
const C=PAP.config,M=PAP_ABI,T=new Interface(['function sale() view returns(address)','function distributor() view returns(address)','function tradingEnabled() view returns(bool)']);
const w={account:2,address:'0x2222222222222222222222222222222222222222'},inviter={account:1,address:'0x1111111111111111111111111111111111111111'};
function rpc(options={}){
 const calls=[];const defaults={saleOpen:true,refunding:false,remainingMints:20000n,isAgentWallet:true,remainingFor:10n,mintedBy:0n,quotaOf:10n,extraQuota:0n,referrerOf:ZeroAddress,token:C.token,AGENT_ID:'0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F',sale:C.sale,distributor:C.distributor,tradingEnabled:false,saleInfo:[1500000000000000n,2000n*10n**18n,20000n,10n,40000000n*10n**18n],...options};
 return {calls,verifyChain:async()=>{},getBlockNumber:async()=>100,getBalance:async()=>options.bnb??10n**18n,getCode:async address=>Object.values(code).find(x=>x.target.toLowerCase()===address.toLowerCase()).code+(options.changedCode?'00':''),send:async(method,args)=>{
  if(method==='eth_estimateGas'){const tx=args[0],p=M.parseTransaction({data:tx.data});if(options.rejectReferral&&p.name==='mintWithReferrer')throw Object.assign(Error('execution reverted: referrer'),{code:'CALL_EXCEPTION'});return '0x'+BigInt(options.batchGas&&p.args[0]>1n?options.batchGas:300000).toString(16);}
  assert.ok(['eth_getStorageAt','eth_gasPrice','eth_estimateGas'].includes(method),'no signing or broadcast');return method==='eth_getStorageAt'?'0x'+'0'.repeat(64):method==='eth_gasPrice'?'0x5f5e100':'0x493e0';
 },call:async tx=>{const abi=tx.to.toLowerCase()===C.token.toLowerCase()?T:M,p=abi.parseTransaction({data:tx.data});calls.push({name:p.name,args:p.args,value:tx.value});
  if(p.name==='mintMany'||p.name==='mintWithReferrer'){if(options.rejectReferralCall&&p.name==='mintWithReferrer')throw Object.assign(Error('execution reverted: referrer'),{code:'CALL_EXCEPTION'});return M.encodeFunctionResult(p.name,[(options.wrongCredit?1n:p.args[0])*2000n*10n**18n]);}
  let value=defaults[p.name];if(p.name==='mintedBy'&&p.args[0].toLowerCase()===inviter.address)value=options.inviterMinted??0n;
  return abi.encodeFunctionResult(p.name,Array.isArray(value)?value:[value]);
 }};
}
const intent={account:2,scope:'all',quantity:'max',maxBnb:'0.015',currency:'BNB',referral:'account1'};
test('PAPER matches website variations, sale and token, never a lookalike domain',()=>{
 for(const x of ['https://papagent.app/?ref','https://www.papagent.app/agents?ref=x.ai',C.sale,C.token])assert.equal(papInput(x),true);
 for(const x of ['https://papagent.app.evil.example','https://papagent.app@evil.example',C.distributor])assert.equal(papInput(x),false);
});
test('published deployment binds each role and exact chain',()=>{
 const doc='## Contracts (chainId 56)\n'+Object.entries(C).map(([k,v])=>'- '+k.toUpperCase()+': '+v).join('\n');validatePapDeployment(doc);
 assert.throws(()=>validatePapDeployment(doc.replace('56','1')));assert.throws(()=>validatePapDeployment(doc.replace(C.sale,C.token)));
});
test('changed code or crossed sale/token stops before calldata',async()=>{
 await assert.rejects(verifyPap(rpc({changedCode:true})),e=>e.code==='PAP_VERSION_CHANGED');
 await assert.rejects(verifyPap(rpc({sale:ZeroAddress})),/关系不符/);
});
test('max produces one exact-price batch and passes account1 referral',async()=>{
 const r=rpc();const p=await papPlan(r,intent,w,{wallets:[inviter,w]});
 assert.equal(p.quantity,10);assert.equal(p.amountIn,'15000000000000000');assert.equal(p.minOutput,String(20000n*10n**18n));assert.equal(p.steps.length,1);
 const args=M.decodeFunctionData('mintWithReferrer',p.steps[0].data);assert.equal(args[0],10n);assert.equal(args[1],inviter.address);assert.equal(p.referral.optional,true);assert.equal(r.calls.filter(c=>c.name==='mintedBy').length,1);
 assert.equal(p.metaVerified,false);assert.equal(p.requireAssetCredit,true);assert.equal(p.steps[0].gasLimit,undefined);
});
test('unminted inviter never blocks execution or requires another wallet first',async()=>{
 const p=await papPlan(rpc(),intent,w,{wallets:[inviter,w]});assert.equal(p.referral.optional,true);assert.equal(p.quantity,10);
});
test('account1 and explicit no referral use mintMany',async()=>{
 for(const [i,who]of [[{...intent,account:1},inviter],[{...intent,referral:'none'},w]]){const p=await papPlan(rpc(),i,who,{wallets:[inviter,w]});assert.equal(M.parseTransaction({data:p.steps[0].data}).name,'mintMany');}
});
test('max uses live bonus and remaining inventory, not hard-coded ten',async()=>{
 const p=await papPlan(rpc({quotaOf:13n,extraQuota:3n,remainingFor:11n,mintedBy:2n,referrerOf:inviter.address,remainingMints:9n}),intent,w,{wallets:[inviter,w]});assert.equal(p.quantity,9);
});
test('max ignores stale zero or smaller UI budget and honors live quota',async()=>{
 for(const maxBnb of ['0','0.001','0.01'])for(const quantity of ['max','MAX']){const p=await papPlan(rpc(),{...intent,quantity,maxBnb},w,{wallets:[inviter,w]});assert.equal(p.quantity,10);assert.equal(p.amountIn,'15000000000000000');}
 const p=await papPlan(rpc({quotaOf:13n,extraQuota:3n,remainingFor:13n}),intent,w,{wallets:[inviter,w]});assert.equal(p.quantity,13);
});
test('balance exactly covering mint payment reserves gas and reduces to nine',async()=>{
 const p=await papPlan(rpc({bnb:15000000000000000n}),intent,w,{wallets:[inviter,w]});assert.equal(p.quantity,9);assert.equal(p.steps[0].value,'13500000000000000');assert.equal(p.pap.limited,true);assert.ok(BigInt(p.amountIn)+BigInt(p.pap.gasReserve)<=15000000000000000n);
});
test('affordable boundary includes gas and handles zero without a mint call',async()=>{
 for(const [bnb,n]of [[4560000000000000n,3],[4559999999999999n,2],[1560000000000000n,1]]){const p=await papPlan(rpc({bnb}),intent,w,{wallets:[inviter,w]});assert.equal(p.quantity,n);}
 for(const bnb of [0n,1500000000000000n,1559999999999999n]){const r=rpc({bnb});await assert.rejects(papPlan(r,intent,w,{wallets:[inviter,w]}),e=>e.code==='INSUFFICIENT_FUNDS'&&/其他钱包继续/.test(e.message));assert.equal(r.calls.some(c=>c.name.startsWith('mint')&&c.name!=='mintedBy'),false);}
});
test('exact batch gas can reduce affordable size again without overpaying',async()=>{
 const p=await papPlan(rpc({bnb:4600000000000000n,batchGas:1000000}),intent,w,{wallets:[inviter,w]});assert.equal(p.quantity,2);assert.ok(BigInt(p.amountIn)+BigInt(p.pap.gasReserve)<=4600000000000000n);
});
test('explicit numbered order retains its separate spending cap and accepts partial size',async()=>{
 const p=await papPlan(rpc(),{...intent,quantity:10,maxBnb:'0.0045'},w,{wallets:[inviter,w]});assert.equal(p.quantity,3);assert.equal(p.amountIn,'4500000000000000');
 await assert.rejects(papPlan(rpc(),{...intent,quantity:10,maxBnb:'0'},w,{wallets:[inviter,w]}),e=>e.code==='BUDGET_LIMIT');
});
test('optional referral fallback and missing inviter continue with ordinary mint',async()=>{
 for(const opts of [{rejectReferral:true},{rejectReferralCall:true}]){const p=await papPlan(rpc(opts),intent,w,{wallets:[inviter,w]});assert.equal(p.referral,null);assert.equal(M.parseTransaction({data:p.steps[0].data}).name,'mintMany');}
 const p=await papPlan(rpc(),intent,w,{wallets:[w]});assert.equal(p.referral,null);assert.equal(p.quantity,10);
});
test('wrong incoming token amount still blocks the plan',async()=>{
 await assert.rejects(papPlan(rpc({wrongCredit:true}),intent,w,{wallets:[inviter,w]}),/到账数量/);
});
test('execution refresh permits only affordable reductions, never an increased reviewed charge',async()=>{
 const wallets=[inviter,w],p=await papPlan(rpc(),intent,w,{wallets});
 const small=await refreshPapMint(rpc({bnb:4600000000000000n}),p,intent,{wallets});assert.equal(small.quantity,3);assert.equal(small.minOutput,String(6000n*10n**18n));
 const bigger=await refreshPapMint(rpc(),small,intent,{wallets});assert.equal(bigger.quantity,3);
 await assert.rejects(refreshPapMint(rpc({mintedBy:1n,remainingFor:9n}),p,intent,{wallets}),/已认购/);
 await assert.rejects(refreshPapMint(rpc(),p,intent,{wallets:[{...w,address:inviter.address}]}),/钱包绑定/);
});
test('free-only never switches to paid',async()=>{await assert.rejects(papPlan(rpc(),{...intent,scope:'free',maxBnb:'0'},w),e=>e.code==='NO_FREE_MINT');});
test('closed, ended and ineligible have specific reasons',async()=>{
 for(const [options,expected]of [[{saleOpen:false},'MINT_NOT_OPEN'],[{refunding:true},'MINT_ENDED'],[{tradingEnabled:true},'MINT_ENDED'],[{isAgentWallet:false},'MINT_INELIGIBLE'],[{remainingFor:0n,mintedBy:10n},'NO_QUOTA']]){
  await assert.rejects(papPlan(rpc(options),intent,w,{wallets:[inviter,w]}),e=>e.code===expected);
 }
});
test('changed price and inconsistent quota fail',async()=>{
 await assert.rejects(papState(rpc({remainingFor:11n}),w),/规则/);
 await assert.rejects(papState(rpc({saleInfo:[1n,2000n*10n**18n,20000n,10n,40000000n*10n**18n]}),w),/规则/);
});
test('existing or missed referral keeps minting without pretending to rebind',async()=>{
 for(const referrerOf of [ZeroAddress,inviter.address,'0x3333333333333333333333333333333333333333']){const p=await papPlan(rpc({mintedBy:1n,remainingFor:9n,referrerOf}),intent,w,{wallets:[inviter,w]});assert.equal(p.quantity,9);assert.equal(p.referral,null);assert.equal(M.parseTransaction({data:p.steps[0].data}).name,'mintMany');}
});
test('PAPER preview does not re-fetch all wallets for a group budget',async()=>{
 assert.equal(await refreshMintBudget({project:{platform:'pap'},scope:'all',quantity:'max'},()=>assert.fail('no extra website or batch balance read')),null);
});
test('closed sale still exposes exact max budget and invite link',async()=>{
 const p=await inspectPap(rpc({saleOpen:false}),{platform:'pap'},[inviter,w]);assert.equal(p.quotas[0].phase,'MINT_NOT_OPEN');assert.equal(p.referral.url,'https://papagent.app/?ref='+inviter.address);
 const b=corlaBudget(p,[1,2],'all','MAX');assert.equal(b.maxBnb,'0.015');assert.equal(b.total,'0.03');assert.equal(b.costs[0].lots,10);
 assert.equal(corlaBudget(p,[1,2],'paid',3).maxBnb,'0.0045');assert.equal(corlaBudget(p,[1],'free','max'),null);
});

test('engine refreshes a reduced max batch through official preview and never replays it',async t=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'pap-engine-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 const wallets=bindings(),who=wallets[0],r=rpc();let balance=10n**18n,submits=0,planCalls=0;const previews=[];
 r.getBalance=async()=>balance;
 const bridge={ready:async()=>({}),call:async(account,args)=>{
  assert.equal(account,who.account);assert.equal(args[0],'contract-call');
  if(args[1]==='execute'){submits++;return {txHash:'0x'+'12'.repeat(32)};}
  assert.equal(args[1],'preview');const value=args[args.indexOf('--value')+1],data=args[args.indexOf('--inputData')+1],n=M.parseTransaction({data}).args[0];previews.push(Number(n));
  return {requestId:'fixture-'+previews.length,parsedTx:{contractAddress:C.sale},simulationResult:{simulationCode:'000000000',balanceChanges:[{owner:who.address,contractAddress:BNB,change:'-'+value},{owner:who.address,contractAddress:C.token,tokenType:'Erc20',change:String(n*2000n*10n**18n)}]}};
 }};
 const engine=new Engine({data,live:true,rpc:r,bridge,planFn:async i=>{planCalls++;return {...await papPlan(r,i,who,{wallets}),resolved:{platform:'pap',address:C.sale},project:{platform:'pap'}};}});
 engine.observeContract=async(o,e)=>{e.status='CONFIRMED';};
 const i={...intent,side:'mint',account:who.account,asset:'https://papagent.app/',maxBnb:'0'};
 const p=await engine.prepare(i,'paper-test');assert.equal(p.status,'PREPARED');assert.equal(p.plan.quantity,10);
 p.timing.preparedAt=Date.now()-20000;engine.write(p);balance=4600000000000000n;
 const done=await engine.execute(p.id,{authorization:'synthetic fixture only',acknowledgeReview:true});assert.equal(done.status,'CONFIRMED',JSON.stringify(done.error));assert.equal(done.plan.quantity,3);assert.deepEqual(previews,[10,3]);assert.equal(planCalls,1);assert.equal(submits,1);
 await engine.execute(p.id,{authorization:'synthetic repeated click',acknowledgeReview:true});assert.equal(submits,1);
});
