import {PersonalDeployment} from './lib/delegated-sale/personal-deployment.mjs';
import {LiveFastSale} from './lib/delegated-sale/live.mjs';
import {activeDeployment} from './lib/delegated-sale/bsc.mjs';
import {FastSaleRuntime} from './lib/delegated-sale/runtime.mjs';
import {DisabledFastSale,validateFastSettings} from './lib/delegated-sale/service.mjs';
import {GangWarmup,shareTradeMetadata} from './lib/gang-warmup.mjs';
import {gangClient} from './lib/gang-modern.mjs';
import {TaskEnrollment} from './lib/task-enrollment.mjs';
import {editTasks} from './lib/task-edit.mjs';
import {AppUpdates} from './lib/app-updates.mjs';
import {CorlaAutomation} from './lib/corla-automation.mjs';
import {OpeningPreparation} from './lib/opening-preparation.mjs';
import {ManualSellWarmup} from './lib/manual-sell-warmup.mjs';
import {canWarmTrades} from './lib/trade-warm-priority.mjs';
import {OpeningSell} from './lib/opening-sell.mjs';
import {OpeningPools} from './lib/opening-pools.mjs';
import {OpeningQuotes} from './lib/opening-quotes.mjs';
import {InfinityPools} from './lib/infinity.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {same,ROOT,LOCAL,DATA,bindings,save,load,json,publicError,address} from './lib/common.mjs';
import {Rpc,forkReadRpc,preemptibleReadRpc} from './lib/network.mjs';
import {RpcEndpoints} from './lib/rpc-endpoints.mjs';
import {Wallets} from './lib/wallet.mjs';
import {Engine} from './lib/engine.mjs';
import {HIGH_FEE_PPM} from './lib/trade-fees.mjs';
import {OriginalTracker} from './lib/original-tracker.mjs';
import {Batches} from './lib/batch.mjs';
import {parallelWallets} from './lib/parallel-wallets.mjs';
import {market,holdings} from './lib/market.mjs';
import {discover} from './lib/discovery.mjs';
import {inspectProject} from './lib/project.mjs';
import {walletOverview} from './lib/wallet-overview.mjs';
import {pausedTasks,resumeTasks,controlTasks} from './lib/task-center.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
export function validateSettings(s){
 if(!s||!Array.isArray(s.buy)||!Array.isArray(s.sell)||s.buy.length!==5||s.sell.length!==5)throw Error('买入和卖出均需正好 5 个按钮');
 for(const x of s.buy)if(!/^\d+(\.\d{1,18})?$/.test(String(x))||Number(x)<=0)throw Error('买入金额必须大于 0');
 for(const x of s.sell)if(!/^\d+(\.\d{1,6})?$/.test(String(x))||Number(x)<=0||Number(x)>100)throw Error('卖出比例须在 0–100% 之间');
 return {buy:s.buy.map(String),sell:s.sell.map(String)};
}
export function createServer({rpc=new Rpc(process.env.BSC_RPC_URL||undefined),bridge=new Wallets(),readRpc=null,live=false,data=DATA,engine:provided,opening:providedOpening,corla:providedCorla,updates:providedUpdates,fastSale:providedFastSale,walletBindings=bindings,deploymentWitness,token=randomBytes(32).toString('hex')}={}){
 const deployment=load(path.join(data,'fast-deployment.json'),null);
 let deployed=live&&deployment?.payer&&walletBindings().some(w=>same(w.address,deployment.payer))&&activeDeployment(deployment,load(path.join(data,'fast-sale-mainnet-jobs.json'),[]));
 let fastSale=providedFastSale||(deployed?new LiveFastSale({rpc,bridge,data,bindings:walletBindings,deployment:deployed}):new DisabledFastSale());
 const fastSettingsFile=path.join(data,'fast-sale-settings.json');
 const rpcSettings=rpc instanceof Rpc?(rpc.endpoints??=new RpcEndpoints({data,primary:rpc.url,fetchImpl:rpc.fetch})):null;
 if(rpcSettings)rpc.fetch=rpcSettings.fetch;
 // Keep long project scans / periodic display reads out of the order RPC queue.
 readRpc??=forkReadRpc(rpc);
 if(rpcSettings&&readRpc instanceof Rpc){readRpc.endpoints=rpcSettings;readRpc.fetch=rpcSettings.fetch;}
 const engine=provided||new Engine({rpc,bridge,live,data});const batches=new Batches(engine);const configFile=path.join(data,'buttons.json');
 const openingRpc=forkReadRpc(rpc),prepRpc=forkReadRpc(rpc),routeRpc=forkReadRpc(rpc);
 // Optional platform discovery must not hold up a batch of fresh balances.
 // Use the same endpoint policy and full deadline, with its own read queue.
 engine.routeRpc=routeRpc;shareTradeMetadata(rpc,routeRpc);
 const warmIdle=()=>canWarmTrades(engine,opening,corla);
 const warmRpc=preemptibleReadRpc(rpc,warmIdle);engine.warmRpc=warmRpc;
 engine.onForegroundRead=()=>warmRpc.interrupt?.();
 shareTradeMetadata(rpc,warmRpc);
 // Historical discovery can fill its RPC queue without occupying the live
 // reserve scanner. All clients retain the user's same endpoint/failover policy.
 const discoveryRpc=forkReadRpc(rpc);
 const detector=new OpeningPools(openingRpc,{quoteDiscovery:new OpeningQuotes(discoveryRpc),infinity:typeof discoveryRpc.send==='function'?new InfinityPools(discoveryRpc):null}),preparation=new OpeningPreparation(prepRpc);engine.openingScan=(t,o)=>detector.scan(t,o);engine.openingPreparation=preparation;
 engine.tradePlanOptions={...engine.tradePlanOptions,tokenMetadata:t=>preparation.peekToken(t)};
 const opening=providedOpening||new OpeningSell({engine,rpc:openingRpc,bridge,detector,data,preparation});
 const corla=providedCorla||new CorlaAutomation({engine,rpc:openingRpc,opening,data});engine.onAuthorized=o=>corla.enroll(o);
 opening.fastSaleOwns=(asset,owner)=>fastSale.owns(asset,owner);
 corla.onClaimConfirmed=o=>fastSale.onClaimOrder(o);
 const fastRuntime=new FastSaleRuntime(fastSale);if(fastSale.status().enabled)fastRuntime.start();
 const deploymentManager=new PersonalDeployment({
  data,rpc,witness:deploymentWitness||new Rpc('https://bsc-dataseed1.defibit.io'),bridge,bindings:walletBindings,enabled:()=>live&&engine.live&&!providedFastSale,
  async activate(manifest){
   const verified=activeDeployment(manifest,load(path.join(data,'fast-sale-mainnet-jobs.json'),[]));
   const previous=fastSale;
   if(!verified?.payer||!walletBindings().some(w=>same(w.address,verified.payer))||
      deployed&&(deployed.dividendGas||!verified.dividendGas||!same(verified.payer,deployed.payer)||
      previous.walletWork?.size||previous.starting?.size||previous.busy?.size||previous.firing?.size||previous.unlocking||previous.importing||previous.backingUp))throw Error('本机执行合约或任务状态已变化');
   const service=new LiveFastSale({rpc,bridge,data,bindings:walletBindings,deployment:verified});
   save(path.join(data,'fast-deployment.json'),manifest);
   deployed=verified;fastSale=service;fastRuntime.service=service;fastRuntime.start();
   await previous.close?.();
  }
 });

 // Background full planning previously shared the live scanner and metadata
 // promises. A click could inherit unfinished warm reads despite a separate
 // main RPC. Share only completed identities/topology, never pending work.
 const warmDetector=new OpeningPools(warmRpc),warmPreparation=new OpeningPreparation(warmRpc);
 warmDetector.known=detector.known;warmPreparation.entries=preparation.entries;
 engine.primaryPoolHints=t=>{detector.quoteDiscovery.adoptCompleted(t,warmDetector.quoteDiscovery);return detector.quoteDiscovery.knownRoutes(t);};
 detector.hintSource=warmDetector.quoteDiscovery;warmDetector.hintSource=detector.quoteDiscovery;
 engine.warmOpeningScan=(t,o)=>warmDetector.scan(t,{...o,watch:true});engine.warmOpeningPreparation=warmPreparation;
 const sellWarmup=new ManualSellWarmup({scan:engine.warmOpeningScan,preparation:warmPreparation,busy:()=>!warmIdle()});
 const gangWarmup=new GangWarmup({rpc:warmRpc,busy:()=>!warmIdle()});
 const warmTrade=token=>{const gang=gangWarmup.request(token),external=!gangClient(rpc).known.has(token.toLowerCase())&&sellWarmup.request(token);return !!(gang||external);};
 const reconcileOrder=o=>{opening.reconcileOrder?.(o);corla.reconcileOrder?.(o);return o;};
 const tracker=new OriginalTracker({engine,onUpdate:reconcileOrder});
 const enrollment=new TaskEnrollment({engine,corla,opening,rpc:readRpc});
 const instance=randomBytes(12).toString('hex'),updates=providedUpdates||new AppUpdates();
 const readiness=new Map();const settings=()=>load(configFile,{buy:['0.005','0.01','0.02','0.05','0.1'],sell:['10','25','50','75','100']});
 function guard(req){
  const host=req.headers.host;if(!/^(127\.0\.0\.1|localhost):\d+$/.test(host||''))throw Error('Host 不允许');
  // Opening a dashboard link from another site is a top-level navigation,
  // not an API call. Only the public landing document gets this exception.
  const landing=req.method==='GET'&&new URL(req.url,'http://'+host).pathname==='/'&&
   req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document';
  if(!landing&&req.headers.origin&&!['http://'+host].includes(req.headers.origin))throw Error('Origin 不允许');
  if(!landing&&['cross-site','same-site'].includes(req.headers['sec-fetch-site']))throw Error('跨站请求不允许');
 }
 function checkFastOverlap(asset,accounts){
  const token=address(asset).toLowerCase();
  const openingMatch=opening.list().some(j=>!['COMPLETED','CANCELLED','EXPIRED'].includes(j.status)&&j.config?.asset?.toLowerCase()===token&&j.config.accounts.some(a=>accounts.includes(a)));
  const claimMatch=corla.list().some(j=>j.policy?.sell&&!['DONE','STOPPED','CANCELLED','EXPIRED'].includes(j.status)&&accounts.includes(j.account)&&[j.policy.expectedToken,j.mint].some(a=>a?.toLowerCase()===token));
  if(openingMatch||claimMatch)throw Error('所选钱包已有此代币的卖出任务，请先核对原任务');
 }
 function auth(req){const received=req.headers['x-console-token']||'';if(typeof received!=='string'||Buffer.byteLength(received)!==Buffer.byteLength(token)||!timingSafeEqual(Buffer.from(received),Buffer.from(token)))throw Object.assign(Error('本地会话验证失败'),{code:'LOCAL_SESSION_EXPIRED',statusCode:401,details:{requestAccepted:false}});}
 async function body(req,limit=65536){if(!String(req.headers['content-type']).startsWith('application/json'))throw Error('需要 application/json');let b='';for await(const part of req){b+=part;if(b.length>limit)throw Error('请求过大');}return JSON.parse(b);}
 const server=http.createServer(async(req,res)=>{
  const send=(code,v,type='application/json')=>{res.writeHead(code,{'content-type':type+'; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});res.end(type==='application/json'?json(v):v);};
  try{
   guard(req);const u=new URL(req.url,'http://'+req.headers.host),p=u.pathname;
   if(req.method==='GET'&&p==='/api/bootstrap')return send(200,{service:'agent-trade-console',installationId:load(path.join(LOCAL,'install.json'))?.installationId,instance,capabilities:{fastSaleVersion:10,fastSaleSimulationOnly:!deployed,multiWalletVersion:11,sellSlippageMaxBps:9900,shallowPoolVersion:1,previewSubmitSpeedVersion:2,openingPreapprovalVersion:1,starsVersion:2,gangVersion:2,sellCoordinationVersion:7,queuedSellPreviewVersion:3,manualSellPreparationVersion:4,tradePreparationVersion:6,instantGuardsVersion:2,sellQuoteIsolationVersion:3,rpcRecoveryVersion:1,genericMintVersion:3,infinitySellVersion:1,sellFeeGuardVersion:4,sellRouteValueVersion:1,primaryPoolSpeedVersion:2,primaryTradePolicyVersion:1,sellFeeThresholdPpm:HIGH_FEE_PPM,feeRouteSearchVersion:1,sellGasVersion:1,openingVersion:8,tradeWarmupVersion:2,recoveryVersion:1,instantReview:true,corlaVersion:3,corlaAutomationVersion:3,taskCenterVersion:2,originalTrackingVersion:1},token,mode:live?'LIVE':'SIMULATION',wallets:walletBindings(),settings:settings(),readiness:[...readiness.values()],orders:engine.list(30),opening:opening.list(),corla:corla.list()});
   if(p.startsWith('/api/'))auth(req);
   if(req.method==='POST'&&p==='/api/parallel'){
    const {requests}=await body(req,524288);
    if(!Array.isArray(requests)||!requests.length||requests.length>200||new Set(requests.map(r=>r?.body?.id)).size!==requests.length||requests.some(r=>!['run','prepare','execute'].includes(r?.path)||!r.body||typeof r.body.id!=='string'||! /^[a-zA-Z0-9_.:-]{1,160}$/.test(r.body.id)))throw Object.assign(Error('并发请求须为 1–200 个不重复的操作'),{details:{requestAccepted:false}});
    // One authenticated browser connection, independent engine workflows.
    // Stream each result immediately; disconnects never re-dispatch an order.
    res.writeHead(200,{'content-type':'application/x-ndjson; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.flushHeaders();
    await parallelWallets(requests,async({path:action,body:b})=>{
     let row;try{const options={...b,swapReceiptWaitMs:b.fastReturn===true?0:10000};const value=action==='prepare'?await engine.prepare(b.intent,b.id,{retryBlocked:b.retryBlocked===true}):action==='execute'?await engine.execute(b.id,options):await engine.run(b.intent,b.id,options);row={id:b.id,value:reconcileOrder(value)};}
     catch(e){row={id:b.id,error:publicError(e),details:e.details};}
     if(!res.destroyed)res.write(JSON.stringify(row,(_,x)=>typeof x==='bigint'?String(x):x)+'\n');
    });res.end();return;
   }
   if(req.method==='POST'&&p==='/api/trade-warm'){
    const b=await body(req);if(!b||Object.keys(b).length!==1||typeof b.asset!=='string')throw Error('预热只接受交易代币 CA');
    const token=address(b.asset);if(/^0x0{40}$/i.test(token))throw Error('请输入有效的交易代币 CA');return send(200,{scheduled:warmTrade(token)});
   }
   if(req.method==='POST'&&['/api/sell-warm','/api/trade-prepare-warm'].includes(p)){
    const b=await body(req);if(!b||Object.keys(b).length!==1||!Array.isArray(b.intents)||b.intents.length>200)throw Error('交易预热参数无效');
    const warmer=engine.manualSellPreparation;if(!warmer)return send(200,{scheduled:0});
    const intents=b.intents.map(i=>{if(p==='/api/sell-warm'&&i?.side!=='sell')throw Error('卖出预热仅支持卖出');return warmer.intent(i);});
    const idle=warmIdle;
    return send(200,{scheduled:warmer.requestMany?warmer.requestMany(intents,idle):intents.filter(i=>!!warmer.request(i,idle)).length});
   }
   if(req.method==='GET'&&p==='/api/rpc')return send(200,rpcSettings?.status()||{available:false});
   if(req.method==='POST'&&p==='/api/rpc'){
    const b=await body(req);if(!rpcSettings||!b||Object.keys(b).length!==1||typeof b.url!=='string')throw Error('RPC 设置无效');
    return send(200,await rpcSettings.configure(b.url));
   }
   if(req.method==='GET'&&p==='/api/fast-venue'){
    if(!fastSale.adapter?.verifiedVenue)throw Error('当前模式未启用主池核验');
    const v=await fastSale.adapter.verifiedVenue(address(u.searchParams.get('ca')));
    const transferMismatch=!fastSale.adapter.taxAware&&fastSale.jobs?.some(j=>same(j.asset,v.token)&&same(j.venue?.pair,v.pair)&&j.venue?.tokenHash===v.tokenHash&&j.rows.some(r=>r.reason==='TRANSFER_MISMATCH'));
    return send(200,{token:v.token,quote:v.quote,quoteSymbol:v.quoteSymbol,quoteDecimals:v.quoteDecimals,tokenDecimals:v.tokenDecimals,tax:v.tax,dividendGas:!!fastSale.adapter.dividendGas,blockedReason:v.blockedReason,marketPending:!!v.marketPending,transferMismatch:!!transferMismatch});
   }
   if(req.method==='GET'&&p==='/api/fast-sale'){
    await fastSale.refreshPastFills?.();
    return send(200,{...fastSale.status(),settings:load(fastSettingsFile,null),deployment:deploymentManager.status()});
   }
   if(req.method==='POST'&&p.startsWith('/api/fast-sale/deployment/')){
    return send(200,await deploymentManager.run(p.slice('/api/fast-sale/deployment/'.length),await body(req)));
   }
   if(req.method==='POST'&&p==='/api/fast-sale/settings'){const settings=validateFastSettings(await body(req));save(fastSettingsFile,settings);return send(200,{...fastSale.status(),settings});}
   if(req.method==='POST'&&p==='/api/fast-sale/authorize'){
    const b=await body(req);if(!Array.isArray(b.accounts)||!b.accounts.length||new Set(b.accounts).size!==b.accounts.length)throw Error('请选择不重复的钱包');
    const wallets=b.accounts.map(account=>{const w=walletBindings().find(w=>w.account===account);if(!w)throw Error('钱包编号无效');return w;});
    checkFastOverlap(b.asset,b.accounts);
    return send(200,await fastSale.authorize({id:b.id,asset:b.asset,wallets,settings:b.settings,appFreeOnly:b.appFreeOnly}));
   }
   if(req.method==='POST'&&['/api/fast-sale/backup','/api/fast-sale/export-key'].includes(p)){
    if(!deployed)throw Error('本机触发端未启用');return send(200,await fastSale.backup(await body(req),p.split('/').at(-1)));
   }
   if(req.method==='POST'&&['/api/fast-sale/setup','/api/fast-sale/unlock','/api/fast-sale/generated','/api/fast-sale/import-key'].includes(p)){
    if(!deployed)throw Error('主网执行合约未启用');
    const input=await body(req);
    const action=p.split('/').at(-1);
    let result;
    if(action==='setup')result=await fastSale.setupManaged(input);
    else if(action==='unlock')result=await fastSale.unlock(input);
    else result=await fastSale.configureKey(action,input);
    if(result.cancelled)return send(200,{cancelled:true});
    const settings=load(fastSettingsFile,null);if(settings&&settings.trigger!==result.trigger)save(fastSettingsFile,{...settings,trigger:result.trigger});
    return send(200,result);
   }
   if(req.method==='POST'&&p==='/api/fast-sale/start'){
    const b=await body(req);
    if(!deployed||!Array.isArray(b.accounts)||!b.accounts.length||b.accounts.some(a=>!walletBindings().some(w=>w.account===a)))throw Error('主网执行合约或钱包选择无效');
    checkFastOverlap(b.asset,b.accounts);
    return send(200,await fastSale.start(b));
   }
   if(req.method==='POST'&&p==='/api/fast-sale/confirm-ratings'){
    const b=await body(req);if(!deployed||!Array.isArray(b.reviews))throw Error('当前部署或钱包预览无效');
    checkFastOverlap(b.asset,b.reviews.map(r=>r.account));return send(200,await fastSale.confirmRatings(b));
   }
   if(req.method==='POST'&&p==='/api/fast-sale/control'){const b=await body(req);return send(200,await fastSale.control(b.id,b.action));}
   if(req.method==='GET'&&p==='/api/updates')return send(200,await updates.check());
   if(req.method==='GET'&&p==='/api/tasks')return send(200,{instance,corla:corla.list(),opening:opening.list(),paused:pausedTasks(corla,opening)});
   if(req.method==='GET'&&p==='/api/tasks/candidates')return send(200,await enrollment.candidates());
   if(req.method==='POST'&&p==='/api/tasks/add')return send(200,await enrollment.add(await body(req)));
   if(req.method==='POST'&&p==='/api/tasks/edit')return send(200,editTasks(corla,opening,await body(req)));
   if(req.method==='POST'&&p==='/api/tasks/resume')return send(200,resumeTasks(corla,opening,await body(req)));
   if(req.method==='POST'&&['/api/tasks/pause','/api/tasks/delete','/api/tasks/restore'].includes(p))return send(200,controlTasks(corla,opening,p.split('/').at(-1),await body(req)));
   if(req.method==='GET'&&p==='/api/order'){const o=engine.get(u.searchParams.get('id'));if(!o)throw Error('未找到原单');return send(200,o);}
   if(req.method==='POST'&&p==='/api/reconcile'){const b=await body(req),accounts=b.accounts||walletBindings().map(w=>w.account);if(!Array.isArray(accounts)||accounts.some(a=>!walletBindings().some(w=>w.account===a)))throw Error('钱包编号无效');return send(200,await Promise.all([...new Set(accounts)].map(a=>engine.reconcileAccount(a))));}
   if(req.method==='GET'&&p==='/api/corla-jobs')return send(200,corla.list());
   if(req.method==='POST'&&p==='/api/corla-stop'){const b=await body(req);return send(200,corla.pause(b.id));}
   if(req.method==='POST'&&p==='/api/corla-resume'){const b=await body(req);if(b.confirmed!==true)throw Error('需要点击恢复任务');return send(200,corla.resume(b.id));}
   if(req.method==='GET'&&p==='/api/opening')return send(200,opening.list());
   if(req.method==='POST'&&p==='/api/opening/check')return send(200,await opening.check(await body(req)));
   if(req.method==='POST'&&p==='/api/opening/arm'){const b=await body(req);return send(200,opening.arm(b.id,{confirmed:b.confirmed}));}
   if(req.method==='POST'&&p==='/api/opening/stop'){const b=await body(req);return send(200,opening.pause(b.id));}
   if(req.method==='GET'&&p==='/api/market')return send(200,await market(readRpc,u.searchParams.get('ca')));
   if(req.method==='GET'&&p==='/api/holdings'){
    const result=await holdings(readRpc,u.searchParams.get('ca'));send(200,result);
    if(result.assetType==='ERC20')warmTrade(result.token);
    return;
   }
   if(req.method==='GET'&&p==='/api/wallets')return send(200,await walletOverview(readRpc,bridge,readiness));
   if(req.method==='POST'&&p==='/api/refresh-wallets'){await body(req);return send(200,await walletOverview(readRpc,bridge,readiness,{checkConnection:true}));}
   if(req.method==='GET'&&p==='/api/discover')return send(200,await discover(u.searchParams.get('asset'),{rpc:readRpc,chainFallback:true,learn:u.searchParams.get('learn')==='1'}));
   if(req.method==='GET'&&p==='/api/project')return send(200,await inspectProject(readRpc,bridge,u.searchParams.get('asset'),{experience:engine.experience,learn:u.searchParams.get('learn')==='1'}));
   if(req.method==='GET'&&p==='/api/orders')return send(200,u.searchParams.get('summary')==='1'?engine.history(50):engine.list(50));
   if(req.method==='POST'&&p==='/api/shutdown'){
    if(deploymentManager.busy||fastSale.backingUp||fastSale.importing||fastSale.unlocking||fastSale.starting?.size||fastSale.jobs?.some(j=>['AUTHORIZING','REGISTERING','ARMED'].includes(j.status)||j.rows.some(r=>['PENDING','APPROVAL_PENDING','REGISTRATION_PENDING'].includes(r.status)))||corla.active()||opening.active()||engine.running.size||engine.list().some(o=>['PENDING','SUBMITTING','SUBMISSION_UNKNOWN','APPROVAL_CONFIRMED','READY_TO_CONTINUE','RECEIPT_REVIEW'].includes(o.status)))throw Error('存在运行中或待核对原单，暂不能切换模式');
    send(200,{stopping:true});setTimeout(()=>{engine.manualSellPreparation?.close();tracker.close();corla.close();opening.close();server.close();bridge.close();server.closeIdleConnections();},100);return;
   }
   if(req.method==='POST'&&p==='/api/ready'){const b=await body(req);const result=await Promise.all(walletBindings().filter(w=>!b.account||w.account===b.account).map(async w=>{try{const r=await bridge.ready(w.account,{force:true});readiness.set(w.account,r);return r;}catch(e){const r={...w,status:'ERROR',error:e.message};readiness.set(w.account,r);return r;}}));return send(200,result);}
   if(req.method==='POST'&&p==='/api/settings'){const s=validateSettings(await body(req));save(configFile,s);return send(200,s);}
   if(req.method==='POST'&&p==='/api/prepare'){const b=await body(req);return send(200,await engine.prepare(b.intent,b.id,{retryBlocked:b.retryBlocked===true}));}
   if(req.method==='POST'&&p==='/api/select-mint-route'){const b=await body(req);return send(200,await engine.selectMintRoute(b.id,b.routeId));}
   if(req.method==='POST'&&p==='/api/execute'){const b=await body(req);return send(200,reconcileOrder(await engine.execute(b.id,{...b,swapReceiptWaitMs:b.fastReturn===true?0:10000})));}
   if(req.method==='POST'&&p==='/api/batch')return send(200,await batches.run(await body(req)));
   if(req.method==='POST'&&p==='/api/run'){const b=await body(req);return send(200,reconcileOrder(await engine.run(b.intent,b.id,{...b,swapReceiptWaitMs:b.fastReturn===true?0:10000})));}
   if(req.method==='POST'&&p==='/api/follow'){const b=await body(req);return send(200,reconcileOrder(await engine.follow(b.id)));}
   if(req.method==='POST'&&p==='/api/stop-remaining'){const b=await body(req);return send(200,await engine.stopRemaining(b.id));}
   if(req.method==='GET'&&['/','/app.js','/task-center.mjs','/app-updates.mjs','/rpc-settings.mjs','/fast-sale.mjs','/mint-quantity.mjs','/binancians-input.mjs','/corla-input.mjs','/corla-view.mjs','/corla-budget.mjs','/review-model.mjs','/error-message.mjs','/failure-kind.mjs','/trade-workflow.mjs','/trade-warmup.mjs','/asset-input.mjs','/session-client.mjs','/style.css','/favicon.svg'].includes(p)){const file=path.join(HERE,'public',p==='/'?'index.html':p.slice(1));return send(200,fs.readFileSync(file,'utf8'),/\.m?js$/.test(p)?'text/javascript':p.endsWith('.css')?'text/css':p.endsWith('.svg')?'image/svg+xml':'text/html');}
   return send(404,{error:'未找到接口'});
  }catch(e){return send(e.code==='LOCAL_SESSION_EXPIRED'&&e.statusCode===401?401:400,{error:publicError(e),details:e.details,diagnostics:e.diagnostics});}
 });
 server.on('close',()=>{fastRuntime.close();void fastSale.close?.()?.catch?.(()=>{});});
 let warming=null;
 function warm(){
  if(warmIdle())void rpcSettings?.warm().catch(()=>{});
  if(warming)return warming;
  const pending=bindings();let index=0;
  warming=Promise.all(Array.from({length:Math.min(4,pending.length)},async()=>{
   while(index<pending.length){const w=pending[index++];
    if(engine.running.has(w.account)||bridge.queues?.has(w.account)||!bridge.warm)continue;
    try{const result=await bridge.warm(w.account);if(result)readiness.set(w.account,result);}
    catch(e){readiness.set(w.account,{...w,status:'ERROR',error:e.message});}
   }
  })).finally(()=>{warming=null;});return warming;
 }
 server.on('listening',()=>{tracker.start();if(rpcSettings)void rpc.verifyChain().catch(()=>{});});server.on('close',()=>{engine.manualSellPreparation?.close();gangWarmup.close();sellWarmup.close();tracker.close();corla.close();opening.close();void rpcSettings?.close()?.catch(()=>{});});
 return {server,engine,bridge,token,warm,rpc,readRpc,opening,corla,rpcSettings,enrollment,tracker,get fastSale(){return fastSale;}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const install=load(path.join(LOCAL,'install.json'));if(!install?.installationId)throw Error('请先运行 python3 setup.py');const live=true;if(install.liveEnabled!==true)throw Error('请重新运行安装器更新配置；用户入口仅提供真实交易模式');const port=0;
 fs.mkdirSync(DATA,{recursive:true,mode:0o700});const lock=path.join(DATA,'service.lock');
 const previous=load(lock);if(previous){let alive=true;try{process.kill(previous.pid,0);}catch{alive=false;}if(alive)throw Error('已有交易台进程使用此数据目录');fs.unlinkSync(lock);}
 const fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,json({pid:process.pid}));fs.closeSync(fd);
 const release=()=>{if(load(lock)?.pid===process.pid)fs.unlinkSync(lock);};process.on('exit',release);
 const app=createServer({live});let timer;app.server.on('close',()=>{clearInterval(timer);release();});app.server.on('error',()=>release());
 app.server.listen(port,'127.0.0.1',()=>{const port=app.server.address().port;save(path.join(DATA,'service.json'),{installationId:install.installationId,pid:process.pid,port,mode:live?'LIVE':'SIMULATION',startedAt:Date.now()});console.log(`Agent 交易台 http://127.0.0.1:${port} · ${live?'真实交易模式':'模拟模式（不签名、不广播）'}`);});
 app.warm().catch(()=>{});timer=setInterval(()=>app.warm().catch(()=>{}),15000);timer.unref();
 const close=()=>{app.tracker.close();app.corla.close();app.opening.close();app.server.close();app.bridge.close();setTimeout(()=>process.exit(0),12000).unref();};process.on('SIGINT',close);process.on('SIGTERM',close);
}
