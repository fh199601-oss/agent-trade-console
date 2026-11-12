import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {SellCoordinator,sellLane} from '../lib/sell-coordinator.mjs';import {Engine} from '../lib/engine.mjs';
import {bindings,ERC20,BNB,WBNB,same} from '../lib/common.mjs';import {DEXES,QUOTER,V3_LEGACY} from '../lib/opening-dex.mjs';import {MULTICALL,MULTI} from '../lib/opening-read.mjs';
const wallets=bindings().slice(0,3),token='0x'+'b1'.repeat(20),pool='0x'+'b2'.repeat(20),dex=DEXES.find(x=>x.id==='pancake-v3');
const tick=()=>new Promise(r=>setImmediate(r));
test('conflicting sells queue, unrelated pools remain parallel, exceptions release the lane',async()=>{const c=new SellCoordinator(),a=await c.enter('one');let entered=false;const b=c.enter('one').then(x=>{entered=true;return x;});await tick();assert.equal(entered,false);const d=await c.enter('two');d.release();a.release();const next=await b;assert.equal(next.waited,true);next.release();assert.equal(c.tails.size,0);assert.equal(sellLane({token,opening:{pool}},{kind:'approve'}),null);});
for(const [fastReturn,staggered] of [[false,false],[true,false],[false,true]])test('three same-pool sales refresh after prior receipt, retain 1% slippage and never resend; fastReturn='+fastReturn+', staggered='+staggered,async t=>{
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'sell-lane-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));let price=1000000n,submits=0,sequence=0;
 const requests=new Map(),submitted=[];
 const callData=(w,min)=>V3_LEGACY.encodeFunctionData('exactInputSingle',[[token,WBNB,2500,w.address,Math.floor(Date.now()/1000)+120,500n,min,0]]);
 const plan=intent=>{const w=wallets.find(w=>w.account===intent.account);return {kind:'contract',account:w.account,wallet:w.address,token,inputToken:token,outputToken:WBNB,amountIn:'500',holdingBefore:'1000',decimals:18,outputDecimals:18,minOutput:'990000',route:'pancake-v3-opening',opening:{...dex,pool,token,token0:token,token1:WBNB,quote:WBNB,fee:2500,kind:'v3'},requireSellCredit:true,slippage:{mode:'auto',bps:100,capBps:5000},quote:{toCoinAmount:'0.000000000001'},poolFees:{poolFeePpm:2500},audit:{available:true,taxes:{sellTax:'0'}},review:[],steps:[{kind:'sell',to:dex.router,value:'0',data:callData(w,990000n)}]};};
 const rpc={getBlockNumber:async()=>100,call:async tx=>{
  if(same(tx.to,token))return ERC20.encodeFunctionResult('balanceOf',[1000n]);
  if(same(tx.to,MULTICALL))return MULTI.encodeFunctionResult('tryBlockAndAggregate',[100,'0x'+'00'.repeat(32),[[true,QUOTER.encodeFunctionResult('quoteExactInputSingle',[price,0,0,0])]]]);
  throw Error('unexpected read');
 }};
 const bridge={ready:async()=>{},call:async(a,args)=>{if(args[1]==='preview'){const data=args[args.indexOf('--inputData')+1],v=V3_LEGACY.parseTransaction({data}).args[0],id='request'+(++sequence);requests.set(id,{account:a,minimum:v.amountOutMinimum,amount:v.amountIn});return {requestId:id,simulationResult:{simulationCode:'000000000',balanceChanges:[{owner:wallets.find(w=>w.account===a).address,contractAddress:WBNB,change:String(price)}]}};}
  const req=requests.get(args.at(-1));assert.equal(req.amount,500n);assert.ok(req.minimum<=price,'stale quote must not be submitted');submitted.push(req);submits++;return {txHash:'0x'+String(submits).padStart(64,'0')};}};
 const e=new Engine({rpc,bridge,data,live:true,planFn:async i=>plan(i)});
 e.observeContract=async(o,s,timeout)=>{if(fastReturn&&timeout===0)return;await new Promise(r=>setTimeout(r,5));if(s.status!=='CONFIRMED'){s.status='CONFIRMED';price=price*80n/100n;}};
 const intents=wallets.map(w=>({account:w.account,side:'sell',asset:token,percent:'50',currency:'WBNB',slippageMode:'auto',slippageBps:5000}));
 await Promise.all(intents.map((i,n)=>e.prepare(i,'sale'+n)));
 const submit=n=>e.execute('sale'+n,{authorization:'synthetic fixture',swapReceiptWaitMs:fastReturn?0:10000});const results=[];if(staggered){for(let n=0;n<intents.length;n++)results.push(await submit(n));}else results.push(...await Promise.all(intents.map((_,n)=>submit(n))));
 assert.equal(submits,wallets.length);assert.ok(results.every(o=>['PENDING','CONFIRMED'].includes(o.status)),JSON.stringify(results.map(o=>o.error)));
 assert.deepEqual(submitted.map(s=>String(s.minimum)),['990000','792000','633600'].slice(0,wallets.length));assert.ok(results.every(o=>o.plan.slippage.bps===100));
 const before=submits;await e.execute('sale0',{authorization:'same fixture'});assert.equal(submits,before);
});
