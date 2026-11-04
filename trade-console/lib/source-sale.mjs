import parser from '@solidity-parser/parser';
import {Interface} from 'ethers';
import {USDT,BNB,ERC20,read,same,parseUnits,formatUnits,ZeroAddress} from './common.mjs';
import {addressReferral,referralParameter} from './referral.mjs';
import {runtimeShape} from './bytecode.mjs';
import {chooseBatch,min,positive} from './mint-policy.mjs';

// Infer a bounded sale from verified Solidity data flow. No domain, deployment,
// function-name or whole-body hash is an execution template. Arbitrary JS is
// never evaluated. Unknown expressions remain unsupported, not guessed values.
const memo=new WeakMap(),ident=(n,s)=>n?.type==='Identifier'&&n.name===s;
const caller=n=>n?.type==='MemberAccess'&&ident(n.expression,'msg')&&n.memberName==='sender';
const castName=n=>n?.expression?.name||n?.expression?.typeName?.name;
const self=n=>n?.type==='FunctionCall'&&castName(n)==='address'&&n.arguments.length===1&&ident(n.arguments[0],'this');
function walk(n,fn){if(!n||typeof n!=='object')return;fn(n);for(const [k,v]of Object.entries(n))if(!['loc','range'].includes(k)){if(Array.isArray(v))v.forEach(x=>walk(x,fn));else if(v&&typeof v==='object')walk(v,fn);}}
const failure=(code,message,details)=>Object.assign(Error(message),{code,details});
const unsupported=message=>failure('MINT_ADAPTER_INCOMPLETE',message);
const hasQty=e=>e?.kind==='quantity'||(e?.args||[]).some(hasQty);
const hasWallet=e=>e?.kind==='wallet'||(e?.args||[]).some(hasWallet);
const msgValue=n=>n?.type==='MemberAccess'&&ident(n.expression,'msg')&&n.memberName==='value';
// Inline only a transparent entry wrapper: a single internal call, positional
// forwarding of its own parameters (or address(0)), with no extra statements.
// This is AST substitution, not execution of downloaded code.
function entryBody(contract,fn){
 const s=fn.body.statements;if(s.length!==1||s[0].type!=='ExpressionStatement')return fn;
 const call=s[0].expression;if(call?.type!=='FunctionCall'||call.expression?.type!=='Identifier')return fn;
 const helpers=contract.subNodes.filter(n=>n.type==='FunctionDefinition'&&n.name===call.expression.name&&['internal','private'].includes(n.visibility)&&n.parameters?.length===call.arguments.length&&n.body&&!(n.modifiers||[]).length);
 if(helpers.length!==1)return fn;const helper=helpers[0],mapping=new Map();
 for(let i=0;i<call.arguments.length;i++){const arg=call.arguments[i];if(arg.type==='Identifier'&&fn.parameters.some(p=>p.name===arg.name))mapping.set(helper.parameters[i].name,arg);else if(arg.type==='FunctionCall'&&castName(arg)==='address'&&arg.arguments[0]?.number==='0')mapping.set(helper.parameters[i].name,arg);else return fn;}
 const replace=n=>{if(!n||typeof n!=='object')return n;if(n.type==='Identifier'&&mapping.has(n.name))return structuredClone(mapping.get(n.name));if(Array.isArray(n))return n.map(replace);return Object.fromEntries(Object.entries(n).map(([k,v])=>[k,replace(v)]));};
 return {...fn,body:replace(helper.body),bodyOrigin:helper.name};
}
function compileRoute(meta,contract,fn,abi,shape){
 const method=abi.fragments.find(f=>f.type==='function'&&f.name===fn.name&&f.inputs.length===fn.parameters.length&&f.inputs[0].type==='uint256'&&f.inputs[0].name===fn.parameters[0].name&&['nonpayable','payable'].includes(f.stateMutability)&&f.inputs.slice(1).every(p=>p.type==='uint256'||p.type==='address'&&referralParameter(p.name)));
 if(!method||!shape.selectors.has(method.selector)||/approve|transfer|withdraw|refund|redeem|burn|stake|deposit|admin|rescue|set[A-Z_]/.test(method.name))return null;
 fn=entryBody(contract,fn);const native=method.stateMutability==='payable';
 const qty=fn.parameters[0].name,vars=contract.subNodes.filter(n=>n.type==='StateVariableDeclaration').flatMap(n=>n.variables),stable=new Set(vars.filter(v=>v.isImmutable||v.isDeclaredConst).map(v=>v.name));
 const alias=new Map(),topCalls=[];
 for(const s of fn.body.statements){if(s.type==='VariableDeclarationStatement'){if(s.variables.length===1)alias.set(s.variables[0].name,s.initialValue);else if(s.initialValue?.type==='FunctionCall')s.variables.forEach((v,index)=>{if(v?.name)alias.set(v.name,{type:'TupleProjection',call:s.initialValue,index});});}if(s.type==='ExpressionStatement'&&s.expression?.type==='FunctionCall')topCalls.push(s.expression);}
 const costParams=method.inputs.slice(1).filter(p=>p.type==='uint256').map(p=>p.name);
 let mutated=false;walk(fn.body,n=>{const lhs=n.type==='BinaryOperation'&&/^(=|[+*\/%-]=)$/.test(n.operator)?n.left:n.type==='UnaryOperation'&&['++','--','delete'].includes(n.operator)?n.subExpression:null;if(lhs?.type==='Identifier'&&(lhs.name===qty||costParams.includes(lhs.name)||alias.has(lhs.name)))mutated=true;});if(mutated)return null;
 const resolve=(n,depth=0)=>depth<8&&n?.type==='Identifier'&&alias.has(n.name)?resolve(alias.get(n.name),depth+1):n;
 const getter=(name,args=[],index=null)=>{const choices=abi.fragments.filter(f=>f.type==='function'&&f.name===name&&['view','pure'].includes(f.stateMutability)&&f.inputs.length===args.length&&(index===null?f.outputs.length===1:f.outputs.length>index&&f.outputs.length<=4)&&['uint256','address','bool'].includes(f.outputs[index??0]?.type)&&shape.selectors.has(f.selector));if(choices.length!==1)throw unsupported('无法唯一核验源码读取接口：'+name);return {kind:'read',method:choices[0].format('sighash'),args,...(index===null?{}:{index})};};
 const expr=(input,depth=0)=>{if(depth>12)throw unsupported('源码表达式过深');const n=resolve(input);
  if(n?.type==='TupleProjection'&&n.call.expression?.type==='Identifier')return getter(n.call.expression.name,n.call.arguments.map(a=>expr(a,depth+1)),n.index);
  if(ident(n,qty))return {kind:'quantity'};
  if(caller(n))return {kind:'wallet'};
  if(n?.type==='NumberLiteral'&&!n.subdenomination&&/^(?:0x[\da-f]+|\d+)$/i.test(n.number))return {kind:'number',value:n.number};
  if(n?.type==='BooleanLiteral')return {kind:'boolean',value:n.value};
  if(n?.type==='Identifier')return getter(n.name);
  if(n?.type==='MemberAccess'&&ident(n.expression,'block')&&n.memberName==='timestamp')return {kind:'timestamp'};
  if(n?.type==='IndexAccess'){let root=n,keys=[];while(root?.type==='IndexAccess'&&keys.length<4){keys.unshift(expr(root.index,depth+1));root=root.base;}if(root?.type==='Identifier')return getter(root.name,keys);}
  if(n?.type==='FunctionCall'&&n.expression?.type==='Identifier')return getter(n.expression.name,n.arguments.map(a=>expr(a,depth+1)));
  if(n?.type==='FunctionCall'&&n.expression?.type==='MemberAccess'&&n.expression.memberName==='balanceOf'&&n.arguments.length===1){return {kind:'balance',target:assetGetter(n.expression.expression),args:[self(n.arguments[0])?{kind:'self'}:expr(n.arguments[0],depth+1)]};}
  if(n?.type==='UnaryOperation'&&n.operator==='!')return {kind:'not',args:[expr(n.subExpression,depth+1)]};
  if(n?.type==='BinaryOperation'&&['+','-','*','/','%','<','>','<=','>=','==','!=','&&','||'].includes(n.operator))return {kind:n.operator,args:[expr(n.left,depth+1),expr(n.right,depth+1)]};
  throw unsupported('源码包含尚不能核验的报价或额度表达式');
 };
 const assetGetter=input=>{let n=resolve(input);for(let i=0;i<4&&n?.type==='FunctionCall'&&n.arguments.length===1&&/^(?:address|I?ERC20|IERC20Metadata)$/.test(castName(n)||'');i++)n=resolve(n.arguments[0]);if(n?.type!=='Identifier'||!stable.has(n.name))throw unsupported('付款或资产地址不是固定公开字段');const g=getter(n.name);if(abi.getFunction(g.method).outputs[0].type!=='address')throw unsupported('资产字段不是地址');return g;};
 const pulls=topCalls.filter(c=>c.expression?.type==='MemberAccess'&&/^(safeTransferFrom|transferFrom)$/.test(c.expression.memberName));
 const credits=topCalls.filter(c=>c.expression?.type==='MemberAccess'&&/^(safeTransfer|transfer|mint)$/.test(c.expression.memberName)&&c.arguments.length===2&&caller(resolve(c.arguments[0])));
 if(pulls.length!==(native?0:1)||credits.length!==1)return null;
 const pull=pulls[0],credit=credits[0];if(!native&&(pull.arguments.length!==3||!caller(resolve(pull.arguments[0]))||!self(resolve(pull.arguments[1]))))return null;
 const revert=n=>n?.type==='RevertStatement'?n:n?.type==='Block'&&n.statements.length===1?revert(n.statements[0]):null;
 const conditionOf=s=>{
  if(s.type==='IfStatement'&&!s.falseBody&&revert(s.trueBody))return s.condition;
  const c=s.type==='ExpressionStatement'?s.expression:null;
  if(c?.type==='FunctionCall'&&ident(c.expression,'require')&&c.arguments[0]?.type==='BinaryOperation'){
   const n=c.arguments[0],op=({'==':'!=','!=':'==','>=':'<','<=':'>','>':'<=','<':'>='})[n.operator];
   if(op)return {...n,operator:op};
  }
  return null;
 };
 const nativePayments=fn.body.statements.flatMap(statement=>{const c=conditionOf(statement);if(c?.type!=='BinaryOperation')return [];
  if(msgValue(c.left)&&['!=','<'].includes(c.operator))return [{statement,due:c.right}];
  if(msgValue(c.right)&&['!=','>'].includes(c.operator))return [{statement,due:c.left}];return [];
 });
 if(native&&nativePayments.length!==1)return null;
 const payment=native?null:assetGetter(pull.expression.expression),token=assetGetter(credit.expression.expression),cost=expr(native?nativePayments[0].due:pull.arguments[2]),out=expr(credit.arguments[1]);
 if(payment?.method===token.method||!hasQty(cost))return null;
 const tupleOutput=out.kind==='read'&&out.index!==undefined&&cost.kind==='read'&&cost.index!==undefined&&out.index!==cost.index&&out.method===cost.method&&JSON.stringify(out.args)===JSON.stringify(cost.args)&&hasQty(out);
 if(!tupleOutput&&(out.kind!=='*'||!out.args.some(a=>a.kind==='quantity')||out.args.filter(hasQty).length!==1))return null;
 const unit=tupleOutput?null:out.args.find(a=>a.kind!=='quantity');if(!tupleOutput&&(!unit||hasQty(unit)))return null;
 if(tupleOutput&&credit.expression.memberName!=='mint')return null; // dynamic inventory division would not prove a supply cap
 // Both quote and asset credit must use the original quantity, without alias
 // reassignment. Extra pulls anywhere in the entry are rejected.
 let nestedPulls=0;walk(fn.body,n=>{if(n.type==='FunctionCall'&&n.expression?.type==='MemberAccess'&&/^(safeTransferFrom|transferFrom)$/.test(n.expression.memberName))nestedPulls++;});if(nestedPulls!==(native?0:1))return null;
 // Infer a caller-supplied payment ceiling from its comparison to the exact
 // source-bound debit. Its name is irrelevant; unknown integers stay rejected.
 const costGuards=new Set(),boundCosts=new Set();
 for(const s of fn.body.statements){const c=conditionOf(s);if(!c)continue;
  let cap,due;if(c.operator==='>'&&costParams.some(n=>ident(c.right,n))){cap=c.right.name;due=c.left;}
  else if(c.operator==='<'&&costParams.some(n=>ident(c.left,n))){cap=c.left.name;due=c.right;}
  if(cap&&JSON.stringify(expr(due))===JSON.stringify(cost)){boundCosts.add(cap);costGuards.add(s);}
 }
 if(costParams.some(n=>!boundCosts.has(n)))return null;
 const guards=[];
 const guardBlock=body=>{for(const s of body?.statements||[]){const rev=s.type==='IfStatement'&&!s.falseBody?revert(s.trueBody):null;
  if(costGuards.has(s)||nativePayments.some(p=>p.statement===s))continue;
  if(rev){guards.push({condition:expr(s.condition),error:rev.revertCall?.expression?.name||'require'});continue;}
  const c=s.type==='ExpressionStatement'?s.expression:null;if(c?.type==='FunctionCall'&&ident(c.expression,'require')&&c.arguments.length){guards.push({condition:{kind:'not',args:[expr(c.arguments[0])]},error:c.arguments[1]?.value||'require'});}
 }};
 // Only guards before the first state mutation/payment are entry constraints.
 const prefix=[];for(const s of fn.body.statements){if(s.type==='ExpressionStatement'&&(s.expression===pull||s.expression?.type==='BinaryOperation'))break;prefix.push(s);}guardBlock({statements:prefix});
 for(const m of fn.modifiers||[]){if(m.name==='nonReentrant')continue;const mod=contract.subNodes.find(n=>n.type==='ModifierDefinition'&&n.name===m.name);if(!mod||m.arguments?.length)throw unsupported('无法核验入口修饰器：'+m.name);guardBlock(mod.body);}
 const caps=[];
 const capFrom=(e,invert=false)=>{if(e.kind==='not')return capFrom(e.args[0],!invert);if(e.kind===(invert?'&&':'||')){e.args.forEach(a=>capFrom(a,invert));return;}let [lhs,rhs]=e.args||[];const op=invert?({'<=':'>','<':'>=','>=':'<','>':'<='}[e.kind]):e.kind;if(!['>','>='].includes(op)||!hasQty(lhs)||hasQty(rhs))return;
  let used=null,factor={kind:'number',value:'1'},quantity=lhs;if(lhs.kind==='+'){used=lhs.args.find(a=>!hasQty(a));quantity=lhs.args.find(hasQty);}else used={kind:'number',value:'0'};
  if(quantity?.kind==='*'&&quantity.args.filter(a=>a.kind==='quantity').length===1){factor=quantity.args.find(a=>a.kind!=='quantity');quantity={kind:'quantity'};}
  if(quantity?.kind!=='quantity'||!used||hasQty(used)||hasQty(factor))return;
  caps.push({limit:rhs,used,factor,adjust:op==='>='?1:0,scope:hasWallet(used)||hasWallet(rhs)?'wallet':used.kind==='number'&&used.value==='0'?'transaction':'global'});
 };
 guards.forEach(g=>capFrom(g.condition));
 if(!caps.some(c=>c.scope==='wallet'))throw unsupported('未从源码约束中核验本钱包额度，不支持打满');
 return {kind:native?'source-native-sale':'source-erc20-sale',native,method:method.format('sighash'),selector:method.selector,roles:method.inputs.map((p,i)=>i===0?'quantity':p.type==='uint256'?'cost':'zero'),bodyOrigin:fn.bodyOrigin||null,payment,token,cost,unit,...(tupleOutput?{output:out}:{}),guards,caps,inventory:credit.expression.memberName!=='mint'};
}
export function recognizeSourceSale(meta){
 if(memo.has(meta))return memo.get(meta);let result=null;
 if(meta.verified&&!meta.proxy&&!meta.identity?.implementation){const shape=runtimeShape(meta.runtimeCode);if(!shape.delegate){const abi=new Interface(meta.abi),routes=[];
  for(const source of Object.values(meta.sources||{}))try{parser.visit(parser.parse(source.content),{ContractDefinition(c){for(const f of c.subNodes.filter(n=>n.type==='FunctionDefinition'&&n.body&&n.parameters?.length>=1&&n.parameters[0].typeName?.name==='uint256'&&['public','external'].includes(n.visibility)))try{const route=compileRoute(meta,c,f,abi,shape);if(route)routes.push(route);}catch{}}});}catch{}
  if(routes.length===1)result=routes[0];
  else if(routes.length===2&&routes[0].bodyOrigin&&routes[0].bodyOrigin===routes[1].bodyOrigin&&JSON.stringify([routes[0].cost,routes[0].token,routes[0].unit,routes[0].caps])===JSON.stringify([routes[1].cost,routes[1].token,routes[1].unit,routes[1].caps])&&routes.some(r=>r.roles.length===1)&&routes.some(r=>r.roles.length===2))result=routes.find(r=>r.roles.length===2);
 }}
 if(result&&!result.roles.includes('zero'))result.unresolvedReferral=(meta.abi||[]).some(f=>f.type==='function'&&!['view','pure'].includes(f.stateMutability)&&f.inputs?.some(p=>p.type==='address'&&referralParameter(p.name)));
 memo.set(meta,result);return result;
}

export async function sourceSaleState(rpc,intent,meta,w,profile=recognizeSourceSale(meta)){
 if(!profile)return null;const abi=new Interface(meta.abi),block=await rpc.getBlockNumber(),header=await rpc.send('eth_getBlockByNumber',['0x'+block.toString(16),false]),cache=new Map();
 const evaluate=async(e,q=1n)=>{
  if(e.kind==='quantity')return q;if(e.kind==='wallet')return w.address;if(e.kind==='self')return meta.address;if(e.kind==='timestamp')return BigInt(header.timestamp);if(e.kind==='number')return BigInt(e.value);if(e.kind==='boolean')return e.value;
  const args=await Promise.all((e.args||[]).map(a=>evaluate(a,q)));
  if(e.kind==='read'){const key=e.method+args.join(',');if(!cache.has(key))cache.set(key,read(rpc,meta.address,abi,e.method,args,block));const values=await cache.get(key),index=e.index??0;if(e.index===undefined&&values.length!==1||index>=values.length)throw unsupported('状态返回字段不匹配');return values[index];}
  if(e.kind==='balance'){const target=await evaluate(e.target,q),key=target+args.join(',');if(!cache.has(key))cache.set(key,read(rpc,target,ERC20,'balanceOf',args,block).then(r=>r[0]));return cache.get(key);}
  const [a,b]=args;switch(e.kind){case'not':return !a;case'+':return a+b;case'-':if(a<b)throw unsupported('状态计数下溢');return a-b;case'*':return a*b;case'/':return a/b;case'%':return a%b;case'<':return a<b;case'>':return a>b;case'<=':return a<=b;case'>=':return a>=b;case'==':return a===b;case'!=':return a!==b;case'&&':return a&&b;case'||':return a||b;default:throw unsupported('未知源码表达式');}
 };
 const [payment,token,unit,price,limits,guardResults]=await Promise.all([profile.native?BNB:evaluate(profile.payment),evaluate(profile.token),evaluate(profile.output||profile.unit),evaluate(profile.cost),Promise.all(profile.caps.map(async c=>({...c,remaining:positive((await evaluate(c.limit))-(await evaluate(c.used))-BigInt(c.adjust))/(await evaluate(c.factor||{kind:'number',value:'1'}))}))),Promise.all(profile.guards.map(async g=>({...g,failed:await evaluate(g.condition)})))]);
 if(!profile.native&&!same(payment,USDT))throw unsupported('已识别 ERC20 付款方式，但该计价币尚未接入预算限制');
 if(same(token,ZeroAddress)||same(token,payment)||unit<=0n||price<=0n)throw unsupported('付款、到账资产或报价无效');
 const [[decimals],[inventory]]=await Promise.all([read(rpc,token,ERC20,'decimals',[],block),read(rpc,token,ERC20,'balanceOf',[meta.address],block)]);
 if(decimals>36n)throw unsupported('资产精度无效');
 const walletLimits=limits.filter(c=>c.scope==='wallet').map(c=>c.remaining),txLimits=limits.filter(c=>c.scope==='transaction').map(c=>c.remaining),globalLimits=limits.filter(c=>c.scope==='global').map(c=>c.remaining);
 const walletCap=min(...walletLimits),globalCap=min(...globalLimits,profile.inventory?inventory/unit:BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')),paid=min(walletCap,globalCap),txCap=min(...txLimits,500n);
 const freeEntries=abi.fragments.some(f=>f.type==='function'&&!['view','pure'].includes(f.stateMutability)&&/free|airdrop|^(?:claim|claimGift|giftMint)$/i.test(f.name));
 let blocked=null,blockedCode=null;
 const bad=guardResults.filter(g=>g.failed&&!hasQty(g.condition))[0];
 if(bad){const n=bad.error;if(/end|closed|finished|expired/i.test(n)){blockedCode='MINT_ENDED';blocked='铸造阶段已结束（链上源码约束 '+n+'）';}else if(/notopen|notstarted|tooearly/i.test(n)){blockedCode='MINT_NOT_OPEN';blocked='铸造尚未开放（链上源码约束 '+n+'）';}else if(/agent|eligible|identity/i.test(n)){blockedCode='MINT_INELIGIBLE';blocked='当前钱包不满足项目身份资格（'+n+'）';}else if(/paused/i.test(n)){blockedCode='MINT_PAUSED';blocked='合约已暂停铸造';}else{blockedCode='MINT_STATE';blocked='当前链上入口约束不满足：'+n;}}
 const info={block,currency:profile.native?'BNB':'USDT',freeRemaining:freeEntries?null:'0',paidRemaining:String(paid),walletRemaining:String(walletCap),globalRemaining:String(globalCap),maxPerTransaction:String(txCap),...(profile.native?{unitPrice:{raw:String(price),formatted:formatUnits(price,18),symbol:'BNB'}}:{unitPriceUsdt:formatUnits(price,18)}),tokensPerShare:formatUnits(unit,Number(decimals)),blocked,errorCode:blockedCode,freeUnknown:freeEntries,notes:['从已核验源码推导付款、到账与份额限制；每次按当前钱包重读，不复制历史交易。']};
 const referral=addressReferral(meta,profile,intent);
 return {name:profile.kind,token,assetKind:'Erc20',inputToken:payment,block,free:0n,paid,txCap,info,blocked,blockedCode,freeUnknown:freeEntries,
  referral,quote:async n=>{for(const g of profile.guards)if(await evaluate(g.condition,n))throw failure('MINT_STATE','本批数量不满足源码约束：'+g.error,{quota:info});const cost=await evaluate(profile.cost,n);if(cost<=0n)throw unsupported('当前付款报价无效');const out=profile.output?await evaluate(profile.output,n):n*unit;if(out<=0n)throw unsupported('当前到账报价无效');return {cost,out,step:{kind:'mint',to:meta.address,value:profile.native?String(cost):'0',data:abi.encodeFunctionData(profile.method,profile.roles.map(role=>role==='quantity'?n:role==='cost'?cost:referral?.callValue||ZeroAddress))}};}
 };
}
export async function sourceSalePlan(rpc,intent,meta,w,resolved,profile=recognizeSourceSale(meta)){
 if(!profile)return null;const s=await sourceSaleState(rpc,intent,meta,w,profile);
 if(s.blocked)throw failure(s.blockedCode,s.blocked,{quota:s.info});
 if(intent.scope!=='paid'&&s.freeUnknown)throw unsupported('发现独立免费入口，尚未核验其凭证或参数；可明确选择已核验的付费方式');
 if(intent.scope==='free')throw failure('NO_FREE_MINT','这个入口只有 '+s.info.currency+' 付费铸造，没有零费用份额；不会自动改成付费',{quota:s.info});
 if(intent.routeId&&!['source:'+profile.method,profile.method].includes(intent.routeId))throw failure('MINT_ROUTE_INVALID','所选入口与当前源码推导方式不一致');
 if(!s.referral&&(resolved.referralHints?.detected||profile.unresolvedReferral)&&intent.referral==='account1'&&[2,3].includes(intent.account))throw failure('REFERRAL_NOT_VERIFIED','发现邀请制度，但当前入口尚未核验邀请绑定；不会省略 1 号邀请继续铸造');
 const q=await chooseBatch(s,intent,parseUnits((profile.native?intent.maxBnb:intent.maxUsdt)||'0',18));
 if(profile.native){await rpc.call({to:meta.address,from:w.address,data:q.step.data,value:q.cost},s.block);return {kind:'contract',route:profile.kind+':'+profile.method,token:s.token,wallet:w.address,inputToken:BNB,outputToken:s.token,amountIn:String(q.cost),minOutput:String(q.out),quantity:Number(q.n),identity:meta.identity,metaVerified:true,freshBeforeExecute:true,requireAssetCredit:true,expectedAsset:{token:s.token,kind:'Erc20',amount:String(q.out)},quota:s.info,referral:s.referral,fill:{continue:q.continue,lane:'paid',remainingBefore:String(q.remaining)},budgetCurrency:'BNB',review:s.info.notes,steps:[q.step]};}
 const [[balance],[allowance]]=await Promise.all([read(rpc,USDT,ERC20,'balanceOf',[w.address],s.block),read(rpc,USDT,ERC20,'allowance',[w.address,meta.address],s.block)]);
 if(balance<q.cost)throw failure('BUDGET_LIMIT','USDT 余额不足以支付本批铸造；未自动换币',{quota:s.info});
 const steps=[];if(allowance<q.cost)steps.push({kind:'approve',to:USDT,spender:meta.address,allowance:String(q.cost),value:'0',data:ERC20.encodeFunctionData('approve',[meta.address,q.cost])});
 if(!steps.length)await rpc.call({to:meta.address,from:w.address,data:q.step.data,value:0n},s.block);
 return {kind:'contract',route:profile.kind+':'+profile.method,token:s.token,wallet:w.address,inputToken:USDT,outputToken:s.token,amountIn:String(q.cost),minOutput:String(q.out),quantity:Number(q.n),identity:meta.identity,metaVerified:true,freshBeforeExecute:true,requireAssetCredit:true,expectedAsset:{token:s.token,kind:'Erc20',amount:String(q.out)},approvalFirst:!!steps.length,quota:s.info,fill:{continue:q.continue,lane:'paid',remainingBefore:String(q.remaining)},budgetCurrency:'USDT',review:[...s.info.notes,...(steps.length?['当前仅预览精确额度授权；Mint 必须等授权上链后另行通过官方模拟，不能把授权预览称为 Mint 成功。']:[])],steps:[...steps,q.step]};
}
