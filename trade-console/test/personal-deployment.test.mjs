import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {keccak256,id} from 'ethers';
import {PersonalDeployment,deploymentInput,inspectDeployment} from '../lib/delegated-sale/personal-deployment.mjs';
import {DEPLOY_PROXY,INIT_HASH,PROXY_HASH,personalExecutor} from '../lib/delegated-sale/personal-address.mjs';
import {TAX_BSC_SALE,pinnedBscSale,BscVenue} from '../lib/delegated-sale/bsc.mjs';
import {save} from '../lib/common.mjs';

import {dividendInitHash,dividendRuntimeHash,dividendBatch,standardBatch,heelsIdentity,batchGas} from '../lib/delegated-sale/dividend-gas.mjs';

const latest=payer=>personalExecutor(payer,dividendInitHash);
const address=n=>'0x'+n.toString(16).padStart(40,'0');
const proxy='0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3';
const init=fs.readFileSync(new URL('../lib/delegated-sale/executor-init.txt',import.meta.url),'utf8').trim();
// solc 0.8.38 immutableReferences on the published build. Materialize the verified BSC runtime offline.
function runtime(legacy=false){
 const wide=deploymentInput(address(1)).slice(66);
 const bytes=legacy?Buffer.from(init.slice(2),'hex').subarray(662,662+14755):Buffer.from(wide,'hex').subarray(671,671+15266);
 for(const [value,offsets] of [
  [TAX_BSC_SALE.factory,legacy?[1498,4750,6516,6734,6989,7328,11840]:[1573,5261,7027,7245,7500,7839,12351]],
  ['0x9e8d17faaee69b053be6ac65b2b2c317741d770cb5fbdd9512536d17e9e076ca',legacy?[1396,4717]:[1471,5228]],
  ['0x60e4bcb14447615ab7c14fda2c2d70ca4191570e8841c75618e627c8f72662f8',legacy?[557,7271]:[579,7782]],
  [TAX_BSC_SALE.wrapped,legacy?[302,608,3919,4155,4857,8638]:[324,661,4430,4666,5368,9149]],
  ['0xb7d84205eaaf83ce7b3940c6beaad6d22790255e34a9a2b486aa8cdfff118fe6',legacy?[1447,4824]:[1522,5335]]
 ])for(const at of offsets)Buffer.from(value.slice(2).padStart(64,'0'),'hex').copy(bytes,at);
 return '0x'+bytes.toString('hex');
}
const code=runtime();
function fixture(t){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'personal-executor-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));
 const ctx={code:'0x',submitted:0,activated:0,receipt:null};
 const hash=id('synthetic deployment');
 const rpc={send:async(method,args)=>{
  switch(method){
   case 'eth_chainId':return '0x38';
   case 'eth_getCode':return args[0]===DEPLOY_PROXY?proxy:ctx.code;
   case 'eth_call':return args[0].to?latest(args[0].from):code;
   case 'eth_estimateGas':return '0x300000';
   case 'eth_gasPrice':return '0x5f5e100';
   case 'eth_getTransactionByHash':return {hash,from:address(1),to:DEPLOY_PROXY,input:deploymentInput(address(1)),value:'0x0'};
   case 'eth_getTransactionReceipt':return ctx.receipt;
   default:throw Error('unexpected mock RPC');
  }
 }};
 const bridge={ready:async()=>{},call:async(n,args)=>{
  if(args[1]==='preview')return {requestId:'fake-'+n,risks:[],parsedTx:{contractAddress:DEPLOY_PROXY},simulationResult:{simulationCode:'000000000'}};
  assert.deepEqual(args,['contract-call','execute','--requestId','fake-'+n]);ctx.submitted++;
  if(ctx.disconnect)throw Error('synthetic disconnect');
  return {txHash:hash};
 }};
 const config={data,rpc,witness:rpc,bindings:()=>[1,2].map(n=>({account:n,address:address(n)})),bridge,enabled:()=>true,
  activate:m=>{ctx.activated++;save(path.join(data,'fast-deployment.json'),m);}};
 return {config,make:()=>new PersonalDeployment(config),ctx,hash};
}
test('personal address binds the payer and the exact audited constructor; arbitrary destinations cannot be selected',()=>{
 assert.equal(keccak256(proxy),PROXY_HASH);assert.equal(keccak256(init),INIT_HASH);assert.equal(keccak256(runtime(true)),TAX_BSC_SALE.executorHash);assert.equal(keccak256(code),dividendRuntimeHash);
 const first=personalExecutor(address(1)), other=personalExecutor(address(2));
 assert.notEqual(first,other);
 assert.equal(pinnedBscSale(first,TAX_BSC_SALE.executorHash,address(1)).executor,first);
 assert.equal(pinnedBscSale(first,TAX_BSC_SALE.executorHash,address(2)),undefined);
 assert.equal(pinnedBscSale(first,TAX_BSC_SALE.executorHash),undefined);
 assert.throws(()=>new BscVenue({}, {...TAX_BSC_SALE,executor:other,payer:address(1)}));
});
test('preview is read-only; payment needs a matching wallet and ticket, replay follows original',async t=>{
 const {ctx,make,hash}=fixture(t);const service=make(),r=await service.run('preview',{account:1});
 assert.equal(ctx.submitted,0);assert.ok(r.ticket&&r.fee);
 await assert.rejects(service.run('execute',{account:2,ticket:r.ticket}));
 await assert.rejects(service.run('execute',{account:1,ticket:'wrong'}));
 const submit=()=>service.run('execute',{account:1,ticket:r.ticket});await Promise.allSettled([submit(),submit()]);
 assert.equal(ctx.submitted,1);assert.equal((await make().run('check',{})).state,'SUBMITTED');
 await submit();assert.equal(ctx.submitted,1);ctx.receipt={transactionHash:hash,status:'0x1'};ctx.code=code;
 const ready=await make().run('check',{});assert.equal(ready.executor,latest(address(1)));assert.equal(ready.state,'PERSONAL');
 assert.equal(ctx.activated,1);
});
test('disconnect after dispatch survives restart and recovers by deterministic address',async t=>{
 const {ctx,make}=fixture(t);const service=make();const r=await service.run('preview',{account:1});
 ctx.disconnect=true;await service.run('execute',{account:1,ticket:r.ticket});await make().run('preview',{account:1});
 await assert.rejects(make().run('preview',{account:2}));assert.equal(ctx.submitted,1);
 ctx.code=code;assert.equal((await make().run('check',{})).state,'PERSONAL');assert.equal(ctx.submitted,1);
});
test('reinstall reuses existing verified personal contract with zero wallet calls',async t=>{
 const {config,make,ctx}=fixture(t);ctx.code=code;config.bridge=null;
 assert.equal((await make().run('preview',{account:2})).executor,latest(address(2)));
 assert.equal(ctx.submitted,0);
});
test('both observers must agree, and reject wrong network, proxy and runtime',async t=>{
 const {config,make,ctx}=fixture(t);
 for(const [method,wrong] of [['eth_chainId','0x1'],['eth_getCode','0x01']]){
  await assert.rejects(inspectDeployment({send:(m,a)=>m===method?wrong:config.rpc.send(m,a)},latest(address(1))));
 }
 ctx.code='0x6001';await assert.rejects(make().run('preview',{account:1}),/代码指纹/);
 ctx.code='0x';config.witness={send:(m,a)=>m==='eth_getCode'&&a[0]!==DEPLOY_PROXY?code:config.rpc.send(m,a)};
 await assert.rejects(make().run('preview',{account:1}),/尚未一致/);assert.equal(ctx.submitted,0);
});
for(const upgrade of [false,true])test('个人合约从'+(upgrade?'旧版升级':'全新安装')+'后可即时使用，重启沿用同一地址',async t=>{
 const {config,ctx,hash}=fixture(t);
 const {createServer}=await import('../server.mjs');
 const start=async()=>{
  const app=createServer({data:config.data,rpc:config.rpc,deploymentWitness:config.witness,bridge:config.bridge,walletBindings:config.bindings,engine:{live:true,list:()=>[],running:new Set()},live:true});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const root='http://127.0.0.1:'+app.server.address().port;
  const post=async(action,body,authorized=true)=>fetch(root+'/api/fast-sale/deployment/'+action,{method:'POST',headers:{'content-type':'application/json',...(authorized?{'x-console-token':app.token}:{})},body:JSON.stringify(body)});
  return {app,root,post,close:()=>new Promise(resolve=>app.server.close(resolve))};
 };
 if(upgrade)save(path.join(config.data,'fast-deployment.json'),{...TAX_BSC_SALE,payer:address(1),executor:personalExecutor(address(1))});
 const first=await start();
 try{
  if(upgrade)assert.equal(first.app.fastSale.status().executor,personalExecutor(address(1)));
  assert.match(await (await fetch(first.root)).text(),/id="fastDeploy"/);
  assert.ok((await first.post('preview',{account:1},false)).status>=400);
  const r=await (await first.post('preview',{account:1})).json();
  assert.ok(r.ticket);assert.equal(ctx.submitted,0);
  const submitted=await (await first.post('execute',{account:1,ticket:r.ticket})).json();
  assert.equal(submitted.state,'SUBMITTED');
  ctx.receipt={transactionHash:hash,status:'0x1'};ctx.code=code;
  assert.equal((await (await first.post('check',{})).json()).state,'PERSONAL');
  assert.equal(first.app.fastSale.status().executor,latest(address(1)));
  const venue={token:address(8),quote:address(9),quoteSymbol:'BNB',quoteDecimals:18,tokenDecimals:9,tax:{buyBps:100,sellBps:200},marketPending:true};
  first.app.fastSale.adapter.verifiedVenue=async token=>{assert.equal(token,venue.token);return venue;};
  const readVenue=()=>fetch(first.root+'/api/fast-venue?ca='+venue.token,{headers:{'x-console-token':first.app.token}}).then(res=>res.json());
  assert.deepEqual(await readVenue(),{...venue,dividendGas:true,transferMismatch:false,registerAfterOpening:false});
  venue.registerAfterOpening=true;
  assert.equal((await readVenue()).registerAfterOpening,true);
  venue.blockedReason='主池身份尚未核实';assert.equal((await readVenue()).blockedReason,venue.blockedReason);
 }finally{await first.close();}
 const restarted=await start();
 try{assert.equal(restarted.app.fastSale.status().executor,latest(address(1)));assert.equal(ctx.submitted,1);}
 finally{await restarted.close();}
});

test('新版只启用当前钱包派生的个人合约，分红 Gas 按代币分批',()=>{
 const payer=address(1),executor=latest(payer);
 assert.notEqual(executor,latest(address(2)));assert.notEqual(executor,personalExecutor(payer));
 assert.equal(pinnedBscSale(executor,dividendRuntimeHash,address(2)),undefined);
 assert.equal(pinnedBscSale(executor,dividendRuntimeHash),undefined);
 assert.equal(pinnedBscSale(executor,TAX_BSC_SALE.executorHash,payer),undefined);
 const adapter=new BscVenue({}, {executor,executorHash:dividendRuntimeHash,payer});
 assert.equal(adapter.batchSpec(heelsIdentity),dividendBatch);assert.equal(adapter.batchSpec({token:address(9)}),standardBatch);
 assert.equal(batchGas(dividendBatch,8),11960000n);
});
test('已安装用户沿用原付款钱包升级，存在旧任务时禁止切换',async t=>{
 const {config,make,ctx}=fixture(t),svc=make(),payer=address(2);
 const legacy={chainId:56,payer,executor:personalExecutor(payer),executorHash:TAX_BSC_SALE.executorHash};
 save(svc.manifest,legacy);assert.equal(svc.status().upgradeAccount,2);
 await assert.rejects(svc.run('preview',{account:1}),/原个人合约/);
 const jobs=path.join(config.data,'fast-sale-mainnet-jobs.json');
 save(jobs,[{executor:legacy.executor,status:'ARMED'}]);await assert.rejects(svc.run('preview',{account:2}),/任务或原单/);
 save(jobs,[]);const review=await svc.run('preview',{account:2});
 assert.equal(review.executor,latest(payer));assert.equal(ctx.submitted,0);
 ctx.code=code;const ready=await svc.run('check',{});assert.equal(ready.state,'PERSONAL');assert.equal(ready.executor,latest(payer));
 save(svc.manifest,{...legacy,payer:address(3)});assert.equal(svc.status().state,'OTHER_WALLET');
 await assert.rejects(svc.run('preview',{account:1}),/未绑定/);
});
test('升级安装遇到旧版未决部署时只核对原单，再提供新版预览',async t=>{
 const {config,make,ctx}=fixture(t),payer=address(1),old=personalExecutor(payer);
 save(path.join(config.data,'personal-deployment.json'),{state:'SUBMITTING',account:1,payer,executor:old});
 const svc=make();assert.equal((await svc.run('check',{})).state,'SUBMITTING');
 ctx.code=runtime(true);assert.equal((await svc.run('check',{})).state,'UPGRADE');
 ctx.code='0x';assert.equal((await svc.run('preview',{account:1})).executor,latest(payer));
 assert.equal(ctx.submitted,0);
});
