import {describeError,safeErrorText} from './error-message.mjs';
import {createRpcDialog} from './rpc-settings.mjs';
import {createMintQuantityControl} from './mint-quantity.mjs';
import {createUpdateDialog} from './app-updates.mjs';
import {createTaskCenter} from './task-center.mjs';
import {corlaBudget,refreshMintBudget} from './corla-budget.mjs';
import {needsRoute,statusLabel,projectLabel,reviewSummary,totalTimeLabel,compactReviewGroups,trackingLabel} from './review-model.mjs';
import {corlaProgress,corlaSummary} from './corla-view.mjs';
import {executeIndependent,runInstantTrades,isReady,independentOrder,tradeResultMessage,followSubmittedOrder,mergeTradeUpdate,canRetryTrade} from './trade-workflow.mjs';
import {normalizeAssetInput,mintTradeCA,pasteAsset,resolvedTradeAsset} from './asset-input.mjs';
import {binanciansInput} from './binancians-input.mjs';
import {createConsoleClient} from './session-client.mjs';
import {createTradeWarmup,createSellPreparationWarmup} from './trade-warmup.mjs';
const $=id=>document.getElementById(id);
let boot,ca=null,settings,selected=new Set(),busy=false,reviewOrders=[],refreshing=false,holdingsRows=[],nativeRows=[],walletRequest=null,project=null,generation=0,tradeRevision=0,tradeManual=false,tradeKind=null;
let budgetManual=false;
let noticeTarget='appNotice',noticeTimer;
const note=(s,error=false)=>{const box=$(noticeTarget)||$('appNotice');box.textContent=s;box.hidden=!s;box.classList.toggle('error',error);box.style.color=error?'var(--red)':'var(--muted)';if(box.id==='appNotice'){clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>box.hidden=true,error?12000:6000);}};
const clipboardReads=new Map();
for(const [id,target] of [['asset','mintNotice'],['tradeCA','tradeNotice']]){
 const input=$(id);
 // Reading is tied to a real click, never to page load or programmatic focus.
 const cancel=()=>clipboardReads.delete(id);
 input.addEventListener('input',cancel);input.addEventListener('blur',cancel);
 input.addEventListener('paste',event=>{cancel();pasteAsset(input,event,{caOnly:id==='tradeCA'});});
 input.addEventListener('click',async event=>{
  if(!event.isTrusted||event.button!==0||event.detail<1||busy)return;
  const ticket=Symbol(),before=input.value;clipboardReads.set(id,ticket);
  const current=()=>clipboardReads.get(id)===ticket&&document.activeElement===input&&input.value===before;
  try{
   if(!navigator.clipboard?.readText)throw Error('Clipboard unavailable');
   const text=(await navigator.clipboard.readText()).trim();
   if(!current()||!text)return;
   let value;
   try{value=id==='asset'?normalizeAssetInput(text):/^0x[0-9a-f]{40}$/i.test(text)&&!/^0x0{40}$/i.test(text)?text:null;}catch{value=null;}
   noticeTarget=target;
   if(!value)return note(id==='asset'?'剪贴板中没有有效的网址或 CA，可直接手动输入。':'剪贴板中没有完整的代币 CA，可直接手动输入。');
   if(input.value===value)return;
   input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));
   note(id==='asset'?'已自动粘贴，点击“识别项目”继续。':'已自动粘贴，点击“加载持仓”查看。');
  }catch{if(current()){noticeTarget=target;note('浏览器未允许读取剪贴板。可允许后再点输入框，或手动粘贴。');}}
  finally{if(clipboardReads.get(id)===ticket)clipboardReads.delete(id);}
 });
}
const client=createConsoleClient({onSession:applySession}),api=client.request;
const warmTrade=createTradeWarmup({api,allowed:()=>!!boot?.capabilities?.tradeWarmupVersion&&!busy&&!document.hidden});
let warmSellPercent='100',warmBuyAmount=null,warmSide='sell',lastSellActivity=Date.now();
const warmSell=createSellPreparationWarmup({api,endpoint:'trade-prepare-warm',delayMs:100,allowed:()=>!!boot?.capabilities?.tradePreparationVersion&&!busy&&!document.hidden&&document.hasFocus()&&Date.now()-lastSellActivity<60000,intents:()=>{
 const asset=checkedTradeCA(),buy=warmSide==='buy',slip=$(buy?'slippage':'sellSlippage').value;if(!/^\d+(?:\.\d{1,2})?$/.test(slip)||Number(slip)>50)return [];
 return [...selected].slice(0,4).map(account=>({account,side:warmSide,asset,...(buy?{amount:warmBuyAmount||settings.buy[0]}:{percent:warmSellPercent}),currency:$(buy?'currency':'receive').value,slippageBps:Math.round(Number(slip)*100),slippageMode:buy?'fixed':$('sellSlippageMode').value}));
}});
$('tradeCA').addEventListener('input',()=>{lastSellActivity=Date.now();warmSide='sell';warmSellPercent='100';warmSell();});
for(const event of ['pointermove','focusin','input'])$('sellButtons').closest('section')?.addEventListener(event,()=>lastSellActivity=Date.now());
document.addEventListener('change',()=>{lastSellActivity=Date.now();warmSell();});
for(const id of ['tradeCA','asset'])$(id).addEventListener('input',()=>warmTrade($(id).value));
createUpdateDialog({api});
createRpcDialog({api});
const mintQuantity=createMintQuantityControl({onChange:()=>{budgetManual=false;applyAutoBudget();}});
const taskCenter=createTaskCenter({api,viewOrder,onFeeReview:showPendingFeeReviews,notify:(message,error)=>{noticeTarget='appNotice';note(message,error);}});
function renderOpeningSupport(){taskCenter.setFeatures(boot?.capabilities);const version=boot?.capabilities?.openingVersion||0;$('openingCoverage').textContent=(version>=4?'Pancake / Uniswap V2、V3 · Biswap / Sushi / ApeSwap V2；自动发现配对币，BNB / USDT 支持 V2 两跳。':version>=3?'Pancake / Uniswap V2、V3 · 自动识别链上配对币；AUTO 到账为池子原币种。':version>=2?'Pancake / Uniswap V2、V3 · BNB、USDT、USDC、USD1 池（自动到账）。':'当前后端：Pancake V2 / V3 · BNB、USDT 池；本轮加速更新尚未应用。')+'已有流动性会立即检查卖出；首次授权增加耗时，50% 滑点允许较大价差。';}
function renderMode(){
 renderOpeningSupport();
 document.body.dataset.verification=boot.verification?'isolated':'';
 $('mint').textContent=boot.mode==='SIMULATION'?'模拟 Mint →':'预览 Mint →';updateTradePreferences();
}
function applySession(next){
 if(!boot)return;
 const modeChanged=boot.mode!==next.mode,bindingsChanged=JSON.stringify(boot.wallets)!==JSON.stringify(next.wallets),oldWallets=boot.wallets;boot=next;renderOpeningSupport();
 if(bindingsChanged){selected=new Set(next.wallets.filter(w=>selected.has(w.account)&&oldWallets.some(p=>p.account===w.account&&p.address.toLowerCase()===w.address.toLowerCase())).map(w=>w.account));holdingsRows=[];nativeRows=[];tradeRevision++;}
 if(modeChanged||bindingsChanged){reviewOrders=[];$('review').close();$('confirm').disabled=true;renderMode();renderWallets();note('本地连接已恢复，运行模式或钱包绑定已更新，请重新核对本次操作。',true);}
}
const num=v=>v===null||v===undefined?'—':Number(v).toLocaleString('en-US',{maximumFractionDigits:Number(v)>1?2:8});
const compact=v=>v==null?'—':Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2}).format(Number(v));
const compactUsd=v=>v==null?'—':'$'+compact(v);
const usd=v=>v===null||v===undefined?'—':'$'+num(v);
function el(tag,text,className){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;}
const preferenceKey='agent-trade-console:manual-trades:v1';
function updateTradePreferences(save=false){
 const auto=$('sellSlippageMode').value==='auto';$('sellSlippageLabel').textContent=auto?'上限 %':'固定 %';
 $('sellSlippageHint').textContent=auto?'优先官方建议；聚合器无流动性但直连池可用时取 1%，均不超过上限。':'本次卖出严格使用固定滑点；不足时停止，不会自动放宽。';
 $('quickState').textContent=$('quick').checked?'已开启 · 点击即交易':'已关闭 · 弹窗确认';
 $('quickHint').textContent=(boot?.mode==='SIMULATION'?'当前为模拟模式，不会签名或提交。':$('quick').checked?'买卖点击即执行，不弹本地确认窗；费用异常在下方显示，不自动放行。币安 App 核对由 App 决定。':'点击买卖按钮后先显示数量、到账币种和滑点，确认后提交。')+' Mint 保留单独确认。';
 if(save)try{localStorage.setItem(preferenceKey,JSON.stringify({quick:$('quick').checked,sellSlippageMode:$('sellSlippageMode').value,sellSlippage:$('sellSlippage').value,buySlippage:$('slippage').value,openingPercent:$('openingPercent').value,openingSlippage:$('openingSlippage').value}));}catch{}
}
function loadTradePreferences(){try{const p=JSON.parse(localStorage.getItem(preferenceKey)||'null');if(p){if(typeof p.quick==='boolean')$('quick').checked=p.quick;if(['auto','fixed'].includes(p.sellSlippageMode))$('sellSlippageMode').value=p.sellSlippageMode;for(const [key,id]of [['sellSlippage','sellSlippage'],['buySlippage','slippage'],['openingSlippage','openingSlippage']])if(/^\d+(?:\.\d{1,2})?$/.test(String(p[key]))&&Number(p[key])<=50)$(id).value=p[key];if(/^\d+(?:\.\d{1,6})?$/.test(String(p.openingPercent))&&Number(p.openingPercent)>0&&Number(p.openingPercent)<=100)$('openingPercent').value=p.openingPercent;}}catch{}updateTradePreferences();}
for(const id of ['quick','sellSlippageMode','sellSlippage','slippage','openingPercent','openingSlippage'])$(id).addEventListener('change',()=>updateTradePreferences(true));
function buildButtons(){for(const [side,id]of [['buy','buyButtons'],['sell','sellButtons']]){$(id).replaceChildren();settings[side].forEach(value=>{const b=el('button',side==='buy'?value:value+'%');b.append(el('small',side==='buy'?$('currency').selectedOptions[0].textContent:'当前持仓'));for(const event of ['pointerenter','focus'])b.addEventListener(event,()=>{lastSellActivity=Date.now();warmSide=side;if(side==='sell')warmSellPercent=String(value);else warmBuyAmount=String(value);warmSell();});b.addEventListener('click',()=>act(side,value));$(id).append(b);});}}
function renderWalletSelection(){
 applyAutoBudget();
 const count=boot.wallets.filter(w=>selected.has(w.account)).length;
 $('walletCount').textContent=`${count}/${boot.wallets.length} 已选`;
 $('selectAllWallets').disabled=count===boot.wallets.length;
 $('clearWallets').disabled=count===0;
}
$('selectAllWallets').addEventListener('click',()=>{selected=new Set(boot.wallets.map(w=>w.account));renderWallets();lastSellActivity=Date.now();warmSell();});
$('clearWallets').addEventListener('click',()=>{selected.clear();renderWallets();warmSell();});
function renderWallets(){
 const rows=new Map(holdingsRows.map(r=>[r.account,r])),native=new Map(nativeRows.map(r=>[r.account,r])),scrollTop=$('wallets').scrollTop;$('wallets').replaceChildren();
 for(const w of boot.wallets){
  const row=rows.get(w.account),n=native.get(w.account),box=el('div',undefined,'wallet'),top=el('div',undefined,'wallet-top'),label=el('label'),check=el('input');
  check.type='checkbox';check.checked=selected.has(w.account);check.setAttribute('aria-label',w.account+' 号钱包');check.addEventListener('change',()=>{if(check.checked)selected.add(w.account);else selected.delete(w.account);renderWalletSelection();});label.append(check,document.createTextNode(w.account));
  const connected=n?.status==='CONNECTED',failed=n?.status==='ERROR'||n?.status==='UNCONNECTED';
  const errors=[n?.connectionError,n?.balanceError?'BNB 读取失败：'+n.balanceError:null,row?.error?'代币持仓读取失败：'+row.error:null].filter(Boolean);
  const quota=project?.quotas?.find(q=>q.account===w.account),redeem=corlaRedemption(),refund=$('mintRoute').value==='corla:refund',issue=redeem&&quota?(BigInt((refund?quota.refundable:quota.claimable)||0)>0n?null:refund?'当前没有可退款费用':'当前没有可领取代币'):quota?.error||quota?.blocked;
  const details=[w.account+' 号 · '+(connected?'已连接':failed?'连接异常':'待检查'),...errors];
  if(quota)details.push(issue?'Mint：'+issue:redeem?(refund?'本钱包有认购费用可退回':'本钱包有已认购代币可领取'):`Mint 免费 ${quota.freeRequiresVoucher?'待凭证':quota.freeRequiresProof&&Number(quota.freeRemaining)>0?quota.freeRemaining+'（待官网凭证）':quota.freeRemaining??'未知'} · 付费 ${quota.paidRemaining??'未知'}${quota.paidIsGlobalInventory?'（全局）':''}`);
  if(n?.checkedAt)details.push('检查于 '+new Date(n.checkedAt).toLocaleTimeString());
  const state=el('button',undefined,'wallet-status '+(failed?'error':connected?'connected':''));state.type='button';state.title=details.join('；');state.setAttribute('aria-label','查看 '+w.account+' 号钱包状态');state.addEventListener('click',()=>{noticeTarget='appNotice';note(details.join('；'),!!(failed||errors.length||issue));});top.append(label,state);box.append(top);
  const addressLabel=w.address.slice(0,5)+'…'+w.address.slice(-4),addr=el('button',addressLabel,'wallet-address');addr.type='button';addr.title='点击复制完整地址：'+w.address;addr.setAttribute('aria-label','复制 '+w.account+' 号钱包地址 '+w.address);
  addr.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(w.address);addr.textContent='已复制 ✓';noticeTarget='appNotice';note(w.account+' 号完整钱包地址已复制。');setTimeout(()=>{if(addr.isConnected)addr.textContent=addressLabel;},1500);}catch{noticeTarget='appNotice';note('复制失败，请手动复制：'+w.address,true);}});box.append(addr);
  const shortBalance=value=>value==null?'—':Number(value)>=1000?compact(value):Number(value)>0&&Number(value)<.0001?'<0.0001':Number(value).toLocaleString('en-US',{maximumFractionDigits:4});
  const bnb=el('strong',n?.balanceError?'读取失败':shortBalance(n?.bnb),'bnb'),holding=el('span',row?.error?'读取失败':shortBalance(row?.balance),'holding');bnb.title=n?.balanceError||'BNB 余额：'+(n?.bnb??'尚未读取');holding.title=row?.error||'当前代币持仓：'+(row?.balance??'尚未读取');bnb.classList.toggle('error',!!n?.balanceError);holding.classList.toggle('error',!!row?.error);box.append(bnb,holding);
  $('wallets').append(box);
 }
 $('wallets').scrollTop=scrollTop;
 renderWalletSelection();
}
async function refreshWallets(checkConnection=false){
 if(walletRequest){if(!checkConnection)return walletRequest;await walletRequest.catch(()=>{});}
 walletRequest=(async()=>{const r=await api(checkConnection?'refresh-wallets':'wallets',checkConnection?{}:undefined);nativeRows=r.wallets;renderWallets();const bad=r.wallets.filter(w=>w.balanceError||checkConnection&&w.connectionError);$('walletState').textContent=(checkConnection?'连接及 BNB':'BNB')+' · '+new Date(r.at).toLocaleTimeString()+(bad.length?' · '+bad.map(w=>w.account+' 号需检查').join('、'):'');return r;})();
 try{return await walletRequest;}finally{walletRequest=null;}
}
function renderProject(){
 $('chainTools').hidden=['corla','binancians','stars'].includes(project?.platform);
 $('candidates').dataset.platform=project?.platform||'';
 const other=project?.platform==='corla'?project.quotas?.find(q=>q.budgetCurrency==='QUOTE'):null;$('quoteBudgetWrap').hidden=!other;$('quoteBudgetLabel').textContent=other?'每钱包 '+other.currency+' 预算':'其他付款币预算';$('quoteBudgetToken').textContent=other?.paymentToken||'';
 renderMintRoutes();
 renderChainLearning(project?.chainLearning);
 $('inviteBox').hidden=!project||project.platform==='corla'||project.platform==='stars'&&!project.address;
 const r=project?.referral;
 if(project){
  const status=r?.status||(r?.url?'ready':r?.detected?'needs-adapter':'not-detected'),ready=status==='ready'&&!!r?.url;
  $('inviteStatus').textContent=status==='ready'&&!r.bindingVerified?'链接已生成 · 绑定待核验':({ready:'已生成',unavailable:'网站读取失败',inactive:'本阶段不适用','not-detected':'未检测到邀请','needs-code':'需核验邀请码',ambiguous:'格式有歧义','needs-website':'需项目网址','needs-adapter':'待适配'})[status]||'待核验';
  $('inviteBox').classList.toggle('pending',!ready&&!['inactive','not-detected'].includes(status));$('inviteBox').classList.toggle('absent',['inactive','not-detected'].includes(status));
  $('inviteLink').textContent=ready?r.url:status==='not-detected'?'本次未检测到邀请链接':status==='inactive'?'当前铸造阶段不使用邀请':'尚未生成可核验链接';
  if(ready)$('inviteLink').href=r.url;else $('inviteLink').removeAttribute('href');
  $('inviteNote').textContent=(r?.note||'').replace(/[。；]+$/,'')+(r?.active===false||!r?.detected?'':r.bindingVerified?(r.bindingRule==='first-paid'?'。1 号不自邀。':'。2、3 号预览时自动使用 1 号身份，1 号不自邀。'):'。生成链接不代表铸造邀请已完成适配，请以预览结果为准。');
  $('copyInvite').disabled=!ready;$('copyInvite').textContent='复制链接';
 }
 const prices=[...new Set((project?.quotas||[]).filter(q=>!q.error&&!q.blocked).map(q=>q.unitPriceUsdt!=null?q.unitPriceUsdt+' USDT':q.unitPriceBnb!=null?q.unitPriceBnb+' BNB':q.unitPrice?.formatted!=null?q.unitPrice.formatted+' '+q.unitPrice.symbol:null).filter(Boolean))];
 const rules=[...(prices.length===1?['当前 1 份报价：'+prices[0]+'（Gas 另计）。']:[]),['Erc721','Erc1155'].includes(project?.assetKind)?'本次 Mint 到账为 NFT：可预览、铸造和查看数量，ERC20 快捷买卖不适用于该 NFT。':'项目 Mint 合约与交易代币可能不同，持仓和行情使用已识别的到账资产。',...new Set((project?.quotas||[]).flatMap(q=>q.notes||[]))];
 $('projectRules').textContent=rules.filter(Boolean).join(' ');renderWallets();
}
function fillRouteSelect(select,routes){select.replaceChildren();const empty=el('option',project?.platform==='corla'?'认购份额（默认）':'请选择铸造方式');empty.value='';select.append(empty);for(const r of routes){const option=el('option',r.label||(r.title||'铸造入口')+' · '+r.method);option.value=r.id;select.append(option);}}
function automaticMintLanes(routes){return routes?.length===2&&routes.some(r=>r.lane==='free')&&routes.some(r=>r.lane==='paid');}
function renderMintRoutes(){const routes=project?.mintRoutes||[],previous=$('mintRoute').value;$('mintRouteWrap').hidden=routes.length<2;fillRouteSelect($('mintRoute'),routes);if(routes.some(r=>r.id===previous))$('mintRoute').value=previous;if(automaticMintLanes(routes))$('mintRoute').options[0].textContent='按免费 / 付费范围自动选择（推荐）';renderCorlaAction();}
function corlaRedemption(){return project?.platform==='corla'&&['corla:claim','corla:refund'].includes($('mintRoute').value);}
function renderCorlaAction(){const redeem=corlaRedemption();$('corlaFollowOptions').hidden=project?.platform!=='corla'||redeem;renderClaimLink();applyAutoBudget();for(const id of ['scope','quantity','maxBnb','maxUsdt'])(id==='quantity'?$('mintQuantityField'):$(id).closest('label')).hidden=redeem;const other=project?.platform==='corla'&&project.quotas?.some(q=>q.budgetCurrency==='QUOTE');$('quoteBudgetWrap').hidden=redeem||!other;$('mint').textContent=redeem?($('mintRoute').value==='corla:refund'?'预览退款 ↗':'预览领取 ↗'):'预览 Mint ↗';document.querySelector('.mint-help').textContent=redeem?'只处理本钱包已有份额，无新增认购费用；Gas 另计。':'免费额度默认打满 · 未知额度自动模拟数量 · Gas 另计';}
$('mintRoute').addEventListener('change',()=>{renderCorlaAction();renderWallets();});
$('copyInvite').addEventListener('click',async()=>{noticeTarget='mintNotice';const url=project?.referral?.url;if(!url)return;try{await navigator.clipboard.writeText(url);if(project?.referral?.url===url){$('copyInvite').textContent='已复制 ✓';note('1 号邀请链接已复制。');}}catch{note('自动复制失败，请选中邀请链接手动复制：'+url,true);}});
function clearTrade(){ca=null;tradeKind=null;holdingsRows=[];tradeRevision++;$('tokenCA').textContent='等待加载';$('tokenName').textContent='等待加载';for(const id of ['mcap','price','holders','liquidity'])$(id).textContent='—';$('holdingBlock').textContent='代币持仓待加载';$('change').textContent='24h —';$('volume').textContent='24h 成交 —';$('holdersSource').textContent='暂无数据';$('updated').textContent='行情尚未加载';}
function checkedTradeCA(){const raw=$('tradeCA').value.trim();if(!/^0x[0-9a-f]{40}$/i.test(raw)||/^0x0{40}$/i.test(raw))throw Error('请在快捷交易卡片填写完整的 42 字符代币 CA');return raw;}
function activateTrade(address,kind=null,name=null){$('tradeFeedback').replaceChildren();feedbackRows=[];$('tradeNotice').hidden=true;clearTrade();ca=address;tradeKind=kind;$('tradeCA').value=address;$('tokenCA').textContent=address;$('tokenName').textContent=name||'正在读取代币';warmTrade(address);warmSell();}
async function loadTrade(){noticeTarget='tradeNotice';try{const address=checkedTradeCA();tradeManual=true;activateTrade(address);note('正在读取此 CA 的行情和钱包持仓…');await refreshAsset(true);if(ca===address)note('已加载交易 CA；买卖使用此地址，卖出按点击时实时持仓计算。');}catch(e){note(e.message,true);$('tradeCA').focus();}}
$('tradeCA').addEventListener('input',()=>{noticeTarget='tradeNotice';tradeManual=true;clearTrade();renderWallets();note('交易 CA 已改变；可加载持仓。买卖按钮按下方确认设置执行。');});
$('tradeCA').addEventListener('keydown',e=>{if(e.key==='Enter')loadTrade();});$('loadTradeCA').addEventListener('click',loadTrade);
function clearProject(){
 project=null;generation++;budgetManual=false;$('maxBnb').value='0';$('maxUsdt').value='0';$('claimSell').checked=false;$('chainTools').hidden=false;$('maxQuote').value='0';$('quoteBudgetWrap').hidden=true;$('quoteBudgetToken').textContent='';renderMintRoutes();if(!tradeManual){clearTrade();$('tradeCA').value='';}
 $('candidates').replaceChildren();$('addressRoles').replaceChildren();$('discovery').textContent='';
 $('chainEvidence').replaceChildren();
 $('inviteBox').hidden=true;$('copyInvite').disabled=true;$('inviteLink').removeAttribute('href');$('projectRules').textContent='';renderWallets();
}
function renderChainLearning(evidence){
 const root=$('chainEvidence');root.replaceChildren();if(!evidence)return;
 const box=el('details',undefined,'chain-evidence'),methods=evidence.methods||[];
 box.append(el('summary',methods.length?'链上 Mint 记录 · '+methods.length+' 种调用 · 展开查看':'链上回查 · '+({unavailable:'读取未完成','no-address':'缺少候选地址','no-samples':'本次范围内未找到可核验样本','time-budget':'回查达到时限，结果未完整'})[evidence.status]));
 if(evidence.scan)box.append(el('p',`最近交易回查：已查 ${evidence.scan.checked} / 最多 ${evidence.scan.limit} 笔 · 成功回执 ${evidence.scan.successful} 笔 · 铸造样本 ${evidence.scan.accepted} 笔`));
 const reasons={missing_receipt:'交易或回执暂缺',not_verified_issuance:'不是已核验的铸造/库存发放',unrelated_receipt:'不属于候选项目',support_contract:'公共辅助合约',unverified_dispatch:'代理实现或入口未核验',historical_code_changed:'历史代码与当前不同',asset_not_verified:'到账资产接口未核验',historical_rpc_unavailable:'历史节点不可用',query_failed:'查询失败'};
 for(const [key,n]of Object.entries(evidence.scan?.reasons||{}))box.append(el('p',`${reasons[key]||key}：${n} 笔`,'helper'));
 box.append(el('p',evidence.note,'helper'));
 for(const m of methods){const row=el('div',undefined,'chain-method'),usable=m.usable&&evidence.targets?.some(t=>t.corroborated&&t.address.toLowerCase()===m.target.toLowerCase());
  row.append(el('strong',(m.method||m.selector)+' · '+m.participants+' 个参与者'),el('p','调用入口：'+m.target,'mono'));
  for(const a of m.assets||[])row.append(el('p',(['Erc721','Erc1155'].includes(a.kind)?'NFT 合约：':'代币 CA：')+a.token,'mono'));
  row.append(el('p',usable?'参数可供重新构造；是否可 Mint 以本钱包预览为准':m.reason+'；仅作适配线索','helper'));
  if(m.parameterRoles?.length){const names={id:'当前钱包 Agent ID',quantity:'本次份数',start:'实时起始编号',minimum:'最低到账',deadline:'新截止时间',inviter:'已核验的邀请人 ID',referrer:'本次邀请钱包',cost:'本次实时报价',task:'当前领取任务',signature:'本钱包官网签名凭证',usernameHash:'本人的社交账号标识',postIdHash:'本人的帖子标识'};row.append(el('p','重新生成：'+m.parameterRoles.map(r=>names[r]||r).join('、'),'helper'));}
  const links=el('div',undefined,'chain-links');for(const [i,s]of m.samples.slice(0,6).entries()){const a=el('a','成功记录 '+(i+1));a.href='https://bscscan.com/tx/'+s.txHash;a.target='_blank';a.rel='noopener';links.append(a);}row.append(links);box.append(row);
 }
 if(evidence.partial)box.append(el('p','本次为有限样本，未读取到的记录和复杂调用可能需要进一步适配。','helper'));
 root.append(box);
}
$('asset').addEventListener('input',()=>{noticeTarget='mintNotice';const pastedCA=mintTradeCA($('asset').value);if(pastedCA)tradeManual=true;clearProject();if(pastedCA&&$('tradeCA').value.trim().toLowerCase()!==pastedCA.toLowerCase()){$('tradeCA').value=pastedCA;clearTrade();renderWallets();}note(pastedCA?'CA 已同步到快捷交易；请识别当前项目。':'输入已改变，请识别当前项目。');});
function renderAddressRoles(d){
 const rows=d.addresses||[];if(!rows.length)return;
 const checked=rows.filter(r=>r.verifiedRoles?.length).length;const box=el('details',undefined,'address-roles'),summary=el('summary',`地址用途：${checked} 个有核验依据 / 共 ${rows.length} 个 · 展开查看`);box.append(summary);
 for(const r of rows){const row=el('div',undefined,'address-role'),label=el('strong',(r.primary?'当前项目 · ':'')+(r.name||r.field||''));row.append(label);
  const names=(r.roleLabels||['用途待核验']).map((name,n)=>name+(!(r.verifiedRoles||[]).includes(r.roles[n])?'（网站标注，未核验）':''));
  row.append(el('div',names.join(' · '),'role-description'));const link=el('a',r.address,'mono');link.href='https://bscscan.com/address/'+r.address;link.target='_blank';link.rel='noopener';row.append(link);
  const proofs=[...new Set((r.evidence||[]).map(e=>e.label))];if(proofs.length)row.append(el('small',proofs.join('；')));if(r.error)row.append(el('small','核验未完成：'+r.error));box.append(row);
 }
 $('addressRoles').append(box);
}
$('scope').addEventListener('change',()=>{budgetManual=false;applyAutoBudget();if($('scope').value==='free'){$('maxBnb').value='0';$('maxUsdt').value='0';$('maxQuote').value='0';}});
function applyAutoBudget(){
 const balanceFill=project?.platform==='stars'&&!corlaRedemption()&&['all','paid'].includes($('scope').value)&&mintQuantity.value()==='max';
 for(const id of ['maxBnb','maxUsdt','maxQuote'])$(id).readOnly=balanceFill;
 if(balanceFill){budgetManual=false;try{const b=corlaBudget(project,[...selected],$('scope').value,'max');if(b)for(const id of ['maxBnb','maxUsdt'])$(id).value=b[id];}catch{}$('budgetHint').textContent='全部打满：按实时额度与余额认购，预留 Gas；余额不足自动减少份数，不受旧预算数值限制。';return;}
 if(budgetManual){$('budgetHint').textContent='使用手动预算上限；不会自动增加。';return;}
 $('budgetHint').textContent='';if(corlaRedemption())return;
 try{const b=corlaBudget(project,[...selected],$('scope').value,mintQuantity.value());if(!b)return;
  for(const id of ['maxBnb','maxUsdt','maxQuote'])$(id).value=b[id];
  $('budgetHint').textContent='已自动填入费用预算：'+b.costs.map(c=>c.account+' 号 '+c.lots+' 份 / '+c.cost+' '+b.symbol+(c.limited?'（单次上限 500 份）':'')).join('；')+'。当前合计 '+b.total+' '+b.symbol+(b.bufferBps?'；已预留 '+b.bufferBps/100+'% 报价余量，预算总上限 '+b.totalLimit+' '+b.symbol:'')+'。Gas 另计；余额不足或全局额度被抢占时无法打满。';
  if(b.unavailable?.length)$('budgetHint').textContent+=' '+b.unavailable.map(q=>q.account+' 号报价暂不可用').join('、')+'，按各钱包预览分别核对。';
 }catch(e){for(const id of ['maxBnb','maxUsdt','maxQuote'])$(id).value='0';$('budgetHint').textContent='预算未自动填入：'+e.message;}
}
for(const id of ['maxBnb','maxUsdt','maxQuote'])$(id).addEventListener('input',()=>{budgetManual=true;applyAutoBudget();});
function renderClaimLink(){
 const enabled=project?.platform==='corla'&&!corlaRedemption()&&$('autoClaim').checked;
 $('claimSell').disabled=!enabled;if(!enabled)$('claimSell').checked=false;
 const linked=enabled&&$('claimSell').checked;
 $('claimSellHint').textContent=linked?'领取 100% 后卖出当前总持仓 '+$('openingPercent').value+'%，滑点 '+$('openingSlippage').value+'%'+($('openingGasLimit').value?'，卖出 Gas 上限 '+$('openingGasLimit').value:'')+'；参数在右侧设置。随本次认购确认启动。':'确认本次认购后启动；关闭网页继续监测，服务重启暂停。领取 Gas 另计。';
 $('startOpening').disabled=linked;$('startOpening').textContent=linked?'随认购确认启动':'检查并启动 ↗';
}
$('autoClaim').addEventListener('change',renderClaimLink);
$('claimSell').addEventListener('change',()=>{if($('claimSell').checked){$('openingEnabled').checked=true;$('openingControls').hidden=false;}renderClaimLink();});
for(const id of ['openingPercent','openingSlippage','openingGasLimit'])$(id).addEventListener('input',renderClaimLink);
async function refreshAsset(force=false){if(!ca||refreshing===tradeRevision||!force&&document.hidden)return;const revision=tradeRevision,active=ca;refreshing=revision;try{
 const results=await Promise.allSettled([api('market?ca='+active),api('holdings?ca='+active)]);if(revision!==tradeRevision||active!==ca)return;
 const [m,h]=results;if(m.status==='fulfilled'){const x=m.value;$('tokenName').textContent=x.name||x.symbol||(!tradeManual?project?.name:null)||'未命名代币';$('mcap').textContent=compactUsd(x.marketCap);$('mcap').title=usd(x.marketCap);$('price').textContent=usd(x.price);$('holders').textContent=num(x.holders);$('liquidity').textContent=compactUsd(x.liquidity);$('liquidity').title=usd(x.liquidity);$('volume').textContent='24h 成交 '+compactUsd(x.volume24h);$('change').textContent='24h '+(x.priceChange24h==null?'—':num(x.priceChange24h)+'%');$('holdersSource').textContent=x.sources.holders?'来源 '+x.sources.holders:'来源暂未提供';$('updated').textContent=(x.sources.market||'行情未知')+' · '+new Date(x.at).toLocaleTimeString();}
 if(h.status==='fulfilled'){tradeKind=h.value.assetType;holdingsRows=h.value.wallets;renderWallets();$('holdingBlock').textContent='持仓 #'+h.value.block;for(const id of ['notice','tradeNotice','mintNotice'])if($(id).textContent.startsWith('持仓读取失败：')){$(id).textContent='持仓已恢复更新';$(id).classList.remove('error');$(id).style.color='var(--gold)';}}else {note('持仓读取失败：'+h.reason.message,true);if(force)throw h.reason;}
 }finally{if(refreshing===revision)refreshing=false;}}
async function inspect({learn=false}={}){noticeTarget='mintNotice';let asset;try{asset=normalizeAssetInput($('asset').value);}catch(e){clearProject();return note(e.message,true);}$('asset').value=asset;clearProject();const revision=generation;$('inspect').disabled=true;$('learnChain').disabled=true;const platformProgress=/^https:\/\/(?:www\.)?starsagent\.org(?:\/|$)/i.test(asset)?'正在核验 Stars 平台项目、剩余额度及认购费用…':binanciansInput(asset)?.explicit?'正在核验币安人发射台项目、Agent ID 额度和实时费用…':corlaProgress(asset);$('chainTools').hidden=!!platformProgress;note(platformProgress||(learn?'正在回查近期成功 Mint 交易并核验入口、资产和代码…':'正在识别地址用途；常规识别不足时自动回查链上 Mint…'));try{
 const d=await api('project?asset='+encodeURIComponent(asset)+(learn?'&learn=1':''));if(revision!==generation||$('asset').value.trim()!==asset)return;
 renderAddressRoles(d);if(!d.address){project=d;renderProject();for(const c of d.candidates||[]){const b=el('button',(c.roleLabels||[c.field||'待核验']).join(' / ')+' · '+c.address,'secondary candidate');b.addEventListener('click',()=>{$('asset').value=c.source?.startsWith('https://flap.sh/apps/corla/')?c.source:c.address;inspect();});$('candidates').append(b);}
  if(!tradeManual)$('tokenName').textContent=d.name||'待核验项目';
  $('discovery').textContent=(d.name||'当前项目')+' · '+(d.access?.kind==='site-session-targets'?'合约地址需要官网登录后提供':d.candidates?.length?'请选择下方候选入口':'尚未找到可核验合约地址')+' · 来源：'+d.source;note(d.reason||'尚未核验到项目合约地址。',d.platform!=='stars');return;}
 project=d;const correctedTrade=resolvedTradeAsset(d,asset,$('tradeCA').value);if(correctedTrade)activateTrade(correctedTrade,d.assetKind,d.name);else if(!tradeManual){if(d.token&&(d.platform!=='corla'||d.quotas?.some(q=>q.status===3)))activateTrade(d.token,d.assetKind,d.name);else {clearTrade();$('tradeCA').value='';}}const primary=d.addresses?.find(r=>r.primary);$('discovery').textContent='已识别当前项目：'+(primary?.roleLabels?.filter((_,n)=>(primary.verifiedRoles||[]).includes(primary.roles[n])).join(' + ')||'项目合约')+' · '+d.address+' · 来源：'+d.source;
 if(!tradeManual)$('tokenName').textContent=d.token?(d.name||primary?.name||'项目资产'):'尚未核验交易代币 CA';renderProject();note((d.platform==='stars'?'已识别 Stars '+(d.mode==='quick'?'Quick':'标准')+'模式。此平台只有付费认购，请选择全部或付费额度；打满会按本钱包余额预留 Gas 后计算份数。':corlaSummary(d))||(automaticMintLanes(d.mintRoutes)?'已识别免费及付费入口，将按本次范围自动选择；全部额度会逐批重查，先免费后付费。':d.mintRoutes?.length>1?'已识别项目，请在 Mint 区域选择铸造方式；也可点击预览 Mint 查看选项。':'地址用途已识别。当前 '+(boot.mode==='SIMULATION'?'模拟模式：只检查和预览，不提交。':'真实模式：请核对每笔预览。')));if(d.platform!=='corla'||d.quotas?.some(q=>q.status===3))await refreshAsset();
 }catch(e){if(revision===generation)note(e.message,true);}finally{$('inspect').disabled=false;$('learnChain').disabled=false;}}
$('learnChain').addEventListener('click',()=>inspect({learn:true}));
function setBusy(value){busy=value;for(const b of document.querySelectorAll('.buy-row button,.sell-row button,#mint'))b.disabled=value;}
async function act(side,value){noticeTarget=side==='mint'?'mintNotice':'tradeNotice';if(busy)return note('本次操作正在准备，请等待当前预览。');if(!selected.size)return note('请选择至少一个钱包',true);let asset;try{asset=side==='mint'?normalizeAssetInput($('asset').value):checkedTradeCA();}catch(e){note(e.message,true);if(side!=='mint')$('tradeCA').focus();return;}if(side==='mint')$('asset').value=asset;else if(ca?.toLowerCase()!==asset.toLowerCase()){activateTrade(asset);}
 if(side!=='mint'&&['Erc721','ERC721','Erc1155','ERC1155'].includes(tradeKind))return note('这是 NFT，不能按 ERC20 池子比例卖出；需要 NFT 市场订单适配。',true);
 // Manual caps stay fixed. A moving-price platform refreshes automatic caps
 // once for the group BEFORE review; execution may never raise confirmed caps.
 if(side==='mint'&&!budgetManual)applyAutoBudget();
 const slip=$(side==='sell'?'sellSlippage':'slippage').value;if(!/^\d+(?:\.\d{1,2})?$/.test(slip)||Number(slip)>50)return note('滑点范围 0–50%，最多两位小数',true);const s=Math.round(Number(slip)*100);
 const base={side,asset,currency:side==='sell'?$('receive').value:$('currency').value,slippageBps:s};if(side==='buy')base.amount=value;if(side==='sell'){base.percent=value;base.slippageMode=$('sellSlippageMode').value;}if(side==='mint'){base.quantity=mintQuantity.value();base.maxBnb=$('maxBnb').value;base.maxUsdt=$('maxUsdt').value;base.scope=$('scope').value;if(!$('quoteBudgetWrap').hidden){base.maxQuote=$('maxQuote').value;base.quoteToken=$('quoteBudgetToken').textContent;}base.referral='account1';if($('mintRoute').value&&!$('mintRouteWrap').hidden)base.routeId=$('mintRoute').value;}
 if(side==='mint'&&project?.platform==='corla'&&!corlaRedemption()){base.autoClaim=$('autoClaim').checked;if(base.autoClaim&&$('claimSell').checked){try{base.claimSell={percent:$('openingPercent').value,slippageBps:Math.round(Number($('openingSlippage').value)*100),currency:$('receive').value,...openingGasInput()};}catch(e){return note(e.message,true);}}}
 if(side==='mint'&&corlaRedemption()){Object.assign(base,{quantity:1,maxBnb:'0',maxUsdt:'0',scope:'free'});delete base.maxQuote;delete base.quoteToken;}
 const context=side==='mint'&&project?{name:project.name,source:project.source,address:project.address}:side==='mint'?null:{name:['等待加载','正在读取代币'].includes($('tokenName').textContent)?null:$('tokenName').textContent,source:'手动交易 CA',address:asset};
 setBusy(true);note('正在读取当前状态并生成预览…');try{
 const id='manual-'+crypto.randomUUID(),accounts=[...selected],quick=side!=='mint'&&boot.mode==='LIVE'&&$('quick').checked;let completed=0;
 $('reviewBody').replaceChildren(el('h3',side==='mint'?'正在准备铸造预览':'正在准备'+(side==='sell'?'卖出':'买入')+'预览'),el('p',asset,'mono'));const progress=el('p',`正在检查 ${accounts.length} 个钱包…`);$('reviewBody').append(progress);$('confirm').disabled=true;$('confirm').textContent='预览中…';if(!quick&&!$('review').open)$('review').showModal();
 if(side==='mint'){
  const snapshot=()=>JSON.stringify([generation,$('asset').value,[...selected],$('scope').value,mintQuantity.value(),budgetManual,$('maxBnb').value,$('maxUsdt').value,boot.wallets]);
  const before=snapshot(),updated=await refreshMintBudget({project,asset,accounts,scope:base.scope,quantity:base.quantity,manual:budgetManual},url=>api('project?asset='+encodeURIComponent(url)));
  if(before!==snapshot())throw Error('准备期间项目、钱包或预算已修改，请重新预览');
  if(updated){project=updated.project;applyAutoBudget();base.maxBnb=updated.budget.maxBnb;base.maxUsdt=updated.budget.maxUsdt;}
 }
 const requests=accounts.map(account=>({id:id+'-account'+account,intent:{...base,account},project:context}));const quickResults=new Map();
 const results=quick?await runInstantTrades(requests,o=>api('run',{id:o.id,intent:o.intent,execute:true,fastReturn:true,acknowledgeReview:true,authorization:`用户在本地看板开启免二次确认后点击：${JSON.stringify(o.intent)}`}),{onResult:o=>{quickResults.set(o.id,o);showTradeFeedback([...quickResults.values()]);trackSubmitted([o]);completed++;note(`${o.intent.account} 号：${statusLabel(o)}；已返回 ${completed}/${accounts.length} 个钱包`);refreshOrders().catch(()=>{});}}):await Promise.all(accounts.map(async account=>{try{const o=await api('prepare',{id:id+'-account'+account,intent:{...base,account}});if(context)o.project={...context,...o.project,name:o.project?.name||context.name};return o;}catch(e){return {id:id+'-account'+account,intent:{...base,account},project:context,status:'BLOCKED',error:{message:e.message,details:e.details,code:e.code}};}finally{completed++;progress.textContent=`已返回 ${completed}/${accounts.length} 个钱包；等待其余预览…`;}}));
 reviewOrders=results;refreshOrders().catch(e=>note('记录刷新失败：'+e.message,true));
 if(quick){showTradeFeedback(results);note(tradeResultMessage(feedbackRows),results.some(o=>o.needsFeeReview||['BLOCKED','FAILED','REJECTED','SUBMISSION_UNKNOWN'].includes(o.status)));void Promise.allSettled([refreshOrders(),refreshAsset(true)]);}
 else showReviews(results);
 }catch(e){note(e.message,true);if($('review').open&&$('confirm').disabled){$('reviewBody').append(el('p',e.message,'error'));$('confirm').textContent='未提交 · 请重新预览';}}finally{setBusy(false);}}
function renderReviewDetail(o){const div=el('div',undefined,'review-item');div.append(el('h3',`${o.intent.account} 号 · ${o.intent.side==='mint'?'铸造':o.intent.side==='buy'?'买入':'卖出'}`),el('span',statusLabel(o),'review-status'));
   if(o.feeRouteSearch){const s=o.feeRouteSearch,details=el('details');details.append(el('summary',s.status==='selected'?'已自动切换低费路线 · 查看检查结果':'已自动寻找其他低费路线 · 查看结果'));for(const row of s.checks||[])details.append(el('p',row.result==='selected'?'已选用池费 '+Number((row.poolFeePpm/10000).toFixed(4))+'% 的路线':(row.reasons||[]).join('；')||row.message||'该路线未通过检查'));if(s.status!=='selected')details.append(el('p','本轮未找到符合原交易约束、且通过模拟的低费路线；不代表所有市场都没有其他池子。','helper'));div.append(details);}
   if(o.feeReview){const f=o.feeReview,box=el('section',undefined,f.required?'fee-review fee-review-required':'fee-review');const percent=n=>n===null||n===undefined?'未知':Number((n/10000).toFixed(4))+'%';
    box.append(el('b',f.blocked?'已阻止卖出：无法核验路线费用':f.required?'卖出费用需要单独确认':'卖出费用'),el('p','池手续费 '+percent(f.poolFeePpm)+' · 代币卖出税 '+percent(f.taxPpm)));
    if(f.additionalLossPpm>0)box.append(el('p','模拟到账相对报价减少 '+percent(f.additionalLossPpm)));
    for(const pool of f.pools||[])box.append(el('p',pool.address+' · 池费 '+percent(pool.feePpm),'mono'));
    for(const reason of f.reasons||[])box.append(el('p',reason));
    box.append(el('p',f.blocked?'此路线不能通过确认放行。请重新检查已适配的固定池；不会自动改走聚合器。':f.required?'高费用需要单独确认；滑点不能阻止报价中已扣除的费用。':f.pendingSellPreview?'授权后自动检查模拟净到账，通过后立即卖出，无需再次确认。':f.taxPpm==null?'税率接口未返回数据，已检查本钱包模拟净到账；Gas 另计。':'税率为当前检测值；Gas 另计。','helper'));div.append(box);
   }
   if(o.intent.side==='mint')div.append(el('div',`${({free:'只用免费额度',paid:'只用付费额度',all:'全部额度'})[o.intent.scope]||'核对额度'} · ${o.intent.quantity==='max'?'打满可核验额度':o.intent.quantity+' 份'} · ${o.plan?.mintFunding?.full?'按余额打满；本次 '+(o.plan.quantity||0)+' 份':'预算 '+o.intent.maxBnb+' BNB / '+(o.intent.maxUsdt||'0')+' USDT'}${o.intent.maxQuote!==undefined?' / '+o.intent.maxQuote+' '+(o.plan?.quota?.currency||'指定付款币'):''}（Gas 另计）`,'helper'));
   if(o.intent.routeId)div.append(el('div','所选方法：'+o.intent.routeId.replace(/^auto:/,''),'mono'));
   if(o.error){div.append(el('p',needsRoute(o)?'请使用上方选择框，然后点击重新预览。':describeError(o.error)));if(o.error.providerMessage){const original=el('details');original.append(el('summary','币安原始返回'),el('p',safeErrorText(o.error.providerMessage)));div.append(original);}}
   if(o.plan&&o.intent.side!=='mint'){const p=o.plan;if(p.gang)div.append(el('p','Gang · '+(p.route==='gang-pool'?'外盘':({curve:'曲线内盘',fair:'Fair 按份认购',fly:'Fly 飞轮内盘'}[p.state?.mode]||'内盘'))+' · 计价 '+(p.quote?.quoteSymbol||'链上原币')+(p.quote?.conversion?' · 含兑换步骤':''),'helper'));div.append(el('p',`${o.intent.side==='sell'?'卖出当前持仓 '+o.intent.percent+'%':'买入'} · 支出 ${p.quote?.fromCoinAmount||p.amountIn+' 最小单位'} ${p.quote?.fromCoinSymbol||''}`,'review-trade-amount'),el('p',`预计到账 ${p.quote?.toCoinAmount||'见详情'} ${p.quote?.toCoinSymbol||o.intent.currency} · 滑点 ${(p.slippage?.bps??o.intent.slippageBps)/100}%${p.slippage?.mode==='auto'?'（'+(p.slippage.source==='verified-direct-fallback'?'直连保守值':'自动建议')+'，上限 '+p.slippage.capBps/100+'%）':''}`));}if(o.plan){div.append(el('p',`${o.plan.route==='corla:mint'?'首笔 1 份 · 本次最多 '+o.plan.fill.targetQuantity+' 份 · ':o.plan.fill?.probe?'免费试算 '+o.plan.quantity+' 份 · 确认后逐批检查剩余额度 · ':o.plan.quantity?o.plan.quantity+' 份 · ':''}准备 ${((o.timing?.prepareMs||0)/1000).toFixed(2)} 秒`),el('div',o.plan.token,'mono'));for(const r of o.review||[])div.append(el('p',r));const details=el('details');details.append(el('summary','查看金额、模拟资产变化与风险详情'),el('pre',JSON.stringify({route:o.plan.route,inputToken:o.plan.inputToken,amountRaw:o.plan.amountIn,minimumOutputRaw:o.plan.minOutput,quota:o.plan.quota,referral:o.plan.referral,fill:o.plan.fill,quote:o.plan.quote,preview:o.preview},null,2)));div.append(details);}
   if(o.diagnostics){const details=el('details'),experience=o.plan?.experience||o.mintContext?.experience,labels={corlaDiscovery:'Corla 工厂直查',corlaMintPlan:'Corla 价格与额度预检',projectDiscovery:'网站与合约识别',codeIdentity:'合约版本检查',verifiedSource:'源码读取',walletReady:'钱包连接检查',mintPlan:'铸造参数与额度',officialPreview:'官方钱包模拟',chainLearning:'链上成功记录回查'};details.append(el('summary','预检耗时与历史经验'));for(const [key,label]of Object.entries(labels)){const stage=o.diagnostics.stages?.[key];if(stage)details.append(el('p',`${label}：${(stage.totalMs/1000).toFixed(2)} 秒${stage.calls>1?'（'+stage.calls+' 次）':''}`));}details.append(el('p',`本次预检合计 ${(o.diagnostics.totalMs/1000).toFixed(2)} 秒；部分阶段并行或嵌套，未包含真实成交时间。`,'helper'));if(experience)details.append(el('p',`匹配当前合约版本的历史记录：${experience.exactMatches} 条。${experience.recommendedRouteId?'已参考历史入口，价格和额度重新核验。':'本次按当前链上信息核验。'}`));details.append(el('p','历史预览通过与真实成交分开记录。','helper'));div.append(details);}
   return div;
}
function showReviews(rows){
 reviewOrders=rows;$('reviewBody').replaceChildren();
 const groups=new Map();for(const o of rows){const key=o.intent.asset;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(o);}
 for(const [asset,items]of groups){
  const context=items[0].project||items[0].plan?.project||items[0].plan?.resolved;
  const head=el('div',undefined,'review-project');head.append(el('h3',projectLabel(items[0])));$('reviewBody').append(head);
  if(items.some(o=>o.error?.code==='MINT_QUOTA_UNKNOWN')){const adjust=el('button','改用付费份数','secondary');adjust.addEventListener('click',()=>{$('review').close();mintQuantity.usePaidCount();$('quantity').scrollIntoView({block:'center'});note('请在铸造份数填写数量，再预览；预算上限仍单独保留。');});$('reviewBody').append(adjust);}
  const needing=items.filter(needsRoute);if(needing.length){
   const box=el('div',undefined,'route-picker'),select=el('select'),label=el('label','铸造方式（'+needing.map(o=>o.intent.account+' 号').join('、')+'）');
   const options=needing[0].error.details.routes.filter(r=>needing.every(o=>o.error.details.routes.some(x=>x.id===r.id)));
   fillRouteSelect(select,options);label.append(select);box.append(label,el('p','选择只改变调用方式，保留原钱包、免费/付费范围、份数和预算。免费入口名称不代表资格或零费用已通过验证。','helper'));
   const retry=el('button','按所选方式重新预览','primary');retry.disabled=true;select.addEventListener('change',()=>{retry.disabled=!select.value;});
   retry.addEventListener('click',async()=>{retry.disabled=true;select.disabled=true;$('confirm').disabled=true;setBusy(true);const choice=select.value;note('正在按所选方式重新预览，不会提交…');try{
    const replacements=new Map();for(const o of needing){const next=await api('select-mint-route',{id:o.id,routeId:choice});next.project??=o.project;replacements.set(o.id,next);}
    if($('asset').value.trim()===asset&&[...$('mintRoute').options].some(x=>x.value===choice)){$('mintRoute').value=choice;renderWallets();}
    showReviews(rows.map(o=>replacements.get(o.id)||o));await refreshOrders();
   }catch(e){note(e.message,true);box.append(el('p',e.message,'error'));select.disabled=false;retry.disabled=!select.value;}finally{setBusy(false);}});
   box.append(retry);if(!options.length)box.append(el('p','这些钱包没有共同入口，请按钱包分别预览。'));$('reviewBody').append(box);
  }
  const details=el('details',undefined,'review-all-details');details.append(el('summary','查看详情'));
  details.append(el('p',asset,'mono'));if(context?.address)details.append(el('p','项目合约：'+context.address,'mono'));
  for(const group of compactReviewGroups(items)){
   const first=group.rows[0],summary=group.summary,accounts=group.rows.map(o=>o.intent.account).join('、');
   if(summary){
    const card=el('section',undefined,'review-compact');card.append(el('h3',summary.walletCount+' 个钱包'+(items.length!==group.rows.length?'（'+accounts+' 号）':'')));
    const metrics=el('div',undefined,'review-compact-metrics');
    for(const [label,value]of [['每钱包份数',summary.perWalletQuantity+' 份'],['每钱包认购',summary.perWalletAmount+' '+summary.symbol]]){const metric=el('div');metric.append(el('span',label),el('strong',value));metrics.append(metric);}card.append(metrics);
    if(summary.budgetCap!==undefined)card.append(el('p','每钱包费用上限 '+summary.budgetCap+' '+summary.symbol+'；按最新报价支付，Gas 另计。','helper'));
    card.append(el('div',(summary.maximum?'合计最多 ':'合计 ')+summary.totalQuantity+' 份 · '+summary.totalAmount+' '+summary.symbol,'review-compact-total'));
    const follow=first.plan.afterMint,terms=['Gas 另计'];if(summary.approval)terms.push('先授权，再认购');if(follow){terms.push('开盘领取 100%');if(follow.sell)terms.push('到账后卖出当前持仓 '+follow.sell.percent+'% · 滑点 '+follow.sell.slippageBps/100+'%');}
    card.append(el('p',terms.join(' · '),'helper'));$('reviewBody').append(card);
    for(const o of group.rows)details.append(renderReviewDetail(o));
   }else if(group.error){const div=el('div',undefined,'review-compact-error');div.append(el('b',group.rows.length+' 个钱包（'+accounts+' 号）· '+statusLabel(first)),el('p',describeError(first.error)));$('reviewBody').append(div);for(const o of group.rows)details.append(renderReviewDetail(o));}
   else for(const o of group.rows)$('reviewBody').append(renderReviewDetail(o));
  }
  if(details.children.length>2)$('reviewBody').append(details);

 }
 const state=reviewSummary(rows),historic=boot.mode==='LIVE'&&rows.some(o=>o.simulationOnly&&['PREPARED','READY_TO_CONTINUE'].includes(o.status));$('confirm').textContent=historic?'旧模拟记录 · 请重新发起预览':state.waiting?'请先选择方式并重新预览':state.completed===rows.length?'已完成 · 无需再次提交':!state.ready?(state.skipped===rows.length?'无持仓 · 无需提交':rows.some(o=>o.feeReview?.blocked)?'费用无法核验 · 禁止提交':'无待执行操作 · 请查看状态'):boot.mode==='SIMULATION'?'完成模拟 · 不提交':rows.some(o=>o.feeReview?.required)?'确认承担上述费用并执行':'确认执行';$('confirm').disabled=historic||!state.canConfirm;if(!$('review').open)$('review').showModal();note(historic?'这是切换实盘前的模拟记录。请从操作面板重新预览本次真实操作。':state.message,historic||!state.canConfirm);
}
async function executeReviews(ack,{instant=false}={}){
 const snapshot=[...reviewOrders],pending=snapshot.filter(isReady),independent=pending.every(independentOrder);
 if(snapshot.some(needsRoute))return;
 if(busy||$('confirm').disabled)return;
 $('confirm').disabled=true;setBusy(true);note('正在提交本次操作；请勿重复点击…');
 const submit=(o,ack)=>api('execute',{id:o.id,fastReturn:true,acknowledgeReview:ack,...(!instant&&o.feeReview?.required?{feeAcknowledgement:o.feeReview.id}:{}),authorization:`用户在本地看板${instant?'开启免二次确认后点击':'点击并确认'}：${JSON.stringify(o.intent)}`});
 try{
  if(independent){reviewOrders=await executeIndependent(snapshot,submit,{ack:ack||boot.mode==='SIMULATION',onResult:r=>{trackSubmitted([r]);note(`${r.intent.account} 号：${statusLabel(r)}；其余钱包独立处理…`);refreshOrders().catch(()=>{});}});}
  else{
   const results=new Map();for(const o of pending.sort((a,b)=>a.intent.account-b.intent.account)){const r=await submit(o,ack);results.set(o.id,r);if(boot.mode==='LIVE'&&r.status!=='CONFIRMED')break;}reviewOrders=snapshot.map(o=>results.get(o.id)||o);
  }
  if(!instant&&reviewOrders.some(o=>o.needsFeeReview||o.feeReview?.blocked))showReviews(reviewOrders);
  else{$('review').close();showTradeFeedback(independent?reviewOrders:[]);note(tradeResultMessage(independent?feedbackRows:reviewOrders),reviewOrders.some(o=>['BLOCKED','FAILED','REJECTED','SUBMISSION_UNKNOWN'].includes(o.status)));}
  void Promise.allSettled([refreshOrders(),refreshAsset(true)]);
 }catch(e){note(e.message,true);}finally{setBusy(false);$('confirm').disabled=!reviewOrders.some(isReady);}
}
const trackedSubmitted=new Set(),tradeUpdates=new Map();let feedbackRows=[];
function trackSubmitted(rows){for(const o of rows){if(o.status!=='PENDING'||!o.orderId&&!o.txHash&&!o.steps?.at(-1)?.txHash||trackedSubmitted.has(o.id))continue;trackedSubmitted.add(o.id);void followSubmittedOrder(o,id=>api('follow',{id}),{onUpdate:current=>{tradeUpdates.set(current.id,mergeTradeUpdate(tradeUpdates.get(current.id)||current,current));if(tradeUpdates.size>100)tradeUpdates.delete(tradeUpdates.keys().next().value);if(feedbackRows.some(r=>r.id===current.id))showTradeFeedback(feedbackRows);void refreshOrders().catch(()=>{});if(['CONFIRMED','CONFIRMED_REVIEW'].includes(current.status)&&!busy)void refreshAsset(true).catch(()=>{});}}).finally(()=>trackedSubmitted.delete(o.id));}}
let ordersRefresh=null,ordersDirty=false;
function refreshOrders(){ordersDirty=true;if(ordersRefresh)return ordersRefresh;ordersRefresh=(async()=>{do{ordersDirty=false;await renderOrders();}while(ordersDirty);})().finally(()=>{ordersRefresh=null;});return ordersRefresh;}
async function viewOrder(id,{follow=false}={}){
 noticeTarget='appNotice';try{const o=await api(follow?'follow':'order?id='+encodeURIComponent(id),follow?{id}:undefined);reviewOrders=[o];showReviews([o]);await refreshOrders();}catch(e){note(e.message,true);}
}
function showTradeFeedback(rows){
 rows=rows.map(o=>mergeTradeUpdate(o,tradeUpdates.get(o.id)));feedbackRows=rows;
 const box=$('tradeFeedback');box.replaceChildren();const reasons=[...new Set(rows.flatMap(o=>[o.error?describeError(o.error):null,...(o.needsFeeReview?o.feeReview?.reasons||[]:[])]).filter(Boolean))];
 for(const o of rows){const r=el('div',undefined,'feedback-row');r.dataset.status=o.status;const text=el('span');text.append(el('b',`${o.intent.account} 号 · ${statusLabel(o)}`));if(o.error)text.append(el('small',describeError(o.error),'error'));r.append(text);
  const id=o.error?.details?.orderId||o.id,btn=el('button',o.error?.code==='ORDER_UNRESOLVED'?'核对原单':'详情','text-button');btn.addEventListener('click',()=>viewOrder(id,{follow:o.error?.code==='ORDER_UNRESOLVED'}));r.append(btn);box.append(r);
  if(o.feeRouteSearch)text.append(el('small',o.feeRouteSearch.status==='selected'?'已自动切换低费路线':'已自动寻找低费路线，本轮未找到符合条件的替代路线'));
 }
 for(const reason of reasons){const p=el('p',reason,'helper');box.append(p);}
}
async function retryOrder(id){
 if(busy)return;noticeTarget='tradeNotice';setBusy(true);
 try{const old=await api('order?id='+encodeURIComponent(id));if(!canRetryTrade(old))throw Error(['FAILED','REJECTED','BLOCKED'].includes(old.status)?describeError(old.error):'原单尚未明确结束，请先核对原单');
  const intent=old.intent,newId='manual-'+crypto.randomUUID()+'-account'+intent.account,quick=boot.mode==='LIVE'&&$('quick').checked;
  const o=quick?await api('run',{id:newId,intent,execute:true,fastReturn:true,acknowledgeReview:true,authorization:'用户点击重新发起，免二次确认已开启：'+JSON.stringify(intent)}):await api('prepare',{id:newId,intent});
  reviewOrders=[o];trackSubmitted([o]);if(quick){showTradeFeedback([o]);note(tradeResultMessage(feedbackRows),o.needsFeeReview||['BLOCKED','FAILED','REJECTED'].includes(o.status));}else showReviews([o]);
  await refreshOrders();
 }catch(e){note(e.message,true);}finally{setBusy(false);}
}
async function renderOrders(){
 const rows=await api('orders?summary=1');$('orders').replaceChildren();
 // Server-side reconciliation also handles unknown submissions. Keep the quick
 // feedback in sync even when no identified PENDING order was polled by the UI.
 const previousMessage=tradeResultMessage(feedbackRows);
 for(const row of rows){tradeUpdates.set(row.id,mergeTradeUpdate(tradeUpdates.get(row.id)||row,row));}
 while(tradeUpdates.size>100)tradeUpdates.delete(tradeUpdates.keys().next().value);
 if(feedbackRows.length){
  showTradeFeedback(feedbackRows);
  const box=$('tradeNotice');
  // Do not overwrite a later clipboard/holdings/user-action message.
  if(box.textContent===previousMessage){box.textContent=tradeResultMessage(feedbackRows);}
 }

 const pendingRows=rows.filter(o=>['PENDING','SUBMITTING','SUBMISSION_UNKNOWN','RECEIPT_REVIEW'].includes(o.status)),continuations=rows.filter(o=>['READY_TO_CONTINUE','APPROVAL_CONFIRMED'].includes(o.status));$('recoveryBar').hidden=!pendingRows.length&&!continuations.length;$('recoveryTitle').textContent=[pendingRows.length?`${pendingRows.length} 笔原单${boot?.capabilities?.originalTrackingVersion?'由后台自动核对':'待核对'}`:'',continuations.length?`${continuations.length} 笔后续步骤待处理`:''].filter(Boolean).join(' · ');
 if(!rows.length){const empty=el('div',undefined,'empty');empty.append(el('span','⌁'),el('b','交易从这里开始'),el('p','输入项目网址或代币 CA，操作记录将在这里显示。'));$('orders').append(empty);return;}
 for(const o of rows){const row=el('div',undefined,'order'),a=el('div'),b=el('div'),c=el('div'),actions=el('div',undefined,'order-actions');row.dataset.status=o.status;
  const name=projectLabel(o),short=/^0x[0-9a-f]{40}$/i.test(name)?name.slice(0,8)+'…'+name.slice(-6):name;
  a.append(el('b',`${o.intent.account} 号 · ${o.intent.side==='buy'?'买入':o.intent.side==='sell'?'卖出':'Mint'}`),el('small',short),el('small',new Date(o.createdAt).toLocaleTimeString()));a.title=o.intent.asset;
  b.append(el('span',statusLabel(o),'order-state'),el('small',o.intent.side==='buy'?`${o.intent.amount} ${o.intent.currency}`:o.intent.side==='sell'?`当前持仓 ${o.intent.percent}%`:o.intent.quantity==='max'?'打满可核验额度':`${o.intent.quantity||'—'} 份`));
  c.append(el('div',totalTimeLabel(o),'order-time'));if(o.error)c.append(el('small',needsRoute(o)?'请选择铸造方式后重新预览':describeError(o.error),o.status==='SKIPPED'?'muted':'error'));const progress=trackingLabel(o);if(progress)c.append(el('small',progress));if(o.followError)c.append(el('small',describeError(o.followError),'error'));
  if(o.txHash){const link=el('a','链上回执 ↗');link.href='https://bscscan.com/tx/'+o.txHash;link.target='_blank';link.rel='noopener';c.append(link);}
  const pending=['PENDING','SUBMITTING','SUBMISSION_UNKNOWN','RECEIPT_REVIEW'].includes(o.status),btn=el('button',pending?'核对原单':needsRoute(o)?'选择方式':isReady(o)?'查看预览':'详情','text-button');btn.addEventListener('click',()=>viewOrder(o.id,{follow:pending}));actions.append(btn);
  if(canRetryTrade(o)){const retry=el('button','重新发起','secondary');retry.addEventListener('click',()=>retryOrder(o.id));actions.append(retry);}
  if(boot?.capabilities?.originalTrackingVersion&&['READY_TO_CONTINUE','APPROVAL_CONFIRMED'].includes(o.status)){const stop=el('button','结束剩余步骤','secondary');stop.addEventListener('click',async()=>{stop.disabled=true;try{await api('stop-remaining',{id:o.id});note('剩余步骤已结束，已成功的交易保留，钱包可继续操作。');await refreshOrders();}catch(e){note(e.message,true);stop.disabled=false;}});actions.append(stop);}
  row.append(a,b,c,actions);$('orders').append(row);
 }
}
$('reconcileOrders').addEventListener('click',async()=>{noticeTarget='appNotice';const b=$('reconcileOrders');b.disabled=true;b.textContent='正在核对…';try{const rows=await api('reconcile',{});const remaining=rows.filter(r=>!r.ready);note(remaining.length?`${remaining.map(r=>r.account).join('、')} 号仍有原单需要核对，请查看详情；其他钱包可正常操作。`:'原单已核对，钱包可继续操作。没有重新下单。',!!remaining.length);await refreshOrders();}catch(e){note(e.message,true);}finally{b.disabled=false;b.textContent='核对并恢复';}});
$('inspect').addEventListener('click',inspect);$('asset').addEventListener('keydown',e=>{if(e.key==='Enter')inspect();});$('currency').addEventListener('change',buildButtons);$('mint').addEventListener('click',()=>act('mint'));$('closeReview').addEventListener('click',()=>$('review').close());$('confirm').addEventListener('click',()=>executeReviews(true));$('refreshOrders').addEventListener('click',()=>refreshOrders().catch(e=>note(e.message,true)));
$('ready').addEventListener('click',async()=>{noticeTarget='appNotice';$('ready').disabled=true;$('ready').textContent='刷新中…';try{const [r]=await Promise.all([refreshWallets(true),refreshAsset(true)]);note(r.wallets.some(w=>w.connectionError||w.balanceError)?'刷新完成；未读到的连接或余额信息已分别标出。':'钱包连接、BNB 余额和当前代币持仓已刷新。');}catch(e){note('刷新失败：'+e.message,true);}finally{$('ready').disabled=false;$('ready').textContent='刷新 ↻';}});
$('edit').addEventListener('click',()=>{$('buttonEditor').hidden=!$('buttonEditor').hidden;for(const side of ['buy','sell']){const box=$(side+'Inputs');box.replaceChildren();settings[side].forEach((v,n)=>{const i=el('input');i.value=v;i.setAttribute('aria-label',(side==='buy'?'买入金额':'卖出百分比')+(n+1));box.append(i);});}});
$('saveButtons').addEventListener('click',async()=>{try{settings=await api('settings',{buy:[...$('buyInputs').children].map(e=>e.value),sell:[...$('sellInputs').children].map(e=>e.value)});buildButtons();$('buttonEditor').hidden=true;note('自定义按钮已保存到本机。');}catch(e){note(e.message,true);}});
let openingCheck=null,openingBusy=false,openingPoll=null,openingArmUnknown=false;const expandedOpening=new Set();
const openingLabels={ARMED:'监测中',FIRING:'开盘检查中',TRACKING:'跟踪原单',COMPLETED:'任务结束',PAUSED:'已暂停',CANCELLED:'已停止',EXPIRED:'已到期',WAITING:'等待开盘 / 可卖出',PREPARING:'准备卖出',CONFIRMED:'已确认卖出',SIMULATED:'模拟通过，未提交',SKIPPED:'无持仓，跳过',BLOCKED:'已停止，需检查',REVIEW:'需核对原单'};
function openingGasInput(){const value=$('openingGasLimit').value.trim();if(!value)return {};if(!boot?.capabilities?.sellGasVersion)throw Error('后端需要更新后才能使用自定义卖出 Gas 上限');if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<21000||Number(value)>15000000)throw Error('卖出 Gas 上限须为 21000–15000000 的整数');return {gasLimit:Number(value)};}
function openingInput(){const slip=$('openingSlippage').value;if(!/^\d+(?:\.\d{1,2})?$/.test(slip)||Number(slip)>50)throw Error('开盘滑点范围 0–50%，最多两位小数');return {asset:checkedTradeCA(),accounts:[...selected].sort((a,b)=>a-b),percent:$('openingPercent').value,slippageBps:Math.round(Number(slip)*100),currency:$('receive').value,...openingGasInput()};}
function openingPreflight(p){if(!p?.rows?.length)return '';return '预检 '+new Date(p.at).toLocaleTimeString()+' · '+p.rows.map(r=>{const ok=r.routes.filter(x=>x.ready),approved=ok.filter(x=>x.approvalNeeded===false);return r.account+' 号 '+ok.length+'/'+r.routes.length+' 条路线已核验，'+(approved.length?approved.length+' 条无需首次授权':'需首次授权')+(Number(r.bnb)===0?'，无 BNB 支付 Gas':'');}).join('；');}
function openingNote(text){$('openingNotice').textContent=text;}
$('openingEnabled').addEventListener('change',()=>{$('openingControls').hidden=!$('openingEnabled').checked;if(!$('openingEnabled').checked)$('claimSell').checked=false;renderClaimLink();});
const shownFeeReviews=new Set();let feeDialogLoading=false;
async function showPendingFeeReviews(ids){
 if($('quick').checked||busy||feeDialogLoading||document.querySelector('dialog[open]'))return;
 const pending=[...new Set(ids)].filter(id=>!shownFeeReviews.has(id));if(!pending.length)return;feeDialogLoading=true;
 try{const rows=(await Promise.all(pending.map(id=>api('order?id='+encodeURIComponent(id)).catch(()=>null)))).filter(o=>o?.feeReview?.blocked||o?.needsFeeReview&&isReady(o));if($('quick').checked||busy||document.querySelector('dialog[open]'))return;for(const o of rows)shownFeeReviews.add(o.id);if(rows.length)showReviews(rows);}finally{feeDialogLoading=false;}
}
function refreshCorlaJobs(){return taskCenter.refresh();}
async function refreshOpening(){return (await taskCenter.refresh()).opening;}
async function armOpening(){if(!openingCheck||openingBusy)return;openingBusy=true;$('confirmOpening').disabled=true;$('startOpening').disabled=true;
 try{const j=await api('opening/arm',{id:openingCheck.id,confirmed:true});openingArmUnknown=false;openingNote(j.message);$('openingReview').close();openingCheck=null;await refreshOpening();}
 catch(e){try{const rows=await refreshOpening(),existing=rows.find(j=>j.id===openingCheck.id);if(existing){openingCheck=null;openingArmUnknown=false;$('openingReview').close();openingNote(existing.message);return;}if(e.serverRejected||e.details?.requestAccepted===false){openingCheck=null;openingArmUnknown=false;}else openingArmUnknown=true;}catch{openingArmUnknown=true;}openingNote('启动未完成：'+e.message+(openingArmUnknown?'。再次点击只核对/重试同一任务，不会新建。':''));}
 finally{openingBusy=false;$('confirmOpening').disabled=false;$('startOpening').disabled=false;}}
$('startOpening').addEventListener('click',async()=>{if(openingBusy||!boot)return;if(openingArmUnknown)return armOpening();openingBusy=true;$('startOpening').disabled=true;openingNote('正在检查池子、钱包连接和持仓…');
 try{const config=openingInput();const c=await api('opening/check',config);if(JSON.stringify(config)!==JSON.stringify(openingInput()))throw Error('输入或钱包选择已改变，请重新检查');openingCheck=c;
  if($('quick').checked){openingBusy=false;return await armOpening();}
  const b=$('openingReviewBody');b.replaceChildren(el('p',c.config.asset,'mono'),el('p',`${c.config.accounts.join('、')} 号钱包 · 卖出实时持仓 ${c.config.percent}% · 滑点 ${c.config.slippageBps/100}% · 到账 ${c.config.currency==='AUTO'?'池子原币种':c.config.currency}`),el('p',c.snapshot.open?'已经检测到流动性，确认后立即检查并卖出。':'检测到当前后端支持的有效流动性后，自动检查并卖出一次。'),el('p',c.mode==='SIMULATION'?'本次仅模拟，不签名、不提交。':'必要时执行本次数量授权；新增风险或模拟失败不会强行提交。'));if(c.config.gasLimit!==undefined)b.append(el('p','卖出 Gas 上限：'+c.config.gasLimit+'（按实际消耗计费）'));if(c.preflight)b.append(el('p',openingPreflight(c.preflight),'muted'));$('openingReview').showModal();
 }catch(e){openingNote(e.message);}finally{openingBusy=false;$('startOpening').disabled=false;}});
$('confirmOpening').addEventListener('click',armOpening);$('closeOpeningReview').addEventListener('click',()=>$('openingReview').close());
setInterval(()=>{if(boot&&!document.hidden){refreshOpening().catch(()=>{});refreshCorlaJobs().catch(()=>{});}},1000);
let starting=null,resuming=null,lastResumeAt=0;
function startApp(){
 if(boot)return Promise.resolve();if(starting)return starting;
 starting=(async()=>{boot=await client.refreshSession();settings=boot.settings;$('openingGasSettings').hidden=!boot.capabilities?.sellGasVersion;selected=new Set(boot.wallets.map(w=>w.account));loadTradePreferences();renderMode();note(boot.mode==='LIVE'?($('quick').checked?'免二次确认已开启；高费卖出需核对，池费未知则拦截。':'真实交易 · 二次确认已开启，点击按钮后弹窗核对。'):'模拟模式下所有按钮只检查和预览，不签名、不广播。');buildButtons();renderWallets();await Promise.all([refreshCorlaJobs(),refreshOpening(),refreshOrders(),refreshWallets().catch(e=>{$('walletState').textContent='BNB 读取失败：'+e.message;})]);})();
 starting.finally(()=>{starting=null;}).catch(()=>{});return starting;
}
function resumePage(){
 if(document.hidden||busy||resuming||Date.now()-lastResumeAt<1000)return;lastResumeAt=Date.now();
 resuming=(async()=>{if(!boot)return startApp();await client.refreshSession();await Promise.all([refreshOrders(),refreshWallets(),refreshAsset(true)]);})();
 resuming.catch(e=>{$('walletState').textContent='恢复连接失败：'+e.message;}).finally(()=>{resuming=null;});
}
document.addEventListener('visibilitychange',resumePage);for(const event of ['focus','pageshow','online'])window.addEventListener(event,resumePage);
setInterval(()=>{if(document.hidden||busy)return;if(!boot){startApp().catch(e=>note('连接本地服务失败：'+e.message,true));return;}refreshAsset().catch(e=>note('数据更新失败：'+e.message,true));},5000);
setInterval(()=>{if(boot&&!document.hidden)refreshOrders().catch(()=>{});},5000);
setInterval(()=>{if(boot&&!busy&&!document.hidden)refreshWallets().catch(e=>{$('walletState').textContent='BNB 更新失败：'+e.message;});},15000);
setInterval(warmSell,4000);
try{await startApp();}catch(e){note('连接本地服务失败：'+e.message,true);}
