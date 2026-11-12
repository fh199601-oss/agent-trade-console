import {Interface} from './common.mjs';import {describeError,errorCategory,safeErrorText} from '../public/error-message.mjs';
const reasons=new Interface(['error Error(string)','error Panic(uint256)','error TooLittleReceived()','error InsufficientOutputAmount()','error ERC20InsufficientBalance(address,uint256,uint256)','error ERC20InsufficientAllowance(address,uint256,uint256)']);
export async function diagnoseRevert(rpc,tx,receipt){
 if(BigInt(receipt.status)!==0n)return null;
 if(tx.gas&&receipt.gasUsed&&BigInt(receipt.gasUsed)>=BigInt(tx.gas))return {kind:'gas_limit',source:'receipt',message:'本笔 Gas 已耗尽，交易回滚；请重新估算 Gas 后再试'};
 if(!rpc.call||!receipt.blockNumber||BigInt(receipt.blockNumber)<1n)return null;
 try{await rpc.call({from:tx.from,to:tx.to,data:tx.input,value:tx.value,gas:tx.gas},Number(BigInt(receipt.blockNumber)-1n));return null;}
 catch(e){let raw=e.message||'',data=typeof e.data==='string'?e.data:e.data?.data;
  try{const decoded=reasons.parseError(data);if(decoded)raw=decoded.name==='Error'?String(decoded.args[0]):decoded.name;}catch{}
  if(/ERC20InsufficientBalance/.test(raw))raw='ERC20: transfer amount exceeds balance';if(/ERC20InsufficientAllowance/.test(raw))raw='ERC20: insufficient allowance';
  const kind=errorCategory({message:raw});if(!['balance','gas_limit','allowance','slippage','liquidity'].includes(kind))return null;
  // This is a replay at the previous block, not an exact transaction trace.
  return {kind,source:'previous-block-eth-call',message:'原交易已回滚；前一区块回放提示：'+describeError({message:raw}),providerMessage:safeErrorText(raw)};
 }
}
