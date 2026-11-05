import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {ROOT,LOCAL} from './paths.mjs';
export {ROOT,LOCAL};
import {Interface,getAddress,parseUnits,formatUnits,ZeroAddress} from 'ethers';
import {normalizeAssetInput} from '../public/asset-input.mjs';
import {validateSiteProof} from './site-proof.mjs';
export {Interface,parseUnits,formatUnits,ZeroAddress};
export const DATA=path.join(LOCAL,'runtime');
export const BNB='0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const USDT='0x55d398326f99059fF775485246999027B3197955';
export const WBNB='0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
export const ERC20=new Interface(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)','function decimals() view returns(uint8)','function symbol() view returns(string)','function name() view returns(string)','function totalSupply() view returns(uint256)']);
export const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
export const native=a=>same(a,BNB)||same(a,ZeroAddress);
export const json=v=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?String(x):x,2);
export const hash=v=>createHash('sha256').update(typeof v==='string'?v:json(v)).digest('hex');
export const address=a=>{if(!/^0x[0-9a-f]{40}$/i.test(String(a)))throw Error('请输入完整的 42 字符 CA');return getAddress(a.toLowerCase());};
export function bindings(){const c=load(path.join(LOCAL,'install.json'),{wallets:[]});return c.wallets.map(w=>({account:w.account,address:address(w.address)}));}
export function wallet(n){const w=bindings().find(x=>x.account===n);if(!w)throw Error('钱包编号未绑定');return w;}
export function save(file,v){
 fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID()+'.tmp';let fd;
 try{
  // Flush the writable handle: Windows rejects fsync on an O_RDONLY handle.
  fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,json(v));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  fs.renameSync(tmp,file);
 }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
export function load(file,fallback=null){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function percentOf(balance,pct){if(!/^\d+(\.\d{1,6})?$/.test(String(pct)))throw Error('百分比最多 6 位小数');const n=parseUnits(String(pct),6);if(n<=0n||n>100000000n)throw Error('百分比需大于 0 且不超过 100');return BigInt(balance)*n/100000000n;}
export function validateIntent(input){
 const allowed=new Set(['account','side','asset','amount','percent','currency','slippageBps','slippageMode','quantity','maxBnb','maxUsdt','maxQuote','quoteToken','scope','referral','routeId','siteProof','openingOnly','autoClaim','claimSell']);
 for(const k of Object.keys(input))if(!allowed.has(k))throw Error('未知交易参数：'+k);
 const i={...input};wallet(i.account);if(!['buy','sell','mint'].includes(i.side))throw Error('未知交易方向');
 if(typeof i.asset!=='string'||!i.asset.trim()||i.asset.length>2048)throw Error('需要项目网址或 CA');i.asset=normalizeAssetInput(i.asset);
 i.slippageBps??=100;if(!Number.isInteger(i.slippageBps)||i.slippageBps<0||i.slippageBps>5000)throw Error('滑点范围 0–50%，单位 bps');
 if(i.slippageMode!==undefined&&(!['fixed','auto'].includes(i.slippageMode)||i.slippageMode==='auto'&&i.side!=='sell'))throw Error('自动滑点仅用于卖出，模式须为 auto 或 fixed');
 if(i.openingOnly!==undefined&&(i.openingOnly!==true||i.side!=='sell'))throw Error('开盘模式仅用于卖出');
 i.currency??=i.side==='sell'?'AUTO':'BNB';if(!['BNB','USDT','WBNB','QUOTE','AUTO'].includes(i.currency)||i.currency==='AUTO'&&i.side!=='sell')throw Error('不支持的付款币');
 if(i.side==='sell'){percentOf(100000000n,i.percent);i.percent=String(i.percent);}
 if(i.side==='buy'){if(!/^\d+(\.\d{1,18})?$/.test(String(i.amount))||parseUnits(String(i.amount),18)<=0n)throw Error('买入金额必须大于 0');i.amount=String(i.amount);}
 if(i.side==='mint'){
  if(i.autoClaim!==undefined&&typeof i.autoClaim!=='boolean')throw Error('自动领取开关无效');
  if(i.claimSell!==undefined){
   const s=i.claimSell;if(!s||Object.keys(s).some(k=>!['percent','slippageBps','currency'].includes(k))||i.autoClaim===false)throw Error('领取后卖出需要开启自动领取');
   percentOf(100000000n,s.percent??'50');const slip=s.slippageBps??5000,currency=s.currency??'AUTO';
   if(!Number.isInteger(slip)||slip<0||slip>5000||!['AUTO','BNB','WBNB','USDT'].includes(currency))throw Error('领取后卖出滑点或到账币种无效');
   i.claimSell={percent:String(s.percent??'50'),slippageBps:slip,currency};
  }
  if(i.siteProof!==undefined)validateSiteProof(i.siteProof);
  if(i.routeId!==undefined&&(typeof i.routeId!=='string'||!i.routeId.trim()||i.routeId.length>200))throw Error('铸造方式标识无效');
  if(i.quantity!=='max'&&(!Number.isInteger(Number(i.quantity))||Number(i.quantity)<1||Number(i.quantity)>500))throw Error('Mint 份数需为 1–500 或 max');
  i.quantity=i.quantity==='max'?'max':Number(i.quantity);
  if(!/^\d+(\.\d{1,18})?$/.test(String(i.maxBnb)))throw Error('Mint 必须明确每钱包最高 BNB 预算，免费填 0（Gas 另计）');
  i.maxBnb=String(i.maxBnb);
  i.scope??=i.maxBnb==='0'&&!i.maxUsdt?'free':'all';
  if(!['free','paid','all'].includes(i.scope))throw Error('scope 只能为 free、paid 或 all');
  i.referral??='account1';if(!['account1','none'].includes(i.referral))throw Error('邀请策略只能为 account1 或 none');
  if(i.maxUsdt!==undefined&&!/^\d+(\.\d{1,18})?$/.test(String(i.maxUsdt)))throw Error('USDT 预算无效');
  if(i.maxUsdt!==undefined)i.maxUsdt=String(i.maxUsdt);
  if(i.maxQuote!==undefined||i.quoteToken!==undefined){if(!/^\d+(\.\d{1,36})?$/.test(String(i.maxQuote))||i.quoteToken===undefined)throw Error('其他付款币预算须同时提供 maxQuote 与完整 quoteToken CA');i.maxQuote=String(i.maxQuote);i.quoteToken=address(i.quoteToken);if(same(i.quoteToken,ZeroAddress)||native(i.quoteToken)||same(i.quoteToken,USDT))throw Error('BNB / USDT 请使用原有预算输入');if(i.scope==='free'&&Number(i.maxQuote)!==0)throw Error('只打免费时其他付款币预算必须为 0');}
  if(i.scope==='free'&&(parseUnits(i.maxBnb,18)!==0n||parseUnits(i.maxUsdt||'0',18)!==0n))throw Error('只打免费时，BNB 和 USDT 铸造预算必须为 0（Gas 另计）');
 }else if(i.siteProof!==undefined||i.maxQuote!==undefined||i.quoteToken!==undefined||i.autoClaim!==undefined||i.claimSell!==undefined)throw Error('官网凭证、其他付款币预算及自动领取只用于 Mint');
 return i;
}
export async function read(rpc,to,abi,method,args=[],block='latest'){return abi.decodeFunctionResult(method,await rpc.call({to,data:abi.encodeFunctionData(method,args)},block));}
export const publicError=e=>({message:e.message,code:e.code||'ERROR'});
