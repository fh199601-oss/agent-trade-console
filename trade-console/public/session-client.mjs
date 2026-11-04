// Only the local console token is renewed here, never the Binance login.
// Never retry a submitted operation on a transport error or an unknown reply.
const readPosts=new Set(['ready','refresh-wallets','follow','prepare','select-mint-route','opening/check','reconcile']);
const failure=v=>Object.assign(Error(v?.error?.message||v?.error||'本地服务响应无效'),{details:v?.details,code:v?.error?.code,serverRejected:true});
export function createConsoleClient({fetchImpl=(...args)=>fetch(...args),onSession=()=>{}}={}){
 let session=null,loading=null;
 async function send(path,body,token){
  const response=await fetchImpl('/api/'+path,{method:body===undefined?'GET':'POST',cache:'no-store',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/json',...(token?{'x-console-token':token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(body===undefined?45000:120000)}).catch(e=>{throw Error(e.name==='TimeoutError'?'请求超时，请在本地操作记录核对原单；不要重复提交。':e.message);});
  return {response,value:await response.json()};
 }
 function refreshSession(){
  if(loading)return loading;
  loading=(async()=>{
   const {response,value}=await send('bootstrap');if(!response.ok)throw failure(value);
   if(value?.service!=='agent-trade-console'||! /^[0-9a-f]{64}$/i.test(value.token||'')||!['LIVE','SIMULATION'].includes(value.mode)||!Array.isArray(value.wallets)||value.wallets.some(w=>!Number.isInteger(w.account)||!/^0x[0-9a-f]{40}$/i.test(w.address)))throw Error('本地服务身份或会话响应无效');
   const previous=session;session=value;onSession(value,previous);return value;
  })();loading.finally(()=>{loading=null;}).catch(()=>{});return loading;
 }
 async function request(path,body){
  if(!/^(?:[a-z][a-z0-9-]*(?:\?.*)?|opening\/(?:check|arm|stop))$/.test(path)||path==='bootstrap')throw Error('本地接口路径无效');
  if(!session)await refreshSession();
  const used=session.token,{response,value}=await send(path,body,used);
  if(response.ok)return value;
  const expired=response.status===401&&value?.error?.code==='LOCAL_SESSION_EXPIRED'&&value?.details?.requestAccepted===false;
  // Read recovery also works during rollout against the previous server.
  const legacy=response.status===400&&value?.error?.message==='本地会话验证失败';
  if(!expired&&!legacy)throw failure(value);
  if(session.token===used)await refreshSession();
  if(body!==undefined&&!readPosts.has(path))throw Object.assign(Error('本地连接已恢复，本次请求未进入操作流程。请核对当前模式后重新点击；没有自动重发。'),{code:'SESSION_REFRESHED_RETRY',details:{requestAccepted:false}});
  // Exactly one retry. Concurrent or late failures share the renewed token.
  const retry=await send(path,body,session.token);if(!retry.response.ok)throw failure(retry.value);return retry.value;
 }
 return {request,refreshSession};
}
