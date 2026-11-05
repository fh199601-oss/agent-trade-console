import {Interface} from 'ethers';
import {DEXES} from '../../lib/opening-dex.mjs';
import {BNB,WBNB,USDT} from '../../lib/common.mjs';
export const addresses={token:'0x'+'1'.repeat(40),pool:'0x'+'2'.repeat(40),owner:'0x'+'3'.repeat(40),tax:'0x'+'4'.repeat(40)};
const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)','event Withdrawal(address indexed src,uint256 wad)','event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
export function settlementFixture({dex=DEXES[0],native=true,reverse=false,nested=true,taxToRouter=false,quoteTax=false}={}){
 const {token,pool,owner,tax}=addresses,quote=native?WBNB:USDT,recipient=native?dex.router:owner;
 const state={kind:dex.kind,factory:dex.factory,pool,quote,token0:reverse?quote:token,token1:reverse?token:quote};
 const plan={kind:'contract',route:dex.id+'-opening',token,wallet:owner,inputToken:token,outputToken:native?BNB:quote,amountIn:'1000',minOutput:'100',holdingBefore:'2000',state,steps:[]};
 const step={kind:'sell',to:dex.router,value:'0',data:'0x12345678'};plan.steps=[step];
 const log=(address,name,args)=>({address,...abi.encodeEventLog(abi.getEvent(name),args)});
 const transfer=(asset,from,to,value)=>log(asset,'Transfer',[from,to,value]);
 const v3=new Interface(['event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick'+(dex.id==='pancake-v3'?',uint128 protocolFeesToken0,uint128 protocolFeesToken1':'')+')']);
 const swap=(input,output,to)=>dex.kind==='v3'?{address:pool,...v3.encodeEventLog(v3.getEvent('Swap'),[dex.router,to,...(reverse?[-output,input]:[input,-output]),1,1,0,...(dex.id==='pancake-v3'?[0,0]:[])])}:log(pool,'Swap',[dex.router,...(reverse?[0,input,output,0]:[input,0,0,output]),to]);
 const logs=[];
 if(nested){logs.push(transfer(token,tax,pool,10000),transfer(quote,pool,taxToRouter?dex.router:tax,2000),swap(10000,2000,taxToRouter?dex.router:tax));if(native&&taxToRouter)logs.push(log(WBNB,'Withdrawal',[dex.router,2000]));}
 const paid=quoteTax?180:200,output=[transfer(quote,pool,recipient,paid),...(quoteTax?[transfer(quote,pool,tax,20)]:[])];
 if(dex.kind==='v3')logs.push(...output);
 logs.push(transfer(token,owner,tax,30),transfer(token,owner,pool,970));
 if(dex.kind==='v2')logs.push(...output);
 logs.push(swap(970,200,recipient));if(native)logs.push(log(WBNB,'Withdrawal',[dex.router,200]));
 const hash='0x'+'a'.repeat(64),receipt={transactionHash:hash,from:owner,to:dex.router,status:'0x1',logs},tx={hash,from:owner,to:dex.router,input:step.data,value:'0x0'};
 return {receipt,tx,token,state,wallet:owner,plan,step,log,transfer,swap,hash};
}
