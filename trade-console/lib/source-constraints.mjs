import parser from '@solidity-parser/parser';
import {Interface} from 'ethers';
import {read} from './common.mjs';

// Before spending time learning calldata, identify a source-proven stop that
// applies to EVERY public issuance entry. This does not infer a transaction.
// Only unconditional top-level guards / unconditional internal view helpers
// are traversed. A closed free lane cannot hide an open paid lane.
const cache=new WeakMap();
function stopCode(message){
 const name=message.replace(/[^a-z]/gi,'').toLowerCase();
 return /soldout|supplyexhausted|(?:supply|cap)(?:reached|exceeded)|^cap$/.test(name)?'NO_QUOTA':/notstart|notopen|tooearly/.test(name)?'MINT_NOT_OPEN':/^(?:mint|minting|sale|free|paid|public|phase|window)?(?:ended|end|closed|retired|finished|expired)$/.test(name)?'MINT_ENDED':/^(?:mint|minting|sale)?paused$/.test(name)?'MINT_PAUSED':null;
}
function constraints(meta){
 if(cache.has(meta))return cache.get(meta);const result=[];if(!meta.verified||meta.proxy)return result;
 const abi=new Interface(meta.abi),methods=abi.fragments.filter(f=>f.type==='function'&&!['view','pure'].includes(f.stateMutability)&&/^(mint|freeMint|paidMint|publicMint|claimFree)/.test(f.name));
 for(const s of Object.values(meta.sources||{}))try{parser.visit(parser.parse(s.content),{ContractDefinition(c){
  for(const f of c.subNodes.filter(f=>f.type==='FunctionDefinition'&&f.body&&['public','external'].includes(f.visibility)&&methods.some(m=>m.name===f.name&&m.inputs.length===f.parameters.length))){
   const guards=[],seen=new Set(),shadowed=new Set();
   const readOnly=node=>{if(!node)return true;let safe=true;parser.visit(node,{BinaryOperation(n){if(/^(=|[+*\/%-]=)$/.test(n.operator))safe=false;},UnaryOperation(n){if(['++','--','delete'].includes(n.operator))safe=false;},FunctionCall(n){const name=n.expression?.type==='Identifier'?n.expression.name:null;if(!name||!abi.fragments.some(f=>f.type==='function'&&f.name===name&&['view','pure'].includes(f.stateMutability)))safe=false;}});return safe;};
   const expression=n=>{
    if(n?.type==='TupleExpression'&&n.components?.length===1)return expression(n.components[0]);
    if(n?.type==='BooleanLiteral')return {kind:'boolean',value:n.value};
    if(n?.type==='Identifier'&&!shadowed.has(n.name)){const g=abi.getFunction(n.name+'()');if(g&&['view','pure'].includes(g.stateMutability)&&g.outputs.length===1&&['uint256','uint64','bool'].includes(g.outputs[0].type))return {kind:'read',method:g.format('sighash')};}
    if(n?.type==='MemberAccess'&&n.expression?.name==='block'&&n.memberName==='timestamp')return {kind:'now'};
    if(n?.type==='NumberLiteral'&&!n.subdenomination&&/^\d+$/.test(n.number))return {kind:'number',value:n.number};
    if(n?.type==='UnaryOperation'&&n.operator==='!')return {kind:'!',args:[expression(n.subExpression)]};
    if(n?.type==='BinaryOperation'&&['+','-','<','<=','>','>=','==','!=','||','&&'].includes(n.operator))return {kind:n.operator,args:[expression(n.left),expression(n.right)]};
    throw Error('unsupported');
   };
   const visit=fn=>{if(seen.has(fn)||seen.size>8)return;seen.add(fn);for(const p of fn.parameters||[])shadowed.add(p.name);for(const stmt of fn.body?.statements||[]){
    if(stmt.type==='VariableDeclarationStatement'){for(const v of stmt.variables||[])if(v?.name)shadowed.add(v.name);if(!readOnly(stmt.initialValue))break;continue;}
    const rev=stmt.trueBody?.type==='Block'&&stmt.trueBody.statements.length===1?stmt.trueBody.statements[0]:stmt.trueBody;
    if(stmt.type==='IfStatement'){
     // Only a pure guard can be crossed. A conditional update can change the
     // state read by a later guard, even though the update isn't top-level.
     if(stmt.falseBody||rev?.type!=='RevertStatement'||!readOnly(stmt.condition))break;
     try{const name=rev.revertCall?.expression?.name||'',code=stopCode(name);if(code)guards.push({condition:expression(stmt.condition),error:name,code});}catch{}
     continue;
    }
    const call=stmt.type==='ExpressionStatement'?stmt.expression:null;
    if(call?.type==='FunctionCall'&&call.expression?.name==='require'){
     try{const name=call.arguments[1]?.value||'',condition=expression(call.arguments[0]),code=stopCode(name);if(code)guards.push({condition:{kind:'!',args:[condition]},error:name,code});}catch{}
     // require arguments can themselves execute code. Never inspect later
     // guards past one whose side effects cannot be excluded.
     if(!call.arguments.every(readOnly))break;continue;
    }
    if(call?.type==='FunctionCall'&&call.expression?.type==='Identifier'){const helpers=c.subNodes.filter(n=>n.type==='FunctionDefinition'&&n.name===call.expression.name&&['internal','private'].includes(n.visibility)&&['view','pure'].includes(n.stateMutability)&&n.body);if(helpers.length===1)visit(helpers[0]);else break;}
    // A mutation/unknown external call can change the state tested afterwards.
    if(stmt.type==='ExpressionStatement'&&(call?.type!=='FunctionCall'||call.expression?.type!=='Identifier'))break;
    if(stmt.type!=='ExpressionStatement')break;
   }};visit(f);result.push({method:f.name+'('+f.parameters.map(p=>p.typeName.name).join(',')+')',guards});
  }
 }});}catch{}
 const unique=[...new Map(result.map(r=>[r.method,r])).values()];const valid=unique.length===methods.length?unique:[];cache.set(meta,valid);return valid;
}
export async function unavailableMintState(rpc,meta){
 const entries=constraints(meta);if(!entries.length||entries.some(e=>!e.guards.length))return null;
 const abi=new Interface(meta.abi),block=await rpc.getBlockNumber(),header=await rpc.send('eth_getBlockByNumber',['0x'+block.toString(16),false]),memo=new Map();
 const evalExpr=async e=>{if(e.kind==='now')return BigInt(header.timestamp);if(e.kind==='number')return BigInt(e.value);if(e.kind==='boolean')return e.value;if(e.kind==='read'){if(!memo.has(e.method))memo.set(e.method,read(rpc,meta.address,abi,e.method,[],block).then(r=>r[0]));return memo.get(e.method);}const [a,b]=await Promise.all(e.args.map(evalExpr));switch(e.kind){case'!':return !a;case'+':return a+b;case'-':if(a<b)throw Error('underflow');return a-b;case'<':return a<b;case'<=':return a<=b;case'>':return a>b;case'>=':return a>=b;case'==':return a===b;case'!=':return a!==b;case'||':return a||b;case'&&':return a&&b;}};
 const stopped=await Promise.all(entries.map(async entry=>{const checks=await Promise.all(entry.guards.map(async g=>{try{return await evalExpr(g.condition)?g:null;}catch{return null;}}));return {...entry,stop:checks.find(Boolean)};}));
 if(stopped.some(e=>!e.stop))return null;const codes=new Set(stopped.map(e=>e.stop.code));if(codes.size!==1)return null;const code=stopped[0].stop.code,message={MINT_ENDED:'链上源码与当前状态确认：所有铸造入口均已结束',NO_QUOTA:'链上源码与当前状态确认：所有铸造入口额度已耗尽',MINT_NOT_OPEN:'所有铸造入口当前尚未开放',MINT_PAUSED:'所有铸造入口当前已暂停'}[code];
 return {code,message,details:{block,evidence:stopped.map(e=>({method:e.method,error:e.stop.error}))}};
}
