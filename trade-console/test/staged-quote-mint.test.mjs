import test from 'node:test';import assert from 'node:assert/strict';
import {Interface,keccak256} from 'ethers';
import {BNB,USDT,ERC20,bindings,wallet} from '../lib/common.mjs';
import {recognizeStagedQuoteMint,stagedQuoteState,stagedQuotePlan} from '../lib/staged-quote-mint.mjs';
import {mintPlan} from '../lib/mint.mjs';import {mintError} from '../lib/mint-errors.mjs';
import {corlaBudget,refreshMintBudget} from '../public/corla-budget.mjs';
const A='0x'+'7'.repeat(40),T='0x'+'8'.repeat(40),zero='0x'+'0'.repeat(40);
// Synthetic source, no production wallets, RPC credentials, or deployment pins.
const source=`contract FutureSale {
 function claimFree() external { _checkLive(); uint n=sold; if(n>=FREE_SHARES) revert FreeRoundOver(); (uint id,bool ok)=agentIdOf(msg.sender); if(!ok) revert AgentIdRequired(); if(freeTaken[id]) revert FreeAlreadyTaken(); freeTaken[id]=true; preBought[id]+=1; sold=n+1; token.mint(msg.sender,FREE_TOKENS); }
 function mintShares(uint256 shares,address inviter,bool payUsdt,uint256 maxUsdt,uint256 minTokens) external payable {
  _checkLive(); uint s=sold; if(s<FREE_SHARES) revert FreeRoundOpen(); if(s>=TOTAL_SHARES) revert SoldOut(); uint cost; uint out; uint agentId; bool pre=s<OPEN_SHARE;
  if(pre){ shares=_min(shares,OPEN_SHARE-s); agentId=_gatePreOpen(shares,inviter); cost=shares*PRE_PRICE; out=shares*SHARE_TOKENS; }
  else { (shares,cost,out)=_postFill(s+1,shares,_refPriceNow()); }
  if(out<minTokens) revert BelowMinTokens(); uint usdtPaid; if(payUsdt) usdtPaid=_usdtToBnb(cost,maxUsdt); else if(msg.value<cost) revert WrongValue();
  sold=s+shares; token.mint(msg.sender,out);
 }
 function quote(uint256 shares) external view returns(uint256 bnbCost,uint256 usdtCost,uint256 tokensOut,uint256 filled){ uint s=sold; if(s<OPEN_SHARE){ filled=_min(shares,OPEN_SHARE-s); bnbCost=filled*PRE_PRICE; tokensOut=filled*SHARE_TOKENS; }else{ (filled,bnbCost,tokensOut)=_postFill(s+1,shares,_refPriceNow()); }usdtCost=_usdtNeeded(bnbCost); }
 function _checkLive() private view {if(expired()) revert SaleExpired();}
 function agentIdOf(address w) public view returns(uint id,bool ok){}
 function _gatePreOpen(uint n,address inviter) private returns(uint id){ if(n>limitLeft(id)) revert OverLimit(); _creditInviter(id,inviter); }
 function _usdtToBnb(uint bnbOut,uint maxUsdt) private returns(uint usdtIn){usdtIn=_usdtNeeded(bnbOut);if(usdtIn>maxUsdt) revert OverMaxPay();usdt.safeTransferFrom(msg.sender,up,usdtIn);}
 function userInfo(address w) external view returns(User memory u){u.limitLeft=limitLeft(u.agentId);}
 function stats() external view returns(Stats memory st){}
}`;
const specs=['function claimFree()','function mintShares(uint256 shares,address inviter,bool payUsdt,uint256 maxUsdt,uint256 minTokens) payable','function quote(uint256 shares) view returns(uint256 bnbCost,uint256 usdtCost,uint256 tokensOut,uint256 filled)',
 'function stats() view returns(tuple(uint256 sold,bool started,bool freeRound,bool open,bool expired,bool soldOut,uint256 tierLeft,uint256 sharesLeft))','function userInfo(address) view returns(tuple(bool hasAgentId,bool freeUsed,uint256 limitLeft))',
 'function token() view returns(address)','function usdt() view returns(address)','function FREE_TOKENS() view returns(uint256)','function FREE_SHARES() view returns(uint256)','function OPEN_SHARE() view returns(uint256)',
 'error FreeRoundOver()','error FreeRoundOpen()','error FreeAlreadyTaken()','error AgentIdRequired()','error SaleExpired()'];
function fixture(rename=false){
 const changes={mintShares:'subscribeNext',quote:'priceForLots',claimFree:'takeSeat',shares:'lots',inviter:'sponsor',payUsdt:'useStable',maxUsdt:'stableCap',minTokens:'outputFloor',FREE_SHARES:'ROUND_ONE_CAP',OPEN_SHARE:'ROUND_TWO_CAP',PRE_PRICE:'UNIT_PRICE',SHARE_TOKENS:'TOKENS_PER_LOT',FREE_TOKENS:'FREE_OUTPUT'};
 const change=s=>rename?s.replace(/\b\w+\b/g,n=>changes[n]||n):s;
 const abi=new Interface(specs.map(change)),runtimeCode='0x'+abi.fragments.filter(f=>f.type==='function').map(f=>'63'+f.selector.slice(2)+'14600057').join('')+'00';
 const meta={address:A,verified:true,abi:JSON.parse(abi.formatJson()),runtimeCode,hash:keccak256(runtimeCode),identity:{target:A,fingerprint:'synthetic'},sources:{sale:{content:change(source)}}};
 const state={sold:20n,started:true,expired:false,eligible:true,used:false,limit:10n,partial:false,fail:false,allowance:0n,balance:1000000n,credit:1000n},calls=[];
 const rpc={getBlockNumber:async()=>123,call:async(tx,block)=>{
  assert.equal(block,123);const erc=tx.to.toLowerCase()===USDT.toLowerCase(),i=erc?ERC20:abi,f=i.parseTransaction(tx);calls.push(f);
  if(state.fail)throw Error('RPC timeout');const name=Object.keys(changes).find(k=>change(k)===f.name)||f.name;
  let val;
  if(name==='stats')val={sold:state.sold,started:state.started,freeRound:state.started&&!state.expired&&state.sold<10n,open:state.sold>=100n,expired:state.expired,soldOut:state.sold>=1000n,tierLeft:state.sold<100n?100n-state.sold:500n,sharesLeft:1000n-state.sold};
  else if(name==='userInfo')val={hasAgentId:state.eligible,freeUsed:state.used,limitLeft:state.limit};
  else if(name==='quote'){const n=state.partial?f.args[0]-1n:f.args[0];return i.encodeFunctionResult(f.fragment,[n*2000n,n*3000n,n*state.credit,n]);}
  else if(name==='claimFree'){assert.equal(BigInt(tx.value),0n);if(state.sold>=10n)throw {data:abi.encodeErrorResult('FreeRoundOver')};assert.ok(state.eligible&&!state.used);return '0x';}
  else if(name==='mintShares'){const [n,ref,stable,cap,out]=f.args;assert.ok(state.sold>=10n);assert.equal(out,n*state.credit*99n/100n);assert.equal(BigInt(tx.value),stable?0n:n*2000n);assert.equal(cap,stable?n*3000n:0n);assert.ok(state.sold>=100n||n<=state.limit);return '0x';}
  else val={token:T,usdt:USDT,FREE_TOKENS:100n,FREE_SHARES:10n,OPEN_SHARE:100n,allowance:state.allowance,balanceOf:state.balance}[name];
  assert.notEqual(val,undefined,name);return i.encodeFunctionResult(f.fragment,[val]);
 }};
 const intent={account:1,scope:'all',quantity:'max',maxBnb:'0.00000000000002',maxUsdt:'0',referral:'account1',slippageBps:100};
 const plan=i=>mintPlan(rpc,{call:()=>assert.fail('no wallet calls')},{...intent,...i},A,{source:'https://new-unseen.example/',referralHints:{detected:true,templates:[],signals:[]}},null,{sourceLoader:async()=>meta,chainLearner:{learn:()=>assert.fail('no historical fallback')}});
 return {abi,meta,state,calls,rpc,intent,plan};
}
test('source-based staged mint handles new function/parameter/constant names without domain pins or history',async()=>{
 for(const rename of [false,true]){const f=fixture(rename),p=recognizeStagedQuoteMint(f.meta);assert.equal(p.kind,'staged-quote');const out=await f.plan();assert.equal(out.quantity,10);assert.equal(out.amountIn,'20000');assert.equal(out.minOutput,'9900');assert.equal(out.requireAssetCredit,true);assert.equal(out.freshBeforeExecute,true);assert.equal(f.calls.filter(c=>c.fragment.stateMutability==='payable').length,1);}
});
test('four wallets get independent paid plans and only applicable paid referrals use account one',async()=>{
 const f=fixture();for(const w of bindings()){const p=await f.plan({account:w.account});const args=f.abi.parseTransaction(p.steps[0]).args;assert.equal(args[1],[2,3].includes(w.account)?wallet(1).address:zero);assert.equal(p.quantity,10);}
});
test('zero-argument free entry does not inherit a paid-only invitation requirement',async()=>{
 const f=fixture();f.state.sold=3n;
 for(const account of [1,2,3,4]){const p=await f.plan({account,scope:'free',maxBnb:'0'});assert.equal(p.quantity,1);assert.equal(p.amountIn,'0');assert.equal(p.minOutput,'100');assert.equal(f.abi.parseTransaction(p.steps[0]).name,'claimFree');}
 await assert.rejects(f.plan({scope:'paid'}),e=>e.code==='MINT_NOT_OPEN');
});
test('free ended, ineligible, expired, unknown paid maximum and zero budget have distinct outcomes',async()=>{
 const f=fixture();await assert.rejects(f.plan({scope:'free',maxBnb:'0'}),e=>e.code==='NO_QUOTA'&&/免费阶段已结束/.test(e.message));await assert.rejects(f.plan({maxBnb:'0'}),e=>e.code==='BUDGET_LIMIT');
 f.state.eligible=false;await assert.rejects(f.plan(),e=>e.code==='MINT_INELIGIBLE');f.state.eligible=true;f.state.limit=0n;await assert.rejects(f.plan(),e=>e.code==='NO_QUOTA');
 f.state.expired=true;await assert.rejects(f.plan(),e=>e.code==='MINT_ENDED');f.state.expired=false;f.state.started=false;await assert.rejects(f.plan(),e=>e.code==='MINT_NOT_OPEN');
 f.state.started=true;f.state.sold=120n;await assert.rejects(f.plan(),e=>e.code==='MINT_QUOTA_UNKNOWN');f.state.eligible=false;assert.equal((await f.plan({quantity:3})).quantity,3);
});
test('manual quantity, live output quote, budget and pre-open boundary are honored',async()=>{
 const f=fixture();assert.equal((await f.plan({quantity:3})).amountIn,'6000');assert.equal((await f.plan({maxBnb:'0.000000000000005'})).quantity,2);
 f.state.sold=98n;const p=await f.plan();assert.equal(p.quantity,2);assert.equal(p.fill.continue,false);
 f.state.partial=true;await assert.rejects(f.plan(),e=>e.code==='MINT_STATE');f.state.partial=false;f.state.sold=120n;f.state.credit=250n;assert.equal((await f.plan({quantity:3})).minOutput,'742');
});
test('explicit route cannot silently switch lane or conflict with a free-only instruction',async()=>{
 const f=fixture(),p=recognizeStagedQuoteMint(f.meta);await assert.rejects(f.plan({routeId:'staged:'+p.freeMethod}),e=>e.code==='NO_QUOTA');await assert.rejects(f.plan({scope:'free',routeId:'staged:'+p.method}),e=>['MINT_ROUTE_INVALID','NO_QUOTA'].includes(e.code));
 assert.equal((await f.plan({routeId:'staged:'+p.method,quantity:2})).quantity,2);
});
test('USDT mode is explicit, approval exact and cannot be mistaken for the native branch',async()=>{
 const f=fixture();const p=await f.plan({maxBnb:'0',maxUsdt:'0.00000000000003'});assert.equal(p.inputToken,USDT);assert.equal(p.amountIn,'30000');assert.deepEqual(p.steps.map(s=>s.kind),['approve','mint']);assert.equal(p.steps[0].allowance,'30000');assert.equal(p.approvalFirst,true);assert.equal(f.calls.filter(c=>c.name==='mintShares').length,0);
 f.state.allowance=30000n;const ready=await f.plan({maxBnb:'0',maxUsdt:'0.00000000000003'});assert.equal(ready.steps.length,1);f.state.balance=1n;await assert.rejects(f.plan({maxBnb:'0',maxUsdt:'0.00000000000003'}),e=>e.code==='BUDGET_LIMIT');
});
test('RPC failures and inconsistent/zero asset quotes never become invented quota or a payable plan',async()=>{
 const f=fixture();f.state.fail=true;await assert.rejects(f.plan(),/RPC timeout/);f.state.fail=false;f.state.credit=0n;await assert.rejects(f.plan(),e=>e.code==='MINT_STATE');
});
test('source proof rejects proxy/unverified/ambiguous contracts, wrong recipient, changed quote formula or payment guard',()=>{
 const f=fixture();for(const m of [{...f.meta,verified:false},{...f.meta,proxy:true},{...f.meta,identity:{implementation:A}},{...f.meta,sources:{a:{content:source},b:{content:source}}}])assert.equal(recognizeStagedQuoteMint(m),null);
 for(const [a,b]of [['token.mint(msg.sender,out)','token.mint(treasury,out)'],['bnbCost=filled*PRE_PRICE','bnbCost=filled*OTHER_PRICE'],['msg.value<cost','msg.value<1'],['(filled,bnbCost,tokensOut)','(filled,tokensOut,bnbCost)'],['if(n>limitLeft(id))','if(n<limitLeft(id))'],['_checkLive(); uint n=sold','_bindReferral(); _checkLive(); uint n=sold']]){
  const m={...f.meta,sources:{a:{content:source.replace(a,b)}}};if(a.startsWith('_checkLive'))m.sources.a.content=m.sources.a.content.replace('function _checkLive()', 'function _bindReferral() private {} function _checkLive()');assert.equal(recognizeStagedQuoteMint(m),null,a);
 }
});
test('custom phase errors are decoded from verified ABI and no longer masquerade as unsupported mint',()=>{
 const f=fixture();for(const [name,code]of [['FreeRoundOver','NO_QUOTA'],['FreeAlreadyTaken','NO_QUOTA'],['FreeRoundOpen','MINT_NOT_OPEN'],['AgentIdRequired','MINT_INELIGIBLE'],['SaleExpired','MINT_ENDED']])assert.equal(mintError({data:f.abi.encodeErrorResult(name)},f.meta.abi).code,code);
});
test('bounded native max and explicit counts auto-budget from verified quote; manual cap is not raised',async()=>{
 const f=fixture(),s=await stagedQuoteState(f.rpc,f.intent,f.meta,wallet(1),undefined,{includeBudget:true});const project={address:A,token:T,budgetPolicy:'verified-staged-quote',quotas:[1,2,3,4].map(account=>({account,...s.info}))};
 const b=corlaBudget(project,[1,2,3,4],'all','MAX');assert.equal(b.maxBnb,'0.00000000000002');assert.equal(b.total,'0.00000000000008');assert.equal(corlaBudget(project,[1],'paid','3').maxBnb,'0.000000000000006');assert.equal(corlaBudget(project,[1],'free','max'),null);
 assert.equal(await refreshMintBudget({project,scope:'all',quantity:'max',manual:true},()=>assert.fail('manual cap')),null);
 assert.ok((await refreshMintBudget({project,accounts:[1],scope:'paid',quantity:'3'},async()=>project)).budget);
 await assert.rejects(refreshMintBudget({project,accounts:[1],scope:'all',quantity:'max'},async()=>({...project,token:A})),/发生变化/);
 project.quotas[0].error='RPC failed';assert.equal(corlaBudget(project,[1,2],'all','max').costs.length,1);project.quotas[1].unboundedPaid=true;assert.throws(()=>corlaBudget(project,[2],'all','max'),/项目总库存/);
});
