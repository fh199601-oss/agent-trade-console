import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {STARS_MODES} from '../lib/stars.mjs';import {primaryBuyPlan} from '../lib/primary-buy.mjs';
import {TradeConversions} from '../lib/trade-conversion.mjs';import {openingPlan} from '../lib/opening-route.mjs';
import {Engine,verifyPreview} from '../lib/engine.mjs';import {OpeningSell} from '../lib/opening-sell.mjs';
import {BNB,WBNB,ERC20,Interface,bindings,same} from '../lib/common.mjs';import {DEXES,QUOTER,V3_LEGACY} from '../lib/opening-dex.mjs';
const code=fs.readFileSync(new URL('./fixtures/stars-token.txt',import.meta.url),'utf8'),token='0x'+'97'.repeat(20),pool='0x'+'98'.repeat(20),d=DEXES.find(x=>x.id==='pancake-v3'),one=10n**18n;
const PRICE=new Interface(['function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint32,bool)']);
function fixture(mode){
 const units=STARS_MODES[mode].units,owner=bindings()[0].address,requests=[],p={...d,token,quote:WBNB,pool,token0:token,token1:WBNB,fee:100,liquid:true,liquidity:String(1000000000n*one),block:100,declaredByToken:true};
 const rpc={verifyChain:async()=>{},getBalance:async()=>one,call:async tx=>{
  requests.push(tx);
  if(same(tx.to,d.quoter)){const q=QUOTER.parseTransaction(tx);return QUOTER.encodeFunctionResult(q.name,[q.args[0].amountIn*9999n/10000n,1n<<96n,0,100000]);}
  if(same(tx.to,pool))return PRICE.encodeFunctionResult('slot0',[1n<<96n,0,0,0,0,0,true]);
  const q=ERC20.parseTransaction(tx);if(q.name==='balanceOf')return ERC20.encodeFunctionResult(q.name,[units*3n]);if(q.name==='allowance')return ERC20.encodeFunctionResult(q.name,[2n**255n]);if(q.name==='decimals')return ERC20.encodeFunctionResult(q.name,[18]);throw Error('Unexpected read '+q.name);
 }};
 const prep={token:async()=>({identity:{target:token,code,fingerprint:'synthetic'},decimals:18}),venue:async()=>({assets:[]}),quote:async()=>({decimals:18})};
 let opened=true;const scan=async()=>({token,at:Date.now(),block:100,open:opened,pools:opened?[p]:[],partial:false});
 return {rpc,prep,scan,owner,p,units,requests,setOpen:v=>opened=v,converter:new TradeConversions(rpc,{prep})};
}
for(const mode of [0,1,2,3]){
 test(`${STARS_MODES[mode].id}: 1% buy slippage protects NET receipt after 2% buy tax`,async()=>{
  const f=fixture(mode),amount=one/100n,i={side:'buy',account:1,currency:'BNB',slippageBps:100},p=await primaryBuyPlan(f.rpc,i,{token,wallet:f.owner,inputToken:BNB,amountIn:String(amount),holdingBefore:'0',decimals:18,slippage:{bps:100,capBps:100}},f);
  const net=amount*9999n/10000n-2n*(amount*9999n/10000n/100n),min=net*99n/100n,step=p.steps.at(-1),args=V3_LEGACY.decodeFunctionData('exactInputSingle',step.data)[0];
  assert.equal(p.primaryPool,pool);assert.equal(p.minOutput,String(min));assert.equal(args.amountOutMinimum,(min*100n+97n)/98n);assert.ok(args.amountOutMinimum-2n*(args.amountOutMinimum/100n)>=min);
  const preview={requestId:'synthetic',parsedTx:{contractAddress:d.router},simulationResult:{simulationCode:'000000000',balanceChanges:[{owner:f.owner,contractAddress:BNB,change:String(-amount)},{owner:f.owner,contractAddress:token,change:String(net),tokenType:'Erc20'}]}};
  assert.doesNotThrow(()=>verifyPreview(preview,p,step));preview.simulationResult.balanceChanges[1].change=String(min-1n);assert.throws(()=>verifyPreview(preview,p,step));
 });
 test(`${STARS_MODES[mode].id}: manual sale and opening sale use same primary and fresh wallet amounts`,async()=>{
  const f=fixture(mode),i={side:'sell',asset:token,account:1,currency:'BNB',slippageBps:100,percent:'50'};
  for(const openingOnly of [false,true]){const p=await openingPlan(f.rpc,{}, {...i,...(openingOnly?{openingOnly:true}:{})},{scan:f.scan,preparation:f.prep});assert.equal(p.opening.pool,pool);assert.equal(p.opening.declaredByToken,true);assert.equal(p.amountIn,String(f.units*3n/2n));assert.equal(p.minOutput,String(f.units*3n/2n*9999n/10000n*99n/100n));assert.equal(p.steps.at(-1).to,d.router);}
  f.setOpen(false);await assert.rejects(openingPlan(f.rpc,{}, {...i,openingOnly:true},{scan:f.scan,preparation:f.prep}),{code:'OPENING_WAIT'});
 });
}
test('Stars opening tasks wait, simulate four wallets independently, never sign or re-arm on restart',async t=>{
 const f=fixture(2),data=fs.mkdtempSync(path.join(os.tmpdir(),'stars-opening-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 let previews=0;const bridge={ready:async()=>{},call:async(account,args)=>{
  assert.deepEqual(args.slice(0,2),['contract-call','preview']);previews++;
  if(account===2)throw Error('本钱包 Gas 余额不足');
  const owner=bindings().find(w=>w.account===account).address;
  return {requestId:'synthetic-'+account,simulationResult:{simulationCode:'000000000',balanceChanges:[{owner,contractAddress:token,change:String(-f.units*3n)},{owner,contractAddress:BNB,change:String(f.units*3n*9999n/10000n)}]}};
 }};
 const engine=new Engine({rpc:f.rpc,bridge,data,live:false,planFn:i=>openingPlan(f.rpc,bridge,i,{scan:f.scan,preparation:f.prep})}),opening=new OpeningSell({engine,rpc:f.rpc,bridge,data,detector:{scan:f.scan},autoSchedule:false});t.after(()=>opening.close());
 f.setOpen(false);const checked=await opening.check({asset:token,accounts:[1,2,3,4],percent:'100',slippageBps:100,currency:'BNB'}),job=opening.arm(checked.id,{confirmed:true});
 assert.equal(job.status,'ARMED');await opening.tick(job.id);assert.equal(previews,0);
 f.setOpen(true);await opening.tick(job.id);assert.ok(previews>=4);assert.equal(engine.list().length,4);assert.equal(engine.get(job.rows.find(r=>r.account===2).orderId).status,'BLOCKED');
 for(const o of engine.list()){assert.equal(o.simulationOnly,true);assert.ok(!o.txHash&&!o.orderId);if(o.intent.account!==2)assert.equal(o.status,'SIMULATED');}
 opening.close();
 const restarted=new OpeningSell({engine,rpc:f.rpc,bridge,data,detector:{scan:f.scan},autoSchedule:false});t.after(()=>restarted.close());assert.equal(restarted.jobs.get(job.id).status,'PAUSED');assert.equal(previews,4);
});
