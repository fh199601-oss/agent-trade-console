import {percentOf,same,wallet} from './common.mjs';
const terminal=new Set(['DONE','STOPPED','COMPLETED','CANCELLED','EXPIRED','DELETED']);
export const editableSaleRow=r=>!r.commitStartedAt&&!r.recovery&&!r.submittedPercent&&['WAITING','PREPARING','PAUSED'].includes(r.status);
export function taskSellSettings(input){
 if(!input||Object.keys(input).some(k=>!['percent','sellEnabled'].includes(k))||input.sellEnabled!==undefined&&typeof input.sellEnabled!=='boolean')throw Error('任务修改参数无效');
 const percent=String(input.percent??'50');percentOf(100000000n,percent);return {percent,sellEnabled:input.sellEnabled!==false};
}
function rollback(j,old){for(const k of Object.keys(j))delete j[k];Object.assign(j,old);}
export function editOpening(manager,id,settings,{linked=false,revision}={}){
 const s=taskSellSettings(settings),j=manager.jobs.get(id);if(!j||j.deletedAt||terminal.has(j.status)||manager.closed)throw Error('任务已结束或不存在，不能修改');
 if(j.sourceClaim&&!linked)throw Error('请从自动领取任务修改联动卖出');
 if(!s.sellEnabled)throw Error('开盘卖出任务请使用暂停按钮停止执行');
 if(revision!==undefined&&revision!==(j.revision||0))throw Error('任务设置已变化，请刷新后重新修改');
 if(j.bindings.some(w=>!same(wallet(w.account).address,w.address)))throw Error('钱包绑定已变化');
 const pending=j.rows.filter(editableSaleRow);if(!pending.length)throw Error('该任务已进入提交或原单核对阶段，不能改写已提交的卖出');
 const old=structuredClone(j);j.config={...j.config,percent:s.percent};j.revision=(j.revision||0)+1;delete j.preflight;
 j.updatedAt=manager.now();j.authorization+='；用户修改尚未提交的钱包卖出比例为 '+s.percent+'% 当前持仓';j.message='卖出比例已改为 '+s.percent+'%；已提交钱包继续核对原单';
 try{manager.persist();}catch(e){rollback(j,old);throw e;}return j;
}
export function editCorla(manager,id,settings,{revision}={}){
 const s=taskSellSettings(settings),j=manager.jobs.get(id);if(!j||j.deletedAt||terminal.has(j.status)||manager.closed)throw Error('任务已结束或不存在，不能修改');
 if(revision!==undefined&&revision!==(j.revision||0))throw Error('任务设置已变化，请刷新后重新修改');
 if(!same(manager.binding(j.account).address,j.wallet))throw Error('钱包绑定已变化');
 if(j.status==='REVIEW')throw Error('任务存在待核对原单，请先核对结果');
 const child=manager.opening.jobs.get(j.sellJobId);
 if(child&&!s.sellEnabled)throw Error('领取已完成并交接卖出，请使用暂停按钮；已提交原单不能取消');
 if(s.sellEnabled&&manager.opening.list().some(x=>x.id!==j.sellJobId&&!terminal.has(x.status)&&same(x.config.asset,j.policy.expectedToken)&&x.config.accounts.includes(j.account)))throw Error('此钱包已有该代币卖出任务，请修改原任务');
 const old=structuredClone(j),oldChild=child&&structuredClone(child);
 // Synchronous policy transaction: no scheduler can interleave a new handoff.
 try{
  if(child)editOpening(manager.opening,child.id,s,{linked:true});
  j.policy={...j.policy,sell:s.sellEnabled?{...(j.policy.sell||{slippageBps:5000,currency:'AUTO'}),percent:s.percent}:null};j.revision=(j.revision||0)+1;j.updatedAt=manager.now();
  j.authorization+='；用户修改领取后操作：'+(s.sellEnabled?'按当前持仓卖出 '+s.percent+'%':'仅领取，不自动卖出');j.message=s.sellEnabled?'领取后卖出比例已改为 '+s.percent+'%':'已设置为仅自动领取全部';manager.persist();return j;
 }catch(e){rollback(j,old);if(child){rollback(child,oldChild);try{manager.opening.persist();}catch{child.status='PAUSED';j.status='PAUSED';}}throw e;}
}
export function editTasks(corla,opening,input){
 if(input?.confirmed!==true||!Array.isArray(input.tasks)||!input.tasks.length||input.tasks.length>200)throw Error('请确认要修改的任务');
 const settings=taskSellSettings(input.settings),seen=new Set();
 for(const r of input.tasks){const k=r?.kind+':'+r?.id;if(!r||!['corla','opening'].includes(r.kind)||typeof r.id!=='string'||!/^[a-zA-Z0-9_.:-]{1,160}$/.test(r.id)||!Number.isInteger(r.revision)||r.revision<0||seen.has(k))throw Error('任务列表或版本无效');seen.add(k);}
 const results=input.tasks.map(r=>{try{const j=r.kind==='corla'?editCorla(corla,r.id,settings,{revision:r.revision}):editOpening(opening,r.id,settings,{revision:r.revision});return {...r,changed:true,status:j.status,revision:j.revision};}catch(e){return {...r,changed:false,message:e.message};}});
 return {results,changed:results.filter(r=>r.changed).length};
}
