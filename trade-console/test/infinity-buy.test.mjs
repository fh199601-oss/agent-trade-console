import test from 'node:test';import assert from 'node:assert/strict';import {AbiCoder} from 'ethers';
import {Interface,BNB,WBNB,USDT,ZeroAddress,ERC20,same,bindings} from '../lib/common.mjs';
import {INFINITY,INF_ROUTER,INF_QUOTER,INF_MANAGER,POOL_KEY,PERMIT2,infinityId,verifyInfinityApproval} from '../lib/infinity.mjs';
import {infinityBuyData,infinityBuyPool,infinityBuySettlement,INFINITY_BUY} from '../lib/infinity-buy.mjs';
import {primaryBuyPlan} from '../lib/primary-buy.mjs';import {TradeConversions} from '../lib/trade-conversion.mjs';import {verifyPreview} from '../lib/engine.mjs';
const coder=AbiCoder.defaultAbiCoder(),owner=bindings()[0],token='0x'+'f4'.repeat(20),other='0x'+'f5'.repeat(20),amount=10n**16n,output=amount*9975n/10000n;
const E=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)','event Deposit(address indexed dst,uint256 wad)','event Withdrawal(address indexed src,uint256 wad)']);
const log=(a,abi,name,args)=>({address:a,...abi.encodeEventLog(abi.getEvent(name),args)});
function make(currency){const key=[currency,token,ZeroAddress,INFINITY.factory,2500,'0x'+'00'.repeat(32)];return {...INFINITY,key,pool:infinityId(key),token,token0:currency,token1:token,quote:same(currency,ZeroAddress)?WBNB:currency,nativeQuote:same(currency,ZeroAddress),protocolFee:0,lpFee:2500,fee:2500,sqrtPriceX96:String(1n<<96n),liquidity:'100000000000000000000',block:99,liquid:true,declaredByToken:true};}
for(const [pay,currency,commands,actions] of [[BNB,ZeroAddress,'0x10','0x060c0f'],[BNB,WBNB,'0x0b10','0x060b0f'],[WBNB,ZeroAddress,'0x020c10','0x060c0f'],[WBNB,WBNB,'0x10','0x060c0f'],[USDT,USDT,'0x10','0x060c0f']])test('Infinity buy exact payment '+pay.slice(-4)+' / '+currency.slice(-4),async()=>{
 const pool=make(currency),minimum=output*99n/100n,data=infinityBuyData(pool,pay,token,owner.address,amount,minimum),tx=INF_ROUTER.decodeFunctionData('execute',data);
 assert.equal(tx[0],commands);const [a,params]=coder.decode(['bytes','bytes[]'],tx[1].at(-1));assert.equal(a,actions);
 const [swap]=coder.decode([`(${POOL_KEY},bool,uint128,uint128,bytes)`],params[0]);assert.equal(swap[1],true);assert.equal(swap[2],amount);assert.equal(swap[3],minimum);
 const take=coder.decode(['address','uint256'],params.at(-1));assert.ok(same(take[0],token));assert.equal(take[1],minimum);
 const rpc={call:async t=>{
  if(same(t.to,INFINITY.quoter)){const q=INF_QUOTER.parseTransaction(t).args[0];assert.equal(q[1],true);assert.equal(q[2],amount);return INF_QUOTER.encodeFunctionResult('quoteExactInputSingle',[output,200000]);}
  if(same(t.to,INFINITY.permit2))return PERMIT2.encodeFunctionResult('allowance',[0,0,0]);
  return ERC20.encodeFunctionResult('allowance',[0]);
 }};
 const prep={venue:async()=>({assets:[]}),token:async()=>({identity:{fingerprint:'mock'}}),quote:async()=>({decimals:18})};
 const converter=new TradeConversions(rpc,{prep}),currencyName=pay===BNB?'BNB':pay===WBNB?'WBNB':'USDT',intent={side:'buy',account:owner.account,asset:token,currency:currencyName,slippageBps:100};
 const plan=await primaryBuyPlan(rpc,intent,{wallet:owner.address,token,inputToken:pay,amountIn:String(amount),holdingBefore:'0',decimals:18,slippage:{bps:100,capBps:100}},{converter,scan:async()=>({pools:[pool]})});
 assert.equal(plan.route,INFINITY_BUY);assert.equal(plan.steps.length,pay===BNB?1:3);assert.equal(plan.poolFees.quoteLossPpm,2500);
 for(const s of plan.steps.filter(s=>s.approvalType))verifyInfinityApproval(s,plan);
 const step=plan.steps.at(-1),preview={requestId:'mock',simulationResult:{simulationCode:'000000000',balanceChanges:[{owner:owner.address,contractAddress:pay,change:'-'+amount},{owner:owner.address,contractAddress:token,change:String(output)}]}};
 assert.doesNotThrow(()=>verifyPreview(preview,plan,step));
 const logs=[log(INFINITY.factory,INF_MANAGER,'Swap',[pool.pool,INFINITY.router,-amount,output,1n<<96n,1000000,0,2500,0]),log(token,E,'Transfer',[INFINITY.vault,owner.address,output])];
 if(pay!==BNB)logs.push(log(pay,E,'Transfer',[owner.address,currency===ZeroAddress?INFINITY.router:INFINITY.vault,amount]));
 if(pay===BNB&&currency===WBNB)logs.push(log(WBNB,E,'Deposit',[INFINITY.router,amount]));
 if(pay===WBNB&&currency===ZeroAddress)logs.push(log(WBNB,E,'Withdrawal',[INFINITY.router,amount]));
 const args={receipt:{logs},wallet:owner.address,state:plan.state,plan,step};assert.equal(infinityBuySettlement(args).amountOut,output);
 assert.throws(()=>infinityBuySettlement({...args,receipt:{logs:logs.filter(l=>!same(l.address,token))}}),/足额到账/);
 assert.throws(()=>infinityBuySettlement({...args,plan:{...plan,wallet:other}}),/身份/);
});
test('Infinity reverse-side protocol fee is recomputed and wrong assets or missing proof are rejected',()=>{
 const p={...make(WBNB),protocolFee:3000|(100<<12)};assert.equal(infinityBuyPool(p,token).fee,5493);
 assert.throws(()=>infinityBuyData(p,USDT,token,owner.address,amount,output),/付款币/);
 assert.throws(()=>infinityBuyPool({...p,protocolFee:undefined},token),/费率/);
 assert.throws(()=>infinityBuyPool({...p,pool:'0x'+'ff'.repeat(32)},token),/身份/);
});
