const validCA=s=>/^0x[\da-f]{40}$/i.test(s)&&!/^0x0{40}$/i.test(s);
const same=(a,b)=>a?.toLowerCase()===b?.toLowerCase();
const groupKey=ns=>[...ns].sort((a,b)=>a-b).join(',');
function units(raw,decimals){
 if(!Number.isInteger(decimals)||decimals<0||decimals>36)return raw+' 最小单位';
 if(!decimals)return raw;
 const s=raw.padStart(decimals+1,'0'),fraction=s.slice(-decimals).replace(/0+$/,'');
 return s.slice(0,-decimals)+(fraction?'.'+fraction:'');
}
const labels={APPROVAL_REVIEW:'待核对授权',REGISTRATION_REVIEW:'待核对登记',AUTHORIZED:'授权成功',AUTHORIZING:'正在授权',WAIT_AUTH:'等候授权',APPROVAL_PENDING:'授权原单待核对',REGISTERING:'正在登记钱包计划',REGISTRATION_PENDING:'计划原单待核对',READY:'已就绪',ARMED:'监测中',WAIT_CLAIM:'等待领取到账',WAIT_TAX:'等待税率回落',FAILED:'失败',PENDING:'卖出原单待核对',SOLD:'已卖出',REVIEW:'需要核对',RETRY:'待重试',EXPIRED:'已过期',PAUSED:'已暂停',COMPLETED:'已结束',SKIPPED:'已跳过'};
const belowMinimum=r=>r.status==='REVIEW'&&(r.reason==='MINIMUM_NOT_MET'||r.message==='报价低于钱包最低到账');
export function createFastSalePanel({api,getSelection,document:doc=document}){
 const $=id=>doc.getElementById(id);
 const say=text=>{$('fastMessage').textContent=text;};
 const node=(tag,text,cls)=>{const el=doc.createElement(tag);el.textContent=text;if(cls)el.className=cls;return el;};
 let state={},busy=false,hydrated=false,epoch=0,holdings=null,key='',requestId=null,requestKey='',timer,tick=0;
 const asset=()=>$('fastAsset').value.trim();
 const unchecked=new Set(),controlling=new Set();
 let venue=null,venueError='',lookupTimer,loading=null,loadedCA='',minimumDirty=false;
 let fillRead=null,fillTimer;
 const accounts=()=>getSelection().accounts.filter(n=>!unchecked.has(n));
 const selectionKey=()=>asset().toLowerCase()+'/'+groupKey(accounts());
 const triggerAddress=()=>$('fastTrigger').value.trim();
 function config(){
  const percent=$('fastPercent').value.trim();
  if(!/^([1-9]\d?|100)$/.test(percent))throw Error('卖出比例请填写 1–100 的整数');
  if(!venue||!same(venue.token,asset()))throw Error(venueError||'请先加载代币并核验主池计价币');
  const minAmount=$('fastMinimum').value.trim();
  if(!/^\d+(?:\.\d+)?$/.test(minAmount)||!/[1-9]/.test(minAmount)||(minAmount.split('.')[1]?.length||0)>venue.quoteDecimals)throw Error('最低到账须大于零，'+venue.quoteSymbol+' 最多支持 '+venue.quoteDecimals+' 位小数');
  return {trigger:triggerAddress(),source:$('fastSource').value,percent,expiryHours:Number($('fastExpiry').value),minAmount,quote:venue.quote,quoteDecimals:venue.quoteDecimals};
 }
 function jobFor(){
  const ns=accounts();if(!ns.length)return;
  const jobs=[...(state.jobs||[])].reverse().filter(j=>same(j.asset,asset()));
  return jobs.find(j=>groupKey(j.selectedAccounts||j.rows.map(r=>r.account))===groupKey(ns))||
   jobs.find(j=>['AUTHORIZED','AUTHORIZING'].includes(j.status)&&ns.every(n=>j.rows.some(r=>r.account===n)));
 }
 function renderRows(wrap,rows,job){
  const list=node('div','','fast-wallet-list');
  for(const r of rows){
   const original=r.status==='APPROVAL_PENDING'?r.approval:r.status==='REGISTRATION_PENDING'?r.registration:null;
   let pending='';
   if(original?.hash)pending='已广播，等待链上确认';
   else if(original?.status==='PENDING_CONFIRMATION')pending='等待币安 App 确认';
   else if(original?.orderId)pending=original.appConfirmation===true?'币安预览要求 App 确认，原单已受理':'币安已受理，等待交易哈希。可在 App 查看原单';
   else if(original)pending='正在核对提交结果';
   const text=r.account+' 号 · '+(pending||(belowMinimum(r)?'未成交':labels[r.status]||'准备中'));
   const f=r.status==='SOLD'&&r.fill;
   const quote=f?.nativePaid?'BNB':job.venue?.quoteSymbol==='BNB'?'WBNB':job.venue?.quoteSymbol||'计价币';
   const info=f?units(f.amount,job.venue?.tokenDecimals)+' 枚 · 到账 '+units(f.output,job.venue?.quoteDecimals)+' '+quote:belowMinimum(r)&&r.plan?.minOut?'低于本钱包最低到账 '+units(String(r.plan.minOut),job.venue?.quoteDecimals)+' '+(job.venue?.quoteSymbol||'计价币'):pending?'':r.message;
   const row=node('div',text+(info?' · '+info:''),'fast-result');
   if(/^0x[\da-f]{64}$/i.test(r.receipt||'')){
    const link=node('a','链上回执 ↗');link.href='https://bscscan.com/tx/'+r.receipt;link.target='_blank';link.rel='noopener noreferrer';row.append(link);
   }
   if(r.ratingReview&&['APPROVAL_REVIEW','REGISTRATION_REVIEW'].includes(r.status)){
    const preview=node('details','');preview.append(node('summary','钱包预览详情'));
    if(typeof r.ratingReview.appConfirmation==='boolean')row.append(node('span',r.ratingReview.appConfirmation?' 本笔需要币安 App 确认。':' 币安预览允许直接提交。'));
    const amount=units(String(r.cap),job.venue.tokenDecimals);
    if(r.ratingReview.field==='approval')row.append(node('span',' 本次授权 '+amount+' 枚。'));
    preview.append(node('p','持币钱包 '+r.address+' · 代币 '+job.asset),node('p','执行合约 '+job.executor+' · 授权额度 '+amount+' 枚'));
    if(r.ratingReview.field==='registration')preview.append(node('p','登记卖出 '+job.settings.percent+'% · 触发地址 '+job.settings.trigger+' · 最低到账 '+units(String(job.settings.minOut),job.venue.quoteDecimals)+' '+job.venue.quoteSymbol+' · 有效期 '+job.settings.expiryHours+' 小时'));
    preview.append(node('p','币安地址评级 '+r.ratingReview.ratings.map(([a,n])=>a+'（'+n+'）').join('、')+'。风险明细为空。'));row.append(preview);
   }
   list.append(row);
  }
  wrap.append(list);return list;
 }
 function buttons(){
  const job=jobFor(),live=state.mode==='LIVE'&&state.enabled;
  $('fastAuthorize').disabled=busy||!live||!venue||!!venue.blockedReason||!same(holdings?.token,asset())||!accounts().length||!!job&&['AUTHORIZING','REGISTERING','ARMED','PAUSED'].includes(job.status);
  const target=triggerAddress(),usable=validCA(target)&&same(target,state.trigger||state.managedAddress);
  const ready=validCA(target)&&same(target,state.trigger);
  const keyActions=live&&state.privateKeyActions;
  $('fastGenerate').disabled=busy||!keyActions;
  $('fastGenerate').textContent=state.generatedAddress?'使用脚本钱包':'生成触发钱包';
  $('fastImportKey').disabled=busy||!keyActions;
  $('fastSetup').hidden=!!keyActions&&(!target||ready);
  $('fastSetup').disabled=busy||!live||!state.managedSupported||!!target&&!validCA(target)||ready;
  $('fastSetup').textContent=ready?'触发端已就绪':'一键设置触发端';
  const stored=(state.managedAddresses||[state.managedAddress]).some(a=>same(a,target));
  $('fastExportKey').hidden=!keyActions||!validCA(target)||!stored;
  $('fastExportKey').disabled=busy;
  $('fastBackup').hidden=!validCA(target)||!stored;
  $('fastCopyAddress').disabled=busy||!validCA(target)||!(ready||stored);
  $('fastBackup').disabled=busy||!live;
  $('fastUnlock').disabled=busy||!live||!validCA(target);
  $('fastTrigger').readOnly=busy;
  $('fastTriggerState').textContent=ready&&keyActions&&stored?'此地址已就绪。导出的通用 EVM 私钥可直接导入 OKX Wallet。':ready?'此地址已就绪。':target&&!validCA(target)?'请输入完整的 0x 钱包地址。':
   target&&stored?'此地址已在本机保存，点击即可启用。':
   target?'首次使用此地址，请点击「导入私钥」。':'选择生成触发钱包或导入自己的私钥，地址会自动填入。';
  const chosen=new Set(accounts()),n=job?.rows.filter(r=>chosen.has(r.account)&&r.status==='AUTHORIZED').length||0;
  $('fastStart').disabled=busy||!live||!(job?.status==='AUTHORIZED'||job?.status==='AUTHORIZING'&&!job.rows.some(r=>chosen.has(r.account)&&['WAIT_AUTH','APPROVAL_REVIEW'].includes(r.status)))||!n||!usable;
  $('fastStart').textContent=n?'开始任务 · '+n+' 个已授权钱包':'开始任务';
  let validation='';
  try{config();}catch(e){validation=e.message;}
  $('fastStart').disabled||=!!validation||!!venue?.blockedReason;
  $('fastSave').disabled=busy||!live||!!validation||!validCA(target);
  $('fastUnit').textContent=venue?.quoteSymbol||'计价币';
  let hint=validation||'每个钱包单独核对最低到账，单位为 '+venue.quoteSymbol+'。';
  if(!state.taxAware&&/^[1-9]\d?$/.test($('fastPercent').value)&&Number($('fastPercent').value)%25!==0)hint+=' 自定义比例按开始任务时的持仓折算为固定数量；执行时最多卖到该数量或剩余持仓。';
  if(venue?.marketPending&&!venue.blockedReason)hint+=' 预定主池地址已核验。代币到账后可授权并点击「开始任务」提前登记，开盘后自动触发。';
  if(state.taxAware&&venue)hint+=' 按主池实收和钱包税后到账结算。转账税与池费合计达到 50% 时，该钱包等待税率回落。';
  if(venue?.transferMismatch)hint+=' 此主池已有转账实收不符的卖出回执，极速合约无法处理该次扣费，可在快捷交易预览。';
  if(venue?.tax)hint+=' 核验买入税 '+venue.tax.buyBps/100+'%，卖出税 '+venue.tax.sellBps/100+'%。';
  if(venue?.blockedReason)hint+=' '+venue.blockedReason;
  $('fastMinimumHint').textContent=hint;
  const results=$('fastResults'),scroll=results.querySelector('.fast-wallet-list')?.scrollTop||0;
  results.replaceChildren();if(job){results.append(node('h3','钱包处理结果'));const rows=job.rows.filter(r=>chosen.has(r.account));renderRows(results,rows,job).scrollTop=scroll;
   for(const [field,status,label] of [['approval','APPROVAL_REVIEW','授权'],['registration','REGISTRATION_REVIEW','登记']]){
    const reviews=rows.filter(r=>r.status===status&&r.ratingReview?.field===field).map(r=>({account:r.account,ticket:r.ratingReview.ticket}));
    if(!reviews.length||job.deletedAt||!['AUTHORIZING','REGISTERING','ARMED'].includes(job.status))continue;
    const button=node('button','确认 '+reviews.length+' 个钱包的'+label,'secondary');button.type='button';button.disabled=busy;
    button.onclick=()=>action(async()=>{
     const result=await api('fast-sale/confirm-ratings',{id:job.id,asset:job.asset,field,reviews});
     const renewed=result.rows.some(r=>r.status===status&&reviews.some(previous=>previous.account===r.account&&previous.ticket!==r.ratingReview?.ticket));
     say(renewed?'部分钱包的预览已到期或有变化，已更新金额和评级。请核对后再次确认。':'请查看逐钱包处理结果。');
    },true);
    results.append(button);
   }}
 }
 function renderHoldings(){
  const wrap=$('fastHoldings'),top=wrap.scrollTop;wrap.replaceChildren();if(!holdings||!same(holdings.token,asset()))return;
  const available=new Set(getSelection().accounts);
  for(const r of holdings.wallets.filter(r=>available.has(r.account))){
   const label=node('label',''),check=node('input','');check.type='checkbox';check.checked=!unchecked.has(r.account);
   check.addEventListener('change',()=>{if(check.checked)unchecked.delete(r.account);else unchecked.add(r.account);buttons();});
   label.append(check,node('span',r.account+' 号 · '+(r.error?'持仓读取失败 · '+r.error:'持仓 '+r.balance)));
   if(!r.error&&venue?.tax&&/^\d+$/.test(r.raw||'')&&/^(100|[1-9]\d?)$/.test($('fastPercent').value)){
    const amount=BigInt(r.raw)*BigInt($('fastPercent').value)/100n;
    const net=amount-amount*BigInt(venue.tax.sellBps)/10000n;
    label.append(node('span','计划卖 '+units(String(amount),venue.tokenDecimals)+' · 预计入池 '+units(String(net),venue.tokenDecimals)));
   }
   wrap.append(label);
  }
  wrap.scrollTop=top;
 }
 function syncSoldHoldings(){
  if(!holdings||!same(holdings.token,asset())||fillRead||fillTimer)return;
  const ca=asset(),stamp=epoch;
  const sold=(state.jobs||[]).filter(j=>same(j.asset,ca)).flatMap(j=>j.rows).filter(r=>r.status==='SOLD'&&r.fill?.block&&holdings.wallets.some(w=>w.account===r.account&&same(w.address,r.address)));
  const ready=r=>sold.every(s=>r.block>=s.fill.block&&r.wallets.some(w=>w.account===s.account&&same(w.address,s.address)&&!w.error&&w.balance!=null));
  if(!sold.length||ready(holdings))return;
  const current=()=>stamp===epoch&&same(ca,asset());
  say('成交已确认，正在刷新剩余持仓…');
  const query=api('holdings?ca='+encodeURIComponent(ca)).then(r=>{
   if(!current())return;
   if(!same(r.token,ca)||r.assetType!=='ERC20'||!ready(r))throw Error('节点尚未返回成交后的持仓');
   holdings=r;renderHoldings();buttons();say('已更新成交后的持仓 · 区块 '+r.block);
  }).catch(e=>{
   if(!current())return;
   say('成交已确认，持仓待更新：'+e.message);
   fillTimer=setTimeout(()=>{fillTimer=null;syncSoldHoldings();},3000);
  }).finally(()=>{if(fillRead===query){fillRead=null;if(!fillTimer)syncSoldHoldings();}});
  fillRead=query;
 }
 function selectionChanged(){const next=groupKey(getSelection().accounts);if(next!==key){key=next;renderHoldings();buttons();}}
 async function controlJob(j,command){
  if(controlling.has(j.id))return;
  if(command==='delete'&&!doc.defaultView.confirm('删除这个极速卖出任务并停止后续提交？已发送的交易仍会结算，链上授权与登记按原有效期生效。'))return;
  controlling.add(j.id);render(state);
  try{await api('fast-sale/control',{id:j.id,action:command});
   if(command==='delete'){requestKey='';requestId=null;}
   say(command==='delete'?'任务已删除。':command==='pause'?'任务已暂停。':'原任务已恢复。');
  }catch(e){say(e.message);}finally{controlling.delete(j.id);await refresh();}
 }
 let deployReview=null,deployBusy=false;
 function renderDeployment(d){
  const box=$('fastDeployBox');if(!box||!d)return;
  box.hidden=!d.available||['PERSONAL','EXISTING'].includes(d.state);
  if(box.hidden)return;
  const pick=$('fastDeployAccount'),button=$('fastDeploy');
  const accounts=getSelection().accounts,previous=pick.value;
  if([...pick.options].map(o=>o.value).join(',')!==accounts.join(',')){
   pick.replaceChildren(...accounts.map(n=>{const option=node('option',n+' 号钱包');option.value=String(n);return option;}));
   if(accounts.includes(Number(previous)))pick.value=previous;
  }
  const pending=['SUBMITTING','SUBMITTED'].includes(d.state);
  if(pending||d.upgradeAccount)pick.value=String(d.upgradeAccount||d.account);
  pick.disabled=pending||!!d.upgradeAccount||deployBusy;
  button.disabled=deployBusy||(!pending&&!pick.value);
  const review=deployReview?.account===Number(pick.value)&&deployReview?.executor===d.executor&&d.state==='PREVIEWED';
  button.textContent=pending?'核对原部署':review?'确认部署我的合约':d.upgradeAccount?'预览升级个人合约':'预览我的合约';
  $('fastDeployNotice').textContent=pending?'已提交，正在等待个人合约核验。':review?
   '预计 Gas '+d.fee+' BNB。个人执行合约 '+d.executor:
   d.state==='REVERTED'?'原部署已上链回滚，可重新预览。':d.upgradeAccount?'使用原付款钱包部署分红版。新地址启用后，所选代币须重新授权和登记。':'选择自己的付款钱包。部署一次，之后所有代币可复用。';
 }
 if($('fastDeploy')){
  $('fastDeployAccount').onchange=()=>{deployReview=null;renderDeployment(state.deployment);};
  $('fastDeploy').onclick=async()=>{
   if(deployBusy)return;
   const d=state.deployment;if(!d?.available)return;
   const account=Number($('fastDeployAccount').value);
   const pending=['SUBMITTING','SUBMITTED'].includes(d.state);
   const review=deployReview?.account===account&&deployReview?.executor===d.executor&&d.state==='PREVIEWED'?deployReview:null;
   const action=pending?'check':review?'execute':'preview';
   deployBusy=true;renderDeployment(d);
   try{
    const result=await api('fast-sale/deployment/'+action,{account,ticket:review?.ticket});
    deployReview=result.ticket?{ticket:result.ticket,account,executor:result.executor}:null;
    await refresh();
   }catch(e){deployReview=null;say(e.message);await refresh();}
   finally{deployBusy=false;renderDeployment(state.deployment);}
  };
 }
 function render(s){
  state=s;renderDeployment(s.deployment);const live=s.mode==='LIVE'&&s.enabled;
  $('fastMode').textContent=live?'BNB 主网':s.deployment?.available?'待部署':'模拟模式';
  $('fastExecutor').value=s.executor||'';
  const verifiedAddress=s.trigger||s.managedAddress||'';
  $('fastKnownTriggers').replaceChildren(...(s.managedAddresses||[s.managedAddress]).filter(Boolean).map(address=>{const item=node('option','');item.value=address;return item;}));
  $('fastReadiness').textContent=s.deployment?.state==='OTHER_WALLET'?'本机记录的部署付款钱包不在当前绑定列表，请核对原钱包入口。':s.deployment?.available&&!s.deployment.upgradeAccount?'首次使用请先部署自己的执行合约。':s.reason||'授权各钱包当前余额。开始任务时登记卖出比例、期限和最低到账，成交款直接回各原钱包。';
  if(!hydrated&&s.settings){const x=s.settings;$('fastTrigger').value=x.trigger||'';$('fastSource').value=x.source||'opening';$('fastPercent').value=String(x.percent||100);$('fastExpiry').value=String(x.expiryHours||48);}
  if(!hydrated&&(s.trigger||!$('fastTrigger').value))$('fastTrigger').value=verifiedAddress;
  if(!hydrated&&!asset()&&doc.location?.hash==='#fastSale'){
   const token=new URLSearchParams(doc.location.search).get('openingSellPreview');
   if(validCA(token)){
    $('fastAsset').value=token;$('fastSource').value='opening';$('fastPercent').value='100';
    void loadAsset();
   }
  }
  hydrated=true;buttons();const wrap=$('fastJobs'),expanded=new Set([...wrap.querySelectorAll('details[open]')].map(e=>e.dataset.id));wrap.replaceChildren();
  for(const j of [...s.jobs||[]].reverse()){
   const box=node('details','','fast-job');box.dataset.id=j.id;box.open=expanded.has(j.id);
   const failed=j.rows.filter(r=>r.status==='FAILED').length;
   const count=j.rows.filter(r=>r.status==='SOLD').length,below=j.rows.filter(belowMinimum).length;
   const summaryStatus=j.status==='REVIEW'&&below&&j.rows.every(r=>belowMinimum(r)||['SOLD','FAILED','EXPIRED','SKIPPED'].includes(r.status))?(count?'部分成交':'未成交'):labels[j.status]||j.status;
   box.append(node('summary',j.asset.slice(0,8)+'…'+j.asset.slice(-6)+' · '+summaryStatus+(j.settings?.percent?' · 卖出比例 '+j.settings.percent+'%':'')+' · '+(j.status==='COMPLETED'||count?count+'/'+j.rows.length+' 个钱包成交':j.rows.length+' 个钱包')+(below?' · '+below+' 个未达最低到账':'')+(failed?' · '+failed+' 个失败':'')));
   renderRows(box,j.rows,j);
   const line=node('div','','fast-job-line'),actions=node('div','','fast-job-actions');
   const add=(label,command)=>{const button=node('button',label,'secondary'+(command==='delete'?' fast-delete':''));button.type='button';button.disabled=controlling.has(j.id);button.onclick=()=>controlJob(j,command);actions.append(button);};
   if(j.status==='PAUSED')add('恢复','resume');else if(['ARMED','REGISTERING','AUTHORIZING','AUTHORIZED'].includes(j.status))add('暂停','pause');
   add('删除','delete');line.append(box,actions);wrap.append(line);
  }
  if(!s.jobs?.length)wrap.append(node('p','暂无极速卖出任务','helper'));
  syncSoldHoldings();
  clearTimeout(timer);
  if(['SUBMITTING','SUBMITTED'].includes(s.deployment?.state)){
   timer=setTimeout(async()=>{
    if(!deployBusy)try{await api('fast-sale/deployment/check',{});}catch(e){say(e.message);}
    await refresh();
   },3500);
  }else if(s.jobs?.some(j=>['REGISTERING','ARMED','AUTHORIZING'].includes(j.status)||j.rows.some(r=>['APPROVAL_PENDING','REGISTRATION_PENDING','PENDING'].includes(r.status))))timer=setTimeout(refresh,1800);
 }
 async function refresh(){const id=++tick;try{const s=await api('fast-sale');if(id===tick)render(s);}catch(e){say(e.message);}}
 async function action(fn,showProgress=false){
  if(busy)return;busy=true;buttons();
  const poll=showProgress?setInterval(refresh,1500):null;
  try{await fn();await refresh();}catch(e){say(e.message);}finally{clearInterval(poll);busy=false;buttons();}
 }
 function resetAsset(){
  clearTimeout(fillTimer);fillTimer=null;fillRead=null;
  ++epoch;clearTimeout(lookupTimer);loading=null;holdings=null;venue=null;venueError='';unchecked.clear();minimumDirty=false;
  $('fastMinimum').value='0.001';renderHoldings();buttons();
 }
 function loadAsset(){
  clearTimeout(lookupTimer);
  let ca=asset();if(!ca){const quick=getSelection().asset;if(validCA(quick)){$('fastAsset').value=quick;ca=quick;resetAsset();}}
  if(!validCA(ca)){say('请输入完整代币 CA');return;}
  if(loading&&same(loadedCA,ca))return loading;
  const stamp=++epoch;loadedCA=ca;const current=()=>stamp===epoch&&same(ca,asset());
  say('正在读取钱包持仓和主池计价币…');
  const query='?ca='+encodeURIComponent(ca);
  const balances=api('holdings'+query).then(r=>{
   if(!current())return;
   if(r.assetType!=='ERC20'||!same(r.token,ca))throw Error('该地址不是可卖出的 ERC-20 代币');
   holdings=r;renderHoldings();buttons();say('已读取第 '+r.block+' 块的持仓。');syncSoldHoldings();
  }).catch(e=>{if(current()){holdings=null;renderHoldings();buttons();say(e.message);}});
  const market=api('fast-venue'+query).then(v=>{
   if(!current())return;
   if(!same(v.token,ca)||!validCA(v.quote)||!Number.isInteger(v.quoteDecimals)||v.quoteDecimals<0||v.quoteDecimals>36)throw Error('主池计价币信息不完整');
   const changed=venue&&!same(venue.quote,v.quote);venue=v;venueError='';
   if(changed||!minimumDirty){
    const saved=state.settings;
    $('fastMinimum').value=saved?.minAmount&&same(saved.quote,v.quote)&&saved.quoteDecimals===v.quoteDecimals?saved.minAmount:v.quoteDecimals<3?['1','0.1','0.01'][v.quoteDecimals]:'0.001';
    minimumDirty=false;
   }
   renderHoldings();buttons();
  }).catch(e=>{if(current()){venue=null;venueError=e.message;buttons();}});
  loading=Promise.all([balances,market]).finally(()=>{if(current())loading=null;});return loading;
 }
 $('fastUseCA').addEventListener('click',loadAsset);
 $('fastAsset').addEventListener('input',()=>{resetAsset();say('');if(validCA(asset()))lookupTimer=setTimeout(loadAsset,180);});
 $('fastPercent').addEventListener('input',()=>{renderHoldings();buttons();});$('fastMinimum').addEventListener('input',()=>{minimumDirty=true;buttons();});
 $('fastTrigger').addEventListener('input',()=>{$('fastKey').value='';$('fastPassword').value='';say('');buttons();});$('fastMinimum').addEventListener('change',buttons);
 $('fastSave').addEventListener('click',()=>action(async()=>{await api('fast-sale/settings',config());say('设置已保存');}));
 $('fastSetup').addEventListener('click',()=>action(async()=>{
  const expectedAddress=triggerAddress()||state.managedAddress||null;
  say('正在配置本机触发端。系统如提示访问凭据存储，请在本机确认。');
  let result;try{result=await api('fast-sale/setup',{expectedAddress});}
  catch(e){if(e.code==='TRIGGER_IMPORT_REQUIRED'&&!state.privateKeyActions){$('fastImport').open=true;$('fastKey').focus();}throw e;}
  $('fastTrigger').value=result.trigger;render(result);say('触发端已设置。可复制手续费地址，准备开盘卖出。');
 }));
 function configureKey(actionName){return action(async()=>{
  const target=triggerAddress();
  const typed=validCA(target)&&!same(target,state.trigger)&&!(state.managedAddresses||[]).some(a=>same(a,target));
  const body=actionName==='import-key'&&typed?{expectedAddress:target}:{};
  say(actionName==='import-key'?'请在本机系统窗口粘贴私钥。':'正在设置脚本钱包…');
  let s;try{s=await api('fast-sale/'+actionName,body);}catch(e){
   if(validCA(e.details?.savedTrigger)){$('fastTrigger').value=e.details.savedTrigger;await refresh();}
   throw e;
  }
  if(s.cancelled){say('已取消导入。');return;}
  $('fastTrigger').value=s.trigger;render(s);say('触发钱包已就绪。');
 });}
 $('fastGenerate').addEventListener('click',()=>configureKey('generated'));
 $('fastImportKey').addEventListener('click',()=>configureKey('import-key'));
 $('fastExportKey').addEventListener('click',()=>action(async()=>{
  const address=triggerAddress();
  say('请在本机系统窗口核对地址后查看私钥。');
  const r=await api('fast-sale/export-key',{address});say(r.shown?'私钥查看窗口已关闭。':'已取消导出。');
 }));
 $('fastBackup').addEventListener('click',()=>action(async()=>{
  const address=triggerAddress();
  if(!validCA(address)||!(state.managedAddresses||[state.managedAddress]).some(a=>same(address,a)))throw Error('请选择本机已保存的触发钱包');
  say('请在本机系统窗口设置备份密码并选择保存位置。');
  const r=await api('fast-sale/backup',{address});say(r.saved?'加密密钥已保存。恢复钱包需要该文件和备份密码。':'已取消导出。');
 }));
 $('fastCopyAddress').addEventListener('click',async()=>{
  const addr=$('fastTrigger');if(!validCA(addr.value.trim()))return;
  try{await navigator.clipboard.writeText(addr.value.trim());say('已复制触发钱包地址。');}
  catch{addr.focus();addr.select();say('地址已选中，可手动复制。');}
 });
 $('fastUnlock').addEventListener('click',()=>action(async()=>{
  const f=$('fastKey').files?.[0],address=triggerAddress();if(!validCA(address))throw Error('请输入完整触发地址');if(!f||f.size>32768)throw Error('请选择有效的加密 Keystore 文件');
  const password=$('fastPassword').value;$('fastPassword').value='';
  const s=await api('fast-sale/unlock',{address,keystore:await f.text(),password,remember:!!state.managedSupported});
  $('fastKey').value='';$('fastImport').open=false;$('fastTrigger').value=s.trigger;render(s);
  say(s.managedSupported?'已核验并保存此钱包。下次填写同一地址即可启用。':'已核验并解锁此钱包。');
 }));
 $('fastRefresh').addEventListener('click',refresh);
 $('fastAuthorize').addEventListener('click',()=>action(async()=>{
  const appFreeOnly=$('fastAppFreeOnly').checked;
  if(appFreeOnly&&state.appFreeApprovals!==true)throw Error('此后端尚未支持免 App 模式，请在原单结束后更新后端。');
  const k=selectionKey()+'/'+appFreeOnly,old=jobFor();if(requestKey!==k||!requestId||old&&['REVIEW','COMPLETED'].includes(old.status)){requestId=crypto.randomUUID();requestKey=k;}
  if(old?.status==='AUTHORIZED'){say('本批次已经授权，可设置卖出条件并开始任务。');return;}
  say('正在核验主池并逐钱包授权…');await api('fast-sale/authorize',{asset:asset(),accounts:accounts(),id:requestId,appFreeOnly});say('请查看下方逐钱包结果。');
 },true));
 $('fastStart').addEventListener('click',()=>action(async()=>{
  const job=jobFor();if(!job)throw Error('请先授权所选钱包');
  say('正在登记钱包计划…');await api('fast-sale/start',{id:job.id,asset:asset(),accounts:accounts(),selectedOnly:true,settings:config()});say('已提交开始请求，逐钱包进度见下方。');
 },true));
 if(validCA(asset()))lookupTimer=setTimeout(loadAsset,0);
 return {refresh,selectionChanged};
}
