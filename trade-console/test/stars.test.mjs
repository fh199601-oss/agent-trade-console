import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {STARS,STARS_ABI as M,STARS_SUPPLY,starsInput,verifyStarsReceipt,verifyStarsReferralResponse,STARS_TEMPLATE} from '../lib/stars.mjs';
import {Engine,verifyPreview} from '../lib/engine.mjs';
import {discover} from '../lib/discovery.mjs';
import {BNB,ZeroAddress} from '../lib/common.mjs';
const tokenCode=fs.readFileSync(new URL('./fixtures/stars-token.txt',import.meta.url),'utf8');
const C=STARS.config,w='0x1111111111111111111111111111111111111111',ref='0x2222222222222222222222222222222222222222',key='0x'+'ab'.repeat(32),refkey='0x'+'cd'.repeat(32);
function fixture(){
 const step={kind:'mint',to:C.factory,value:'50000000000000000',data:M.encodeFunctionData('mint',[C.token,50,ref])};
 const plan={route:'stars:mint',identity:STARS.identities.factory,protocolIdentities:[{...STARS.identities.token,code:tokenCode}],token:C.token,wallet:w,inputToken:BNB,outputToken:C.token,amountIn:step.value,minOutput:'133300000000000000000000',quantity:50,metaVerified:false,requireAssetCredit:true,expectedAsset:{token:C.token,kind:'Erc20',amount:'133300000000000000000000'},stars:{key,used:'0',seen:false,balanceBefore:'0',allowanceBefore:'0',automaticAllowance:true,mode:0,price:'1000000000000000',units:'2666000000000000000000',marketing2:C.marketing2},referral:{address:ref,key:refkey,bind:true},steps:[step]};
 const p={requestId:'synthetic-test',parsedTx:{contractAddress:C.factory},simulationResult:{simulationCode:'000000000',authorityChanges:[],balanceChanges:[{owner:w,contractAddress:BNB,change:'-'+step.value,tokenType:'Native'},{owner:w,contractAddress:C.token,change:plan.minOutput,tokenType:'Erc20'}],allowanceChanges:[{owner:w,tokenAddress:C.token,spender:C.factory,preAmount:'0',postAmount:String(STARS_SUPPLY),tokenType:'Erc20'}]}};
 return {plan,step,p};
}
test('Stars platform URLs route directly; trades still use token CA',async()=>{
 for(const s of [C.token,'https://starsagent.org/','starsagent.org','https://starsagent.org/token/'+ref+'?ref=demo.ai#mint','https://www.starsagent.org/token/'+ref+'/'])assert.equal(starsInput(s),true);
 for(const s of [C.factory,'https://evil@starsagent.org/token/'+C.token,'https://starsagent.org.evil/token/'+C.token,'https://starsagent.org/token/'+ref+'/other','https://starsagent.org:444/token/'+ref])assert.equal(starsInput(s),false);
 const rpc=new Proxy({},{get(){throw Error('Must not read Mint metadata for a sale');}});
 assert.equal((await discover(C.token,{rpc,corlaRouting:false})).address.toLowerCase(),C.token.toLowerCase());
});
test('only the exact pinned StarsAI auto allowance survives the generic guard',()=>{
 const {p,plan,step}=fixture();assert.doesNotThrow(()=>verifyPreview(p,plan,step));
 for(const edit of [x=>x.route='other',x=>x.identity={...x.identity,fingerprint:'changed'},x=>x.protocolIdentities=[],x=>x.token=ref,x=>x.outputToken=ref,x=>x.inputToken=ref,x=>x.minOutput='1',x=>x.amountIn='1',x=>x.stars.balanceBefore='1',x=>x.stars.allowanceBefore='1',x=>x.referral.address=w]){
  const c=structuredClone(plan);edit(c);assert.throws(()=>verifyPreview(p,c,step));
 }
 for(const edit of [x=>x.spender=ref,x=>x.tokenAddress=ref,x=>x.owner=ref,x=>x.postAmount='1',x=>x.postAmount=Number(STARS_SUPPLY),x=>x.preAmount='1',x=>x.tokenType='Erc721']){
  const c=structuredClone(p);edit(c.simulationResult.allowanceChanges[0]);assert.throws(()=>verifyPreview(c,plan,step));
 }
 for(const edit of [x=>x.to=ref,x=>x.value='1',x=>x.data=M.encodeFunctionData('mint',[C.token,51,ref]),x=>x.data+='00',x=>x.kind='approve']){
  const c=structuredClone(step);edit(c);assert.throws(()=>verifyPreview(p,plan,c));
 }
});
test('official nested referral response must name the requested wallet, chain and factory',()=>{
 const response={identity:{name:'demo.ai',address:ref},chainId:56,factory:C.factory};
 assert.doesNotThrow(()=>verifyStarsReferralResponse(response,{address:ref}));
 for(const edit of [x=>x.chainId=1,x=>x.factory=ref,x=>x.identity.name='invalid',x=>x.identity.address=w,x=>delete x.identity]){
  const changed=structuredClone(response);edit(changed);assert.throws(()=>verifyStarsReferralResponse(changed,{address:ref}));
 }
});
test('extra authority, allowance, debit, missing allowance and insufficient credit fail closed',()=>{
 for(const edit of [s=>s.authorityChanges.push({}),s=>s.allowanceChanges.push({...s.allowanceChanges[0]}),s=>s.allowanceChanges=[],s=>s.balanceChanges[0].change='-50000000000000001',s=>s.balanceChanges[1].change='1',s=>s.balanceChanges.push({owner:w,contractAddress:C.token,change:'-1'})]){
  const {p,plan,step}=fixture();edit(p.simulationResult);assert.throws(()=>verifyPreview(p,plan,step));
 }
 const {p,plan,step}=fixture();plan.stars={...plan.stars,balanceBefore:'100',allowanceBefore:String(STARS_SUPPLY),automaticAllowance:false};p.simulationResult.allowanceChanges=[];assert.doesNotThrow(()=>verifyPreview(p,plan,step));
});
test('StarsAI receipts prove both exact shares and the requested invitation',()=>{
 const {plan}=fixture();
 const mint=(shares=50n,who=w,id=key)=>({address:C.factory,...M.encodeEventLog(M.getEvent('Minted'),[C.token,who,id,shares,1000])});
 const bind=(who=ref,id=refkey)=>({address:C.factory,...M.encodeEventLog(M.getEvent('ReferralBound'),[C.token,id,key,who])});
 assert.equal(verifyStarsReceipt({logs:[mint(),bind()]},plan).quantity,'50');
 for(const logs of [[mint()],[mint(49n),bind()],[mint(50n,ref),bind()],[mint(50n,w,refkey),bind()],[mint(),bind(w)],[mint(),bind(ref,key)],[mint(),bind(),bind()]])assert.throws(()=>verifyStarsReceipt({logs},plan));
});
test('a simulation-only StarsAI order cannot be promoted into a live execution',async t=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'stars-readonly-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 let executes=0;const {plan,p}=fixture(),bridge={ready:async()=>({}),call:async(a,args)=>{if(args[1]==='execute'){executes++;throw Error('Forbidden');}return p;}};
 const engine=new Engine({data,live:false,rpc:{},bridge,planFn:async()=>plan});
 const intent={account:2,side:'mint',asset:C.token,quantity:50,maxBnb:'0.05',scope:'paid'};
 const prepared=await engine.prepare(intent,'stars-preparation');assert.equal(prepared.status,'PREPARED');
 engine.live=true;
 await assert.rejects(engine.execute('stars-preparation',{authorization:'synthetic',acknowledgeReview:true}),/模拟|重新/);
 assert.equal(executes,0);
});
