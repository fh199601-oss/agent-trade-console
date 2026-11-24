import {personalExecutor} from '../lib/delegated-sale/personal-address.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface,ZeroAddress,getAddress,id,keccak256} from 'ethers';
import {USDT,WBNB,BNB} from '../lib/common.mjs';
import {USDC,USD1} from '../lib/opening-dex.mjs';
import {MULTI,MULTICALL} from '../lib/opening-read.mjs';
import {declaredPairQuote,predictedQuote,knownQuoteLabel} from '../lib/delegated-sale/pending-quote.mjs';

const addr=n=>getAddress('0x'+n.toString(16).padStart(40,'0'));
const token=addr(2),source=addr(3);
function issuer(methods){
 const abi=new Interface(Object.keys(methods).map(n=>'function '+n+'() view returns(address)'));
 return {getCode:async()=>abi.fragments.map(f=>f.selector.slice(2)).join(''),call:async({to,data})=>{
  assert.equal(to,MULTICALL);
  const [,calls]=MULTI.decodeFunctionData('tryBlockAndAggregate',data);
  return MULTI.encodeFunctionResult('tryBlockAndAggregate',[123,id('block'),calls.map(([target,data])=>{
   assert.equal(target,source);const f=abi.getFunction(data);
   return [true,abi.encodeFunctionResult(f,[methods[f.name]])];
  })]);
 }};
}
test('尚未建池，按地址核实币种；原生 BNB 标记、USDT 拼写、主流底池大小写和自定义计价币',async()=>{
 for(const [name,v,q] of [['bNb',BNB,WBNB],['BnB',ZeroAddress,WBNB],['WbNB',WBNB,WBNB],['uSdT',USDT,USDT],['UsTd',USDT,USDT],['uSdC',USDC,USDC],['Usd1',USD1,USD1],['FdUsD','0xc5f0f7b66764f6ec8c8dff7ba683102295e16409','0xc5f0f7b66764f6ec8c8dff7ba683102295e16409'],['BusD','0xe9e7cea3dedca5984780bafc599bd69add087d56','0xe9e7cea3dedca5984780bafc599bd69add087d56'],['DaI','0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3','0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3'],['QUOTE_TOKEN',addr(8),addr(8)],['pairedToken',addr(8),addr(8)]]){
  assert.equal((await predictedQuote(issuer({[name]:v}),source,token)).toLowerCase(),q.toLowerCase());
 }
 assert.equal(knownQuoteLabel(USDT.toLowerCase()),'USDT');assert.equal(knownQuoteLabel(WBNB),'BNB');
 assert.equal(await predictedQuote(issuer({quoteToken:USDC,USDT,WBNB}),source,token),getAddress(USDC));
 await assert.rejects(predictedQuote(issuer({USDT,WBNB}),source,token),/多个/);
 await assert.rejects(predictedQuote(issuer({usdt:addr(91)}),source,token),/不符/);
 await assert.rejects(predictedQuote(issuer({usdt:ZeroAddress}),source,token),/未公布/);
});
test('已建池直接读取双向币对，不依赖代币符号或 getter 拼写；验证工厂、地址和实际代码',async()=>{
 const executor=addr(4),factory=addr(5),pair=addr(6);
 const abi=new Interface(['token0() view returns(address)','token1() view returns(address)','factory() view returns(address)','factoryHash() view returns(bytes32)','pairHash() view returns(bytes32)','getPair(address,address) view returns(address)'].map(s=>'function '+s));
 const tokenCode='0x1234',factoryCode='0x5678';const args={pair,token,factory,executor};
 for(const quote of [WBNB,USDT,USDC,USD1,addr(8)])for(const reverse of [false,true]){
  const values={token0:reverse?token:quote,token1:reverse?quote:token,factory,getPair:pair,pairHash:keccak256(tokenCode),factoryHash:keccak256(factoryCode)};
  const rpc={getCode:async a=>a===factory?factoryCode:tokenCode,call:async({data})=>{
   const f=abi.getFunction(data.slice(0,10));if(f.name==='getPair')assert.deepEqual([...abi.decodeFunctionData(f,data)],[token,getAddress(quote)]);
   return abi.encodeFunctionResult(f,[values[f.name]]);
  }};
  assert.equal(await declaredPairQuote(rpc,args),getAddress(quote));
  values.getPair=addr(20);await assert.rejects(declaredPairQuote(rpc,args),/工厂/);
  values.getPair=pair;values.pairHash=id('wrong-code');await assert.rejects(declaredPairQuote(rpc,args),/池代码/);
 }
});

test('开盘前端到端识别已建的稳定币主池，即使发行方同时公布 WBNB 常量',async()=>{
 const {BscVenue,TAX_BSC_SALE,SALE}=await import('../lib/delegated-sale/bsc.mjs');
 const {ERC20}=await import('../lib/common.mjs');
 const pool=addr(6),factory=TAX_BSC_SALE.factory;
 const methods=['pair() view returns(address)','factory() view returns(address)','WBNB() view returns(address)',
  'token0() view returns(address)','token1() view returns(address)','getPair(address,address) view returns(address)',
  'INIT_CODE_PAIR_HASH() view returns(bytes32)','pairHash() view returns(bytes32)','factoryHash() view returns(bytes32)'];
 const abi=new Interface(methods.map(s=>'function '+s));const code='0x6001',hash=keccak256(code);
 for(const quote of [USDT,USDC,USD1]){
  const impl=addr(17);
  const rpc={getCode:async()=>code,send:async(method,[target,slot])=>{
   assert.equal(method,'eth_getStorageAt');
   return quote!==USDT&&target.toLowerCase()===quote.toLowerCase()&&slot.startsWith('0x360894')?'0x'+impl.slice(2).padStart(64,'0'):'0x'+'00'.repeat(32);
  },call:async({to,data})=>{
   const selector=data.slice(0,10);
   if(selector===SALE.getFunction('openingState').selector)return SALE.encodeFunctionResult('openingState',[true,false]);
   if(selector===ERC20.getFunction('decimals').selector)return ERC20.encodeFunctionResult('decimals',[18]);
   const f=abi.getFunction(selector);if(!f)return '0x';
   const values={pair:pool,factory,WBNB,token0:quote,token1:token,getPair:pool,INIT_CODE_PAIR_HASH:id('init'),pairHash:hash,factoryHash:hash};
   if(f.name==='getPair')assert.deepEqual([...abi.decodeFunctionData(f,data)],[token,getAddress(quote)]);
   return abi.encodeFunctionResult(f,[values[f.name]]);
  }};
  const payer=addr(101);
  const adapter=new BscVenue(rpc,{...TAX_BSC_SALE,payer,executor:personalExecutor(payer)});adapter.identity=async()=>{};
  const v=await adapter.verifiedVenue(token);
  assert.equal(v.quote,getAddress(quote));assert.equal(v.quoteSymbol,knownQuoteLabel(quote));
  assert.equal(v.registerAfterOpening,true);assert.equal(v.marketPending,true);assert.equal(!!v.quoteIdentity,quote!==USDT);
 }
});
