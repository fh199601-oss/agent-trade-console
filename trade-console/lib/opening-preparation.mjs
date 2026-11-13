import {infinityVenue} from './infinity.mjs';
import {keccak256} from 'ethers';
import {address,read,ERC20,WBNB,wallet,percentOf,same,formatUnits} from './common.mjs';
import {codeIdentity} from './discovery.mjs';
import {DEXES,V2_ROUTER_ABI,V3_IMMUTABLE} from './opening-dex.mjs';
import {openingReads} from './opening-read.mjs';
export class OpeningPreparation{
 constructor(rpc,{now=Date.now,identityFor=codeIdentity}={}){Object.assign(this,{rpc,now,identityFor});this.entries=new Map();this.pending=new Map();}
 peekToken(input){const hit=this.entries.get('token:'+address(input));return hit&&hit.until>this.now()?hit.value:null;}
 async cached(key,ttl,fetcher){const old=this.entries.get(key);if(old&&old.until>this.now())return old.value;if(this.pending.has(key))return this.pending.get(key);
  const p=(async()=>{const value=await fetcher();this.entries.set(key,{value,until:this.now()+ttl});if(this.entries.size>128)this.entries.delete(this.entries.keys().next().value);return value;})();this.pending.set(key,p);try{return await p;}finally{this.pending.delete(key);}}
 async token(input){const token=address(input);return this.cached('token:'+token,15000,async()=>{const [identity,[decimals]]=await Promise.all([this.identityFor(this.rpc,token),read(this.rpc,token,ERC20,'decimals')]);if(Number(decimals)>36)throw Error('代币精度不支持');return {identity,decimals:Number(decimals)};});}
 async quote(input){const token=address(input);return this.cached('quote:'+token,15000,async()=>{const [decimals]=await read(this.rpc,token,ERC20,'decimals');if(Number(decimals)>36)throw Error('计价币精度不支持');return {decimals:Number(decimals)};});}
 async venue(d){return this.cached('dex:'+d.id,60000,async()=>{
  if(d.kind==='infinity-cl')return infinityVenue(this.rpc);
  const abi=d.kind==='v2'?V2_ROUTER_ABI:V3_IMMUTABLE,method='factory',wrapped=d.kind==='v2'?'WETH':'WETH9';
  const [[factory],[weth],code]=await Promise.all([read(this.rpc,d.router,abi,method),read(this.rpc,d.router,abi,wrapped),this.rpc.getCode(d.router)]);
  if(!same(factory,d.factory)||!same(weth,WBNB)||code==='0x')throw Error('路由身份不匹配：'+d.id);
  const assets=[{token:d.router,codeHash:keccak256(code)}];
  if(d.quoter){const [[factory],[weth],code]=await Promise.all([read(this.rpc,d.quoter,V3_IMMUTABLE,'factory'),read(this.rpc,d.quoter,V3_IMMUTABLE,'WETH9'),this.rpc.getCode(d.quoter)]);if(!same(factory,d.factory)||!same(weth,WBNB)||code==='0x')throw Error('报价合约身份不匹配');assets.push({token:d.quoter,codeHash:keccak256(code)});}
  return {assets};
 });}
 async warm(config){
  // One bounded Multicall per wallet instead of one request per venue. Each
  // wallet remains independent: a failed balance read must not suppress other
  // wallets' preparation. Individual allowance failures remain unknown.
  const [token,venues,balances]=await Promise.all([this.token(config.asset),Promise.allSettled(DEXES.map(d=>this.venue(d))),Promise.all(config.accounts.map(async account=>{
   const w=wallet(account);
   try{
    const [batch,gas]=await Promise.all([openingReads(this.rpc,[{to:config.asset,abi:ERC20,method:'balanceOf',args:[w.address]},...DEXES.map(d=>({to:config.asset,abi:ERC20,method:'allowance',args:[w.address,d.router]}))]),this.rpc.getBalance(w.address)]);
    const [holding,...allowances]=batch.results;if(holding.status!=='fulfilled')throw holding.reason;
    return {account,w,balance:holding.value[0],gas,allowances};
   }catch{return {account,w,unavailable:true,error:'该钱包持仓或 Gas 暂未读到，本轮跳过预热'};}
  }))]);
  const rows=balances.map(({account,w,balance,gas,allowances,unavailable,error})=>{if(unavailable)return {account,address:w.address,unavailable,error,routes:[]};const amount=percentOf(balance,config.percent);
   return {account,address:w.address,balance:String(balance),amount:String(amount),bnb:formatUnits(gas,18),routes:DEXES.map((d,n)=>({id:d.id,router:d.router,ready:venues[n].status==='fulfilled'&&allowances[n].status==='fulfilled',approvalNeeded:allowances[n].status==='fulfilled'?allowances[n].value[0]<amount:null,error:venues[n].reason?.message||allowances[n].reason?.message}))};
  });return {at:this.now(),decimals:token.decimals,fingerprint:token.identity.fingerprint,rows};
 }
}
