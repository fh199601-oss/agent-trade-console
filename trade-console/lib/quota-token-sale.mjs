import {Interface} from 'ethers';
import parser from '@solidity-parser/parser';
import {USDT,ERC20,read,same,parseUnits,formatUnits,ZeroAddress} from './common.mjs';
import {runtimeShape} from './bytecode.mjs';
import {chooseBatch,min,positive} from './mint-policy.mjs';
import {addressReferral} from './referral.mjs';
const methods=['mint(uint256,uint256,address)','quote(address,uint256)','quotaLeft(address)','freeClaimed(address)','freeCardsRemaining()','maxPerTx()','totalCards()','cardsSold()','tokensPerShare()','usdt()','token()','paused()'];
const cache=new WeakMap(),fail=(code,message,details)=>Object.assign(Error(message),{code,details});
const id=(n,name)=>n?.type==='Identifier'&&n.name===name;
const sender=n=>n?.type==='MemberAccess'&&id(n.expression,'msg')&&n.memberName==='sender';
const self=n=>n?.type==='FunctionCall'&&(n.expression?.typeName?.name||n.expression?.name)==='address'&&id(n.arguments?.[0],'this');
const walk=(n,fn)=>{if(!n||typeof n!=='object')return;fn(n);for(const [k,v]of Object.entries(n))if(!['loc','range'].includes(k)){if(Array.isArray(v))v.forEach(x=>walk(x,fn));else if(v&&typeof v==='object')walk(v,fn);}};
// Mixed free/paid USDT sales with a caller-bound quote and an on-chain maximum
// payment parameter. No hostname or contract address is an execution template.
export function recognizeQuotaTokenSale(meta){
 if(cache.has(meta))return cache.get(meta);let result=null;
 if(meta.verified&&!meta.proxy&&!meta.identity?.implementation){const abi=new Interface(meta.abi),shape=runtimeShape(meta.runtimeCode);
  if(!shape.delegate&&methods.every(s=>abi.getFunction(s)&&shape.selectors.has(abi.getFunction(s).selector))){const entry=abi.getFunction(methods[0]),contracts=[];
   if(entry.stateMutability==='nonpayable'&&entry.inputs.map(p=>p.name).join(',')==='shares,maxCost,referrer'){
    for(const s of Object.values(meta.sources||{}))try{walk(parser.parse(s.content),n=>{if(n.type==='ContractDefinition')contracts.push(n);});}catch{}
    for(const c of contracts){const f=c.subNodes.find(n=>n.type==='FunctionDefinition'&&n.name==='mint'&&n.body&&n.parameters?.map(p=>p.name).join(',')==='shares,maxCost,referrer');if(!f)continue;
     const stable=new Set(c.subNodes.filter(n=>n.type==='StateVariableDeclaration').flatMap(n=>n.variables).filter(v=>v.isImmutable||v.isDeclaredConst).map(v=>v.name));if(!['token','usdt','tokensPerShare'].every(n=>stable.has(n)))continue;
     const pulls=[],credits=[];walk(f.body,n=>{if(n.type==='FunctionCall'&&n.expression?.type==='MemberAccess'){if(['safeTransferFrom','transferFrom'].includes(n.expression.memberName))pulls.push(n);if(n.expression.memberName==='mint')credits.push(n);}});
     if(pulls.length!==1||credits.length!==1)continue;const pull=pulls[0],credit=credits[0];
     if(!id(pull.expression.expression,'usdt')||pull.arguments.length!==3||!sender(pull.arguments[0])||!self(pull.arguments[1])||!id(pull.arguments[2],'charged')||!id(credit.expression.expression,'token')||credit.arguments.length!==2||!sender(credit.arguments[0])||!id(credit.arguments[1],'tokensOut'))continue;
     const statements=f.body.statements,guard=statements.findIndex(s=>s.type==='IfStatement'&&!s.falseBody&&s.condition?.operator==='>'&&id(s.condition.left,'charged')&&id(s.condition.right,'maxCost')&&s.trueBody?.type==='RevertStatement');
     const payment=statements.findIndex(s=>s.type==='IfStatement'&&!s.falseBody&&s.condition?.operator==='>'&&id(s.condition.left,'charged')&&s.condition.right?.number==='0'&&s.trueBody?.statements?.length===1&&s.trueBody.statements[0].expression===pull);
     const output=statements.findIndex(s=>s.expression===credit);if(guard<0||payment<=guard||output<=payment)continue;
     // Reject reassignment of the budget, quantity or guarded cost. Output must
     // be exactly original shares * the immutable unit before the credit.
     let bad=false,outProof=false;walk(f.body,n=>{if(n.type==='UnaryOperation'&&['++','--','delete'].includes(n.operator)&&['shares','maxCost'].includes(n.subExpression?.name))bad=true;if(n.type==='BinaryOperation'&&/^(=|[+*\/%-]=)$/.test(n.operator)&&['shares','maxCost'].includes(n.left?.name))bad=true;});
     for(const s of statements.slice(guard+1,output))walk(s,n=>{if(n.type==='BinaryOperation'&&/^(=|[+*\/%-]=)$/.test(n.operator)){if(id(n.left,'charged'))bad=true;if(id(n.left,'tokensOut')){if(outProof||n.operator!=='='||n.right?.operator!=='*'||!id(n.right.left,'shares')||!id(n.right.right,'tokensPerShare'))bad=true;outProof=true;}}if(n.type==='UnaryOperation'&&['++','--','delete'].includes(n.operator)&&['charged','tokensOut'].includes(n.subExpression?.name))bad=true;});
     if(!bad&&outProof)result={kind:'quota-free-paid-token-sale',method:methods[0],roles:['quantity','cost','zero']};
    }
   }
  }
 }cache.set(meta,result);return result;
}
export async function quotaTokenSaleState(rpc,intent,meta,w,profile=recognizeQuotaTokenSale(meta)){
 if(!profile)return null;const abi=new Interface(meta.abi),block=await rpc.getBlockNumber(),memo=new Map(),get=(name,args=[])=>{const key=name+args.join(',');if(!memo.has(key))memo.set(key,read(rpc,meta.address,abi,name,args,block).then(r=>{if(r.length!==1)throw fail('MINT_ADAPTER_INCOMPLETE','发售状态返回值数量异常');return r[0];}));return memo.get(key);};
 const [payment,token,unit,quota,freeUsed,freeStock,maxTx,total,sold,paused,price]=await Promise.all([get('usdt'),get('token'),get('tokensPerShare'),get('quotaLeft',[w.address]),get('freeClaimed',[w.address]),get('freeCardsRemaining'),get('maxPerTx'),get('totalCards'),get('cardsSold'),get('paused'),get('quote',[w.address,1n])]);
 if(!same(payment,USDT)||same(token,ZeroAddress)||same(token,USDT)||unit<=0n||maxTx<=0n||sold>total)throw fail('MINT_ADAPTER_INCOMPLETE','付款币、到账资产或额度数据不符合此类型');
 if(paused)throw fail('MINT_PAUSED','合约当前暂停铸造');const remaining=min(quota,positive(total-sold)),free=min(!freeUsed&&freeStock>0n?1n:0n,remaining),paid=remaining-free;
 if(remaining>0n&&(price===0n)!==(free>0n))throw fail('MINT_STATE','免费额度标志与本钱包当前报价不一致');
 const referral=addressReferral(meta,profile,intent),info={block,currency:'USDT',freeRemaining:String(free),paidRemaining:String(paid),walletRemaining:String(quota),globalRemaining:String(total-sold),maxPerTransaction:String(maxTx),unitPriceUsdt:formatUnits(price,18)};
 return {name:profile.kind,token,inputToken:USDT,assetKind:'Erc20',block,free,paid,mixed:true,txCap:maxTx,info,referral,quote:async n=>{const cost=await get('quote',[w.address,n]);if(cost<0n)throw fail('MINT_STATE','当前报价无效');return {cost,out:n*unit,step:{kind:'mint',to:meta.address,value:'0',data:abi.encodeFunctionData(profile.method,[n,cost,referral?.callValue||ZeroAddress])}};}};
}
export async function quotaTokenSalePlan(rpc,intent,meta,w,resolved,profile=recognizeQuotaTokenSale(meta)){
 if(!profile)return null;if(intent.routeId&&!['quota:'+profile.method,profile.method].includes(intent.routeId))throw fail('MINT_ROUTE_INVALID','所选入口与当前发售合约不一致');
 const s=await quotaTokenSaleState(rpc,intent,meta,w,profile),q=await chooseBatch(s,intent,parseUnits(intent.maxUsdt||'0',18)),steps=[];
 if(q.cost){const [[balance],[allowance]]=await Promise.all([read(rpc,USDT,ERC20,'balanceOf',[w.address],s.block),read(rpc,USDT,ERC20,'allowance',[w.address,meta.address],s.block)]);if(balance<q.cost)throw fail('BUDGET_LIMIT','USDT 余额不足以支付本批 Mint');if(allowance<q.cost)steps.push({kind:'approve',to:USDT,spender:meta.address,allowance:String(q.cost),value:'0',data:ERC20.encodeFunctionData('approve',[meta.address,q.cost])});}
 if(!steps.length)await rpc.call({to:meta.address,from:w.address,data:q.step.data,value:0n},s.block);
 return {kind:'contract',route:profile.kind,token:s.token,wallet:w.address,inputToken:USDT,outputToken:s.token,amountIn:String(q.cost),minOutput:String(q.out),quantity:Number(q.n),identity:meta.identity,metaVerified:true,freshBeforeExecute:true,requireAssetCredit:true,expectedAsset:{token:s.token,kind:'Erc20',amount:String(q.out)},approvalFirst:!!steps.length,referral:s.referral,quota:s.info,fill:{continue:q.continue,lane:q.lane},budgetCurrency:'USDT',review:['本钱包报价与最高 USDT 付款参数交叉核验；免费入口最高付款固定为 0。',...(steps.length?['当前仅模拟精确额度授权，Mint 仍须在授权后重新模拟']:[])],steps:[...steps,q.step]};
}
