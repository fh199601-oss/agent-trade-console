import {parse} from 'acorn';

// Resolve literal deployment configuration in compiled JS. Never run site code,
// call a function, import a module, or evaluate an arbitrary expression.
export function staticDeployments(text){
 if(typeof text!=='string'||text.length>2_500_000)return [];
 let tree;try{tree=parse(text,{ecmaVersion:'latest',sourceType:'module'});}catch{return [];}
 const declarations=new Map(),invalid=new Set(),results=[];let visited=0;
 const root=(n,depth=0)=>depth>30?null:n?.type==='Identifier'?n.name:n?.type==='MemberExpression'?root(n.object,depth+1):null;
 const pending=[tree];while(pending.length){const n=pending.pop();if(!n||typeof n!=='object')continue;if(++visited>700000)return [];
  if(n.type==='AssignmentExpression'||n.type==='UpdateExpression'){const name=root(n.left||n.argument);if(name)invalid.add(name);}
  for(const v of Object.values(n))if(Array.isArray(v)){for(const item of v)pending.push(item);}else if(v&&typeof v==='object')pending.push(v);
 }
 for(const s of tree.body){const d=s.type==='ExportNamedDeclaration'?s.declaration:s;if(d?.type!=='VariableDeclaration')continue;
  for(const n of d.declarations)if(n.id.type==='Identifier'){if(declarations.has(n.id.name))invalid.add(n.id.name);declarations.set(n.id.name,n.init);}
 }
 const cache=new Map(),active=new Set();
 const resolve=(n,depth=0)=>{
  if(!n||depth>20)return undefined;
  if(n.type==='Literal'&&['string','number','boolean'].includes(typeof n.value))return n.value;
  if(n.type==='TemplateLiteral'&&!n.expressions.length)return n.quasis[0].value.cooked;
  if(n.type==='Identifier'){
   if(invalid.has(n.name)||active.has(n.name))return undefined;if(cache.has(n.name))return cache.get(n.name);
   active.add(n.name);const value=resolve(declarations.get(n.name),depth+1);active.delete(n.name);cache.set(n.name,value);return value;
  }
  if(n.type==='ObjectExpression'){
   const obj=Object.create(null);
   for(const p of n.properties){if(p.type!=='Property'||p.kind!=='init'||p.method)return undefined;
    const key=p.computed?resolve(p.key,depth+1):p.key.name??p.key.value;if(typeof key!=='string'&&typeof key!=='number')return undefined;
    obj[String(key)]=resolve(p.value,depth+1);
   }return obj;
  }
  if(n.type==='MemberExpression'){
   const obj=resolve(n.object,depth+1),key=n.computed?resolve(n.property,depth+1):n.property.name;
   return obj&&typeof obj==='object'&&Object.hasOwn(obj,key)?obj[key]:undefined;
  }
  return undefined;
 };
 const visit=(obj,path=[],context={},depth=0)=>{
  if(!obj||typeof obj!=='object'||depth>8||results.length>250)return;
  const chain=obj.chainId??obj.chainID??obj.chain?.id??context.chainId;
  const network=obj.network??context.network;
  const ctx={chainId:chain,network};
  for(const [key,value]of Object.entries(obj)){
   if(typeof value==='string'&&/^0x[0-9a-f]{40}$/i.test(value))results.push({address:value,field:key==='address'?([obj.role,obj.name,path.at(-1)].find(v=>typeof v==='string')||key):key,path:[...path,key].join('.'),...ctx});
   else if(value&&typeof value==='object')visit(value,[...path,key],/^\d+$/.test(key)?{...ctx,chainId:Number(key)}:ctx,depth+1);
  }
 };
 for(const [name]of declarations){if(invalid.has(name))continue;const value=resolve({type:'Identifier',name});if(value&&typeof value==='object')visit(value,[name]);}
 return results;
}

export function deploymentIsBsc(row){
 // Statically parsed objects have no prototype; do not call String/Number on
 // arbitrary config objects (or infer a network from an opaque object).
 const chain=row.chainId,network=typeof row.network==='string'?row.network:row.network?.name;
 if(chain!=null&&!['number','string'].includes(typeof chain))return false;
 if(row.network!=null&&typeof network!=='string')return false;
 return (chain==null||Number(chain)===56)&&!/(?:test|local|devnet|sepolia|deprecated|legacy|ethereum|polygon|arbitrum|solana)/i.test(network||'');
}
