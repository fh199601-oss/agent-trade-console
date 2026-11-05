// UI snapshots contain task references only. Resuming always revalidates the
// original persisted policy; cancelled and completed tasks are never re-armed.
export function pausedTasks(corla,opening){
 const parents=corla.list(),children=new Set(parents.map(j=>j.sellJobId).filter(Boolean));
 return [...parents.filter(j=>j.status==='PAUSED'&&!j.cancelled).map(j=>({kind:'corla',id:j.id})),
  ...opening.list().filter(j=>j.status==='PAUSED'&&!j.cancelRequested&&!j.sourceClaim&&!children.has(j.id)).map(j=>({kind:'opening',id:j.id}))];
}
export function resumeTasks(corla,opening,input){
 if(input?.confirmed!==true||!Array.isArray(input.tasks)||!input.tasks.length||input.tasks.length>200)throw Error('请点击恢复暂停任务');
 const seen=new Set();for(const ref of input.tasks){if(!ref||!['corla','opening'].includes(ref.kind)||typeof ref.id!=='string'||!/^[a-zA-Z0-9_.:-]{1,160}$/.test(ref.id)||seen.has(ref.kind+':'+ref.id))throw Error('任务列表无效');seen.add(ref.kind+':'+ref.id);}
 const eligible=new Set(pausedTasks(corla,opening).map(r=>r.kind+':'+r.id));
 const results=input.tasks.map(ref=>{if(!eligible.has(ref.kind+':'+ref.id))return {...ref,resumed:false,message:'任务已变化、已停止或无需恢复，未重复启动'};
  try{const j=(ref.kind==='corla'?corla:opening).resume(ref.id);return {...ref,resumed:true,status:j.status};}
  catch(e){return {...ref,resumed:false,message:e.message};}
 });return {results,resumed:results.filter(r=>r.resumed).length,remaining:pausedTasks(corla,opening)};
}
export function controlTasks(corla,opening,action,input){
 if(!['pause','delete','restore'].includes(action)||input?.confirmed!==true||!Array.isArray(input.tasks)||!input.tasks.length||input.tasks.length>200)throw Error('任务操作参数无效');
 const seen=new Set();for(const ref of input.tasks){if(!ref||!['corla','opening'].includes(ref.kind)||typeof ref.id!=='string'||!/^[a-zA-Z0-9_.:-]{1,160}$/.test(ref.id)||seen.has(ref.kind+':'+ref.id))throw Error('任务列表无效');seen.add(ref.kind+':'+ref.id);}
 const children=new Set(corla.list().map(j=>j.sellJobId).filter(Boolean));
 const results=input.tasks.map(ref=>{try{
  if(ref.kind==='opening'&&(children.has(ref.id)||opening.jobs.get(ref.id)?.sourceClaim))throw Error('请从自动领取任务操作联动卖出');
  const manager=ref.kind==='corla'?corla:opening,j=manager[action==='delete'?'remove':action](ref.id);return {...ref,changed:true,status:j.status};
 }catch(e){return {...ref,changed:false,message:e.message};}});
 return {results,changed:results.filter(r=>r.changed).length,remaining:pausedTasks(corla,opening)};
}
