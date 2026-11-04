import path from 'node:path';
import {readFileSync} from 'node:fs';
import {ROOT,LOCAL,DATA,load,json} from './lib/common.mjs';
const [command,...argv]=process.argv.slice(2);
const help=`Agent 交易台 · Grok / Codex 共用入口（JSON）
  node trade-console/cli.mjs inspect <CA、域名或HTTPS网址>
  node trade-console/cli.mjs preflight <CA、域名或HTTPS网址>  # 省略行情/持仓，只读
  node trade-console/cli.mjs learn <CA、域名或HTTPS网址>  # 回查近期成功 Mint，输出可核验线索，只读
  node trade-console/cli.mjs batch --file request.json
  node trade-console/cli.mjs ready
  node trade-console/cli.mjs prepare --file request.json
  node trade-console/cli.mjs run --file request.json
  node trade-console/cli.mjs execute --file confirmation.json
  node trade-console/cli.mjs follow <原操作ID>
  node trade-console/cli.mjs orders
request.json: {"id":"稳定消息ID-account1","intent":{"account":1,"side":"mint","asset":"项目网址","quantity":1,"maxBnb":"0"}}
买入 intent: side=buy, amount=金额, currency=BNB/USDT/QUOTE
卖出 intent: side=sell, percent=50, currency=AUTO（默认；每次重新读取当前余额）
run 执行另需 execute:true, authorization:当前用户原句；默认只预览，没有 execute:true 不会交易。
地址由安装器自动分配，仅连接此安装目录的服务。只用一个服务，重复 ID 不重下。
`;
if(!command||['help','--help','-h'].includes(command)){console.log(help);process.exit(0);}
const service=load(path.join(DATA,'service.json'));const installation=load(path.join(LOCAL,'install.json'));if(!service||service.installationId!==installation?.installationId)throw Error('请先运行 python3 setup.py start');const base='http://127.0.0.1:'+service.port;const u=new URL(base);if(!['127.0.0.1','localhost'].includes(u.hostname)||u.protocol!=='http:')throw Error('只允许本机服务地址');
async function request(path,body){const b=await fetch(base+'/api/bootstrap',{signal:AbortSignal.timeout(3000)}).then(r=>r.json());if(b.installationId!==installation.installationId)throw Error('服务实例不匹配，拒绝发送命令');const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-console-token':b.token},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(150000)});const data=await r.json();if(!r.ok)throw Object.assign(Error(data.error?.message||data.error),{diagnostics:data.diagnostics});return data;}
try{
 let result;
 if(['inspect','preflight','learn'].includes(command)){const started=performance.now(),d=await request('/api/project?asset='+encodeURIComponent(argv[0])+(command==='learn'?'&learn=1':''));result=d;if(command==='inspect'&&(d.token||/^0x[0-9a-f]{40}$/i.test(argv[0]))){const ca=d.token||argv[0];const [m,h]=await Promise.allSettled([request('/api/market?ca='+ca),request('/api/holdings?ca='+ca)]);result={...d,market:m.status==='fulfilled'?m.value:{error:m.reason.message},holdings:h.status==='fulfilled'?h.value:{error:h.reason.message}};}result.clientMs=Math.round(performance.now()-started);}
 else if(command==='ready')result=await request('/api/ready',{});
 else if(command==='orders')result=await request('/api/orders');
 else if(command==='follow')result=await request('/api/follow',{id:argv[0]});
 else if(['prepare','run','execute','batch'].includes(command)){
  const index=argv.indexOf('--file');if(index<0||!argv[index+1])throw Error('请用 --file 传入 JSON；也可以 --file - 从 stdin 读取');
  const data=JSON.parse(readFileSync(argv[index+1]==='-'?0:argv[index+1],'utf8'));if(!data.id)throw Error('必须使用稳定消息 ID');result=await request('/api/'+command,data);
 }else throw Error('未知命令；运行 --help 查看用法');
 console.log(json(result));
}catch(e){console.log(json({success:false,error:e.message,diagnostics:e.diagnostics,hint:'若为提交超时，仅 follow 原 ID；不要生成新 ID 重发。'}));process.exitCode=1;}
