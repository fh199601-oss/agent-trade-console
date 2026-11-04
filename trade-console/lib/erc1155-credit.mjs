import {Interface} from 'ethers';
import {same} from './common.mjs';
const events=new Interface(['event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)','event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)']);
// Count net incoming quantity, including batches and repeated IDs. Asset IDs may
// be random tiers; verify total units, never invent a guaranteed rarity or price.
export function erc1155Received(logs,token,wallet){
 let received=0n;for(const log of logs||[]){if(!same(log.address,token))continue;let e;try{e=events.parseLog(log);}catch{continue;}if(!e)continue;
  const a=e.args,sign=BigInt(Number(same(a.to,wallet))-Number(same(a.from,wallet)));if(!sign)continue;
  if(e.name==='TransferSingle')received+=sign*a.value;
  else {const ids=a[3],values=a[4];if(ids.length!==values.length)throw Error('ERC1155 批次回执长度不一致');received+=sign*values.reduce((sum,n)=>sum+n,0n);}
 }return received;
}
