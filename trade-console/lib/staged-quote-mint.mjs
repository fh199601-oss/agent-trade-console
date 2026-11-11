import parser from '@solidity-parser/parser';
import {Interface,BNB,USDT,ERC20,ZeroAddress,read,same,parseUnits,formatUnits} from './common.mjs';
import {runtimeShape} from './bytecode.mjs';
import {chooseBatch,min,positive} from './mint-policy.mjs';
import {addressReferral} from './referral.mjs';
import {mintError} from './mint-errors.mjs';

// A source-verified family, not a URL/address allowlist: separate free round,
// bounded pre-open shares, then quoted public sales. Resolve payment/min-output
// roles from ABI positions AND Solidity data flow. Never execute website code.
const memo=new WeakMap(),fail=(code,message,details)=>Object.assign(Error(message),{code,details});
const walk=(n,f)=>{if(!n||typeof n!=='object')return;f(n);for(const [k,v]of Object.entries(n))if(!['loc','range'].includes(k))Array.isArray(v)?v.forEach(x=>walk(x,f)):walk(v,f);};
const nodes=(n,p)=>{const a=[];walk(n,x=>{if(p(x))a.push(x);});return a;};
const ident=n=>n?.type==='Identifier'?n.name:'';
const flat=n=>n?.type==='MemberAccess'?flat(n.expression)+'.'+n.memberName:ident(n);
const calls=n=>nodes(n,x=>x.type==='FunctionCall');
const binary=(n,op,l,r)=>n?.type==='BinaryOperation'&&n.operator===op&&flat(n.left)===l&&flat(n.right)===r;
const assigns=n=>nodes(n,x=>x.type==='BinaryOperation'&&x.operator==='=');
const assignment=(n,l)=>assigns(n).find(x=>flat(x.left)===l)?.right;
const initializer=(f,name)=>nodes(f.body,n=>n.type==='VariableDeclarationStatement'&&n.variables?.length===1&&n.variables[0]?.name===name)[0]?.initialValue;
const tupleFields=(f,names)=>f.inputs.length===0&&f.outputs.length===1&&f.outputs[0].type==='tuple'&&names.every(([name,type])=>f.outputs[0].components.some(p=>p.name===name&&p.type===type));
const exact=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const clean=n=>{if(Array.isArray(n))return n.map(clean);if(n&&typeof n==='object')return Object.fromEntries(Object.entries(n).filter(([k])=>!['loc','range'].includes(k)).map(([k,v])=>[k,clean(v)]));return n;};
export function recognizeStagedQuoteMint(meta){
 if(memo.has(meta))return memo.get(meta);let result=null;
 try{
  if(!meta.verified||meta.proxy||meta.identity?.implementation)throw Error('source');
  const abi=new Interface(meta.abi),shape=runtimeShape(meta.runtimeCode);if(shape.delegate)throw Error('proxy');
  const fs=abi.fragments.filter(f=>f.type==='function'),one=a=>{if(a.length!==1)throw Error('ambiguous');return a[0];};
  const paid=one(fs.filter(f=>f.stateMutability==='payable'&&f.inputs.map(p=>p.type).join(',')==='uint256,address,bool,uint256,uint256'));
  const quote=one(fs.filter(f=>f.stateMutability==='view'&&f.inputs.map(p=>p.type).join(',')==='uint256'&&f.outputs.map(p=>p.type).join(',')==='uint256,uint256,uint256,uint256'&&f.outputs.map(p=>p.name).join(',')==='bnbCost,usdtCost,tokensOut,filled'));
  const stats=one(fs.filter(f=>tupleFields(f,[['sold','uint256'],['started','bool'],['freeRound','bool'],['open','bool'],['expired','bool'],['soldOut','bool'],['tierLeft','uint256'],['sharesLeft','uint256']])));
  const user=one(fs.filter(f=>f.stateMutability==='view'&&f.inputs.map(p=>p.type).join(',')==='address'&&tupleFields({...f,inputs:[]},[['hasAgentId','bool'],['freeUsed','bool'],['limitLeft','uint256']])));
  const contracts=[];for(const s of Object.values(meta.sources||{}))walk(parser.parse(s.content),n=>{if(n.type==='ContractDefinition'&&n.subNodes?.some(x=>x.name===paid.name&&x.body)&&n.subNodes.some(x=>x.name===quote.name&&x.body))contracts.push(n);});
  const contract=one(contracts),functions=contract.subNodes.filter(f=>f.type==='FunctionDefinition'&&f.body),fn=name=>one(functions.filter(f=>f.name===name));
  const p=fn(paid.name),q=fn(quote.name),[qty,inv,pay,maxPay,minOut]=p.parameters.map(p=>p.name);
  if(p.parameters.map(p=>p.name).join(',')!==paid.inputs.map(p=>p.name).join(','))throw Error('parameters');
  const payment=one(nodes(p.body,n=>n.type==='IfStatement'&&ident(n.condition)===pay&&n.falseBody?.type==='IfStatement'&&n.falseBody.condition?.operator==='<'&&flat(n.falseBody.condition.left)==='msg.value'));
  const cost=ident(payment.falseBody.condition.right),conversion=one(calls(payment.trueBody).filter(c=>c.arguments.map(flat).join(',')===cost+','+maxPay));
  if(!cost||!ident(conversion.expression))throw Error('payment');
  const outputGuard=one(nodes(p.body,n=>n.type==='IfStatement'&&n.condition?.operator==='<'&&flat(n.condition.right)===minOut)),out=ident(outputGuard.condition.left);
  const credit=one(calls(p.body).filter(c=>c.expression?.memberName==='mint'&&c.arguments.map(flat).join(',')==='msg.sender,'+out)),tokenGetter=ident(credit.expression.expression);
  const branch=one(nodes(p.body,n=>n.type==='IfStatement'&&initializer(p,ident(n.condition))?.operator==='<'&&assigns(n.trueBody).some(a=>flat(a.left)===cost)));
  const phase=initializer(p,ident(branch.condition)),sold=ident(phase.left),openCap=ident(phase.right),soldGetter=ident(initializer(p,sold));if(!soldGetter||!openCap)throw Error('phase');
  const qBranch=one(nodes(q.body,n=>n.type==='IfStatement'&&n.condition?.operator==='<'&&flat(n.condition.right)===openCap&&assigns(n.trueBody).some(a=>flat(a.left)==='bnbCost'))),qSold=ident(qBranch.condition.left),qQty=q.parameters[0].name;
  if(ident(initializer(q,qSold))!==soldGetter)throw Error('quote state');
  const pCost=assignment(branch.trueBody,cost),qCost=assignment(qBranch.trueBody,'bnbCost'),pOut=assignment(branch.trueBody,out),qOut=assignment(qBranch.trueBody,'tokensOut');
  if(!ident(pCost?.right)||!ident(pOut?.right)||!binary(pCost,'*',qty,ident(qCost?.right))||!binary(qCost,'*','filled',ident(pCost?.right))||!binary(pOut,'*',qty,ident(qOut?.right))||!binary(qOut,'*','filled',ident(pOut?.right)))throw Error('quote formula');
  const clamp=assignment(branch.trueBody,qty),qClamp=assignment(qBranch.trueBody,'filled');
  if(clamp?.type!=='FunctionCall'||ident(clamp.expression)!==ident(qClamp?.expression)||flat(clamp.arguments[0])!==qty||flat(qClamp.arguments[0])!==qQty||!binary(clamp.arguments[1],'-',openCap,sold)||!binary(qClamp.arguments[1],'-',openCap,qSold))throw Error('phase clamp');
  // Compare post-open quote helper and tuple ordering, including arguments. A
  // misleading quote or changed payment/output order cannot pass this family.
  const post=(body,tuple)=>one(assigns(body).filter(a=>a.left?.type==='TupleExpression'&&a.left.components.map(flat).join(',')===tuple)).right;
  const pPost=post(branch.falseBody,[qty,cost,out].join(',')),qPost=post(qBranch.falseBody,'filled,bnbCost,tokensOut');
  const normalize=(n,vars)=>{const x=clean(n);walk(x,v=>{if(v.type==='Identifier'&&vars[v.name])v.name=vars[v.name];});return x;};
  if(pPost.type!=='FunctionCall'||!exact(normalize(pPost,{[sold]:'$sold',[qty]:'$qty'}),normalize(qPost,{[qSold]:'$sold',[qQty]:'$qty'})))throw Error('post quote');
  const gateCall=one(calls(branch.trueBody).filter(c=>c.arguments.map(flat).join(',')===qty+','+inv)),gate=fn(ident(gateCall.expression)),gateQty=gate.parameters[0].name;
  if(!nodes(gate.body,n=>n.type==='IfStatement'&&n.condition?.operator==='>'&&flat(n.condition.left)===gateQty&&n.condition.right?.expression?.name==='limitLeft').length)throw Error('wallet bound');
  if(!calls(fn(user.name).body).some(c=>ident(c.expression)==='limitLeft'))throw Error('wallet view');
  const free=one(functions.filter(f=>f.parameters.length===0&&f.stateMutability!=='view'&&calls(f.body).some(c=>flat(c.expression)===tokenGetter+'.mint'&&flat(c.arguments[0])==='msg.sender')));
  const freeCredit=one(calls(free.body).filter(c=>flat(c.expression)===tokenGetter+'.mint')),freeUnits=ident(freeCredit.arguments[1]);
  const freeGuard=one(nodes(free.body,n=>n.type==='IfStatement'&&n.condition?.operator==='>='&&ident(initializer(free,flat(n.condition.left)))===soldGetter)),freeCap=ident(freeGuard.condition.right);
  // No binding is skipped: the zero-argument free path has no inviter flow or
  // mutable helper except its output mint. Paid referrals stay on the paid lane.
  if(!freeUnits||!freeCap||nodes(free.body,n=>n.type==='Identifier'&&/invit|referr|sponsor/i.test(n.name)).length)throw Error('free referral');
  const localNames=new Set(functions.map(f=>f.name));for(const call of calls(free.body)){const name=ident(call.expression);if(localNames.has(name)&&!['view','pure'].includes(fn(name).stateMutability))throw Error('free binding helper');}
  const required=[paid.format('sighash'),quote.format('sighash'),stats.format('sighash'),user.format('sighash'),free.name+'()',tokenGetter+'()',freeUnits+'()',freeCap+'()',openCap+'()'];
  if(!required.every(s=>abi.getFunction(s)&&shape.selectors.has(abi.getFunction(s).selector)))throw Error('dispatch');
  // Verify the ERC20 branch's maximum-payment guard and exact-cost pull. Native
  // mode never invokes it. Only the established BSC USDT is accepted at runtime.
  const convert=fn(ident(conversion.expression)),amount=convert.returnParameters?.[0]?.name;
  const usdtPull=calls(convert.body).filter(c=>c.expression?.memberName==='safeTransferFrom'&&flat(c.arguments[0])==='msg.sender'&&flat(c.arguments[2])===amount);
  const capped=nodes(convert.body,n=>n.type==='IfStatement'&&binary(n.condition,'>',amount,convert.parameters[1]?.name)).length>0;
  const usdtGetter=usdtPull.length===1&&capped?ident(usdtPull[0].expression.expression):null;
  result={kind:'staged-quote',method:paid.format('sighash'),freeMethod:free.name+'()',quote:quote.format('sighash'),stats:stats.format('sighash'),user:user.format('sighash'),tokenGetter,freeUnits,freeCap,openCap,usdtGetter,roles:['quantity','zero','payment-choice','max-payment','min-output'],freeReferralIndependent:true};
 }catch{}memo.set(meta,result);return result;
}

export async function stagedQuoteState(rpc,intent,meta,w,p=recognizeStagedQuoteMint(meta),{includeBudget=false}={}){
 if(!p)return null;const abi=new Interface(meta.abi),block=await rpc.getBlockNumber(),cache=new Map();
 const get=(method,args=[])=>{const key=method+args.join(',');if(!cache.has(key))cache.set(key,read(rpc,meta.address,abi,method,args,block).then(r=>r.length===1?r[0]:r));return cache.get(key);};
 const [st,u,token,freeUnits,freeCap,openCap]=await Promise.all([get(p.stats),get(p.user,[w.address]),get(p.tokenGetter),get(p.freeUnits),get(p.freeCap),get(p.openCap)]);
 if(same(token,ZeroAddress)||same(token,USDT)||same(token,BNB)||freeUnits<=0n||freeCap>=openCap||st.sold<0n||st.sharesLeft<0n)throw fail('MINT_STATE','分阶段报价返回无效资产或额度');
 const pre=st.sold<openCap,freeRound=st.sold<freeCap;
 if(st.freeRound!==(st.started&&!st.expired&&freeRound)||st.open===pre)throw fail('MINT_STATE','阶段状态互相矛盾，请重新读取');
 const ended=st.expired||st.soldOut,free=st.started&&!ended&&freeRound&&u.hasAgentId&&!u.freeUsed?1n:0n;
 const paid=st.started&&!ended&&!freeRound?(pre&&u.hasAgentId?min(u.limitLeft,positive(openCap-st.sold),st.sharesLeft):pre?0n:st.sharesLeft):0n;
 const useUsdt=intent.scope!=='free'&&parseUnits(intent.maxBnb||'0',18)===0n&&parseUnits(intent.maxUsdt||'0',18)>0n;
 if(useUsdt&&(!p.usdtGetter||!same(await get(p.usdtGetter),USDT)))throw fail('MINT_ADAPTER_INCOMPLETE','尚未核验此入口的 USDT 付款分支');
 const s={name:p.kind,token,assetKind:'Erc20',block,free,paid,txCap:500n,unboundedPaid:!pre,inputToken:useUsdt?USDT:BNB,referral:null};
 s.info={block,phase:ended?'ended':!st.started?'not-started':freeRound?'free':pre?'paid-pre-open':'paid-open',freeRemaining:String(free),paidRemaining:pre?String(paid):null,unboundedPaid:!pre,budgetCurrency:useUsdt?'USDT':'BNB',paymentToken:s.inputToken,paymentDecimals:18,currency:useUsdt?'USDT':'BNB',notes:!freeRound&&!ended?['免费阶段已结束；当前为付费认购']:[]};
 if(ended)s.blocked=fail('MINT_ENDED',st.expired?'项目认购已到期':'项目总库存已售罄');
 else if(!st.started)s.blocked=fail('MINT_NOT_OPEN','项目认购尚未开始');
 else if(pre&&!u.hasAgentId)s.blocked=fail('MINT_INELIGIBLE','当前钱包未通过此阶段的 Agent ID 资格检查');
 s.quote=async(n,lane='paid')=>{
  if(lane==='free')return {cost:0n,out:freeUnits,step:{kind:'mint',to:meta.address,value:'0',data:abi.encodeFunctionData(p.freeMethod)}};
  const q=await get(p.quote,[n]);if(q.filled!==n||q.bnbCost<=0n||q.tokensOut<=0n||useUsdt&&(q.usdtCost<=0n||q.usdtCost===(1n<<256n)-1n))throw fail('MINT_STATE','当前报价不能完整成交所选份数，请重新读取额度');
  const bps=BigInt(intent.slippageBps??100);if(bps<0n||bps>=10000n)throw fail('MINT_STATE','最低到账滑点无效');
  const out=q.tokensOut*(10000n-bps)/10000n;if(out<=0n)throw fail('MINT_STATE','最低到账不能为零');
  const ref=pre?addressReferral(meta,p,intent):null;s.referral=ref;
  const cost=useUsdt?q.usdtCost:q.bnbCost;
  return {cost,out,step:{kind:'mint',to:meta.address,value:useUsdt?'0':String(cost),data:abi.encodeFunctionData(p.method,[n,ref?.callValue||ZeroAddress,useUsdt,useUsdt?cost:0n,out])}};
 };
 if(includeBudget&&pre){const n=min(paid,500n),q=n?await s.quote(n):null;s.info.fullBudget={quantity:Number(n),raw:String(q?.cost||0n)};}
 return s;
}

export async function stagedQuotePlan(rpc,intent,meta,w,resolved={},p=recognizeStagedQuoteMint(meta)){
 if(!p)return null;const s=await stagedQuoteState(rpc,intent,meta,w,p);if(s.blocked)throw s.blocked;
 if(intent.scope==='free'&&!s.free)throw fail('NO_QUOTA',s.info.phase==='free'?'当前钱包已领取免费额度':'免费阶段已结束；付费认购仍开放，未自动付款',{quota:s.info});
 if(intent.scope==='paid'&&s.info.phase==='free')throw fail('MINT_NOT_OPEN','当前仍为免费阶段，付费认购尚未开放',{quota:s.info});
 const requested=intent.routeId?[p.freeMethod,p.method].find(m=>intent.routeId===m||intent.routeId==='staged:'+m):null;
 if(intent.routeId&&!requested||requested===p.method&&intent.scope==='free'||requested===p.freeMethod&&intent.scope==='paid')throw fail('MINT_ROUTE_INVALID','所选入口与免费／付费范围不一致，请重新选择');
 const scope=requested?(requested===p.freeMethod?'free':'paid'):intent.scope;
 const lane=scope!=='paid'&&s.free?'free':'paid',method=lane==='free'?p.freeMethod:p.method;
 if(requested&&requested!==method)throw fail('NO_QUOTA','所选铸造入口在当前阶段没有可用额度');
 if(intent.quantity==='max'&&s.unboundedPaid)throw fail('MINT_QUOTA_UNKNOWN','开盘后没有每钱包付费上限，请填写明确份数；不会把全项目库存作为本钱包额度');
 const currency=same(s.inputToken,USDT)?'USDT':'BNB',budget=parseUnits(currency==='USDT'?intent.maxUsdt||'0':intent.maxBnb||'0',18);
 if(lane==='paid'&&s.paid>0n&&budget===0n)throw fail('BUDGET_LIMIT','免费阶段已结束，当前需付费认购；请重新识别以填入打满预算，或填写本次最高费用',{quota:s.info});
 const q=await chooseBatch(s,{...intent,scope},budget),steps=[];
 if(lane==='paid'&&currency==='USDT'){
  const [[balance],[allowance]]=await Promise.all([read(rpc,USDT,ERC20,'balanceOf',[w.address],s.block),read(rpc,USDT,ERC20,'allowance',[w.address,meta.address],s.block)]);
  if(balance<q.cost)throw fail('BUDGET_LIMIT','本钱包 USDT 余额不足');
  if(allowance<q.cost)steps.push({kind:'approve',to:USDT,spender:meta.address,allowance:String(q.cost),value:'0',data:ERC20.encodeFunctionData('approve',[meta.address,q.cost])});
 }
 if(!steps.length)try{await rpc.call({from:w.address,to:meta.address,data:q.step.data,value:BigInt(q.step.value)},s.block);}catch(e){throw mintError(e,meta.abi);}
 return {kind:'contract',route:p.kind+':'+method,token:s.token,wallet:w.address,inputToken:lane==='free'?BNB:s.inputToken,outputToken:s.token,amountIn:String(q.cost),minOutput:String(q.out),quantity:Number(q.n),identity:meta.identity,metaVerified:true,freshBeforeExecute:true,requireAssetCredit:true,expectedAsset:{token:s.token,kind:'Erc20',amount:String(q.out)},approvalFirst:!!steps.length,referral:s.referral,quota:s.info,fill:{continue:q.continue,lane},budgetCurrency:lane==='free'?'BNB':currency,review:[lane==='free'?'免费入口独立于付费邀请；不消耗付费预算':'已按本钱包当前额度和链上报价设置付款币、最高付款及最低到账',...(steps.length?['精确额度授权后，重新报价并模拟 Mint']:[])],steps:[...steps,q.step]};
}
