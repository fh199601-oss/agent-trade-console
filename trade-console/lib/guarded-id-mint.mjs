import {Interface,keccak256,toUtf8Bytes} from 'ethers';
import parser from '@solidity-parser/parser';
import {BNB,read,same,wallet,formatUnits} from './common.mjs';
import {runtimeShape} from './bytecode.mjs';
import {chooseBatch,min,noQuota} from './mint-policy.mjs';

const REGISTRY='0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F';
const roles={id:/^_?(id|agentId|identityId|tokenId)$/i,quantity:/^_?(quantity|qty|count|shares|units|q)$/i,start:/^_?(expectedStart|expectedStartIndex|startIndex|expectedFirst)$/i,minimum:/^_?(minTokens|minAmountOut|minimumOutput|minOutput)$/i,deadline:/^_?(deadline|expiry|expiresAt)$/i,inviter:/^_?(inviterId|referrerId|refAgentId)$/i};
const fields={registry:['idCollection','agentRegistry'],quota:['quotaOf'],used:['mintedById','mintedCount'],minted:['totalMinted'],cap:['MAX_SHARES','TOTAL_SHARES'],txCap:['MAX_PER_TX','MAX_UNITS_PER_TX'],freeCap:['FREE_SHARES','FREE_CAP'],freeMinted:['freeMinted'],freeClaimed:['freeClaimed'],firstPaid:['firstPaid']};
const cache=new WeakMap();
const role=p=>/^uint\d*$/.test(p.type)?Object.keys(roles).find(k=>roles[k].test(p.name)):null;
const nodes=(node,type)=>{const found=[];parser.visit(node,{[type](n){found.push(n);}});return found;};
function expr(n,map={}){
 if(!n)return '';if(n.type==='BooleanLiteral')return String(n.value);if(n.type==='Identifier')return map[n.name]||n.name;if(n.type==='NumberLiteral')return n.number;
 if(n.type==='MemberAccess')return expr(n.expression,map)+'.'+n.memberName;
 if(n.type==='IndexAccess')return expr(n.base,map)+'['+expr(n.index,map)+']';
 if(n.type==='FunctionCall')return expr(n.expression,map)+'('+n.arguments.map(a=>expr(a,map)).join(',')+')';
 if(n.type==='BinaryOperation')return '('+expr(n.left,map)+n.operator+expr(n.right,map)+')';
 if(n.type==='UnaryOperation')return n.operator+expr(n.subExpression,map);return '?';
}
// Recognition is deliberately structural: ABI names alone and historical calldata
// are insufficient. Match a checked wrapper/helper plus the live quote/quota family.
const disjuncts=n=>n?.type==='BinaryOperation'&&n.operator==='||'?[...disjuncts(n.left),...disjuncts(n.right)]:[n];
function sourceProof(meta,fn,parameterRoles,m,quote){
 for(const source of Object.values(meta.sources||{})){
  const text=source?.content;if(!text||text.length>1000000)continue;
  let ast;try{ast=parser.parse(text);}catch{continue;}
  for(const contract of nodes(ast,'ContractDefinition')){
   const functions=contract.subNodes.filter(n=>n.type==='FunctionDefinition'&&n.body);
   const wrapper=functions.find(n=>n.name===fn.name&&n.parameters.map(p=>p.typeName?.name).join(',')===fn.inputs.map(p=>p.type).join(','));if(!wrapper)continue;
   let core=wrapper,map=Object.fromEntries(wrapper.parameters.map((p,i)=>[p.name,parameterRoles[i]]));
   const stmts=wrapper.body.statements;
   if(stmts.length===1&&stmts[0].expression?.type==='FunctionCall'){
    const c=stmts[0].expression,helper=functions.find(n=>n.name===c.expression.name&&n.parameters.length===c.arguments.length);if(!helper)continue;
    const forwarded=c.arguments.map(a=>expr(a,map));if(parameterRoles.some(r=>forwarded.filter(v=>v===r).length!==1))continue;
    core=helper;map=Object.fromEntries(helper.parameters.map((p,i)=>[p.name,forwarded[i]]));
   }
   for(const [key,sig]of Object.entries(m))map[sig.split('(')[0]]=key;
   const direct=core.body.statements,guards=direct.filter(n=>n.type==='IfStatement'&&n.trueBody?.type==='RevertStatement').flatMap(n=>disjuncts(n.condition)).map(n=>expr(n,map));
   const initial=direct.find(n=>n.type==='VariableDeclarationStatement'&&expr(n.initialValue,map)==='(minted+1)');
   const first=initial?.variables?.[0]?.name;if(!first)continue;
   if(!guards.includes('(start!='+first+')')||!guards.includes('(block.timestamp>deadline)')||!guards.includes('(registry.ownerOf(id)!=msg.sender)')||!guards.includes('((used[id]+quantity)>quota(id))')||!guards.includes('(msg.value!=cost)'))continue;
   if(direct.some(n=>n.type==='ReturnStatement'))continue;
   const mint=direct.find(n=>n.expression?.type==='FunctionCall'&&n.expression.expression?.name==='_mint')?.expression;
   if(!mint||expr(mint.arguments[0],map)!=='msg.sender'||!guards.includes('('+expr(mint.arguments[1],map)+'<minimum)'))continue;
   // Free units are exactly one per ID while the shared free pool remains.
   const free=functions.find(n=>n.parameters.length===1&&n.body.statements.length===1&&n.body.statements[0].type==='ReturnStatement'&&expr(n.body.statements[0].expression,{...map,[n.parameters[0].name]:'id'})==='((freeMinted<freeCap)&&!freeClaimed[id])');
   const qfn=functions.find(n=>n.name===quote.name&&n.parameters.length===2);if(!free||!qfn)continue;
   const qm={...map,...Object.fromEntries(qfn.parameters.map((p,i)=>[p.name,role(quote.inputs[i])])),[free.name]:'hasFree',...Object.fromEntries(qfn.returnParameters.map((p,i)=>[p.name,['cost','tokens','freeUnits','paidUnits'][i]]))};
   const assignments=nodes(qfn.body,'BinaryOperation');
   const assignment=assignments.find(n=>n.operator==='='&&expr(n.left,qm)==='freeUnits');
   if(assignment?.right.type!=='Conditional'||expr(assignment.right.condition,qm)!=='hasFree(id)'||expr(assignment.right.trueExpression,qm)!=='1'||expr(assignment.right.falseExpression,qm)!=='0')continue;
   if(!assignments.some(n=>expr(n,qm)==='(paidUnits=(quantity-freeUnits))'))continue;
   // The optional invitation is only the first paid call, never a free gift.
   if(parameterRoles.includes('inviter')){
    const branch=direct.find(n=>n.type==='IfStatement'&&expr(n.condition,map)==='true');
    if(!branch||!nodes(branch.trueBody,'VariableDeclarationStatement').some(n=>n.variables?.[0]?.name==='refOwner'&&expr(n.initialValue,map)==='registry.ownerOf(inviter)'))continue;
    const g=nodes(branch.trueBody,'IfStatement').filter(n=>n.trueBody?.type==='RevertStatement').map(n=>expr(n.condition,map)).join(' ');
    if(!g.includes('(cost==0)')||!g.includes('firstPaid[id]')||!g.includes('(inviter==id)')||!g.includes('(refOwner==msg.sender)'))continue;
   }
   return true;
  }
 }
 return false;
}
export function recognizeGuardedIdMint(meta){
 if(cache.has(meta))return cache.get(meta);let result=null;
 try{
  const shape=runtimeShape(meta.runtimeCode);if(!meta.verified||meta.proxy||meta.identity?.implementation||shape.delegate)return null;
  const abi=new Interface(meta.abi),methods={};
  for(const [k,names]of Object.entries(fields)){
   const args=['quota','used','freeClaimed','firstPaid'].includes(k)?'uint256':'';
   const out=k==='registry'?'address':['freeClaimed','firstPaid'].includes(k)?'bool':'uint256';
   const found=abi.fragments.filter(f=>f.type==='function'&&names.includes(f.name)&&f.inputs.map(p=>p.type).join(',')===args&&f.outputs.map(p=>p.type).join(',')===out&&['view','pure'].includes(f.stateMutability)&&shape.selectors.has(f.selector));
   if(found.length!==1)return null;methods[k]=found[0].format('sighash');
  }
  const quotes=abi.fragments.filter(f=>f.type==='function'&&/^(quoteFor|quoteMint|previewMint)$/.test(f.name)&&['view','pure'].includes(f.stateMutability)&&f.inputs.length===2&&f.inputs.map(role).sort().join(',')==='id,quantity'&&f.outputs.length===4&&f.outputs.every(p=>/^uint\d*$/.test(p.type))&&f.outputs.map(p=>p.name).join(',')==='cost,tokens,freeUnits,paidUnits'&&shape.selectors.has(f.selector));
  if(quotes.length!==1)return null;const quote=quotes[0],routes=[];
  for(const fn of abi.fragments.filter(f=>f.type==='function'&&/^mint(?:WithInviter|WithReferral)?$/.test(f.name)&&f.stateMutability==='payable'&&shape.selectors.has(f.selector))){
   const rr=fn.inputs.map(role);if(rr.some(r=>!r)||new Set(rr).size!==rr.length||!['deadline,id,minimum,quantity,start','deadline,id,inviter,minimum,quantity,start'].includes(rr.slice().sort().join(',')))continue;
   if(sourceProof(meta,fn,rr,methods,quote))routes.push({method:fn.format('sighash'),selector:fn.selector,roles:rr});
  }
  if(routes.filter(r=>!r.roles.includes('inviter')).length!==1||routes.filter(r=>r.roles.includes('inviter')).length>1)return null;
  result={kind:'guarded-agent-id-quote',methods,quote:quote.format('sighash'),quoteRoles:quote.inputs.map(role),routes};
 }catch{}finally{cache.set(meta,result);}return result;
}
const reg=new Interface(['function handleOf(address) view returns(string)','function ownerOf(uint256) view returns(address)']);
async function identity(rpc,registry,w,block){
 const [handle]=await read(rpc,registry,reg,'handleOf',[w.address],block);if(!handle||handle.length>256)throw Error(w.account+' 号钱包没有有效主 Agent ID');
 const id=BigInt(keccak256(toUtf8Bytes(handle))),[owner]=await read(rpc,registry,reg,'ownerOf',[id],block);if(!same(owner,w.address))throw Error(w.account+' 号 Agent ID 所有权不匹配');return {handle,id,address:w.address};
}
export async function guardedIdMintState(rpc,intent,meta,w,profile=recognizeGuardedIdMint(meta)){
 if(!profile)return null;const abi=new Interface(meta.abi),block=await rpc.getBlockNumber();
 const get=async(key,args=[])=>{const f=profile.methods[key]||key,raw=await rpc.call({to:meta.address,data:abi.encodeFunctionData(f,args)},block),v=abi.decodeFunctionResult(f,raw);if(abi.encodeFunctionResult(f,v).toLowerCase()!==raw.toLowerCase())throw Error('身份报价返回格式不匹配');return v;};
 const one=async(k,a=[])=>(await get(k,a))[0];
 const [registry,minted,cap,txCap,freeCap,freeMinted,header]=await Promise.all(['registry','minted','cap','txCap','freeCap','freeMinted'].map(k=>one(k)).concat(rpc.send('eth_getBlockByNumber',['0x'+block.toString(16),false])));
 if(!same(registry,REGISTRY))throw Error('身份注册合约未核验');
 if(minted>cap||freeMinted>freeCap||freeMinted>minted||freeCap>cap||txCap<=0n)throw Error('发行额度计数不一致');
 const own=await identity(rpc,registry,w,block),[quota,used,claimed,firstPaid]=await Promise.all(['quota','used','freeClaimed','firstPaid'].map(k=>one(k,[own.id])));
 if(used>quota)throw Error('钱包已用份数超过总额度');
 const remaining=min(quota-used,cap-minted),free=remaining>0n&&freeMinted<freeCap&&!claimed?1n:0n,paid=remaining-free;
 const quote=async n=>{if(n<1n||n>min(remaining,txCap))throw Error('份数超出当前额度');const values={id:own.id,quantity:n},q=await get(profile.quote,profile.quoteRoles.map(r=>values[r]));
  const expectedFree=free>0n?1n:0n;
  if(q[2]!==expectedFree||q[3]!==n-q[2]||q[1]<=0n||q[3]===0n&&q[0]!==0n||q[3]>0n&&q[0]===0n)throw Error('实时报价与免费/付费额度不一致');return {cost:q[0],out:q[1],freeUnits:q[2],paidUnits:q[3]};};
 let unit=null;if(remaining>0n)unit=await quote(free>0n&&paid>0n&&txCap>1n?2n:1n);
 const paidPrice=unit?.paidUnits===1n?formatUnits(unit.cost,18):null;
 const freeReason=remaining===0n?'本钱包或项目的可用额度已用完':freeMinted===freeCap?`全站免费额度已用完（${freeMinted}/${freeCap}）`:claimed?'当前 Agent ID 已领取免费份额':null;
 const info={agentId:own.handle,agentTokenId:String(own.id),freeRemaining:String(free),paidRemaining:String(paid),globalRemaining:String(cap-minted),globalFreeRemaining:String(freeCap-freeMinted),freeMinted:String(freeMinted),freeCap:String(freeCap),used:String(used),quota:String(quota),paidPriceBnb:paidPrice,firstPaid,currency:'BNB',block,notes:[...(freeReason?[freeReason+'；只打免费不会切换到付费']:[]),'报价、起始编号、最低到账及截止时间均为本次钱包重新生成；邀请仅适用于首次付费。']};
 return {name:profile.kind,profile,abi,registry,own,firstPaid,block,timestamp:Number(BigInt(header.timestamp)),minted,free,paid,mixed:true,txCap:min(txCap,500n),quote,info,freeReason,token:meta.address,assetKind:'Erc20'};
}
export async function guardedIdReferral(rpc,meta,state){
 if(!state.profile.routes.some(r=>r.roles.includes('inviter')))return null;
 const inviter=await identity(rpc,state.registry,wallet(1),state.block);
 return {detected:true,account:1,address:inviter.address,valueKind:'agentId',linkValue:String(inviter.id),bindingVerified:true,bindingRule:'first-paid',appliesTo:[2,3],note:'1 号 Agent ID 已核验；仅在 2、3 号首次付费铸造时传入，免费铸造不绑定邀请。'};
}
function callError(e,abi){let decoded;try{decoded=abi.parseError(e.data||e.message.match(/0x[0-9a-f]{8,}/i)?.[0]);}catch{}
 const messages={StaleQuote:'起始编号或报价已变化，请重新预览本次操作',InvalidIdOrQuota:'Agent ID 所有权或剩余额度已变化',InvalidReferral:'邀请仅适用于首次付费，邀请人必须是不同钱包的有效 Agent ID',IncorrectPayment:'付款与当前报价不一致',ReservePriceOutsideWindow:'合约的市场价格保护未通过'};
 return decoded&&messages[decoded.name]?Object.assign(Error(messages[decoded.name]),{code:decoded.name}):e;
}
export async function guardedIdMintPlan(rpc,intent,meta,budget,w,resolved,profile=recognizeGuardedIdMint(meta)){
 if(!profile)return null;if(intent.routeId)throw Error('该身份报价类型自动选择对应入口，请清除旧的方式选择');
 const s=await guardedIdMintState(rpc,intent,meta,w,profile);
 if(intent.scope==='free'&&!s.free)throw noQuota(s.freeReason+`；本钱包免费 0 份，付费 ${s.info.paidRemaining} 份`+(s.info.paidPriceBnb?`（当前每份 ${s.info.paidPriceBnb} BNB）`:'')+'。本次未切换到付费。',{quota:s.info});
 const q=await chooseBatch(s,intent,budget),minimum=q.out*BigInt(10000-(intent.slippageBps??100))/10000n;if(minimum<=0n)throw Error('最低到账必须大于 0');
 let route=profile.routes.find(r=>!r.roles.includes('inviter')),referral=null;
 const wantsReferral=intent.referral==='account1'&&[2,3].includes(w.account);
 if(wantsReferral&&q.cost>0n&&!s.firstPaid){route=profile.routes.find(r=>r.roles.includes('inviter'));if(!route)throw Error('尚未核验所需邀请入口');referral=await guardedIdReferral(rpc,meta,s);}
 else if(wantsReferral)referral={detected:true,active:false,bindingVerified:true,note:q.cost===0n?'本次是免费份额，合约不支持免费绑定邀请；首次付费时会重新检查':'该 ID 已完成首次付费，本次不能新绑定邀请'};
 const values={id:s.own.id,quantity:q.n,start:s.minted+1n,minimum,deadline:BigInt(s.timestamp+180),inviter:referral?.linkValue};
 const step={kind:'mint',to:meta.address,value:String(q.cost),data:s.abi.encodeFunctionData(route.method,route.roles.map(r=>values[r]))};
 try{await rpc.call({to:step.to,data:step.data,value:q.cost,from:w.address},s.block);}catch(e){throw callError(e,s.abi);}
 return {kind:'contract',route:profile.kind+':'+route.method,token:meta.address,wallet:w.address,inputToken:BNB,outputToken:meta.address,amountIn:String(q.cost),minOutput:String(minimum),quantity:Number(q.n),identity:meta.identity,metaVerified:true,requireAssetCredit:true,freshBeforeExecute:true,
  expectedAsset:{token:meta.address,kind:'Erc20',amount:String(minimum)},referral,review:['已核验调用结构、当前身份和报价；这不等于项目安全审计',...s.info.notes],quota:s.info,fill:{continue:q.continue,remainingBefore:String(q.remaining)},budgetCurrency:'BNB',quote:{block:s.block,expectedStart:String(values.start),deadline:String(values.deadline),cost:String(q.cost),tokens:String(q.out),freeUnits:String(q.freeUnits),paidUnits:String(q.paidUnits)},steps:[step]};
}
