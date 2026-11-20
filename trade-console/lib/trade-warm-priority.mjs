// Watching a future launch is not a foreground wallet operation. Allow bounded
// read-only preparation while it watches; yield as soon as launch/claim/sale
// starts, or when the engine owns any account. Unknown task states stay busy.
const openingFinished=new Set(['COMPLETED','CANCELLED','PAUSED','DELETED','EXPIRED','REVIEW']);
const corlaFinished=new Set(['DONE','STOPPED','PAUSED','DELETED','REVIEW']);
function idleOrWatching(manager,finished,safe){
 if(!manager?.active?.())return true;
 const jobs=manager.list?.();if(!Array.isArray(jobs)||!jobs.length)return false;
 return jobs.every(j=>finished.has(j.status)||safe(j));
}
export function canWarmTrades(engine,opening,corla){
 return !engine.running?.size&&
  idleOrWatching(opening,openingFinished,j=>j.status==='ARMED'&&!j.detectedAt&&!j.cancelRequested&&Array.isArray(j.rows)&&j.rows.every(r=>r.status==='WAITING'))&&
  idleOrWatching(corla,corlaFinished,j=>j.status==='WATCHING'&&!j.openedAt&&!j.commitStartedAt&&!j.cancelled);
}
