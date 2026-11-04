import parser from '@solidity-parser/parser';
import {Interface} from 'ethers';
import {USDT,ERC20,read,same,parseUnits,formatUnits} from './common.mjs';
import {runtimeShape} from './bytecode.mjs';
import {chooseBatch,min,positive} from './mint-policy.mjs';
const memo=new WeakMap(),fail=(code,message)=>Object.assign(Error(message),{code});
const ident=(n,s)=>n?.type==='Identifier'&&n.name===s;
const sender=n=>n?.type==='MemberAccess'&&ident(n.expression,'msg')&&n.memberName==='sender';
const self=n=>n?.type==='FunctionCall'&&(n.expression?.typeName?.name||n.expression?.name)==='address'&&ident(n.arguments[0],'this');
const walk=(n,fn)=>{if(!n||typeof n!=='object')return;fn(n);for(const [k,v]of Object.entries(n))if(!['range','loc'].includes(k)){if(Array.isArray(v))v.forEach(x=>walk(x,fn));else if(v&&typeof v==='object')walk(v,fn);}};
// Match verified payment/credit data flow, not a website or an address. Only
// single-quantity nonpayable mints whose published wallet quote is the same
// expression as the actual ERC20 debit qualify. Unknown expressions stop.
export function recognizeErc20Nft(meta){
 if(memo.has(meta))return memo.get(meta);let result=null;
 if(meta.verified&&!meta.proxy&&!meta.identity?.implementation&&!runtimeShape(meta.runtimeCode).delegate){
  const abi=new Interface(meta.abi),required=['mint(uint256)','quote(address,uint256)','MAX_SUPPLY()','MAX_PER_WALLET()','mintedBy(address)','totalSupply()','mintOpen()','supportsInterface(bytes4)'];
  if(required.every(s=>abi.getFunction(s))&&abi.getFunction('mint').stateMutability==='nonpayable')for(const source of Object.values(meta.sources||{}))try{parser.visit(parser.parse(source.content),{ContractDefinition(c){
   const funcs=c.subNodes.filter(n=>n.type==='FunctionDefinition'&&n.body),f=funcs.find(f=>f.name==='mint'&&f.parameters.length===1),quote=funcs.find(f=>f.name==='quote'&&f.parameters.length===2);if(!f||!quote)return;
   const pulls=[],credits=[],locals=new Map();for(const s of f.body.statements)if(s.type==='VariableDeclarationStatement'&&s.variables.length===1&&s.initialValue)locals.set(s.variables[0].name,s.initialValue);
   walk(f.body,n=>{if(n.type==='FunctionCall'){if(['safeTransferFrom','transferFrom'].includes(n.expression?.memberName))pulls.push(n);if(['_mint','_safeMint'].includes(n.expression?.name))credits.push(n);}});
   if(pulls.length!==1||credits.length!==1)return;const pull=pulls[0],credit=credits[0],payment=pull.expression.expression?.name;
   if(!payment||!sender(pull.arguments[0])||!self(pull.arguments[1])||!sender(credit.arguments[0]))return;
   const variable=c.subNodes.filter(n=>n.type==='StateVariableDeclaration').flatMap(n=>n.variables).find(v=>v.name===payment);
   if(!variable?.isImmutable||!abi.getFunction(payment+'()')||abi.getFunction(payment+'()').outputs[0]?.type!=='address')return;
   const qty=f.parameters[0].name,guardedNames=new Set([qty,...locals.keys()]);let mutated=false;
   walk(f.body,n=>{if(n.type==='BinaryOperation'&&['=','+=','-=','*=','/='].includes(n.operator)&&guardedNames.has(n.left?.name))mutated=true;if(n.type==='UnaryOperation'&&['++','--','delete'].includes(n.operator)&&guardedNames.has(n.subExpression?.name))mutated=true;});if(mutated)return;
   const normalize=(n,env,d=0)=>{if(d>12||!n)throw Error('expression');if(n.type==='TupleExpression'&&!n.isArray&&n.components.length===1)return normalize(n.components[0],env,d+1);if(sender(n))return '$wallet';if(n.type==='Identifier'){if(env.has(n.name)){const v=env.get(n.name);return typeof v==='string'?v:normalize(v,env,d+1);}const g=abi.getFunction(n.name+'()');if(g&&['view','pure'].includes(g.stateMutability)&&g.outputs[0]?.type==='uint256')return {get:g.format('sighash')};}
    if(n.type==='NumberLiteral')return n.number;if(n.type==='BinaryOperation'&&['+','-','*'].includes(n.operator))return [n.operator,normalize(n.left,env,d+1),normalize(n.right,env,d+1)];
    if(n.type==='FunctionCall'&&n.expression?.type==='Identifier'){const g=abi.fragments.find(g=>g.type==='function'&&g.name===n.expression.name&&g.inputs.length===n.arguments.length&&['view','pure'].includes(g.stateMutability));if(g?.outputs.length===1&&g.outputs[0].type==='uint256')return {get:g.format('sighash'),args:n.arguments.map(a=>normalize(a,env,d+1))};}throw Error('expression');};
   const actual=normalize(pull.arguments[2],new Map([...locals,[qty,'$quantity']])),returns=quote.body.statements.filter(s=>s.type==='ReturnStatement');if(returns.length!==1)return;
   // Only a zero-quantity guard may precede the return; no hidden changes.
   const prior=quote.body.statements.filter(s=>s!==returns[0]);if(prior.some(s=>!(s.type==='IfStatement'&&!s.falseBody&&s.condition?.operator==='=='&&ident(s.condition.left,quote.parameters[1].name)&&s.condition.right?.number==='0'&&s.trueBody?.type==='ReturnStatement'&&s.trueBody.expression?.number==='0')))return;
   const proposed=normalize(returns[0].expression,new Map([[quote.parameters[0].name,'$wallet'],[quote.parameters[1].name,'$quantity']]));if(JSON.stringify(actual)!==JSON.stringify(proposed))return;
   // Limit this rule to a caller-bound free amount subtracted from quantity.
   if(!Array.isArray(actual)||actual[0]!=='*'||actual[1]?.[0]!=='-'||actual[1][1]!=='$quantity'||actual[1][2]?.args?.join()!=='$wallet')return;
   const freeMethod=actual[1][2].get;if(!abi.getFunction(freeMethod)||abi.getFunction(freeMethod).inputs[0]?.type!=='address')return;
   result={kind:'source-free-paid-erc20-nft',payment:payment+'()',freeMethod,method:'mint(uint256)'};
  }});}catch{}
 }memo.set(meta,result);return result;
}
export async function erc20NftState(rpc,intent,meta,w,profile=recognizeErc20Nft(meta)){
 if(!profile)return null;const abi=new Interface(meta.abi),block=await rpc.getBlockNumber(),get=async(m,a=[])=>{const v=await read(rpc,meta.address,abi,m,a,block);if(v.length!==1)throw fail('MINT_ADAPTER_INCOMPLETE','NFT 状态返回不规范');return v[0];};
 const [payment,nft,open,cap,total,walletCap,used,freeNow,price]=await Promise.all([get(profile.payment),get('supportsInterface',['0x80ac58cd']),get('mintOpen'),get('MAX_SUPPLY'),get('totalSupply'),get('MAX_PER_WALLET'),get('mintedBy',[w.address]),get(profile.freeMethod,[w.address]),get('quote',[w.address,1n])]);
 if(!same(payment,USDT)||!nft||walletCap<1n||walletCap>500n||total>cap||freeNow>1n)throw fail('MINT_ADAPTER_INCOMPLETE','该 NFT 的付款币、资产或免费额度超出已核验规则');
 if(!open)throw fail('MINT_NOT_OPEN','当前未开放铸造');const remaining=min(positive(walletCap-used),positive(cap-total)),free=min(freeNow,remaining),paid=remaining-free;
 if(remaining&&(price===0n)!==(free>0n))throw fail('MINT_ADAPTER_INCOMPLETE','当前免费额度与钱包报价不一致');
 const info={block,currency:'USDT',freeRemaining:String(free),paidRemaining:String(paid),globalRemaining:String(cap-total),walletRemaining:String(positive(walletCap-used)),unitPriceUsdt:formatUnits(price,18)};
 return {name:profile.kind,token:meta.address,assetKind:'Erc721',block,free,paid,mixed:true,txCap:walletCap,info,quote:async n=>({cost:await get('quote',[w.address,n]),out:n,step:{kind:'mint',to:meta.address,value:'0',data:abi.encodeFunctionData(profile.method,[n])}})};
}
export async function erc20NftPlan(rpc,intent,meta,w,resolved,profile=recognizeErc20Nft(meta)){
 if(!profile)return null;if(intent.routeId&&!['auto:mint(uint256)','mint(uint256)'].includes(intent.routeId))throw Error('所选入口与 ERC20 NFT 类型不一致');
 if(resolved.referralHints?.detected&&[2,3].includes(intent.account)&&intent.referral!=='none')throw fail('REFERRAL_NOT_VERIFIED','当前 NFT 入口尚未核验邀请绑定');
 const s=await erc20NftState(rpc,intent,meta,w,profile),q=await chooseBatch(s,intent,parseUnits(intent.maxUsdt||'0',18));
 const [[balance],[allowance]]=await Promise.all([read(rpc,USDT,ERC20,'balanceOf',[w.address],s.block),read(rpc,USDT,ERC20,'allowance',[w.address,meta.address],s.block)]);if(balance<q.cost)throw fail('BUDGET_LIMIT','USDT 余额不足以支付本批铸造');
 // This mint has no maxCost parameter. Exact allowance is the hard upper bound
 // even if free stock/price changes after preview; larger old allowance is capped.
 const steps=allowance!==q.cost?[{kind:'approve',to:USDT,value:'0',spender:meta.address,allowance:String(q.cost),data:ERC20.encodeFunctionData('approve',[meta.address,q.cost])}]:[];
 if(!steps.length)await rpc.call({...q.step,from:w.address},s.block);
 return {kind:'contract',route:profile.kind,token:meta.address,wallet:w.address,inputToken:USDT,outputToken:meta.address,amountIn:String(q.cost),minOutput:String(q.n),quantity:Number(q.n),identity:meta.identity,metaVerified:true,freshBeforeExecute:true,requireNftCredit:true,requireAssetCredit:true,expectedAsset:{token:meta.address,kind:'Erc721',amount:String(q.n)},approvalFirst:!!steps.length,quota:s.info,fill:{continue:q.continue,lane:q.lane},budgetCurrency:'USDT',review:['付款表达式与钱包报价已核对；用精确 USDT 授权限制本批最大支出',...(steps.length?['当前只预览精确授权，授权后仍须重新模拟 NFT 足额到账']:[])],steps:[...steps,q.step]};
}
