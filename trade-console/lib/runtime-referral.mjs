import {Interface,ZeroAddress,keccak256} from 'ethers';
import {same} from './common.mjs';
import {runtimeShape} from './bytecode.mjs';
const abi=new Interface(['function referrerOf(address) view returns(address)','function token() view returns(address)','function minter() view returns(address)']);
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const tag=n=>'0x'+n.toString(16),cache=new WeakMap(),word=/^0x[\da-f]{64}$/i;
const topic=t=>/^0x0{24}[\da-f]{40}$/i.test(t||'')?'0x'+t.slice(-40):null;
// Learn one parameter role, never a transaction recipe. Two independent,
// finalized successful calls must change referrerOf(sender) from zero to that
// argument and credit the sender with the minter's associated inventory token.
export async function runtimeReferralEvidence(rpc,meta,method){
 if(meta.verified||meta.proxy||meta.identity?.implementation||!/^mint(?:WithBnb|WithBNB)?\(uint256,address\)$/.test(method))return null;
 const shape=runtimeShape(meta.runtimeCode);if(shape.delegate||!['referrerOf','token'].every(n=>shape.selectors.has(abi.getFunction(n).selector)))return null;
 let store=cache.get(rpc);if(!store){store=new Map();cache.set(rpc,store);}const key=meta.address.toLowerCase()+':'+keccak256(meta.runtimeCode)+':'+method;
 const hit=store.get(key);if(hit&&hit.until>Date.now())return hit.promise;
 const promise=inspect(rpc,meta,method).catch(()=>null);store.set(key,{until:Date.now()+60000,promise});if(store.size>128)store.delete(store.keys().next().value);
 const value=await promise;if(!value)store.set(key,{until:Date.now()+5000,promise});return value;
}
async function inspect(rpc,meta,method){
 await rpc.verifyChain();const head=await rpc.getBlockNumber(),to=head-3,from=Math.max(0,to-511),selector=new Interface(['function '+method]).getFunction(method).selector;
 const read=async(to,name,args,block)=>{const raw=await rpc.send('eth_call',[{to,data:abi.encodeFunctionData(name,args)},block]),v=abi.decodeFunctionResult(name,raw);if(abi.encodeFunctionResult(name,v).toLowerCase()!==raw.toLowerCase())throw Error('noncanonical getter');return v[0];};
 const token=await read(meta.address,'token',[],tag(to));if(same(token,ZeroAddress)||!same(await read(token,'minter',[],tag(to)),meta.address))return null;
 const logs=await rpc.send('eth_getLogs',[{address:meta.address,fromBlock:tag(from),toBlock:tag(to)}]);if(!Array.isArray(logs))return null;
 const hashes=[...new Set(logs.slice(-1024).filter(l=>!l.removed&&same(l.address,meta.address)&&word.test(l.transactionHash||'')).map(l=>l.transactionHash))].slice(-16).reverse();
 const txs=await Promise.all(hashes.map(h=>rpc.send('eth_getTransactionByHash',[h]).catch(()=>null)));
 const candidates=txs.filter(t=>t&&same(t.to,meta.address)&&new RegExp('^'+selector+'[\\da-f]{64}0{24}[\\da-f]{40}$','i').test(t.input||'')&&BigInt('0x'+t.input.slice(10,74))>0n&&BigInt('0x'+t.input.slice(74))!==0n).slice(0,6);
 const proofs=await Promise.all(candidates.map(async tx=>{try{
  const bn=Number(BigInt(tx.blockNumber));if(bn>to||bn<from)return null;const ref='0x'+tx.input.slice(-40);if(same(ref,tx.from))return null;
  const [receipt,header,code,before,after]=await Promise.all([rpc.send('eth_getTransactionReceipt',[tx.hash]),rpc.send('eth_getBlockByNumber',[tx.blockNumber,true]),rpc.getCode(meta.address,tx.blockNumber),read(meta.address,'referrerOf',[tx.from],tag(bn-1)),read(meta.address,'referrerOf',[tx.from],tx.blockNumber)]);
  if(code.toLowerCase()!==meta.runtimeCode.toLowerCase()||!same(before,ZeroAddress)||!same(after,ref)||!header||!receipt||BigInt(receipt.status||0)!==1n||!same(receipt.transactionHash,tx.hash)||!same(receipt.to,meta.address)||!same(receipt.from,tx.from)||!same(receipt.blockHash,header.hash)||!same(tx.blockHash,header.hash)||BigInt(receipt.blockNumber)!==BigInt(tx.blockNumber)||BigInt(header.number)!==BigInt(tx.blockNumber))return null;
  if(!Array.isArray(header.transactions)||header.transactions.filter(t=>same(t.from,tx.from)&&same(t.to,meta.address)).length!==1)return null;
  const credit=receipt.logs?.some(l=>!l.removed&&same(l.transactionHash,tx.hash)&&same(l.blockHash,header.hash)&&same(l.address,token)&&l.topics?.length===3&&same(l.topics[0],transfer)&&same(topic(l.topics[1]),meta.address)&&same(topic(l.topics[2]),tx.from)&&word.test(l.data||'')&&BigInt(l.data)>0n);
  return credit?{sender:tx.from.toLowerCase(),txHash:tx.hash,block:bn,blockHash:header.hash}:null;
 }catch{return null;}}));
 const distinct=[...new Map(proofs.filter(Boolean).map(p=>[p.sender,p])).values()];if(distinct.length<2)return null;
 return {kind:'historical-referrer-transition',method,index:1,target:meta.address,fingerprint:meta.hash,token,samples:distinct.slice(0,2).map(({sender,...p})=>p)};
}
