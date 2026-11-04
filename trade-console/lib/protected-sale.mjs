import {Interface} from 'ethers';
import parser from '@solidity-parser/parser';
import {USDT,ERC20,read,same,parseUnits,formatUnits,ZeroAddress} from './common.mjs';
import {runtimeShape} from './bytecode.mjs';
import {chooseBatch,min,positive} from './mint-policy.mjs';
import {addressReferral} from './referral.mjs';

// Bounded multi-parameter sale families. Both ABI dispatch AND source flow are
// checked, independent of domain/deployment. Non-matching variants fail closed.
const families={
 'protected-tuple-sale':['mintWithReferral(uint256,address,uint256,uint256,uint256)','previewMintFor(address,uint256)','remainingFor(address)','MAX_BATCH()','MAX_SHARES()','soldShares()','mintClosed()','aborted()','quote()','token()'],
 'protected-buyback-sale':['mint(uint256,uint256,uint256,uint256)','quoteMint(uint256)','buybackQuote(uint256)','mintedShares(address)','WALLET_LIMIT()','TOTAL_SHARES()','sold()','COLD_SHARES()','TOKENS_PER_SHARE()','UNIT_USDT()','failed()','launched()','startsAt()','endsAt()','hasAgentId(address)','usdt()','token()']
};
const memo=new WeakMap(),fail=(code,message,details)=>Object.assign(Error(message),{code,details});
const exprText=n=>JSON.stringify(n);const sender=n=>n?.type==='MemberAccess'&&n.expression?.name==='msg'&&n.memberName==='sender';
function walk(n,fn){if(!n||typeof n!=='object')return;fn(n);for(const [k,v]of Object.entries(n))if(!['loc','range'].includes(k)){if(Array.isArray(v))v.forEach(x=>walk(x,fn));else if(v&&typeof v==='object')walk(v,fn);}}
export function recognizeProtectedSale(meta){
 if(memo.has(meta))return memo.get(meta);let result=null;
 if(meta.verified&&!meta.proxy&&!meta.identity?.implementation){const abi=new Interface(meta.abi),shape=runtimeShape(meta.runtimeCode),matches=Object.entries(families).filter(([,methods])=>!shape.delegate&&methods.every(s=>abi.getFunction(s)&&shape.selectors.has(abi.getFunction(s).selector)));
  if(matches.length===1){const kind=matches[0][0],functions=[];for(const s of Object.values(meta.sources||{}))try{walk(parser.parse(s.content),n=>{if(n.type==='FunctionDefinition'&&n.body)functions.push(n);});}catch{}
   const name=kind==='protected-tuple-sale'?'_mintShares':'mint',entries=functions.filter(n=>n.name===name&&n.parameters.length===(kind==='protected-tuple-sale'?5:4));
   if(entries.length===1){const f=entries[0],pulls=[],credits=[],comparisons=[];walk(f.body,n=>{if(n.type==='FunctionCall'&&n.expression?.type==='MemberAccess'&&n.expression.memberName==='safeTransferFrom')pulls.push(n);if(n.type==='FunctionCall'&&n.expression?.type==='MemberAccess'&&n.expression.memberName==='safeTransfer'&&sender(n.arguments[0]))credits.push(n);if(n.type==='BinaryOperation')comparisons.push(n);});
    const pull=pulls[0],self=n=>n?.type==='FunctionCall'&&(n.expression?.typeName?.name||n.expression?.name)==='address'&&n.arguments[0]?.name==='this';
    const paymentName=kind==='protected-tuple-sale'?'quote':'usdt',costField=kind==='protected-tuple-sale'?'q.cost':'cost';
    const flat=n=>n?.type==='Identifier'?n.name:n?.type==='MemberAccess'?flat(n.expression)+'.'+n.memberName:'';
    const bound=comparisons.some(n=>n.operator==='>'&&flat(n.left)===costField&&flat(n.right)===(kind==='protected-tuple-sale'?'maxCost':'maxUSDT'));
    const deadline=comparisons.some(n=>['<','>'].includes(n.operator)&&[flat(n.left),flat(n.right)].includes('deadline')&&[flat(n.left),flat(n.right)].includes('block.timestamp'));
    const output=kind==='protected-tuple-sale'?credits.length===2&&credits.every(c=>flat(c.arguments[1])==='q.userTokens')&&comparisons.some(n=>n.operator==='<'&&flat(n.left)==='q.userTokens'&&flat(n.right)==='minTokensOut'):credits.length===1&&credits[0].arguments[1]?.operator==='*'&&flat(credits[0].arguments[1].left)==='shares'&&flat(credits[0].arguments[1].right)==='TOKENS_PER_SHARE';
    const text=functions.map(f=>exprText(f)).join(' '); // AST evidence for explicit buyback input controls.
    const buyback=kind!=='protected-buyback-sale'||functions.some(f=>f.name==='_buyback'&&f.parameters.map(p=>p.name).join(',')==='amount,minimumOut,deadline')&&text.includes('minimumBuybackOut')&&text.includes('buybackQuote');
    const expected=kind==='protected-tuple-sale'?'shares,referrer,maxCost,minTokensOut,deadline':'shares,maxUSDT,minimumBuybackOut,deadline',method=kind==='protected-tuple-sale'?families[kind][0]:'mint(uint256,uint256,uint256,uint256)';
    const positional=f.parameters.map(p=>p.name).join(',')===expected&&abi.getFunction(method).inputs.map(p=>p.name).join(',')===expected;
    const entry=kind!=='protected-tuple-sale'||functions.some(e=>e.name==='mintWithReferral'&&e.parameters.map(p=>p.name).join(',')===expected&&e.body.statements.length===1&&e.body.statements[0].expression?.expression?.name==='_mintShares'&&e.body.statements[0].expression.arguments.map(p=>p.name).join(',')===expected);
    const tokenExpr=n=>{for(let i=0;i<4&&n?.type==='FunctionCall'&&n.arguments?.length===1;i++){if(!['IERC20','address'].includes(n.expression?.name||n.expression?.typeName?.name))return '';n=n.arguments[0];}return n?.name;};
    if(positional&&entry&&credits.every(c=>tokenExpr(c.expression.expression)==='token')&&pulls.length===1&&flat(pull.expression.expression)===paymentName&&sender(pull.arguments[0])&&self(pull.arguments[1])&&flat(pull.arguments[2])===costField&&bound&&deadline&&output&&buyback)result={kind,method,roles:kind==='protected-tuple-sale'?['quantity','zero','cost','min-output','deadline']:['quantity','cost','buyback-min','deadline']};
   }
  }
 }memo.set(meta,result);return result;
}
export async function protectedSaleState(rpc,intent,meta,w,profile=recognizeProtectedSale(meta)){
 if(!profile)return null;const abi=new Interface(meta.abi),block=await rpc.getBlockNumber(),header=await rpc.send('eth_getBlockByNumber',['0x'+block.toString(16),false]),now=BigInt(header.timestamp),memo=new Map();
 const get=async(name,args=[])=>{const key=name+args.join(',');if(!memo.has(key))memo.set(key,read(rpc,meta.address,abi,name,args,block).then(r=>r.length===1?r[0]:r));return memo.get(key);};
 const [payment,token]=await Promise.all([get(profile.kind==='protected-tuple-sale'?'quote':'usdt'),get('token')]);
 if(!same(payment,USDT)||same(token,ZeroAddress)||same(token,USDT))throw fail('MINT_ADAPTER_INCOMPLETE','多参数发售的付款币或到账资产不符合已支持范围');
 const s={name:profile.kind,token,assetKind:'Erc20',inputToken:USDT,block,free:0n,paid:0n,txCap:1n,info:{block,currency:'USDT'},referral:addressReferral(meta,profile,intent)};
 const bps=BigInt(intent.slippageBps??100);if(bps<0n||bps>=10000n)throw Error('最低到账滑点无效');const apply=n=>n*(10000n-bps)/10000n;
 if(profile.kind==='protected-tuple-sale'){
  const [closed,aborted,remaining,maxBatch,max,sold]=await Promise.all([get('mintClosed'),get('aborted'),get('remainingFor',[w.address]),get('MAX_BATCH'),get('MAX_SHARES'),get('soldShares')]);
  if(closed||aborted)throw fail('MINT_ENDED','本次发售已关闭');s.paid=min(remaining,positive(max-sold));s.txCap=maxBatch;
  s.quote=async n=>{const q=await get('previewMintFor',[w.address,n]);if(q.shares!==n||q.cost<=0n||q.userTokens<=0n)throw fail('MINT_STATE','当前报价份数或到账资产改变，请重新识别');const out=apply(q.userTokens);if(out<=0n)throw Error('最低到账为零');return {cost:q.cost,out,step:{kind:'mint',to:meta.address,value:'0',data:abi.encodeFunctionData(profile.method,[n,s.referral?.callValue||ZeroAddress,q.cost,out,now+90n])}};};
 }else{
  const [failed,launched,start,end,eligible,cap,used,max,sold,cold,unit,price]=await Promise.all([get('failed'),get('launched'),get('startsAt'),get('endsAt'),get('hasAgentId',[w.address]),get('WALLET_LIMIT'),get('mintedShares',[w.address]),get('TOTAL_SHARES'),get('sold'),get('COLD_SHARES'),get('TOKENS_PER_SHARE'),get('UNIT_USDT')]);
  if(failed||!launched&&now>=end)throw fail('MINT_ENDED','冷启动发售已结束');if(now<start)throw fail('MINT_NOT_OPEN','发售尚未开始');if(!eligible)throw fail('MINT_INELIGIBLE','当前钱包没有项目要求的 Agent ID');
  s.paid=min(positive(cap-used),positive(max-sold));s.txCap=min(cap,sold<cold?cold-sold:cap);
  s.quote=async n=>{const [cost,coldN,post]=await get('quoteMint',[n]);if(cost<=0n||coldN+post!==n||coldN&&post)throw fail('MINT_STATE','本批报价跨越冷启动边界，需要分批');let minimum=0n;
   if(post){const buyback=(cost-coldN*price)/2n,[amount,allowed]=await get('buybackQuote',[buyback]);if(!allowed||amount<=0n)throw fail('MINT_STATE','当前回购报价超过合约价格影响限制');minimum=apply(amount);const floor=(amount*9200n+9999n)/10000n;if(minimum<floor)minimum=floor;if(minimum<=0n)throw Error('回购最低到账为零');}
   return {cost,out:n*unit,step:{kind:'mint',to:meta.address,value:'0',data:abi.encodeFunctionData(profile.method,[n,cost,minimum,now+90n])}};
  };
 }
 const unit=s.paid?await s.quote(1n):null;s.info={...s.info,freeRemaining:'0',paidRemaining:String(s.paid),maxPerTransaction:String(s.txCap),unitPriceUsdt:unit?formatUnits(unit.cost,18):null,deadlineSeconds:90};return s;
}
export async function protectedSalePlan(rpc,intent,meta,w,resolved,profile=recognizeProtectedSale(meta)){
 if(!profile)return null;const s=await protectedSaleState(rpc,intent,meta,w,profile);
 if(intent.scope==='free')throw fail('NO_FREE_MINT','此入口为 USDT 付费铸造，没有零费用额度',{quota:s.info});
 if(intent.routeId&&!['protected:'+profile.method,profile.method].includes(intent.routeId))throw fail('MINT_ROUTE_INVALID','所选方式与当前多参数入口不一致');
 if(!s.referral&&resolved.referralHints?.detected&&intent.referral==='account1'&&[2,3].includes(intent.account))throw fail('REFERRAL_NOT_VERIFIED','当前入口尚未核验邀请绑定方式');
 const q=await chooseBatch(s,intent,parseUnits(intent.maxUsdt||'0',18)),[[balance],[allowance]]=await Promise.all([read(rpc,USDT,ERC20,'balanceOf',[w.address],s.block),read(rpc,USDT,ERC20,'allowance',[w.address,meta.address],s.block)]);
 if(balance<q.cost)throw fail('BUDGET_LIMIT','本钱包 USDT 余额不足');const steps=[];if(allowance<q.cost)steps.push({kind:'approve',to:USDT,spender:meta.address,allowance:String(q.cost),value:'0',data:ERC20.encodeFunctionData('approve',[meta.address,q.cost])});
 if(!steps.length)await rpc.call({from:w.address,to:meta.address,data:q.step.data,value:0n},s.block);
 return {kind:'contract',route:profile.kind+':'+profile.method,token:s.token,wallet:w.address,inputToken:USDT,outputToken:s.token,amountIn:String(q.cost),minOutput:String(q.out),quantity:Number(q.n),identity:meta.identity,metaVerified:true,freshBeforeExecute:true,requireAssetCredit:true,expectedAsset:{token:s.token,kind:'Erc20',amount:String(q.out)},approvalFirst:!!steps.length,referral:s.referral,quota:s.info,fill:{continue:q.continue,lane:'paid'},budgetCurrency:'USDT',review:['按当前报价设置最高付款、最低到账及链上 90 秒截止时间',...(steps.length?['当前仅预览精确额度授权；授权上链后必须另行通过 Mint 官方模拟']:[])],steps:[...steps,q.step]};
}
