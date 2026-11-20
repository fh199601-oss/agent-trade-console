// Deployment uses the bound Agent wallet only after a separate, expiring preview.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {concat, formatEther, keccak256} from 'ethers';
import {load, same, save} from '../common.mjs';
import {verifyPreview} from '../engine.mjs';
import {hasPreviewRisks} from '../preview-risks.mjs';
import {TAX_BSC_SALE, activeDeployment, pinnedBscSale} from './bsc.mjs';
import {DEPLOY_PROXY, INIT_HASH, PROXY_HASH, personalExecutor, personalSalt} from './personal-address.mjs';

import {dividendInitHash, dividendRuntimeHash} from './dividend-gas.mjs';

const pending = state => ['SUBMITTING', 'SUBMITTED'].includes(state);
export function deploymentInput(payer, legacy=false) {
  const file=legacy?'./executor-init.txt':'./executor-dividend-init.txt';
  const init = fs.readFileSync(new URL(file, import.meta.url), 'utf8').trim();
  if (keccak256(init) !== (legacy?INIT_HASH:dividendInitHash)) throw Error('部署包代码指纹不符');
  return concat([personalSalt(payer), init]);
}
export async function inspectDeployment(rpc, executor, expectedHash=dividendRuntimeHash) {
  const [chain, proxy, code] = await Promise.all([
    rpc.send('eth_chainId', []),
    rpc.send('eth_getCode', [DEPLOY_PROXY, 'latest']),
    rpc.send('eth_getCode', [executor, 'latest'])
  ]);
  if (BigInt(chain) !== 56n || keccak256(proxy) !== PROXY_HASH) throw Error('BNB 主网或部署入口指纹不符');
  if (code === '0x') return false;
  if (keccak256(code) !== expectedHash) throw Error('个人合约的链上代码指纹不符');
  return true;
}
export class PersonalDeployment {
  constructor({data, rpc, witness, bridge, bindings, activate, enabled}) {
    Object.assign(this, {data, rpc, witness, bridge, bindings, activate, enabled});
    this.manifest = path.join(data, 'fast-deployment.json');
    this.oldFile = path.join(data, 'personal-deployment.json');
    this.file = path.join(data, 'personal-deployment.json.v3');
  }
  deploymentRecord(installed) {
    // A pre-update broadcast must finish against the original bytecode and salt.
    const old=load(this.oldFile,{});
    const legacy=!installed&&(pending(old.state)||fs.existsSync(this.oldFile+'.dispatch'));
    const file=legacy?this.oldFile:this.file,lock=file+'.dispatch';
    const prior=legacy?old:load(file,{});
    return {file,lock,prior,legacy,locked:pending(prior.state)||fs.existsSync(lock)};
  }
  status() {
    const manifest=load(this.manifest);
    let upgradeAccount;
    if(manifest){
      const bound=this.bindings().find(w=>same(w.address,manifest.payer));
      const pin=pinnedBscSale(manifest.executor,manifest.executorHash,manifest.payer);
      if(!bound||manifest.chainId!==56||!pin)return {state:'OTHER_WALLET'};
      if(pin.dividendGas)return {state:'PERSONAL',executor:pin.executor,payer:pin.payer};
      upgradeAccount=bound.account;
    }
    const {prior,locked}=this.deploymentRecord(manifest);
    const state=locked&&!pending(prior.state)?'SUBMITTING':prior.state||(upgradeAccount?'UPGRADE':'NEW');
    return {state,account:prior.account,upgradeAccount,executor:prior.executor,fee:prior.fee,available:this.enabled()};
  }
  async run(action, input) {
    if (!this.enabled()) throw Error('当前看板未启用主网部署');
    if (this.busy) throw Error('正在处理本机部署，请稍候核对原单');
    this.busy = true;
    try { return await this.process(action, input); } finally { this.busy = false; }
  }
  async process(action, {account, ticket}) {
    if (!['preview','execute','check'].includes(action)) throw Error('部署操作无效');
    const installed=load(this.manifest);
    const {prior,file,lock,legacy,locked}=this.deploymentRecord(installed);
    if(installed){
      const pin=pinnedBscSale(installed.executor,installed.executorHash,installed.payer);
      if(installed.chainId!==56||!pin||!this.bindings().some(w=>same(w.address,installed.payer)))throw Error('执行合约未绑定当前用户的钱包');
      if(pin.dividendGas)return this.status();
    }
    if (action === 'check') account = prior.account;
    const bound = this.bindings().find(w => w.account === account);
    if (!bound) throw Error('请选择已绑定的部署付款钱包');
    const payer = bound.address, executor = personalExecutor(payer,legacy?INIT_HASH:dividendInitHash);
    if(installed&&!same(installed.payer,payer))throw Error('升级须使用原个人合约的部署付款钱包');
    const manifest = {chainId:56, executor, payer, executorHash:legacy?TAX_BSC_SALE.executorHash:dividendRuntimeHash};
    const jobs = load(path.join(this.data, 'fast-sale-mainnet-jobs.json'), []);
    if (!activeDeployment(manifest, jobs)) throw Error('本机还有其他执行合约的任务或原单，请先处理');
    if ((locked || action !== 'preview') && (prior.account !== account || !same(prior.payer,payer) || !same(prior.executor,executor))) throw Error('请核对原部署钱包及绑定地址');
    const input = deploymentInput(payer,legacy);
    const seen = await Promise.all([this.rpc,this.witness].map(rpc => inspectDeployment(rpc, executor, manifest.executorHash)));
    if (seen[0] !== seen[1]) throw Error('两个节点的部署状态尚未一致，请稍后核对');
    if (prior.hash && locked) {
      const [tx,receipt] = await Promise.all([this.rpc.send('eth_getTransactionByHash',[prior.hash]),this.rpc.send('eth_getTransactionReceipt',[prior.hash])]);
      if (!tx || !receipt) return this.status();
      if (!same(tx.hash,prior.hash) || !same(receipt.transactionHash,prior.hash) || !same(tx.from,payer) || !same(tx.to,DEPLOY_PROXY) ||
          BigInt(tx.value)!==0n || !same(tx.input,input)) throw Error('部署交易与原预览不符');
      if (BigInt(receipt.status)===0n && !seen[0]) {
        save(file,{...prior,state:'REVERTED'}); fs.rmSync(lock,{force:true});
        return this.status();
      }
      if (BigInt(receipt.status)!==1n && !seen[0]) throw Error('原部署回执状态未识别');
    }
    if (seen[0]) {
      await this.activate(manifest);
      fs.rmSync(lock,{force:true});
      return this.status();
    }
    if (locked || action==='check') return this.status();
    const tx = {from:payer, to:DEPLOY_PROXY, data:input, value:'0x0'};
    if (action === 'preview') {
      const [runtime, result, gas, price] = await Promise.all([this.witness.send('eth_call',[{from:payer,data:'0x'+input.slice(66)},'latest']),this.rpc.send('eth_call',[tx,'latest']),this.rpc.send('eth_estimateGas',[tx]),this.rpc.send('eth_gasPrice',[])]);
      if (keccak256(runtime)!==manifest.executorHash || !same(result,executor) || BigInt(gas)<=0n || BigInt(price)<=0n) throw Error('个人部署的预期地址或 Gas 估算未通过核验');
      await this.bridge.ready(account,{external:true});
      const preview = await this.bridge.call(account,['contract-call','preview','--binanceChainId','56','--from',payer,'--to',DEPLOY_PROXY,'--value','0','--inputData',input]);
      verifyPreview(preview,{wallet:payer,amountIn:'0'},{kind:'deploy',to:DEPLOY_PROXY,value:'0',data:input});
      if (preview.simulationResult.allowanceChanges?.length || preview.simulationResult.authorityChanges?.length || hasPreviewRisks(preview.risks)) throw Error('部署预览包含意外授权或风险提示');
      const review = {state:'PREVIEWED',account,payer,executor,ticket:randomUUID(),at:Date.now(),requestId:preview.requestId,fee:formatEther(BigInt(gas)*BigInt(price))};
      save(file,review);
      return {...this.status(),ticket:review.ticket};
    }
    if (prior.state!=='PREVIEWED' || !ticket || ticket!==prior.ticket || Date.now()-prior.at>180000) throw Error('请重新预览部署费用后确认');
    await this.bridge.ready(account,{external:true});
    if (!this.bindings().some(w=>w.account===account && same(w.address,payer))) throw Error('部署钱包绑定已变化');
    // Atomic across processes. Persist the request ID before dispatch and only follow this attempt.
    fs.closeSync(fs.openSync(lock,'wx',0o600));
    save(file,{...prior,state:'SUBMITTING'});
    const record = res => {
      const original = load(file);
      if (original?.ticket !== ticket || !pending(original.state)) return;
      save(file,{...original,state:'SUBMITTED',hash:res?.txHash||res?.transactionHash||original.hash,orderId:res?.orderId||original.orderId});
    };
    try {
      record(await this.bridge.call(account,['contract-call','execute','--requestId',prior.requestId],{onLateResponse:r=>{if(r.data)record(r.data);}}));
    } catch (err) {
      if (err.dispatched===false) {
        save(file,{...prior,state:'NOT_SENT'});fs.rmSync(lock,{force:true});throw err;
      }
    }
    return this.status();
  }
}
