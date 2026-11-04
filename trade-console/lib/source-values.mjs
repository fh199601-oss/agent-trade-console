import parser from '@solidity-parser/parser';
import {Interface,toUtf8Bytes} from 'ethers';

// A deliberately small Solidity value interpreter. It evaluates ONLY local
// arithmetic and ABI-declared view/pure reads, never JS, storage writes, calls
// to another address, signatures, proof downloads or transaction instructions.
const memo=new WeakMap(),maxUint=(1n<<256n)-1n;
const error=message=>Object.assign(Error(message),{code:'MINT_PARAMETER_UNSUPPORTED'});
function walk(n,fn){if(!n||typeof n!=='object')return;fn(n);for(const [k,v]of Object.entries(n))if(!['loc','range'].includes(k)){if(Array.isArray(v))v.forEach(x=>walk(x,fn));else if(v&&typeof v==='object')walk(v,fn);}}
const sender=n=>n?.type==='MemberAccess'&&n.expression?.name==='msg'&&n.memberName==='sender';
const simpleType=p=>['uint256','address','bool','string'].includes(p.typeName?.name);
const byteLength=n=>n?.type==='MemberAccess'&&n.memberName==='length'&&n.expression?.type==='FunctionCall'&&(n.expression.expression?.type==='ElementaryTypeName'&&n.expression.expression.name==='bytes'||n.expression.expression?.type==='ElementaryTypeNameExpression'&&n.expression.expression.typeName?.name==='bytes')&&n.expression.arguments.length===1;
function contracts(meta){if(memo.has(meta))return memo.get(meta);const rows=[];for(const s of Object.values(meta.sources||{}))try{parser.visit(parser.parse(s.content),{ContractDefinition:n=>rows.push(n)});}catch{}memo.set(meta,rows);return rows;}
export function walletParameterPrograms(meta,fragment){
 if(!meta.verified||meta.proxy||meta.identity?.implementation)return {};
 const matches=contracts(meta).flatMap(c=>c.subNodes.filter(f=>f.type==='FunctionDefinition'&&f.name===fragment.name&&f.body&&f.parameters.length===fragment.inputs.length&&f.parameters.every((p,i)=>p.name===fragment.inputs[i].name)).map(f=>({c,f})));
 if(matches.length!==1)return {};const {c,f}=matches[0],abi=new Interface(meta.abi),programs={};
 const functions=c.subNodes.filter(n=>n.type==='FunctionDefinition'&&n.body),view=n=>['view','pure'].includes(n.stateMutability);
 const argument=n=>{
  if(sender(n))return {kind:'wallet'};
  if(n?.type!=='Identifier')return null;
  const declarations=[];let mutated=false;walk(f.body,v=>{if(v.type==='VariableDeclaration'&&v.name===n.name)declarations.push(v);if(v.type==='BinaryOperation'&&/^(=|[+*/%-]=)$/.test(v.operator)&&v.left?.name===n.name||v.type==='UnaryOperation'&&['++','--'].includes(v.operator)&&v.subExpression?.name===n.name)mutated=true;});
  const init=f.body.statements.find(s=>s.type==='VariableDeclarationStatement'&&s.variables.length===1&&s.variables[0]?.name===n.name)?.initialValue;
  if(mutated||declarations.length!==1||!init||init.type!=='FunctionCall'||init.arguments.length!==1||!sender(init.arguments[0]))return null;
  const direct=init.expression?.type==='Identifier'&&abi.fragments.filter(g=>g.type==='function'&&g.name===init.expression.name&&view(g)&&g.inputs.length===1&&g.inputs[0].type==='address'&&g.outputs.length===1&&['string','uint256','address','bool'].includes(g.outputs[0].type));
  if(direct?.length===1)return {kind:'read',method:direct[0].format('sighash')};
  // A verified, single-return wrapper exposes the same external read. Only
  // this contract's public view is called; no website-selected target is used.
  const wrappers=functions.filter(g=>view(g)&&g.parameters.length===1&&g.parameters[0].typeName?.name==='address'&&!g.modifiers?.length&&g.body.statements.length===1&&g.body.statements[0].type==='ReturnStatement').filter(g=>{const ret=g.body.statements[0].expression;return ret?.type==='FunctionCall'&&ret.arguments.length===1&&ret.arguments[0]?.name===g.parameters[0].name&&JSON.stringify(ret.expression)===JSON.stringify(init.expression);});
  const choices=wrappers.flatMap(g=>abi.fragments.filter(a=>a.type==='function'&&a.name===g.name&&view(a)&&a.inputs.length===1&&a.inputs[0].type==='address'&&a.outputs.length===1&&['string','uint256','address','bool'].includes(a.outputs[0].type)));
  return choices.length===1?{kind:'read',method:choices[0].format('sighash')}:null;
 };
 for(const [index,input]of fragment.inputs.entries()){
  if(input.type!=='uint256')continue;const checks=[];
  for(const s of f.body.statements){const rev=s.trueBody?.type==='RevertStatement'||s.trueBody?.type==='Block'&&s.trueBody.statements.length===1&&s.trueBody.statements[0].type==='RevertStatement';
   const req=s.type==='ExpressionStatement'&&s.expression?.type==='FunctionCall'&&s.expression.expression?.name==='require'?s.expression.arguments[0]:null;
   const condition=s.type==='IfStatement'&&!s.falseBody&&rev&&s.condition?.operator==='!='?s.condition:req?.operator==='=='?req:null;
   if(!condition)continue;const a=condition.left,b=condition.right,other=a?.name===input.name?b:b?.name===input.name?a:null;
   if(other?.type==='FunctionCall'&&other.expression?.type==='Identifier'&&other.arguments.length>0&&other.arguments.length<=4&&other.arguments.every(n=>argument(n)))checks.push(other);
  }
  if(checks.length!==1)continue;
  const helpers=functions.filter(n=>n.name===checks[0].expression.name&&view(n)&&!n.modifiers?.length&&n.parameters?.length===checks[0].arguments.length&&n.parameters.every(simpleType)&&n.returnParameters?.length===1&&n.returnParameters[0].typeName?.name==='uint256');
  if(helpers.length!==1)continue;const helper=helpers[0],locals=new Set([...helper.parameters,...helper.returnParameters].map(p=>p.name).filter(Boolean));let valid=true;
  walk(helper.body,n=>{if(n.type==='VariableDeclaration'){if(!simpleType(n))valid=false;locals.add(n.name);}});
  const nodes=new Set(['Block','VariableDeclarationStatement','VariableDeclaration','ElementaryTypeName','ElementaryTypeNameExpression','MemberAccess','Identifier','NumberLiteral','BooleanLiteral','BinaryOperation','UnaryOperation','Conditional','FunctionCall','ExpressionStatement','ForStatement','IfStatement','ReturnStatement','TupleExpression']);
  walk(helper.body,n=>{if(!n.type)return;if(!nodes.has(n.type))valid=false;
   if(n.type==='MemberAccess'&&!byteLength(n))valid=false;
   if(n.type==='ElementaryTypeNameExpression'&&n.typeName?.name!=='bytes')valid=false;
   if(n.type==='Identifier'&&!locals.has(n.name)){const choices=abi.fragments.filter(f=>f.type==='function'&&f.name===n.name&&['view','pure'].includes(f.stateMutability));if(choices.length!==1)valid=false;}
   if(n.type==='FunctionCall'&&!['ElementaryTypeName','ElementaryTypeNameExpression'].includes(n.expression?.type)){const choices=abi.fragments.filter(f=>f.type==='function'&&f.name===n.expression?.name&&['view','pure'].includes(f.stateMutability)&&f.inputs.length===n.arguments.length&&f.outputs.every(p=>['uint256','address','bool','string'].includes(p.type)));if(choices.length!==1)valid=false;}
   if(n.type==='BinaryOperation'&&/=$/.test(n.operator)&&!['==','!=','<=','>='].includes(n.operator)&&(!locals.has(n.left?.name)||n.left?.type!=='Identifier'))valid=false;
   if(n.type==='UnaryOperation'&&['++','--','delete'].includes(n.operator)&&(!locals.has(n.subExpression?.name)||n.operator==='delete'))valid=false;
  });
  // Reject writes to the original argument anywhere in the Mint entry.
  walk(f.body,n=>{if(n.type==='BinaryOperation'&&/^(=|[+*/%-]=)$/.test(n.operator)&&n.left?.name===input.name||n.type==='UnaryOperation'&&['++','--'].includes(n.operator)&&n.subExpression?.name===input.name)valid=false;});
  if(valid)programs[index]={parameter:input.name,helper:helper.name,fn:helper,arguments:checks[0].arguments.map(argument)};
 }
 return programs;
}
export async function evaluateWalletProgram(program,abi,wallet,read){
 const fn=program.fn,values=await Promise.all((program.arguments||[{kind:'wallet'}]).map(async a=>{if(a.kind==='wallet')return wallet;if(a.kind!=='read')throw error('未知钱包参数来源');const f=abi.getFunction(a.method);if(!f||!['view','pure'].includes(f.stateMutability))throw error('钱包参数读取不是只读方法');const v=(await read(a.method,[wallet]))[0];if(typeof v==='string'&&v.length>4096)throw error('钱包身份字符串过长');return v;})),locals=new Map(fn.parameters.map((p,i)=>[p.name,values[i]]));for(const p of fn.returnParameters)if(p.name)locals.set(p.name,0n);
 let operations=0,loops=0,returned=false,result;
 const tick=()=>{if(++operations>10000)throw error('钱包参数计算超过操作上限');};
 const uint=n=>{if(typeof n==='bigint'&&(n<0n||n>maxUint))throw error('钱包参数计算溢出');return n;};
 const binary=(op,a,b)=>{switch(op){case'+':return uint(a+b);case'-':return uint(a-b);case'*':return uint(a*b);case'/':return a/b;case'%':return a%b;case'==':return a===b;case'!=':return a!==b;case'<':return a<b;case'>':return a>b;case'<=':return a<=b;case'>=':return a>=b;case'&&':return a&&b;case'||':return a||b;default:throw error('钱包参数包含未支持的算式：'+op);}};
 const expr=async n=>{tick();if(!n)throw error('钱包参数表达式缺失');
  if(n.type==='Identifier'){if(!locals.has(n.name))throw error('钱包参数引用非局部变量');return locals.get(n.name);}
  if(n.type==='NumberLiteral'&&!n.subdenomination&&/^\d+$/.test(n.number))return uint(BigInt(n.number));
  if(n.type==='BooleanLiteral')return n.value;
  if(byteLength(n)){const value=await expr(n.expression.arguments[0]);if(typeof value!=='string'||value.length>4096)throw error('钱包参数字符串无效');return BigInt(toUtf8Bytes(value).length);}
  if(n.type==='TupleExpression'&&n.components.length===1)return expr(n.components[0]);
  if(n.type==='Conditional')return expr(await expr(n.condition)?n.trueExpression:n.falseExpression);
  if(n.type==='BinaryOperation'){
   if(/^(=|[+*/%-]=)$/.test(n.operator)){if(n.left.type!=='Identifier'||!locals.has(n.left.name))throw error('禁止修改链上状态');const rhs=await expr(n.right),value=n.operator==='='?rhs:binary(n.operator[0],locals.get(n.left.name),rhs);locals.set(n.left.name,value);return value;}
   const a=await expr(n.left);if(n.operator==='&&'&&!a)return false;if(n.operator==='||'&&a)return true;return binary(n.operator,a,await expr(n.right));
  }
  if(n.type==='UnaryOperation'){if(n.operator==='!')return !await expr(n.subExpression);if(['++','--'].includes(n.operator)&&locals.has(n.subExpression?.name)){const old=locals.get(n.subExpression.name),next=uint(old+(n.operator==='++'?1n:-1n));locals.set(n.subExpression.name,next);return n.isPrefix?next:old;}throw error('钱包参数包含未知单目操作');}
  if(n.type==='FunctionCall'){const candidates=abi.fragments.filter(f=>f.type==='function'&&f.name===n.expression?.name&&['view','pure'].includes(f.stateMutability)&&f.inputs.length===n.arguments.length);if(candidates.length!==1)throw error('钱包参数读取接口不唯一');const f=candidates[0],values=await read(f.format('sighash'),await Promise.all(n.arguments.map(expr)));return values.length===1?values[0]:Array.from(values);}
  throw error('钱包参数包含未支持的表达式：'+n.type);
 };
 const statement=async s=>{tick();if(!s||returned)return;
  if(s.type==='Block'){for(const child of s.statements){await statement(child);if(returned)break;}return;}
  if(s.type==='VariableDeclarationStatement'){const value=s.initialValue?await expr(s.initialValue):0n,values=s.variables.length===1?[value]:value;if(!Array.isArray(values)||values.length!==s.variables.length)throw error('钱包参数元组读取不匹配');s.variables.forEach((p,i)=>{if(!p)return;if(!simpleType(p))throw error('钱包参数类型不支持');locals.set(p.name,values[i]);});return;}
  if(s.type==='ExpressionStatement'){await expr(s.expression);return;}
  if(s.type==='ForStatement'){await statement(s.initExpression);while(await expr(s.conditionExpression)){if(++loops>256)throw error('钱包参数循环超过 256 次');await statement(s.body);if(returned)break;await statement(s.loopExpression);}return;}
  if(s.type==='IfStatement'){await statement(await expr(s.condition)?s.trueBody:s.falseBody);return;}
  if(s.type==='ReturnStatement'){result=await expr(s.expression);returned=true;return;}
  throw error('钱包参数包含未支持的语句：'+s.type);
 };
 await statement(fn.body);const value=returned?result:locals.get(fn.returnParameters[0].name);if(typeof value!=='bigint')throw error('钱包参数没有返回 uint256');return uint(value);
}
