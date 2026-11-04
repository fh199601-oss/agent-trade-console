import parser from '@solidity-parser/parser';import {Interface} from 'ethers';
// A price expression is accepted only when verified Solidity compares it to
// msg.value. Read programs call this contract's ABI view/pure functions only.
// No frontend code, guessed currency, foreign wallet values or state writes.
const cache=new WeakMap(),MAX=(1n<<256n)-1n;
const native=n=>n?.type==='MemberAccess'&&n.expression?.name==='msg'&&n.memberName==='value';
const sender=n=>n?.type==='MemberAccess'&&n.expression?.name==='msg'&&n.memberName==='sender';
function contracts(meta){if(cache.has(meta))return cache.get(meta);const out=[];for(const s of Object.values(meta.sources||{}))try{parser.visit(parser.parse(s.content),{ContractDefinition:c=>out.push(c)});}catch{}cache.set(meta,out);return out;}
export function nativePriceProgram(meta,fragment){
 if(!meta.verified||meta.proxy||meta.identity?.implementation)return null;
 const abi=new Interface(meta.abi),matches=contracts(meta).flatMap(c=>c.subNodes.filter(f=>f.type==='FunctionDefinition'&&f.body&&f.name===fragment.name&&f.parameters.length===fragment.inputs.length&&f.parameters.every((p,i)=>p.name===fragment.inputs[i].name)).map(f=>({c,f})));
 if(matches.length!==1)return null;const {c,f}=matches[0],functions=c.subNodes.filter(n=>n.type==='FunctionDefinition'&&n.body),candidates=[];
 const fail=()=>{throw Error('unsupported price expression');};
 const getter=(name,args)=>{const rows=abi.fragments.filter(g=>g.type==='function'&&g.name===name&&['view','pure'].includes(g.stateMutability)&&g.inputs.length===args.length);if(rows.length!==1)fail();return {kind:'read',method:rows[0].format('sighash'),args};};
 const mutable=new Set();const scan=n=>{if(!n||typeof n!=='object')return;if(n.type==='BinaryOperation'&&['=','+=','-=','*=','/='].includes(n.operator)&&n.left?.name)mutable.add(n.left.name);if(n.type==='UnaryOperation'&&['++','--','delete'].includes(n.operator)&&n.subExpression?.name)mutable.add(n.subExpression.name);for(const v of Object.values(n))if(Array.isArray(v))v.forEach(scan);else if(v&&typeof v==='object')scan(v);};scan(f.body);
 const expr=(n,env,depth=0)=>{
  if(depth>16||!n)fail();if(sender(n))return {kind:'wallet'};
  if(n.type==='TupleExpression'&&!n.isArray&&n.components.length===1)return expr(n.components[0],env,depth+1);
  if(n.type==='NumberLiteral'&&!n.subdenomination&&/^\d+$/.test(n.number))return {kind:'literal',value:n.number};
  if(n.type==='Identifier'){if(env.has(n.name))return env.get(n.name);return getter(n.name,[]);}
  if(n.type==='BinaryOperation'&&['+','-','*','/'].includes(n.operator))return {kind:n.operator,args:[expr(n.left,env,depth+1),expr(n.right,env,depth+1)]};
  if(n.type==='MemberAccess'){
   const parent=expr(n.expression,env,depth+1);if(parent.kind!=='read')fail();const g=abi.getFunction(parent.method),idx=g.outputs.findIndex(o=>o.name===n.memberName&&/^uint\d*$/.test(o.type));if(idx<0)fail();return {...parent,index:idx};
  }
  if(n.type==='FunctionCall'&&n.expression?.type==='Identifier'){
   const args=n.arguments.map(a=>expr(a,env,depth+1));try{return getter(n.expression.name,args);}catch{}
   const helper=functions.filter(h=>h.name===n.expression.name&&h.parameters.length===args.length&&['view','pure'].includes(h.stateMutability)&&!h.modifiers?.length);if(helper.length!==1)fail();
   return output(helper[0],args,depth+1);
  }
  fail();
 };
 const declaration=(s,env,depth)=>{
  if(s.type!=='VariableDeclarationStatement'||!s.initialValue)return;
  const value=expr(s.initialValue,env,depth+1),values=value.kind==='tuple'?value.values:[value];if(values.length!==s.variables.length)fail();
  s.variables.forEach((v,i)=>{if(v)env.set(v.name,values[i]);});
 };
 const output=(fn,args,depth)=>{
  if(depth>16)fail();const env=new Map(fn.parameters.map((p,i)=>[p.name,args[i]])),assigned=new Set();let ret;
  for(const s of fn.body.statements){
   if(s.type==='VariableDeclarationStatement'){declaration(s,env,depth);continue;}
   if(s.type==='ReturnStatement'){const n=s.expression;ret=n?.type==='TupleExpression'?{kind:'tuple',values:n.components.map(v=>expr(v,env,depth+1))}:expr(n,env,depth+1);break;}
   if(s.type==='ExpressionStatement'){
    const e=s.expression;if(e?.type==='BinaryOperation'&&e.operator==='='&&e.left?.type==='Identifier'&&fn.returnParameters.some(p=>p.name===e.left.name)&&!assigned.has(e.left.name)){assigned.add(e.left.name);env.set(e.left.name,expr(e.right,env,depth+1));continue;}
    fail();
   }
   // A pure guard can stop the actual mint, but cannot change this expression.
   const rev=s.trueBody?.type==='RevertStatement'||s.trueBody?.type==='Block'&&s.trueBody.statements.length===1&&s.trueBody.statements[0].type==='RevertStatement';
   if(!(s.type==='IfStatement'&&!s.falseBody&&rev))fail();
  }
  if(ret)return ret;const values=fn.returnParameters.map(p=>env.get(p.name));if(!values.length||values.some(v=>!v))fail();return values.length===1?values[0]:{kind:'tuple',values};
 };
 const visit=(fn,args,depth=0)=>{
  if(depth>8)return;const env=new Map(fn.parameters.map((p,i)=>[p.name,args[i]]));
  for(const s of fn.body.statements){
   try{declaration(s,env,depth);}catch{for(const v of s.variables||[])if(v)env.set(v.name,{kind:'unsupported'});}
   const rev=s.trueBody?.type==='RevertStatement'||s.trueBody?.type==='Block'&&s.trueBody.statements.length===1&&s.trueBody.statements[0].type==='RevertStatement';
   const req=s.type==='ExpressionStatement'&&s.expression?.expression?.name==='require'?s.expression.arguments[0]:null;
   const condition=s.type==='IfStatement'&&!s.falseBody&&rev&&['<','!='].includes(s.condition?.operator)?s.condition:req?.operator==='=='?req:null;
   if(condition&&native(condition.left))try{const program=expr(condition.right,env,depth);if(!JSON.stringify(program).includes('unsupported'))candidates.push(program);}catch{}
   const call=s.type==='ExpressionStatement'?s.expression:null;
   if(call?.type==='FunctionCall'&&call.expression?.type==='Identifier'){
    const helper=functions.filter(h=>h.name===call.expression.name&&['private','internal'].includes(h.visibility)&&h.parameters.length===call.arguments.length);if(helper.length===1)try{visit(helper[0],call.arguments.map(a=>expr(a,env,depth+1)),depth+1);}catch{}
   }
   // Never resolve a reassigned local from its earlier initializer.
   if(call?.type==='BinaryOperation'&&['=','+=','-=','*=','/='].includes(call.operator)&&call.left?.name)env.set(call.left.name,{kind:'unsupported'});
  }
 };
 const args=fragment.inputs.map(p=>/^uint\d*$/.test(p.type)&&/^_?(quantity|qty|q|amount|count|n|shares|mints)$/i.test(p.name)&&!mutable.has(p.name)?{kind:'quantity'}:{kind:'unsupported'});visit(f,args);
 const unique=[...new Map(candidates.map(p=>[JSON.stringify(p),p])).values()];return unique.length===1?unique[0]:null;
}
export async function evaluateNativePrice(program,{wallet,quantity,read}){
 let operations=0;const evaluate=async p=>{if(++operations>64)throw Error('源码报价超过读取上限');
  if(p.kind==='wallet')return wallet;if(p.kind==='quantity')return BigInt(quantity);if(p.kind==='literal')return BigInt(p.value);
  if(p.kind==='read'){const args=await Promise.all(p.args.map(evaluate)),v=await read(p.method,args);if(p.index===undefined&&v.length!==1)throw Error('源码报价返回字段不唯一');return v[p.index??0];}
  const [a,b]=await Promise.all(p.args.map(evaluate));if(typeof a!=='bigint'||typeof b!=='bigint')throw Error('源码报价类型不匹配');let value;
  if(p.kind==='+')value=a+b;else if(p.kind==='-')value=a-b;else if(p.kind==='*')value=a*b;else if(p.kind==='/')value=a/b;else throw Error('未知源码报价操作');
  if(value<0n||value>MAX)throw Error('源码报价溢出');return value;
 };const value=await evaluate(program);if(typeof value!=='bigint'||value<0n||value>MAX)throw Error('源码报价不是有效 uint');return value;
}
