import {Interface, ZeroAddress, getAddress, keccak256} from 'ethers';
import {BNB, USDT, WBNB, read, same} from '../common.mjs';
import {USDC, USD1} from '../opening-dex.mjs';
import {openingReads} from '../opening-read.mjs';

const poolAbi = new Interface(['factory() view returns(address)', 'token0() view returns(address)', 'token1() view returns(address)',
 'getPair(address,address) view returns(address)', 'factoryHash() view returns(bytes32)', 'pairHash() view returns(bytes32)'].map(s=>'function '+s));

export async function declaredPairQuote(rpc, {pair, token, factory, executor}) {
 const get = async (to,method,args=[]) => (await read(rpc,to,poolAbi,method,args))[0];
 const [a,b,poolFactory,pairCode,factoryCode,pairHash,factoryHash]=await Promise.all([
  get(pair,'token0'),get(pair,'token1'),get(pair,'factory'),rpc.getCode(pair),rpc.getCode(factory),get(executor,'pairHash'),get(executor,'factoryHash')
 ]);
 if(same(a,b)||(!same(a,token)&&!same(b,token))||!same(poolFactory,factory)||keccak256(pairCode)!==pairHash||keccak256(factoryCode)!==factoryHash)
  throw Error('项目声明的主池与官方工厂、池代码或交易币对不一致');
 const quote=same(a,token)?b:a;
 if(same(quote,ZeroAddress)||!same(await get(factory,'getPair',[token,quote]),pair))throw Error('官方工厂登记的交易对与项目主池不一致');
 return quote;
}

// A symbol alone cannot establish an asset identity. For undeployed pairs only
// accept a ticker getter when its address is the known BSC deployment.
const currencies={bnb:WBNB,wbnb:WBNB,usdt:USDT,ustd:USDT,usdc:USDC,usd1:USD1,
 busd:'0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',fdusd:'0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409',
 dai:'0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3'};
const quoteLabels=new Map(Object.entries(currencies).filter(([name])=>name!=='wbnb'&&name!=='ustd').map(([name,addr])=>[addr.toLowerCase(),name.toUpperCase()]));
export const knownQuoteLabel=address=>quoteLabels.get(address.toLowerCase());
const symbols=new Map();
for(const [ticker,addr] of Object.entries(currencies)){
 let variants=[''];
 for(const c of ticker)variants=variants.flatMap(prefix=>/[a-z]/.test(c)?[prefix+c,prefix+c.toUpperCase()]:[prefix+c]);
 for(const name of variants)symbols.set(name,addr);
}
const quoteNames=new Set();
for(const words of [['quote'],['quote','token'],['quote','asset'],['quote','currency'],['paired','token'],['pairing','token'],['wrapped','native']]){
 const camel=words.map((s,i)=>i?s[0].toUpperCase()+s.slice(1):s).join('');
 for(const name of [camel,camel[0].toUpperCase()+camel.slice(1),words.join(''),words.join('').toUpperCase(),words.join('_'),words.join('_').toUpperCase()])quoteNames.add(name);
}
const getters=new Interface([...quoteNames,...symbols.keys()].map(name=>'function '+name+'() view returns(address)'));

export async function predictedQuote(rpc,source,token) {
 const code=(await rpc.getCode(source)).toLowerCase();
 // Only call public selectors present in this contract's dispatch code. No
 // guesses from a token name, a reserve balance or a third-party pool.
 const candidates=getters.fragments.filter(fn=>code.includes(fn.selector.slice(2)));
 for(const named of [true,false]){
  const group=candidates.filter(fn=>quoteNames.has(fn.name)===named);
  if(!group.length)continue;
  if(group.length>40)throw Error('项目公布的计价币接口过多，无法核验唯一计价币');
  const {results}=await openingReads(rpc,group.map(fn=>({to:source,abi:getters,method:fn.name,canonical:true})));
  const addresses=new Set();
  for(const [i,result] of results.entries()){
   if(result.status==='rejected')throw Error('项目公布的计价币接口读取失败，请重新加载');
   const [value]=result.value;
   const explicitNative=group[i].name.toLowerCase()==='bnb'&&same(value,ZeroAddress);
   if(same(value,ZeroAddress)&&!explicitNative)continue;
   const quote=explicitNative||same(value,BNB)?WBNB:value;
   if(same(quote,token)||!named&&!same(quote,symbols.get(group[i].name)))throw Error('项目计价币声明的地址与币种不符');
   addresses.add(quote.toLowerCase());
  }
  if(addresses.size>1)throw Error('项目公布了多个可能的计价币，需等待主池地址明确');
  if(addresses.size)return getAddress([...addresses][0]);
 }
 throw Error('尚未建池，发行合约也未公布可核验的主池计价币');
}
