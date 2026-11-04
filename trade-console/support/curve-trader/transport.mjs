import {EnvHttpProxyAgent,setGlobalDispatcher} from 'undici';
const marker=Symbol.for('codex.curve.http.transport.v1');
export function configureHttpTransport(){
  if(globalThis[marker])return;
  const agent=new EnvHttpProxyAgent({keepAliveTimeout:60000,keepAliveMaxTimeout:60000,keepAliveTimeoutThreshold:1000,connections:4,connect:{timeout:5000,maxCachedSessions:100}});
  setGlobalDispatcher(agent);globalThis[marker]=true;
}
