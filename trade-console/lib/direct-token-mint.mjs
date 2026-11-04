import {Interface,keccak256,toUtf8Bytes} from 'ethers';
import parser from '@solidity-parser/parser';
import {read,same,USDT,ERC20,parseUnits,formatUnits,ZeroAddress} from './common.mjs';
import {agentHandle} from './sample-mints.mjs';
import {chooseBatch,min,positive,noQuota} from './mint-policy.mjs';
import {runtimeShape} from './bytecode.mjs';
const REGISTRY='0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F';
const fields={paid:['mintDirect(string,uint256)','mintDirect(uint256,string)','mintPaid(string,uint256)','paidMint(uint256,string)'],quote:['quoteCost(uint256)','quotePaid(uint256)'],registry:['registry()','REGISTRY()'],payment:['usdt()','paymentToken()'],token:['token()','mintToken()'],unit:['tokensPerShare()','TOKENS_PER_SHARE()'],cap:['MAX_SHARES()','MAX_SUPPLY_SHARES()'],used:['sharesMinted()','totalSharesMinted()'],walletCap:['PAID_CAP_PER_WALLET()','MAX_PAID_PER_WALLET()'],walletUsed:['paidSharesByWallet(address)','paidMintedByWallet(address)'],txCap:['MAX_SHARES_PER_TX()','MAX_PER_TX()'],eligible:['isAgent(address,string)']};
const memo=new WeakMap();
const walk=(node,fn)=>{if(!node||typeof node!=='object')return;fn(node);for(const [k,v]of Object.entries(node))if(!['loc','range'].includes(k)){if(Array.isArray(v))v.forEach(n=>walk(n,fn));else if(v&&typeof v==='object')walk(v,fn);}};
const ident=(n,name)=>n?.type==='Identifier'&&n.name===name;
const caller=n=>n?.type==='MemberAccess'&&ident(n.expression,'msg')&&n.memberName==='sender';
const self=n=>n?.type==='FunctionCall'&&(n.expression?.name==='address'||n.expression?.typeName?.name==='address')&&n.arguments?.length===1&&ident(n.arguments[0],'this');
function sourceProof(meta,methods,iface){
 const contracts=[],constants=new Set(),immutable=new Set();
 for(const s of Object.values(meta.sources||{}))try{walk(parser.parse(s.content),n=>{if(n.type==='ContractDefinition')contracts.push(n);});}catch{return false;}
 const name=k=>iface.getFunction(methods[k]).name;
 const owners=contracts.filter(c=>c.subNodes.some(n=>n.type==='FunctionDefinition'&&n.name===name('paid')&&n.body));if(owners.length!==1)return false;
 const definitions=owners[0].subNodes.filter(n=>n.type==='FunctionDefinition'&&n.body);
 for(const n of owners[0].subNodes.filter(n=>n.type==='StateVariableDeclaration').flatMap(n=>n.variables)){if(n.isDeclaredConst)constants.add(n.name);if(n.isImmutable)immutable.add(n.name);}
 const matching=(key)=>definitions.filter(n=>n.name===name(key)&&n.parameters?.length===iface.getFunction(methods[key]).inputs.length&&n.parameters.every((p,i)=>p.name===iface.getFunction(methods[key]).inputs[i].name));
 const pp=matching('paid'),qq=matching('quote');if(pp.length!==1||qq.length!==1)return false;
 const p=pp[0],q=qq[0],quantity=p.parameters[iface.getFunction(methods.paid).inputs.findIndex(p=>p.type==='uint256')].name;
 const returnExpr=q.body.statements.length===1&&q.body.statements[0].type==='ReturnStatement'&&q.body.statements[0].expression;
 const constant=n=>n?.type==='NumberLiteral'||n?.type==='Identifier'&&constants.has(n.name);
 if(returnExpr?.type!=='BinaryOperation'||returnExpr.operator!=='*'||!(ident(returnExpr.left,q.parameters[0].name)&&constant(returnExpr.right)||ident(returnExpr.right,q.parameters[0].name)&&constant(returnExpr.left)))return false;
 // Scope this family to immutable payment/output contracts and output units.
 if(![name('payment'),name('token'),name('unit')].every(n=>immutable.has(n)||constants.has(n)))return false;
 const aliases=new Map();for(const s of p.body.statements)if(s.type==='VariableDeclarationStatement'&&s.variables.length===1)aliases.set(s.variables[0].name,s.initialValue);
 const resolve=(n,env=aliases,depth=0)=>depth<6&&n?.type==='Identifier'&&env.has(n.name)?resolve(env.get(n.name),env,depth+1):n;
 const isCost=n=>{const e=resolve(n);return e?.type==='FunctionCall'&&ident(e.expression,name('quote'))&&e.arguments.length===1&&ident(resolve(e.arguments[0]),quantity);};
 let exactPull=false,otherPull=false,credit=false,assignment=false,pulls=0;
 const hasMutation=(body,names)=>{let mutated=false;walk(body,n=>{const lhs=n.type==='BinaryOperation'&&/^(=|[+*\/%-]=)$/.test(n.operator)?n.left:n.type==='UnaryOperation'&&['++','--','delete'].includes(n.operator)?n.subExpression:null;if(lhs?.type==='Identifier'&&names.has(lhs.name))mutated=true;});return mutated;};
 assignment=hasMutation(p.body,new Set([quantity,...aliases.keys()]));
 walk(p.body,n=>{
  if(n.type==='FunctionCall'&&n.expression?.type==='MemberAccess'&&/^(safeTransferFrom|transferFrom)$/.test(n.expression.memberName)){
   pulls++;const ok=p.body.statements.some(s=>s.type==='ExpressionStatement'&&s.expression===n)&&ident(n.expression.expression,name('payment'))&&n.arguments.length===3&&caller(resolve(n.arguments[0]))&&self(resolve(n.arguments[1]))&&isCost(n.arguments[2]);exactPull ||=ok;otherPull ||=!ok;
  }
 });
 // Follow direct private/internal helper calls with parameter substitution. This
 // proves the advertised units are minted to this caller, not a copied address.
 const visit=(fn,env,depth=0)=>{
  if(depth>2)return;if(hasMutation(fn.body,new Set(env.keys()))){assignment=true;return;}for(const s of fn.body.statements){const e=s.type==='ExpressionStatement'?s.expression:null;if(e?.type!=='FunctionCall')continue;
   if(e.expression?.type==='MemberAccess'&&ident(e.expression.expression,name('token'))&&e.expression.memberName==='mint'&&e.arguments.length===2){
    const who=resolve(e.arguments[0],env),amount=resolve(e.arguments[1],env);
    if(caller(who)&&amount?.type==='BinaryOperation'&&amount.operator==='*'&&(ident(resolve(amount.left,env),quantity)&&ident(resolve(amount.right,env),name('unit'))||ident(resolve(amount.right,env),quantity)&&ident(resolve(amount.left,env),name('unit'))))credit=true;
   }
   if(e.expression?.type==='Identifier')for(const helper of definitions.filter(h=>h.name===e.expression.name&&['internal','private'].includes(h.visibility)&&h.parameters.length===e.arguments.length)){
    const child=new Map(helper.parameters.map((v,i)=>[v.name,resolve(e.arguments[i],env)]));visit(helper,child,depth+1);
   }
  }
 };visit(p,aliases);
 return exactPull&&pulls===1&&!otherPull&&!assignment&&credit;
}

export function recognizeDirectTokenMint(meta){
 if(memo.has(meta))return memo.get(meta);
 if(!meta.verified||meta.proxy||meta.identity?.implementation||runtimeShape(meta.runtimeCode).delegate)return null;
 const abi=new Interface(meta.abi),methods={};
 for(const [key,choices]of Object.entries(fields)){const found=choices.filter(s=>abi.getFunction(s));if(found.length!==1)return null;const f=abi.getFunction(found[0]);
  const out=['registry','payment','token'].includes(key)?'address':key==='eligible'?'bool':'uint256';
  if(key==='paid'?f.stateMutability!=='nonpayable':key==='quote'?f.stateMutability!=='pure'||f.outputs.length!==1||f.outputs[0].type!==out:!['view','pure'].includes(f.stateMutability)||f.outputs.length!==1||f.outputs[0].type!==out)return null;
  methods[key]=found[0];
 }
 const result=sourceProof(meta,methods,abi)?{kind:'agent-direct-erc20',methods}:null;memo.set(meta,result);return result;
}

export async function directTokenMintState(rpc,bridge,intent,meta,w,profile=recognizeDirectTokenMint(meta)){
 if(!profile)return null;
 const abi=new Interface(meta.abi),block=await rpc.getBlockNumber(),one=async(key,args=[])=> (await read(rpc,meta.address,abi,profile.methods[key]||key,args,block))[0];
 const [payment,token,registry,unit,cap,used,walletCap,walletUsed,txCap,agent]=await Promise.all([one('payment'),one('token'),one('registry'),one('unit'),one('cap'),one('used'),one('walletCap'),one('walletUsed',[w.address]),one('txCap'),bridge.call(w.account,['wallet','agent-id'])]);
 if(!same(payment,USDT))throw Error('此直接付款接口目前只支持已核验的 BSC USDT');
 if(!same(registry,REGISTRY))throw Error('项目身份注册合约尚未适配');
 if(same(token,ZeroAddress)||same(token,payment)||unit<=0n||used>cap||walletUsed>walletCap||txCap<=0n)throw Error('项目付款币、资产或额度计数不一致');
 const handle=agentHandle(agent),id=BigInt(keccak256(toUtf8Bytes(handle))),ownerAbi=new Interface(['function ownerOf(uint256) view returns(address)']);
 const [[owner],eligible,[decimals],price]=await Promise.all([read(rpc,registry,ownerAbi,'ownerOf',[id],block),one('eligible',[w.address,handle]),read(rpc,token,ERC20,'decimals',[],block),one('quote',[1n])]);
 if(!same(owner,w.address)||!eligible)throw Object.assign(Error('当前钱包未通过 Agent ID 所有权与项目资格核验'),{code:'MINT_STATE'});
 if(decimals>36n||price<=0n)throw Error('资产精度或 USDT 报价无效');
 const paid=min(positive(walletCap-walletUsed),positive(cap-used));
 const freeEntries=abi.fragments.filter(f=>f.type==='function'&&!['view','pure'].includes(f.stateMutability)&&/^(?:mintFree|freeMint|claimFree|freeClaim|claim|airdrop|claimGift|giftMint)$/i.test(f.name));
 let freeUnknown=freeEntries.length>0,freeUpper=null;
 if(freeEntries.length===1&&freeEntries[0].format('sighash')==='mintFree(address,uint256,bytes32,uint256,bytes)'&&['FREE_CAP()','freeMinted()','FREE_PER_AGENT_CAP()','freeUsedByAgent(address)'].every(s=>abi.getFunction(s))){
  const [fc,fm,wc,wm]=await Promise.all([one('FREE_CAP()'),one('freeMinted()'),one('FREE_PER_AGENT_CAP()'),one('freeUsedByAgent(address)',[w.address])]);
  if(fm>fc||wm>wc)throw Error('免费凭证额度计数不一致');freeUpper=min(fc-fm,wc-wm,cap-used);freeUnknown=freeUpper>0n;
 }
 const notes=['USDT 直接付款入口；报价为已核验源码的固定单价乘份数，付款和到账仍须官方模拟。',...(freeUnknown?['免费入口需要本钱包的项目签发凭证；链上上限不等于已获免费额度。']:[])];
 return {name:profile.kind,free:0n,paid,txCap,token,assetKind:'Erc20',inputToken:payment,block,freeUnknown,notes,
  info:{agentId:handle,currency:'USDT',freeRemaining:freeUnknown?null:'0',freeRequiresVoucher:freeUnknown,freeOnchainUpperBound:freeUpper===null?null:String(freeUpper),paidRemaining:String(paid),paidUsed:String(walletUsed),maxPaidPerWallet:String(walletCap),maxPerTransaction:String(txCap),globalRemaining:String(cap-used),unitPriceUsdt:formatUnits(price,18),tokensPerShare:formatUnits(unit,Number(decimals)),block,notes},
  quote:async n=>{const cost=await one('quote',[n]);if(cost!==price*n)throw Error('总报价与固定单价不一致');const method=abi.getFunction(profile.methods.paid),args=method.inputs.map(p=>p.type==='string'?handle:n);return {cost,out:n*unit,step:{kind:'mint',to:meta.address,value:'0',data:abi.encodeFunctionData(method,args)}};}
 };
}

export async function directTokenMintPlan(rpc,bridge,intent,meta,w,resolved,profile=recognizeDirectTokenMint(meta)){
 if(!profile)return null;
 if(intent.routeId)throw Error('此直接付款类型按免费 / 付费 / 全部范围选择，请清除旧入口');
 const s=await directTokenMintState(rpc,bridge,intent,meta,w,profile);
 if(intent.scope!=='paid'&&s.freeUnknown)throw Object.assign(Error('免费额度需要项目为本钱包签发凭证，目前仅能核验链上上限；不会跳过免费凭证或自动改成付费。可明确选择付费范围。'),{code:'MINT_VOUCHER_REQUIRED',details:{quota:s.info}});
 if(intent.scope==='free')throw noQuota('当前链上免费额度上限为 0',{quota:s.info});
 if(resolved?.referralHints?.detected&&intent.referral!=='none'&&[2,3].includes(intent.account))throw Object.assign(Error('此项目的邀请由网站接口绑定，直接付款合约没有邀请参数；尚未核验 2、3 号使用 1 号的绑定，不能忽略后铸造。'),{code:'REFERRAL_NOT_VERIFIED'});
 const q=await chooseBatch(s,intent,parseUnits(intent.maxUsdt||'0',18)),steps=[];
 const [[balance],[allowed]]=await Promise.all([read(rpc,USDT,ERC20,'balanceOf',[w.address],s.block),read(rpc,USDT,ERC20,'allowance',[w.address,meta.address],s.block)]);
 if(balance<q.cost)throw Object.assign(Error('USDT 余额不足以支付本批 Mint；未自动换币'),{code:'BUDGET_LIMIT'});
 if(allowed<q.cost){if(allowed!==0n)throw Error('已有 USDT 授权非零且不足，需要先处理旧授权');steps.push({kind:'approve',to:USDT,spender:meta.address,allowance:String(q.cost),value:'0',data:ERC20.encodeFunctionData('approve',[meta.address,q.cost])});}
 if(!steps.length)await rpc.call({to:q.step.to,from:w.address,data:q.step.data,value:0n},s.block);
 steps.push(q.step);
 return {kind:'contract',route:profile.kind,token:s.token,wallet:w.address,inputToken:USDT,outputToken:s.token,amountIn:String(q.cost),minOutput:String(q.out),quantity:Number(q.n),identity:meta.identity,expectedAsset:{token:s.token,kind:'Erc20',amount:String(q.out)},requireAssetCredit:true,metaVerified:true,
  approvalFirst:steps.length>1,review:['接口兼容不代表项目安全审计',...s.notes,...(steps.length>1?['本次先预览限额 USDT 授权；授权上链后必须再通过 Mint 官方模拟，当前不能称 Mint 已模拟成功。']:[])],quota:s.info,fill:{continue:q.continue,lane:'paid',remainingBefore:String(q.remaining)},quote:{cost:String(q.cost),quantity:Number(q.n),block:s.block,currency:'USDT'},budgetCurrency:'USDT',steps};
}
