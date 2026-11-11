import {parse} from 'acorn';
import {Interface,FunctionFragment} from 'ethers';

// Static call-site evidence, not an executable recipe or verified contract ABI.
// No site JS, imported module, function, getter or supplied calldata is executed.
const ADDRESS=/^0x[0-9a-f]{40}$/i;
const ENTRY=/^(?:mint\w*|publicMint|freeMint|paidMint|agentMint|claimFree|buy|subscribe|purchase|contribute)$/;
export const sourceMintName=name=>/^(?:mint\w*|publicMint|freeMint|paidMint|agentMint|claimFree)$/.test(name);
const UNKNOWN=Symbol('unknown');
const property=n=>n?.computed?(n.property?.type==='Literal'?n.property.value:null):n?.property?.name;
const root=n=>n?.type==='Identifier'?n:n?.type==='MemberExpression'?root(n.object):null;
const equal=(a,b)=>a!==UNKNOWN&&b!==UNKNOWN&&JSON.stringify(a)===JSON.stringify(b);

export function publishedMintCalls(rows){
 const globals=new Map(),invalidGlobals=new Set(),modules=new Map(),units=[],calls=[],nodeScopes=new WeakMap(),functionSites=new WeakMap(),pendingWrites=[],mutated=new Set();let visited=0,substitutions=new Map();
 const inContext=(context,work)=>{const old=substitutions;substitutions=context;try{return work();}finally{substitutions=old;}};
 const scope=(parent,fn=false)=>({parent,fn,bindings:new Map()});
 const lookup=(s,name)=>{for(;s;s=s.parent)if(s.bindings.has(name))return s.bindings.get(name);return null;};
 const binding=(s,name)=>{if(!s.bindings.has(name))s.bindings.set(name,{values:[],invalid:false});return s.bindings.get(name);};
 const globalKey=n=>n?.type==='MemberExpression'&&n.object?.type==='Identifier'&&['window','globalThis'].includes(n.object.name)&&typeof property(n)==='string'?property(n):null;
 // Classic scripts loaded by the SAME page share lexical globals; ESM files
 // do not. Only observed script tags join that scope, never guessed config URLs.
 const classicPages=new Map(),classicFiles=new Map();
 for(const row of rows.slice(0,60))if(typeof row.text==='string'&&!/\.m?js(?:\?|$)/i.test(row.url||'')){
  const top=scope(null,true);classicPages.set(row,top);
  for(const m of row.text.matchAll(/<script\b([^>]*)>/gi)){
   if(/\btype\s*=\s*["']module["']/i.test(m[1]))continue;
   const src=m[1].match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];if(!src)continue;
   try{const url=new URL(src,row.url);if(url.origin!==new URL(row.url).origin)continue;const owners=classicFiles.get(url.href)||new Set();owners.add(top);classicFiles.set(url.href,owners);}catch{}
  }
 }
 for(const row of rows.slice(0,60)){
  if(typeof row.text!=='string'||row.text.length>2_500_000)continue;
  const owners=classicFiles.get(row.url),externalTop=owners?.size===1?[...owners][0]:null;
  const scripts=/\.m?js(?:\?|$)/i.test(row.url||'')?[{text:row.text,shared:externalTop}]:[...row.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].slice(0,32).map(m=>({text:m[2],shared:/\btype\s*=\s*["']module["']/i.test(m[1])?null:classicPages.get(row)}));
  for(const {text,shared} of scripts)try{
   const tree=parse(text,{ecmaVersion:'latest',sourceType:'module'}),scopes=nodeScopes,top=shared&&!tree.body.some(n=>/^(?:Import|Export)/.test(n.type))?shared:scope(null,true),writes=[],sites=[];
   const hide=(p,s)=>{if(!p)return;if(p.type==='Identifier')binding(s,p.name).invalid=true;else if(p.type==='ObjectPattern')p.properties.forEach(x=>hide(x.value||x.argument,s));else if(p.type==='ArrayPattern')p.elements.forEach(x=>hide(x,s));else if(p.type==='AssignmentPattern')hide(p.left,s);else if(p.type==='RestElement')hide(p.argument,s);};
   const visit=(n,s)=>{
    if(!n||typeof n!=='object')return;if(++visited>700000)throw Error('parse budget');
    if(/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type)){
     if(n.type==='FunctionDeclaration'&&n.id)binding(s,n.id.name).values.push(n);
     s=scope(s,true);s.functionNode=n;for(const p of n.params||[])hide(p,s);
    }else if(n.type==='BlockStatement')s=scope(s);
    else if(n.type==='CatchClause'){s=scope(s);hide(n.param,s);}
    scopes.set(n,s);
    if(n.type==='VariableDeclaration')for(const d of n.declarations){let owner=s;if(n.kind==='var')while(owner.parent&&!owner.fn)owner=owner.parent;if(d.id.type==='Identifier')binding(owner,d.id.name).values.push(d.init);else hide(d.id,owner);}
    if(n.type==='ImportDeclaration')for(const spec of n.specifiers){const b=binding(s,spec.local.name);try{
     const u=new URL(n.source.value,row.url);if(!/^\.{0,2}\//.test(n.source.value)||u.origin!==new URL(row.url).origin)throw Error('nonlocal import');
     b.import={url:u.href,name:spec.type==='ImportDefaultSpecifier'?'default':spec.type==='ImportNamespaceSpecifier'?'*':spec.imported.name??spec.imported.value};
    }catch{b.invalid=true;}}
    if(n.type==='AssignmentExpression'||n.type==='UpdateExpression')writes.push(n);
    if(n.type==='CallExpression'){sites.push(n);let owner=s;while(owner&&!owner.functionNode)owner=owner.parent;if(owner){if(!functionSites.has(owner.functionNode))functionSites.set(owner.functionNode,[]);functionSites.get(owner.functionNode).push(n);}}
    for(const [key,v]of Object.entries(n))if(!['start','end','loc'].includes(key)){
     if(Array.isArray(v)){for(const child of v)if(child?.type)visit(child,s);}else if(v?.type)visit(v,s);
    }
   };
   visit(tree,top);
   pendingWrites.push(...writes);
   const exports=new Map();for(const stmt of tree.body){
    if(stmt.type==='ExportDefaultDeclaration')exports.set('default',stmt.declaration);
    if(stmt.type==='ExportNamedDeclaration'&&!stmt.source){
     for(const d of stmt.declaration?.declarations||[])if(d.id.type==='Identifier')exports.set(d.id.name,d.id);
     if(stmt.declaration?.type==='FunctionDeclaration'&&stmt.declaration.id)exports.set(stmt.declaration.id.name,stmt.declaration.id);
     for(const spec of stmt.specifiers||[]){const n=spec.local;exports.set(spec.exported.name??spec.exported.value,n);}
    }
   }
   const unit={sites,scopes,url:row.url,exports};units.push(unit);
   if(exports.size){if(modules.has(row.url))modules.set(row.url,null);else modules.set(row.url,unit);}
  }catch{}
 }
 // All files are parsed before tracking writes, so a config defined in a later
 // fetched row cannot hide an earlier mutation through a shared alias.
 for(const n of pendingWrites){const scopes=nodeScopes,lhs=n.left||n.argument,s=scopes.get(n),key=globalKey(lhs);
    if(key&&n.operator==='='){if(!globals.has(key))globals.set(key,[]);globals.get(key).push({node:n.right,scopes});continue;}
    if(!key&&lhs?.type==='MemberExpression'){let g=lhs;while(g?.type==='MemberExpression'&&!globalKey(g))g=g.object;const k=globalKey(g);if(k)invalidGlobals.add(k);}
    const b=lookup(s,root(lhs)?.name);if(!b)continue;b.written=true;
    if(lhs.type==='Identifier'&&n.operator==='=')b.values.push(n.right);else {b.invalid=true;if(lhs.type==='MemberExpression')mutated.add(b);}
   }
   // An alias shares the same object: changing alias.address also invalidates
   // the original config. Do not mistake its old literal for the current target.
   const invalidate=b=>{if(!b||mutated.has(b)&&b.propagated)return;b.invalid=true;b.written=true;b.propagated=true;mutated.add(b);for(const v of b.values){const r=root(v);if(r)invalidate(lookup(nodeScopes.get(r),r.name));}};
   for(const b of mutated)invalidate(b);
 const resolve=(n,scopes,active=new Set(),depth=0,contract=false)=>{
  if(!n||depth>24)return UNKNOWN;
  if(n.type==='Literal')return ['string','number','boolean'].includes(typeof n.value)||n.value===null?n.value:UNKNOWN;
  if(n.type==='TemplateLiteral'&&!n.expressions.length)return n.quasis[0].value.cooked;
  if(n.type==='LogicalExpression'&&['||','??'].includes(n.operator)){
   const a=resolve(n.left,scopes,active,depth+1,contract);if(a===UNKNOWN)return UNKNOWN;
   return (n.operator==='??'?a!=null:!!a)?a:resolve(n.right,scopes,active,depth+1,contract);
  }
  if(n.type==='Identifier'){
   const b=lookup(scopes.get(n),n.name);if(!b||active.has(b))return UNKNOWN;
   if(substitutions.has(b)){if(b.written)return UNKNOWN;const v=substitutions.get(b);return inContext(v.context,()=>resolve(v.node,scopes,new Set(active).add(b),depth+1,contract));}
   if(b.invalid)return UNKNOWN;
   if(b.import){const unit=modules.get(b.import.url);if(!unit)return UNKNOWN;const next=new Set(active).add(b);
    if(b.import.name==='*'){const obj=Object.create(null);for(const [name,expr]of unit.exports)obj[name]=resolve(expr,unit.scopes,next,depth+1);return obj;}
    return resolve(unit.exports.get(b.import.name),unit.scopes,next,depth+1,contract);
   }
   const next=new Set(active).add(b),values=b.values.filter(Boolean).map(v=>resolve(v,scopes,next,depth+1,contract)).filter(v=>!contract||v!==null);
   return values.length&&values.every(v=>equal(v,values[0]))?values[0]:UNKNOWN;
  }
  if(n.type==='ArrayExpression'){const v=[];for(const e of n.elements){if(e?.type==='SpreadElement'){const items=resolve(e.argument,scopes,active,depth+1);if(!Array.isArray(items)||items.length+v.length>500)return UNKNOWN;v.push(...items);}else v.push(resolve(e,scopes,active,depth+1));}return v.some(e=>e===UNKNOWN)?UNKNOWN:v;}
  if(n.type==='ObjectExpression'){
   const out=Object.create(null);for(const p of n.properties){if(p.type==='SpreadElement'){const value=resolve(p.argument,scopes,active,depth+1);if(!value||typeof value!=='object'||Array.isArray(value))return UNKNOWN;for(const [k,v]of Object.entries(value)){if(['__proto__','prototype','constructor'].includes(k))return UNKNOWN;out[k]=v;}continue;}if(p.type!=='Property'||p.kind!=='init'||p.method)return UNKNOWN;
    const k=p.computed?resolve(p.key,scopes,active,depth+1):p.key.name??p.key.value;if(typeof k!=='string'&&typeof k!=='number'||['__proto__','prototype','constructor'].includes(k))return UNKNOWN;
    out[k]=resolve(p.value,scopes,active,depth+1);
   }return out;
  }
  if(n.type==='MemberExpression'){
   const key=globalKey(n);
   if(key&&!lookup(scopes.get(n),n.object.name)){
    if(invalidGlobals.has(key)||active.has('global:'+key))return UNKNOWN;const next=new Set(active).add('global:'+key);
    const vs=(globals.get(key)||[]).map(x=>resolve(x.node,x.scopes,next,depth+1));return vs.length&&vs.every(v=>equal(v,vs[0]))?vs[0]:UNKNOWN;
   }
   const obj=resolve(n.object,scopes,active,depth+1),k=n.computed?resolve(n.property,scopes,active,depth+1):n.property.name;
   return obj&&typeof obj==='object'&&Object.hasOwn(obj,k)?obj[k]:UNKNOWN;
  }
  if(contract&&n.type==='ConditionalExpression'){
   const a=resolve(n.consequent,scopes,active,depth+1,true),b=resolve(n.alternate,scopes,active,depth+1,true);
   return a===null?b:b===null?a:equal(a,b)?a:UNKNOWN;
  }
  if(contract&&n.type==='NewExpression'&&['Identifier','MemberExpression'].includes(n.callee.type)){
   // Bundlers rename the constructor. Address + ABI + the invoked ABI member
   // establish a candidate; deployed code and wallet simulation still verify it.
   const web3=property(n.callee.object)==='eth',addressNode=n.arguments[web3?1:0];
   const address=resolve(addressNode,scopes,active,depth+1),abi=resolve(n.arguments[web3?0:1],scopes,active,depth+1);
   const obj=addressNode?.type==='MemberExpression'?resolve(addressNode.object,scopes,active,depth+1):null;
   const chain=obj?.chainId??obj?.chain?.id;if(chain!=null&&(!['string','number'].includes(typeof chain)||Number(chain)!==56))return UNKNOWN;
   return typeof address==='string'&&ADDRESS.test(address)&&Array.isArray(abi)?{address:address.toLowerCase(),abi}:UNKNOWN;
  }
  if(n.type==='CallExpression'&&n.arguments.length===1&&n.callee.type==='MemberExpression'&&n.callee.object?.type==='Identifier'&&!lookup(scopes.get(n),n.callee.object.name)){
   if(n.callee.object.name==='Object'&&property(n.callee)==='freeze')return resolve(n.arguments[0],scopes,active,depth+1,contract);
   if(n.callee.object.name==='JSON'&&property(n.callee)==='parse'){const text=resolve(n.arguments[0],scopes,active,depth+1);if(typeof text!=='string'||text.length>200000)return UNKNOWN;try{return JSON.parse(text);}catch{return UNKNOWN;}}
  }
  // A no-argument accessor consisting solely of `return <static expression>`
  // is an alias. Inspect its AST; never invoke it or accept any other statements.
  if(n.type==='CallExpression'&&n.callee.type==='Identifier'&&!n.arguments.length){
   const b=lookup(scopes.get(n),n.callee.name);if(!b||b.invalid||b.values.length!==1||active.has(b))return UNKNOWN;
   const fn=b.values[0];if(!/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(fn?.type)||fn.params.length||fn.async||fn.generator)return UNKNOWN;
   const expr=fn.body.type==='BlockStatement'?(fn.body.body.length===1&&fn.body.body[0].type==='ReturnStatement'?fn.body.body[0].argument:null):fn.body;
   return resolve(expr,scopes,new Set(active).add(b),depth+1,contract);
  }
  return UNKNOWN;
 };
 // Track the value expression back to a scalar view quote on the SAME bound
 // contract, including an async wrapper such as cost = await costFor(qty).
 // This does not evaluate the wrapper, DOM input, arithmetic or site requests.
 const priceOrigin=(node,scopes,target,quantity,subs=new Map(),active=new Set(),depth=0)=>{
  if(!node||depth>20)return null;
  const unwrap=n=>n?.type==='AwaitExpression'?n.argument:n;
  const argument=n=>{n=unwrap(n);if(n?.type==='Identifier'){const b=lookup(scopes.get(n),n.name);return subs.get(b)||n;}return n;};
  const sameQuantity=n=>{const a=argument(n),b=quantity;return a===b||a?.type==='Identifier'&&b?.type==='Identifier'&&lookup(scopes.get(a),a.name)&&lookup(scopes.get(a),a.name)===lookup(scopes.get(b),b.name);};
  node=unwrap(node);
  if(node.type==='Identifier'){
   const b=lookup(scopes.get(node),node.name);if(!b||b.invalid||active.has(b)||b.values.length!==1)return null;
   return priceOrigin(subs.get(b)||b.values[0],scopes,target,quantity,subs,new Set(active).add(b),depth+1);
  }
  if(node.type!=='CallExpression')return null;
  if(node.callee.type==='MemberExpression'){
   const contract=resolve(node.callee.object,scopes,new Set(),0,true);if(contract?.address!==target)return null;
   try{const f=new Interface(contract.abi).getFunction(property(node.callee));if(!f||!['view','pure'].includes(f.stateMutability)||f.inputs.length!==1||f.inputs[0].type!=='uint256'||f.outputs.length!==1||f.outputs[0].type!=='uint256'||node.arguments.length!==1||!sameQuantity(node.arguments[0]))return null;
    return {method:f.format('sighash'),abi:JSON.parse(f.format('json')),args:['quantity'],index:0};
   }catch{return null;}
  }
  if(node.callee.type==='Identifier'){
   const b=lookup(scopes.get(node),node.callee.name);if(!b||b.invalid||active.has(b)||b.values.length!==1)return null;
   const fn=b.values[0];if(!/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(fn?.type)||fn.params.length!==node.arguments.length||fn.params.some(p=>p.type!=='Identifier'))return null;
   const returns=[];const scan=n=>{if(!n||typeof n!=='object'||/Function/.test(n.type))return;if(n.type==='ReturnStatement'){returns.push(n.argument);return;}for(const v of Object.values(n)){if(Array.isArray(v))v.forEach(scan);else if(v?.type)scan(v);}};
   if(fn.body.type==='BlockStatement')scan(fn.body);else returns.push(fn.body);
   if(returns.length!==1)return null;const next=new Map(subs);
   fn.params.forEach((p,i)=>next.set(lookup(scopes.get(p),p.name),argument(node.arguments[i])));
   return priceOrigin(returns[0],scopes,target,quantity,next,new Set(active).add(b),depth+1);
  }
  return null;
 };
 const referralOrigin=(n,scopes,active=new Set(),depth=0)=>{
  if(!n||depth>20)return null;
  if(resolve(n,scopes)==='0x'+'0'.repeat(40))return {zero:true};
  if(n.type==='Identifier'){
   const b=lookup(scopes.get(n),n.name);if(!b||b.invalid||active.has(b)||b.values.length!==1)return null;
   return referralOrigin(b.values[0],scopes,new Set(active).add(b),depth+1);
  }
  const agree=vs=>{if(!vs.length||vs.some(v=>!v))return null;const refs=vs.filter(v=>!v.zero);return refs.length&&refs.every(v=>v.key===refs[0].key&&v.address===refs[0].address)?refs[0]:null;};
  if(n.type==='ConditionalExpression')return agree([referralOrigin(n.consequent,scopes,active,depth+1),referralOrigin(n.alternate,scopes,active,depth+1)]);
  if(n.type!=='CallExpression')return null;
  const searchParams=(x,d=0)=>{
   if(!x||d>12)return false;
   if(x.type==='Identifier'){const b=lookup(scopes.get(x),x.name);return b&&!b.invalid&&b.values.length===1&&searchParams(b.values[0],d+1);}
   const value=x.arguments?.[0];return x.type==='NewExpression'&&x.callee.name==='URLSearchParams'&&!lookup(scopes.get(x),'URLSearchParams')&&x.arguments.length===1&&value?.type==='MemberExpression'&&property(value)==='search'&&value.object?.name==='location'&&!lookup(scopes.get(value),'location');
  };
  if(n.callee.type==='MemberExpression'&&property(n.callee)==='get'&&n.arguments.length===1&&searchParams(n.callee.object)){
   const key=resolve(n.arguments[0],scopes);return typeof key==='string'&&/^(?:ref|referrer|inviter|sponsor|referral)$/i.test(key)?{key,address:false}:null;
  }
  if(n.callee.type==='MemberExpression'&&property(n.callee)==='getAddress'&&n.arguments.length===1){const value=referralOrigin(n.arguments[0],scopes,active,depth+1);return value&&!value.zero?{...value,address:true}:null;}
  if(n.callee.type==='Identifier'&&!n.arguments.length){
   const b=lookup(scopes.get(n),n.callee.name);if(!b||b.invalid||active.has(b)||b.values.length!==1)return null;
   const fn=b.values[0];if(!/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(fn?.type)||fn.params.length||fn.async||fn.generator)return null;
   const results=[],scan=x=>{if(!x||typeof x!=='object'||/Function/.test(x.type))return;if(x.type==='ReturnStatement'){results.push(referralOrigin(x.argument,scopes,new Set(active).add(b),depth+1));return;}for(const v of Object.values(x)){if(Array.isArray(v))v.forEach(scan);else if(v?.type)scan(v);}};
   if(fn.body.type==='BlockStatement')scan(fn.body);else results.push(referralOrigin(fn.body,scopes,new Set(active).add(b),depth+1));return agree(results);
  }
  return null;
 };
 // Inspect small local/imported transaction helpers with argument bindings.
 // This is AST substitution, not JS execution; no helper body is ever invoked.
 const definition=(n,active=new Set(),depth=0)=>{
  if(!n||depth>12)return null;if(/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type))return n;
  if(n.type!=='Identifier')return null;const b=lookup(nodeScopes.get(n),n.name);if(!b||b.invalid||active.has(b))return null;const next=new Set(active).add(b);
  if(b.import){const unit=modules.get(b.import.url);return unit?definition(unit.exports.get(b.import.name),next,depth+1):null;}
  return b.values.length===1?definition(b.values[0],next,depth+1):null;
 };
 const helperCandidate=(fn,seen=new Set(),depth=0)=>{
  if(!fn||seen.has(fn)||depth>2)return false;const next=new Set(seen).add(fn);
  return (functionSites.get(fn)||[]).some(s=>s.callee?.type==='MemberExpression'&&(ENTRY.test(String(property(s.callee)||''))||['writeContract','writeContractAsync','send'].includes(property(s.callee))||s.callee.object?.type==='NewExpression')||helperCandidate(definition(s.callee),next,depth+1));
 };
 const queue=units.flatMap(u=>u.sites.map(site=>({site,scopes:u.scopes,url:u.url,context:new Map(),stack:[]})));let expanded=0;
 for(let cursor=0;cursor<queue.length;cursor++){
  const {site,scopes,url,context,stack}=queue[cursor];substitutions=context;
  const fn=definition(site.callee);
  if(fn&&!stack.includes(fn)&&stack.length<3&&expanded<1000&&helperCandidate(fn)&&site.arguments.length<=fn.params.length&&fn.params.every(p=>p.type==='Identifier'||p.type==='AssignmentPattern'&&p.left.type==='Identifier')){
   const next=new Map(context);fn.params.forEach((p,i)=>next.set(lookup(scopes.get(p),p.type==='Identifier'?p.name:p.left.name),{node:site.arguments[i]||p.right,context}));
   for(const inner of functionSites.get(fn)||[]){if(expanded++>=1000)break;queue.push({site:inner,scopes,url,context:next,stack:[...stack,fn]});}
  }
  const callee=site.callee;if(!['MemberExpression','Identifier'].includes(callee?.type))continue;
  let name=callee.type==='Identifier'?callee.name:callee.computed?resolve(callee.property,scopes):property(callee),bound=resolve(callee.object,scopes,new Set(),0,true),args=site.arguments,quantity=args[0],value=null;
  const field=(n,key)=>n?.type==='ObjectExpression'?n.properties.find(p=>p.type==='Property'&&!p.computed&&(p.key.name??p.key.value)===key)?.value:null;
  value=field(site.arguments.at(-1),'value');
  // web3: contract.methods.mint(qty).send({value: cost}).
  if(name==='send'&&callee.object?.type==='CallExpression'){
   const invocation=callee.object,method=invocation.callee;if(method?.type!=='MemberExpression'||property(method.object)!=='methods')continue;
   bound=resolve(method.object.object,scopes,new Set(),0,true);name=property(method);args=invocation.arguments;quantity=args[0];
  }
  // viem / wagmi-style writeContract({address, abi, functionName, args}).
  if(name==='writeContract'||name==='writeContractAsync'){
   const obj=site.arguments.find(n=>{const data=resolve(n,scopes);return data&&typeof data==='object'&&typeof data.functionName==='string';});if(!obj)continue;
   const data=resolve(obj,scopes);name=data?.functionName;bound={address:data?.address,abi:data?.abi};
   args=field(obj,'args')?.elements||[];quantity=args[0];value=field(obj,'value');
   const chain=data?.chainId??data?.chain?.id;if(chain!=null&&(!['string','number'].includes(typeof chain)||Number(chain)!==56))continue;
  }
  if(typeof name!=='string'||!ENTRY.test(name.split('(')[0])||typeof bound?.address!=='string'||!ADDRESS.test(bound.address)||!Array.isArray(bound.abi))continue;
  try{
   const iface=new Interface(bound.abi),methods=iface.fragments.filter(f=>f.type==='function'&&!['view','pure'].includes(f.stateMutability)&&(name.includes('(')?f.format('sighash')===name:f.name===name));
   // Overloaded names without an explicit signature remain ambiguous.
   if(methods.length!==1)continue;const f=methods[0];
   const price=f.inputs[0]?.type==='uint256'&&value?priceOrigin(value,scopes,bound.address.toLowerCase(),quantity):null;
   const referral=[];f.inputs.forEach((p,index)=>{if(p.type!=='address'||!/^_?(?:ref|referrer|referral|inviter|sponsor|recommender|referrerAddress|inviterAddress|sponsorAddress)$/i.test(p.name))return;const origin=referralOrigin(args[index],scopes);if(origin?.address)referral.push({index,key:origin.key,transport:'query',kind:'address'});});
   calls.push({address:bound.address.toLowerCase(),method:f.format('sighash'),name:f.name,selector:f.selector,source:url,abi:iface.fragments.filter(f=>f.type==='function').map(f=>JSON.parse(f.format('json'))),...(price?{price}:{}),...(referral.length?{referral}:{})});
  }catch{}
 }
 const unique=new Map();for(const c of calls){const key=c.address+':'+c.method+':'+c.source,prior=unique.get(key);if(prior){if(prior.price?.method!==c.price?.method){delete prior.price;prior.priceAmbiguous=true;}if(JSON.stringify(prior.referral)!==JSON.stringify(c.referral)){delete prior.referral;prior.referralAmbiguous=true;}}else unique.set(key,c);}
 return [...unique.values()].slice(0,120);
}

export function frontendCallsFor(meta){
 const rows=(meta.frontendCalls||[]).filter(c=>c.address?.toLowerCase()===meta.address?.toLowerCase());
 return rows.filter(c=>{try{return FunctionFragment.from(c.method).selector===c.selector;}catch{return false;}});
}
