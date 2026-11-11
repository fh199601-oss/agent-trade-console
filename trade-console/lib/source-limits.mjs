import parser from '@solidity-parser/parser';
import {Interface} from 'ethers';

// Derive remaining quantities from verified, unconditional Solidity guards.
// Getter names are irrelevant: used[caller] + quantity <= base + referrals[caller]
// becomes a bounded read program. Never execute website code or write storage.
const cache=new WeakMap(),MAX=(1n<<256n)-1n;
const sender=n=>n?.type==='MemberAccess'&&n.expression?.name==='msg'&&n.memberName==='sender';
const literal=value=>({kind:'literal',value:String(value)});
const contains=(p,kind)=>p?.kind===kind||(p?.args||[]).some(a=>contains(a,kind));
const walk=(n,fn)=>{if(!n||typeof n!=='object')return;fn(n);for(const [k,v]of Object.entries(n))if(!['loc','range'].includes(k)){if(Array.isArray(v))v.forEach(x=>walk(x,fn));else if(v&&typeof v==='object')walk(v,fn);}};
function contracts(meta){if(cache.has(meta))return cache.get(meta);const out=[];for(const s of Object.values(meta.sources||{}))try{parser.visit(parser.parse(s.content),{ContractDefinition:c=>out.push(c)});}catch{}cache.set(meta,out);return out;}
export function sourceLimitPrograms(meta,fragment,roles){
 if(!meta.verified||meta.proxy||meta.identity?.implementation)return [];
 const abi=new Interface(meta.abi),matches=contracts(meta).flatMap(c=>c.subNodes.filter(f=>f.type==='FunctionDefinition'&&f.body&&f.name===fragment.name&&f.parameters.length===fragment.inputs.length&&f.parameters.every((p,i)=>p.name===fragment.inputs[i].name&&p.typeName?.name===fragment.inputs[i].type)).map(f=>({c,f})));
 if(matches.length!==1)return [];const {f}=matches[0];if(f.modifiers?.length)return [];
 const env=new Map(f.parameters.map((p,i)=>[p.name,roles[i]==='quantity'?{kind:'quantity'}:roles[i]==='wallet'?{kind:'wallet'}:{kind:'unsupported'}])),limits=[];
 const fail=()=>{throw Error('unsupported quota expression');};
 const getter=(name,args)=>{const choices=abi.fragments.filter(g=>g.type==='function'&&g.name===name&&['view','pure'].includes(g.stateMutability)&&g.inputs.length===args.length&&g.outputs.length===1&&/^(uint\d*|bool)$/.test(g.outputs[0].type));if(choices.length!==1)fail();return {kind:'read',method:choices[0].format('sighash'),args};};
 const expr=(n,depth=0)=>{
  if(!n||depth>16)fail();if(sender(n))return {kind:'wallet'};
  if(n.type==='TupleExpression'&&!n.isArray&&n.components.length===1)return expr(n.components[0],depth+1);
  if(n.type==='NumberLiteral'&&!n.subdenomination&&/^\d[\d_]*$/.test(n.number))return literal(n.number.replaceAll('_',''));
  if(n.type==='Identifier'){const p=env.has(n.name)?env.get(n.name):getter(n.name,[]);if(contains(p,'unsupported'))fail();return p;}
  if(n.type==='IndexAccess'&&n.base?.type==='Identifier'&&!env.has(n.base.name))return getter(n.base.name,[expr(n.index,depth+1)]);
  if(n.type==='FunctionCall'&&n.expression?.type==='Identifier')return getter(n.expression.name,n.arguments.map(a=>expr(a,depth+1)));
  if(n.type==='BinaryOperation'&&['+','-','*','/'].includes(n.operator))return {kind:n.operator,args:[expr(n.left,depth+1),expr(n.right,depth+1)]};
  fail();
 };
 // A guard after a possible state change no longer describes pre-call storage.
 // View/pure ABI calls and elementary expressions are safe to cross; unknown
 // helpers, external calls, conditional writes, loops and returns stop scanning.
 const readOnly=n=>{let safe=true;walk(n,x=>{
  if(x.type==='BinaryOperation'&&/^(=|[+*\/%-]=)$/.test(x.operator)||x.type==='UnaryOperation'&&['++','--','delete'].includes(x.operator))safe=false;
  if(x.type==='FunctionCall'&&(x.expression?.type!=='Identifier'||!abi.fragments.some(g=>g.type==='function'&&g.name===x.expression.name&&['view','pure'].includes(g.stateMutability))))safe=false;
 });return safe;};
 const incremented=new Set(),setTrue=new Set();walk(f.body,n=>{
  if(n.type==='UnaryOperation'&&n.operator==='++')incremented.add(JSON.stringify(n.subExpression));
  if(n.type==='BinaryOperation'&&n.operator==='+='&&n.right?.type==='NumberLiteral'&&n.right.number==='1')incremented.add(JSON.stringify(n.left));
  if(n.type==='BinaryOperation'&&n.operator==='='&&n.right?.type==='BooleanLiteral'&&n.right.value===true)setTrue.add(JSON.stringify(n.left));
 });
 const guard=n=>{
  if(n?.operator==='&&'){guard(n.left);guard(n.right);return;}
  try{
   if(n?.type==='UnaryOperation'&&n.operator==='!'&&setTrue.has(JSON.stringify(n.subExpression))){const p=expr(n.subExpression);if(p.kind==='read'&&contains(p,'wallet')&&abi.getFunction(p.method).outputs[0].type==='bool')limits.push({scope:'wallet',kind:'once',value:p});return;}
   if(n?.type!=='BinaryOperation'||!['<','<=','>','>='].includes(n.operator))return;
   let left=n.left,right=n.right,strict=['<','>'].includes(n.operator);if(['>','>='].includes(n.operator))[left,right]=[right,left];
   const a=expr(left),b=expr(right);if(contains(b,'quantity'))return;
   let used;
   if(a.kind==='quantity')used=literal(0);
   else if(a.kind==='+'&&a.args.filter(p=>p.kind==='quantity').length===1)used=a.args.find(p=>p.kind!=='quantity');
   else if(!roles.includes('quantity')&&strict&&incremented.has(JSON.stringify(left))){used=a;strict=false;}
   else return;
   if(contains(used,'quantity'))return;
   limits.push({scope:contains(used,'wallet')||contains(b,'wallet')?'wallet':'public',kind:'remaining',cap:b,used,strict});
  }catch{}
 };
 for(const s of f.body.statements){
  if(s.type==='VariableDeclarationStatement'){
   if(!readOnly(s.initialValue))break;
   for(const v of s.variables||[])if(v)env.set(v.name,{kind:'unsupported'});
   if(s.variables.length===1&&s.variables[0])try{env.set(s.variables[0].name,expr(s.initialValue));}catch{}
   continue;
  }
  const call=s.type==='ExpressionStatement'?s.expression:null;
  if(call?.type==='FunctionCall'&&call.expression?.name==='require'){
   if(!call.arguments.every(readOnly))break;guard(call.arguments[0]);continue;
  }
  const rev=s.trueBody?.type==='Block'&&s.trueBody.statements.length===1?s.trueBody.statements[0]:s.trueBody;
  if(s.type==='IfStatement'&&!s.falseBody&&rev?.type==='RevertStatement'&&readOnly(s.condition)){
   const inverse={'<':'>=','<=':'>','>':'<=','>=':'<'}[s.condition?.operator];if(inverse)guard({...s.condition,operator:inverse});continue;
  }
  break;
 }
 return [...new Map(limits.map(p=>[JSON.stringify(p),p])).values()].slice(0,8);
}
export async function evaluateSourceLimits(programs,{wallet,read}){
 let operations=0;const evalExpr=async p=>{if(++operations>128)throw Error('源码额度计算超过读取上限');
  if(p.kind==='wallet')return wallet;if(p.kind==='literal')return BigInt(p.value);
  if(p.kind==='read')return (await read(p.method,await Promise.all(p.args.map(evalExpr))))[0];
  const [a,b]=await Promise.all(p.args.map(evalExpr));if(typeof a!=='bigint'||typeof b!=='bigint')throw Error('源码额度类型不匹配');
  const v=p.kind==='+'?a+b:p.kind==='-'?a-b:p.kind==='*'?a*b:p.kind==='/'?a/b:null;
  if(v===null||v<0n||v>MAX)throw Error('源码额度计算溢出');return v;
 };
 return Promise.all(programs.map(async p=>{if(p.kind==='once'){const v=await evalExpr(p.value);if(typeof v!=='boolean')throw Error('源码领取状态类型不匹配');return {scope:p.scope,remaining:v?0n:1n};}
  const [cap,used]=await Promise.all([evalExpr(p.cap),evalExpr(p.used)]);if(typeof cap!=='bigint'||typeof used!=='bigint')throw Error('源码额度不是有效数量');const floor=used+(p.strict?1n:0n);return {scope:p.scope,remaining:cap>floor?cap-floor:0n};
 }));
}
