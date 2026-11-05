// An explicit user cap is a fallback for state-dependent transfer costs.
// Never invent a cap, multiply an estimate, or change an existing task's cap.
export function sellGasLimit(value){
 if(value===undefined)return undefined;
 if(!Number.isSafeInteger(value)||value<21000||value>15000000)throw Error('卖出 Gas 上限须为 21000–15000000 的整数');
 return value;
}
export function sellGasArgs(intent,step){
 const limit=sellGasLimit(intent.gasLimit);
 if(limit===undefined)return [];
 if(intent.side!=='sell'||intent.openingOnly!==true)throw Error('自定义 Gas 上限仅支持开盘直接卖出');
 // Approval and mint/claim transactions keep their independent backend estimate.
 return step.kind==='sell'?['--gasLimit',String(limit)]:[];
}
