import {BNB,USDT,ERC20,read,same,formatUnits,Interface} from './common.mjs';
import {normalizeMintQuantity} from '../public/mint-quantity.mjs';

const fail=(code,message)=>Object.assign(Error(message),{code});
const positive=n=>n>0n?n:0n;
const refErrors=new Interface(['error InvalidReferrer()','error InvalidInviter()','error ReferrerNotEligible()']);
export const balanceMint=i=>i.side==='mint'&&normalizeMintQuantity(i.quantity)==='max'&&!['corla:claim','corla:refund'].includes(i.routeId);
export function invitationFailure(e){
 if(['REFERRAL_UNAVAILABLE','REFERRAL_NOT_VERIFIED','MINT_REFERRAL'].includes(e?.code))return true;
 try{if(refErrors.parseError(e.data))return true;}catch{}
 // Never treat generic eligibility, network, payment or proof errors as an
 // invitation failure. Only a rebuilt, fully simulated call may omit a ref.
 return /InvalidReferrer|InvalidInviter|ReferrerNotEligible|邀请.*(?:未核验|尚未核验|无效|失败|不匹配|未通过|同|绑定)|(?:邀请人|邀请身份|邀请参数|邀请绑定).*(?:不符|核验|关闭)|源码未核验、邀请|推荐参数|没有已核验的邀请参数|尚无已核验邀请|尚未核验所需邀请|不具备有效邀请身份|未配置 1 号邀请/.test(e?.message||'');
}
export async function optionalReferralPlan(build,intent){
 try{return {plan:await build(intent),intent};}catch(e){
  if(intent.referral==='none'||!invitationFailure(e))throw e;
  const next={...intent,referral:'none'};
  try{const plan=await build(next);plan.referral={...plan.referral,active:false,fallback:true,note:'邀请未生效；已改为不带邀请重新检查，Mint 仍须通过本钱包模拟。'};return {plan,intent:next};}
  catch(error){error.details={...error.details,invitationFallback:'已尝试不带邀请；当前调用仍未通过，不会绕过资格或合约限制'};throw error;}
 }
}

// Production entry shared by CLI and dashboard. build only plans/reads; this
// helper never signs, approves or submits. Numeric quantities retain budgets.
export async function fundedMintPlan(rpc,intent,w,build,{quantityCeiling=500,payment=null}={}){
 const full=balanceMint(intent);
 if(!full)return (await optionalReferralPlan(build,intent)).plan;
 const [native,priceRaw]=await Promise.all([rpc.getBalance(w.address),rpc.send('eth_gasPrice',[])]);
 const gasPrice=BigInt(priceRaw);if(gasPrice<=0n)throw fail('GAS_ESTIMATE_UNAVAILABLE','未取得有效 Gas 价格，请重试');
 let reserve=gasPrice*42000n;
 if(native<=reserve)throw fail('GAS_BALANCE_LOW','BNB 余额不足支付 Gas，当前钱包跳过；其他钱包继续');
 const tokenBalances=new Map();
 async function balance(token){const key=token.toLowerCase();if(!tokenBalances.has(key))tokenBalances.set(key,read(rpc,token,ERC20,'balanceOf',[w.address]).then(v=>v[0]));return tokenBalances.get(key);}
 // Some adapters discover a fixed USDT payment from the verified source.
 // An unavailable unrelated USDT read must not block a native/free mint.
 let usdt=0n,usdtError; if(intent.scope!=='free')try{usdt=await balance(USDT);}catch(e){usdtError=e;}
 let quoteBalance=null;if(payment&&!same(payment.token,BNB)&&!same(payment.token,USDT)&&intent.scope!=='free')quoteBalance=await balance(payment.token);
 let effective={...intent},last,fallback=false;
 let ceiling=Math.max(1,Math.min(500,quantityCeiling));
 for(let attempt=0;attempt<5;attempt++){
  effective={...effective,maxBnb:intent.scope==='free'?'0':formatUnits(positive(native-reserve),18),maxUsdt:intent.scope==='free'?'0':formatUnits(usdt,18),...(quoteBalance!==null?{quoteToken:payment.token,maxQuote:formatUnits(quoteBalance,payment.decimals)}:{})};
  let result;
  try{result=await optionalReferralPlan(build,effective);}catch(e){
   if(attempt===0&&/insufficient funds|insufficient balance/i.test(e.message)){reserve=gasPrice*2000000n;continue;}
   if(['BUDGET_LIMIT','INSUFFICIENT_FUNDS'].includes(e.code)||/没有符合预算|预算不足以铸造一份|预算不足|报价超过本次最高/.test(e.message))throw fail('INSUFFICIENT_FUNDS','当前钱包余额不足以铸造 1 份（已预留 Gas）；其他钱包继续');
   throw e;
  }
  let plan=result.plan;effective=result.intent;fallback ||= !!plan.referral?.fallback;
  if(usdtError&&same(plan.inputToken,USDT))throw fail('MINT_BALANCE_UNAVAILABLE','USDT 余额读取失败，请重试；其他钱包继续');
  if((plan.fill?.targetQuantity||plan.quantity)>ceiling){result=await optionalReferralPlan(build,{...effective,quantity:ceiling});plan=result.plan;effective={...result.intent,quantity:'max'};}
  const steps=plan.steps||[];if(!steps.length)throw fail('MINT_ADAPTER_INCOMPLETE','Mint 计划缺少交易步骤');
  let gas=0n,dependent=false,mintGas=0n;
  for(const step of steps){
   // Approval/binding changes state. Reserve conservatively for dependent
   // calls and replan after confirmation; never fake an allowance to estimate.
   let units;
   if(dependent){units=1000000n;}else try{units=BigInt(await rpc.send('eth_estimateGas',[{from:w.address,to:step.to,data:step.data,value:'0x'+BigInt(step.value||0).toString(16)}]));}
   catch(e){if(effective.referral!=='none'&&invitationFailure(e)){effective.referral='none';fallback=true;last=e;break;}if(attempt===0&&/insufficient funds|insufficient balance/i.test(e.message)){reserve=gasPrice*2000000n;last=e;break;}throw e;}
   if(units<=0n)throw fail('GAS_ESTIMATE_UNAVAILABLE','未取得有效 Mint Gas 估算');
   gas+=units*gasPrice*2n;if(step.kind==='mint')mintGas=units*gasPrice*2n;
   if(step.kind==='approve'||step.kind==='referral')dependent=true;
  }
  if(last){last=null;continue;}
  const target=plan.fill?.targetQuantity||plan.quantity||1;
  const batches=BigInt(Math.ceil(target/(plan.quantity||1)));
  const required=gas+mintGas*(batches-1n),total=BigInt(plan.fill?.targetCost??(same(plan.inputToken,BNB)?BigInt(plan.amountIn||0)*BigInt(target)/BigInt(plan.quantity||1):0));
  if(native<required&&target>(plan.quantity||1)&&mintGas>0n){const upfront=gas-mintGas,affordable=positive(native-upfront)/mintGas;
   if(affordable>0n){ceiling=Math.min(ceiling,Number(affordable)*plan.quantity);continue;}
  }
  if(native<required)throw fail('GAS_BALANCE_LOW','BNB 余额不足以预留认购及后续步骤 Gas；当前钱包跳过，其他钱包继续');
  if(same(plan.inputToken,BNB)&&total+required>native){
   if(plan.route==='corla:mint'&&plan.quantity===1){const affordable=positive(native-(gas-mintGas))/(BigInt(plan.amountIn)+mintGas);if(!affordable)throw fail('INSUFFICIENT_FUNDS','BNB 余额不足认购 1 份及 Gas');ceiling=Math.min(ceiling,Number(affordable));reserve=gas-mintGas+affordable*mintGas;}
   else reserve=required;
   continue;
  }
  // The exact calldata and minimum output remain the adapter's, and the
  // official wallet asset-delta simulation still runs before any submission.
  if(fallback)plan.referral={...plan.referral,active:false,fallback:true,note:'邀请未生效；已改为不带邀请重新模拟'};
  if(plan.route==='bagent:mint'&&same(plan.inputToken,BNB))effective.maxUsdt=formatUnits(BigInt(plan.bagent.maxUsdtDebit),18);
  plan.mintFunding={full:true,gasReserve:String(required),gasEstimated:!dependent,balance:String(native),effectiveIntent:{...effective},quantityCeiling:ceiling};
  plan.review??=[];plan.review.push('按本钱包实时剩余额度认购；余额不足时预留 Gas 后减少份数，后续批次重新检查。');
  return plan;
 }
 throw fail('MINT_FUNDING_CHANGED','余额或 Gas 估算变化较快，本钱包尚未提交，请重新预览；其他钱包继续');
}
