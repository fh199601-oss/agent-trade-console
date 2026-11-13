import {Interface,read} from './common.mjs';
import {transientRead} from './read-failure.mjs';
export const MULTICALL='0xcA11bde05977b3631167028862bE2a173976CA11';
export const MULTI=new Interface(['function tryBlockAndAggregate(bool,(address target,bytes callData)[]) payable returns(uint256 blockNumber,bytes32 blockHash,(bool success,bytes returnData)[] returnData)']);
function decode(request,raw){
 const value=request.abi.decodeFunctionResult(request.method,raw);
 if(request.canonical&&request.abi.encodeFunctionResult(request.method,value).toLowerCase()!==raw.toLowerCase())throw Error('注册接口返回不规范');
 return value;
}
// Only eth_call; all callers provide a fixed read ABI and no value. The block
// returned by Multicall makes cached-pair polling one round-trip per cycle.
export async function openingReads(rpc,requests,block='latest'){
 if(requests.length>64)throw Error('开盘批量查询超出上限');
 if(!requests.length)return {block:await rpc.getBlockNumber(),results:[]};
 try{
  const [height,,rows]=await read(rpc,MULTICALL,MULTI,'tryBlockAndAggregate',[false,requests.map(r=>[r.to,r.abi.encodeFunctionData(r.method,r.args||[])])],block);
  if(rows.length!==requests.length||height<=0n||height>BigInt(Number.MAX_SAFE_INTEGER)||block!=='latest'&&height!==BigInt(block))throw Error('批量查询区块或数量不一致');
  return {block:Number(height),results:rows.map((row,n)=>{if(!row.success)return {status:'rejected',reason:Object.assign(Error('链上读取回退：'+requests[n].method),{code:'CALL_EXCEPTION',data:row.returnData})};try{return {status:'fulfilled',value:decode(requests[n],row.returnData)};}catch(e){return {status:'rejected',reason:e};}})};
 }catch(error){
  // A network timeout used to fan out into up to 64 more requests, worsening
  // the same outage. Endpoint failover already retried the original read.
  if(transientRead(error))throw error;
  // Providers/test transports may not support Multicall. Individual calls stay
  // pinned to one block; their failures are never treated as pool liquidity.
  const height=block==='latest'?await rpc.getBlockNumber():Number(block);
  return {block:height,results:await Promise.allSettled(requests.map(async r=>decode(r,await rpc.call({to:r.to,data:r.abi.encodeFunctionData(r.method,r.args||[])},height))))};
 }
}
