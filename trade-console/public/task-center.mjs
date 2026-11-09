const labels={WAITING_MINT:'等待认购',WATCHING:'监测开盘',CLAIMING:'领取中',SELLING:'联动卖出',DONE:'已完成',REVIEW:'需核对',PAUSED:'已暂停',STOPPED:'已停止',ARMED:'监测开盘',FIRING:'准备卖出',TRACKING:'核对原单',COMPLETED:'已结束',CANCELLED:'已停止',EXPIRED:'已到期',CONFIRMED:'已确认',FAILED:'已失败',WAITING:'等待开盘'};
const finished=new Set(['DONE','STOPPED','COMPLETED','CANCELLED','EXPIRED']);
const canEdit=j=>!finished.has(j.status)&&j.status!=='REVIEW'&&(j.kind==='corla'||(j.rows||[]).some(r=>!r.commitStartedAt&&!r.recovery&&!r.submittedPercent&&['WAITING','PREPARING','PAUSED'].includes(r.status)));
const taskKey=j=>j.kind+':'+j.id;
const address=value=>/^0x[\da-f]{40}$/i.test(value||'')&&!/^0x0{40}$/i.test(value)?value.toLowerCase():null;
const shortAddress=value=>value?value.slice(0,8)+'…'+value.slice(-6):'';
const policyText=j=>j.kind==='corla'?(j.policy?.sell?'领取后卖出 '+j.policy.sell.percent+'%':'自动领取全部'):('卖出 '+j.config.percent+'% · 滑点 '+j.config.slippageBps/100+'%');
const canStop=j=>!finished.has(j.status)&&j.status!=='REVIEW';
const canPause=j=>['WAITING_MINT','WATCHING','CLAIMING','SELLING','ARMED','FIRING','TRACKING'].includes(j.status);
const canRestore=j=>['STOPPED','CANCELLED'].includes(j.status);
const eligible=(j,action)=>!j.deletedAt&&j.status!=='DELETED'&&(action==='pause'?canPause(j):action==='restore'?canRestore(j):action==='delete');
export async function controlTaskMembers(members,action,api){
 const tasks=[...new Map(members.filter(j=>eligible(j,action)).map(j=>[taskKey(j),{kind:j.kind,id:j.id}])).values()];
 if(!tasks.length)return {results:[],changed:0};return api('tasks/'+action,{tasks,confirmed:true});
}
export function groupTasks(rows){
 // Resolve token-less Corla rows through their mint contract only when that
 // contract has one unambiguous token. Names alone never establish identity.
 const tokensByMint=new Map(),groups=new Map();
 for(const j of rows){const mint=address(j.mint||j.policy?.mint),token=address(j.policy?.expectedToken);if(j.kind==='corla'&&mint&&token){if(!tokensByMint.has(mint))tokensByMint.set(mint,new Set());tokensByMint.get(mint).add(token);}}
 for(const j of rows){
  const mint=j.kind==='corla'?address(j.mint||j.policy?.mint):null,known=tokensByMint.get(mint);
  const token=j.kind==='opening'?address(j.config?.asset):(address(j.policy?.expectedToken)||(known?.size===1?[...known][0]:null));
  const key=token?'token:'+token:mint?'mint:'+mint:'task:'+taskKey(j);
  if(!groups.has(key))groups.set(key,{key,asset:token||mint,title:j.kind==='corla'?j.title:shortAddress(token)||'开盘自动卖出',members:[]});
  const group=groups.get(key);if(!group.members.some(m=>taskKey(m)===taskKey(j)))group.members.push(j);
  if(j.kind==='corla')group.title=j.title;
 }
 return [...groups.values()].map(group=>{
  const wallets=[...new Set(group.members.flatMap(j=>j.wallets||[]))].sort((a,b)=>Number(a)-Number(b));
  const policies=new Set(group.members.map(policyText)),statuses=new Set(group.members.map(j=>labels[j.status]||j.status));
  return {...group,wallets,policy:policies.size===1?[...policies][0]:'多种任务 · 展开查看',statusText:statuses.size===1?[...statuses][0]:group.members.some(j=>j.status==='PAUSED')?'部分暂停':'状态不一',statusClass:group.members.some(j=>j.status==='REVIEW')?'attention':group.members.some(j=>j.status==='PAUSED')?'paused':'running'};
 });
}
export async function stopTaskMembers(members,api){
 const unique=[...new Map(members.filter(canStop).map(j=>[taskKey(j),j])).values()];
 const results=await Promise.allSettled(unique.map(j=>Promise.resolve().then(()=>api(j.kind==='corla'?'corla-stop':'opening/stop',{id:j.id}))));
 return results.map((result,i)=>({...result,task:unique[i]}));
}
export function taskModel(snapshot){
 const corla=(snapshot.corla||[]).filter(j=>!j.deletedAt&&j.status!=='DELETED'),opening=(snapshot.opening||[]).filter(j=>!j.deletedAt&&j.status!=='DELETED'),childIds=new Set((snapshot.corla||[]).map(j=>j.sellJobId).filter(Boolean));
 const rows=[...corla.map(j=>({...j,kind:'corla',title:j.name||'Corla',wallets:[j.account]})),...opening.filter(j=>!childIds.has(j.id)).map(j=>({...j,kind:'opening',title:j.name||'开盘自动卖出',wallets:j.config.accounts}))];
 const active=rows.filter(j=>!finished.has(j.status));
 return {active,activeGroups:groupTasks(active),corlaHistory:rows.filter(j=>j.kind==='corla'&&finished.has(j.status)),openingHistory:opening.filter(j=>finished.has(j.status)&&!childIds.has(j.id)).map(j=>({...j,kind:'opening',title:j.name||'开盘自动卖出',wallets:j.config.accounts})),paused:snapshot.paused||[]};
}
export function createTaskCenter({api,notify,onFeeReview=()=>{},viewOrder=()=>{},document:doc=document,storage=globalThis.sessionStorage,confirmDelete=message=>globalThis.confirm(message)}){
 const $=id=>doc.getElementById(id),make=(tag,text,cls)=>{const e=doc.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
 let snapshot={corla:[],opening:[],paused:[]},request=null,resuming=false,noticeKey='',pendingNotice=false,paintKey='',expanded=new Set(),reminderRefs=[];
 const stopping=new Set();let editingSupported=false;
 const dialogs=createTaskDialogs({api,notify,document:doc,onSaved:async()=>{if(request)await request.catch(()=>{});await refresh();}});
 $('addTask').addEventListener('click',()=>dialogs.add());
 function actionsFor(members,title){
  const actions=make('span',undefined,'task-actions'),refs=snapshot.paused.filter(r=>members.some(j=>taskKey(r)===taskKey(j))),busy=members.some(j=>stopping.has(taskKey(j)));
  if(refs.length){const b=make('button','恢复','task-resume');b.type='button';b.disabled=resuming||stopping.size>0;b.setAttribute('aria-label','恢复 '+title);b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();void resume(refs);});actions.append(b);}
  if(editingSupported&&members.some(canEdit)){const b=make('button','修改','task-edit');b.type='button';b.disabled=busy||resuming;b.setAttribute('aria-label','修改 '+title);b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();dialogs.edit(members.filter(canEdit),title);});actions.append(b);}
  for(const [action,label,cls]of [['pause','暂停','task-pause'],['restore','找回','task-resume'],['delete','删除','task-delete']])if(members.some(j=>eligible(j,action))){const b=make('button',label,cls);b.type='button';b.disabled=busy||resuming;b.title=action==='pause'?'暂停后保留在列表，随时恢复':action==='delete'?'删除任务并停止后续操作；原交易记录保留':'找回旧版已停止任务，先恢复为暂停状态';b.setAttribute('aria-label',label+' '+title);b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();void change(action,members,title);});actions.append(b);}
  return actions;
 }
 function groupCard(group){
  const box=make('details',undefined,'task-row task-group'),head=make('summary',undefined,'task-row-head');box.open=expanded.has(group.key);box.dataset.group=group.key;
  box.addEventListener('toggle',()=>{if(!box.isConnected)return;if(box.open)expanded.add(group.key);else expanded.delete(group.key);});
  const name=make('div',undefined,'task-name');name.append(make('b',group.title),make('small',`${group.wallets.length} 个钱包 · ${group.policy}`));
  head.append(name,make('span',group.statusText,'task-status '+group.statusClass),actionsFor(group.members,group.title+'全部任务'));box.append(head);
  const body=make('div',undefined,'task-row-body task-wallets');
  if(group.asset)body.append(make('p',group.asset,'mono task-asset'));
  const entries=group.members.flatMap(j=>(j.wallets||[]).map(account=>({j,account}))).sort((a,b)=>Number(a.account)-Number(b.account));
  for(const {j,account} of entries){
   const row=make('div',undefined,'task-wallet-row'),state=j.kind==='opening'?(j.rows||[]).find(r=>r.account===account):null,status=j.status==='PAUSED'?'PAUSED':state?.status||j.status;
   const info=make('div',undefined,'task-wallet-info');info.append(make('b',account+' 号钱包'),make('span',state?.submittedPercent?'已提交卖出 '+state.submittedPercent+'%':policyText(j),'helper'));
   row.append(info,make('span',labels[status]||status,'task-status '+(status==='PAUSED'?'paused':status==='REVIEW'||status==='FAILED'?'attention':'running')));
   const linked=state||snapshot.opening.find(o=>o.id===j.sellJobId)?.rows?.find(r=>r.account===account);
   if(['SELL_FEE_REVIEW','SELL_FEES_UNVERIFIABLE'].includes(linked?.error?.code)&&linked.orderId){const review=make('button',linked.error.code==='SELL_FEES_UNVERIFIABLE'?'查看拦截原因':'确认卖出费用','secondary');review.addEventListener('click',()=>viewOrder(linked.orderId));row.append(review);}
   // A standalone opening task can own several wallets; do not present its
   // all-wallet stop endpoint as a single-wallet action.
   if(j.wallets.length===1)row.append(actionsFor([j],account+' 号钱包任务'));
   const message=state?.error?.message||j.message;if(message){const note=make('p',message,'helper task-wallet-message');note.title=message;row.append(note);}body.append(row);
  }
  box.append(body);return box;
 }
 function card(j){
  const box=make('details',undefined,'task-row'),head=make('summary',undefined,'task-row-head'),key=j.kind+':'+j.id;box.open=expanded.has(key);
  box.addEventListener('toggle',()=>{if(box.open)expanded.add(key);else expanded.delete(key);});
  const name=make('div',undefined,'task-name');name.append(make('b',j.title),make('small',`${j.wallets.join('、')} 号钱包 · ${j.kind==='corla'?(j.policy?.sell?'领取后卖出 '+j.policy.sell.percent+'%':'自动领取全部'):('卖出 '+j.config.percent+'% · 滑点 '+j.config.slippageBps/100+'%')}`));
  const status=make('span',labels[j.status]||j.status,'task-status '+(j.status==='PAUSED'?'paused':j.status==='REVIEW'?'attention':finished.has(j.status)?'finished':'running'));
  const actions=actionsFor([j],j.title);
  head.append(name,status,actions);box.append(head);
  const body=make('div',undefined,'task-row-body');body.append(make('p',j.message||'','helper'));if(j.kind==='opening'){body.append(make('p',j.config.asset,'mono'));for(const r of j.rows||[])body.append(make('p',`${r.account} 号：${labels[r.status]||r.status}${r.error?.message?' · '+r.error.message:''}`,'helper'));}
  box.append(body);return box;
 }
 function render(){
  onFeeReview(snapshot.opening.flatMap(j=>(j.rows||[]).filter(r=>['SELL_FEE_REVIEW','SELL_FEES_UNVERIFIABLE'].includes(r.error?.code)&&r.orderId).map(r=>r.orderId)));
  const keyFields=j=>[j.id,j.kind,j.status,j.title,j.wallets,j.mint,j.message,j.config,j.policy,j.revision,j.pauseReason,j.rows?.map(r=>[r.account,r.status,r.error?.message])];
  const nextModel=taskModel(snapshot),nextPaint=JSON.stringify([snapshot.instance,resuming,[...stopping],nextModel.paused,...nextModel.active.map(keyFields),...nextModel.corlaHistory.map(keyFields),...nextModel.openingHistory.map(keyFields)]);
  if(nextPaint===paintKey){showReminder();return;}paintKey=nextPaint;
  const model=nextModel,scroll=$('activeTasks').scrollTop;
  $('activeTasks').replaceChildren(...model.activeGroups.map(groupCard));if(!model.active.length)$('activeTasks').append(make('p','暂无进行中的任务','task-empty'));
  $('activeTasks').scrollTop=scroll;$('taskCount').textContent=`${model.activeGroups.length} 个代币`;$('pausedCount').textContent=model.paused.length?`${model.paused.length} 个待恢复`:'';
  $('resumeAllTasks').disabled=resuming||stopping.size>0||!model.paused.length;$('resumeAllTasks').textContent=resuming?'恢复中…':`一键恢复暂停任务${model.paused.length?' · '+model.paused.length:''}`;
  for(const [kind,rows]of [['corla',model.corlaHistory],['opening',model.openingHistory]]){const target=$(kind+'Jobs'),top=target.scrollTop;target.replaceChildren(...rows.map(card));target.scrollTop=top;$(kind+'History').hidden=!rows.length;$(kind+'HistoryCount').textContent=rows.length;}
  reminderRefs=model.paused.filter(ref=>model.active.find(j=>taskKey(j)===taskKey(ref))?.pauseReason!=='user');
  $('resumeDialogCount').textContent=String(reminderRefs.length);$('confirmResumeTasks').disabled=resuming||stopping.size>0||!reminderRefs.length;
  // One reminder per service start. Resuming part of the list must not make
  // the remaining already-dismissed tasks look like a new restart.
  const key='agent-trade-console:paused:'+snapshot.instance;
  if(!reminderRefs.length){pendingNotice=false;if($('resumeTasksDialog').open)$('resumeTasksDialog').close();return;}
  if(key!==noticeKey){noticeKey=key;try{pendingNotice=!storage.getItem(key);}catch{pendingNotice=true;}}
  showReminder();
 }
 function showReminder(){if(pendingNotice&&!doc.querySelector('dialog[open]')){$('resumeTasksDialog').showModal();pendingNotice=false;}}
 function dismiss(){try{storage.setItem(noticeKey,'seen');}catch{}pendingNotice=false;$('resumeTasksDialog').close();}
 async function refresh(){if(request)return request;request=api('tasks').then(r=>{snapshot=r;render();return snapshot;}).finally(()=>request=null);return request;}
 async function change(action,members,title){
  if(resuming||members.some(j=>stopping.has(taskKey(j))))return;
  const keys=new Set(members.map(taskKey)),model=taskModel(snapshot),targets=[...model.active,...model.corlaHistory,...model.openingHistory].filter(j=>keys.has(taskKey(j))&&eligible(j,action));
  if(action==='delete'&&!confirmDelete(`删除「${title}」？将停止后续自动操作，并从任务列表移除。原交易记录保留。`))return;
  if(!targets.length)return;for(const j of targets)stopping.add(taskKey(j));render();
  try{
   const result=await controlTaskMembers(targets,action,api),failed=result.results.filter(r=>!r.changed);
   notify(`已${{pause:'暂停',delete:'删除',restore:'找回'}[action]} ${result.changed} 个任务`+(failed.length?'；未完成：'+failed.map(r=>r.message).join('；'):action==='restore'?'；当前为暂停状态，点击恢复后才继续。':''),failed.length>0);
   // An in-flight poll may predate the stop. Finish it, then read fresh state.
   if(request)await request.catch(()=>{});await refresh();
  }catch(e){notify('任务状态刷新失败：'+e.message+'，请点击刷新核对。',true);}
  finally{for(const j of targets)stopping.delete(taskKey(j));render();}
 }
 async function resume(refs){
  if(resuming||stopping.size||!refs.length)return;resuming=true;render();
  try{const r=await api('tasks/resume',{tasks:refs,confirmed:true});dismiss();const failed=r.results.filter(x=>!x.resumed);notify(`已恢复 ${r.resumed} 个任务`+(failed.length?'；'+failed.map(x=>x.message).join('；'):''),failed.length>0);if(request)await request.catch(()=>{});await refresh();}
  catch(e){notify('恢复未完成：'+e.message+'。刷新任务查看实际状态；不会新建重复任务。',true);await refresh().catch(()=>{});}
  finally{resuming=false;render();}
 }
 $('resumeAllTasks').addEventListener('click',()=>resume([...snapshot.paused]));$('confirmResumeTasks').addEventListener('click',()=>resume([...reminderRefs]));
 $('laterResumeTasks').addEventListener('click',dismiss);$('closeResumeTasks').addEventListener('click',dismiss);$('resumeTasksDialog').addEventListener('cancel',e=>{e.preventDefault();dismiss();});
 $('refreshTasks').addEventListener('click',()=>refresh().catch(e=>notify(e.message,true)));
 for(const d of doc.querySelectorAll('dialog'))d.addEventListener('close',()=>queueMicrotask(showReminder));
 return {refresh,getSnapshot:()=>snapshot,setFeatures(capabilities){const enabled=capabilities?.taskCenterVersion>=2;$('addTask').disabled=!enabled;$('addTask').title=enabled?'为最近已 Mint 的项目补建任务':'任务编辑功能等待后端更新';if(enabled!==editingSupported){editingSupported=enabled;paintKey='';render();}}};
}

// Kept in the existing static entry so an old running server can still load
// the dashboard while its replacement is waiting for active tasks to finish.
export function createTaskDialogs({api,notify,onSaved,document:doc=document}){
 const $=id=>doc.getElementById(id),make=(tag,text)=>{const e=doc.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
 let editing=[],projects=[],requestId='',loading=false,adding=false,editBusy=false,epoch=0;
 const selected=()=>projects.find(p=>p.id===$('taskProject').value);
 function percentState(){const off=$('taskAction').value==='claim';$('taskAddPercent').disabled=off;$('taskAddPercentRow').hidden=off;}
 function renderProject(){
  const p=selected();$('taskAddWallets').replaceChildren();$('taskAction').replaceChildren();
  if(!p){$('taskAddMessage').textContent='最近 30 天没有可用的真实 Mint 记录。';$('confirmAddTask').disabled=true;return;}
  for(const [value,label]of p.kind==='corla'?[['claim','自动领取全部'],['claim-sell','领取全部后自动卖出']]:[['sell','开盘自动卖出']]){const option=make('option',label);option.value=value;$('taskAction').append(option);}
  $('taskAddMessage').textContent=p.unavailable||'仅选择已 Mint、尚未开盘的钱包；已有任务请使用“修改”。';
  for(const w of p.wallets){const label=make('label'),check=make('input');label.className='task-choice';check.type='checkbox';check.value=String(w.account);check.checked=w.available;check.disabled=!w.available;label.append(check,make('span',w.account+' 号钱包'+(w.reason?' · '+w.reason:'')));$('taskAddWallets').append(label);}
  $('confirmAddTask').disabled=!p.wallets.some(w=>w.available)||adding;percentState();requestId=crypto.randomUUID();
 }
 async function add(){
  if(loading||adding)return;loading=true;const ticket=++epoch;projects=[];$('taskProject').replaceChildren();$('taskAddWallets').replaceChildren();$('taskAddMessage').textContent='正在核验最近 Mint 记录与当前开盘状态…';$('confirmAddTask').disabled=true;$('taskAddPercent').value='50';$('addTaskDialog').showModal();
  try{const result=await api('tasks/candidates');if(ticket!==epoch)return;projects=result.projects||[];for(const p of projects){const option=make('option',p.name+(p.unavailable?' · '+p.unavailable:''));option.value=p.id;$('taskProject').append(option);}const first=projects.find(p=>p.wallets.some(w=>w.available));if(first)$('taskProject').value=first.id;renderProject();}
  catch(e){if(ticket===epoch)$('taskAddMessage').textContent='读取失败：'+e.message;}finally{loading=false;}
 }
 function edit(members,title){
  if(editBusy)return;editing=members.map(j=>({kind:j.kind,id:j.id,revision:j.revision||0}));const corlaOnly=members.every(j=>j.kind==='corla'),settings=members.map(j=>j.kind==='corla'?j.policy?.sell:j.config),values=[...new Set(settings.map(s=>s?.percent).filter(Boolean))];
  $('editTaskTitle').textContent='修改 · '+title;$('taskEditPercent').value=values.length===1?values[0]:'50';$('taskEditSellRow').hidden=!corlaOnly;$('taskEditSell').checked=!corlaOnly||settings.some(Boolean);$('taskEditPercent').disabled=!$('taskEditSell').checked;
  $('taskEditMessage').textContent='修改 '+members.length+' 个任务中尚未提交的卖出；暂停的任务保存后仍保持暂停。';$('saveTaskEdit').disabled=false;$('editTaskDialog').showModal();
 }
 $('taskProject').addEventListener('change',renderProject);$('taskAction').addEventListener('change',()=>{percentState();requestId=crypto.randomUUID();});
 for(const id of ['taskAddWallets','taskAddPercent'])$(id).addEventListener('change',()=>requestId=crypto.randomUUID());
 $('taskEditSell').addEventListener('change',()=>$('taskEditPercent').disabled=!$('taskEditSell').checked);
 $('saveTaskEdit').addEventListener('click',async()=>{
  if(editBusy)return;editBusy=true;$('saveTaskEdit').disabled=true;
  try{const r=await api('tasks/edit',{tasks:editing,settings:{percent:$('taskEditPercent').value,sellEnabled:$('taskEditSell').checked},confirmed:true}),failed=r.results.filter(x=>!x.changed);await onSaved();
   if(failed.length){$('taskEditMessage').textContent=`已修改 ${r.changed} 个；`+failed.map(x=>x.message).join('；');editing=editing.filter(x=>failed.some(f=>f.kind===x.kind&&f.id===x.id));}
   else{$('editTaskDialog').close();notify('已修改 '+r.changed+' 个任务的卖出设置');}
  }catch(e){$('taskEditMessage').textContent=e.message;}finally{editBusy=false;$('saveTaskEdit').disabled=false;}
 });
 $('confirmAddTask').addEventListener('click',async()=>{
  if(adding||loading)return;const p=selected(),accounts=[...$('taskAddWallets').querySelectorAll('input:checked:not(:disabled)')].map(e=>Number(e.value));if(!p||!accounts.length){$('taskAddMessage').textContent='请选择至少一个可用钱包';return;}
  adding=true;$('confirmAddTask').disabled=true;$('taskAddMessage').textContent='正在重新核验并添加任务…';
  try{const r=await api('tasks/add',{requestId,candidateId:p.id,accounts,action:$('taskAction').value,percent:$('taskAddPercent').value,confirmed:true}),failed=r.results.filter(x=>!x.created&&!x.duplicate);await onSaved();
   if(failed.length)$('taskAddMessage').textContent=`已添加 ${r.created} 个；`+failed.map(x=>x.account+' 号：'+x.message).join('；');
   else{$('addTaskDialog').close();notify(r.created?'已添加 '+r.created+' 个任务，开始监测开盘':'任务已经添加，没有重复创建');}
  }catch(e){$('taskAddMessage').textContent=e.message;}finally{adding=false;$('confirmAddTask').disabled=false;}
 });
 for(const [button,dialog]of [['closeTaskEdit','editTaskDialog'],['cancelTaskEdit','editTaskDialog'],['closeAddTask','addTaskDialog'],['cancelAddTask','addTaskDialog']])$(button).addEventListener('click',()=>$(dialog).close());
 return {add,edit};
}
