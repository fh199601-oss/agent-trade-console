import {bindings,address,ERC20,read,formatUnits,Interface} from './common.mjs';
import {getJson} from './network.mjs';
const cache=new Map();
async function precision(rpc,token,block='latest'){
 try{return {decimals:Number((await read(rpc,token,ERC20,'decimals',[],block))[0]),assetType:'ERC20'};}
 catch(e){const nft=new Interface(['function supportsInterface(bytes4) view returns(bool)']);const [yes]=await read(rpc,token,nft,'supportsInterface',['0x80ac58cd'],block);if(!yes)throw e;return {decimals:0,assetType:'ERC721'};}
}
export async function market(rpc,ca){
 const token=address(ca),key=token.toLowerCase(),old=cache.get(key);if(old&&Date.now()-old.at<2500)return old;
 const query=`chainId=56&contractAddress=${token}`;
 const [dynamic,dex,meta,chain]=await Promise.allSettled([
  getJson('https://web3.binance.com/bapi/defi/v4/public/wallet-direct/buw/wallet/market/token/dynamic/info?'+query,{},4000),
  getJson('https://api.dexscreener.com/token-pairs/v1/bsc/'+token,{},4000),
  getJson('https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/dex/market/token/meta/info?'+query,{},4000),
  Promise.all([read(rpc,token,ERC20,'decimals'),read(rpc,token,ERC20,'symbol').catch(()=>[null]),read(rpc,token,ERC20,'name').catch(()=>[null])])]);
 const d=dynamic.status==='fulfilled'&&dynamic.value.success===true?dynamic.value.data:null;
 const m=meta.status==='fulfilled'&&meta.value.success===true?meta.value.data:null;
 const pairs=dex.status==='fulfilled'&&Array.isArray(dex.value)?dex.value.filter(p=>p.chainId==='bsc'&&p.baseToken?.address?.toLowerCase()===key).sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0)):[];
 const p=pairs[0];let decimals=chain.status==='fulfilled'?Number(chain.value[0][0]):null;
 if(decimals!==null&&(!Number.isInteger(decimals)||decimals<0||decimals>36))decimals=null;
 const result={token,name:chain.status==='fulfilled'?chain.value[2][0]:m?.name||p?.baseToken.name||null,symbol:chain.status==='fulfilled'?chain.value[1][0]:m?.symbol||p?.baseToken.symbol||null,
  decimals,price:d?.price??p?.priceUsd??null,marketCap:d?.marketCap??p?.marketCap??null,fdv:d?.fdv??p?.fdv??null,holders:d?.holders??null,liquidity:d?.liquidity??p?.liquidity?.usd??null,volume24h:d?.volume24h??p?.volume?.h24??null,
  priceChange24h:d?.percentChange24h!=null?Number(d.percentChange24h)*100:p?.priceChange?.h24??null,pairs:pairs.map(p=>({dexId:p.dexId,pairAddress:p.pairAddress,liquidity:p.liquidity?.usd,url:p.url})),
  sources:{market:d?'Binance':p?'DexScreener':null,holders:d?.holders!=null?'Binance':null},at:Date.now(),errors:[dynamic,dex,meta,chain].flatMap((r,i)=>r.status==='rejected'?[{source:['Binance 动态','DexScreener','Binance 元数据','链上元数据'][i],message:r.reason.message}]:[])};
 cache.set(key,result);return result;
}
export async function holdings(rpc,ca){
 const token=address(ca),block=await rpc.getBlockNumber(),{decimals,assetType}=await precision(rpc,token,block);if(decimals>36)throw Error('代币精度不支持');
 return {token,block,assetType,at:Date.now(),wallets:await Promise.all(bindings().map(async w=>{try{const [[raw],bnb]=await Promise.all([read(rpc,token,ERC20,'balanceOf',[w.address],block),rpc.getBalance(w.address,block)]);return {...w,assetType,raw:String(raw),balance:formatUnits(raw,decimals),decimals,bnb:formatUnits(bnb,18)};}catch(e){return {...w,error:e.message,balance:null};}}))};
}
