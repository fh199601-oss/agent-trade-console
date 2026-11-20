// Deployment uses the bound Agent wallet only after a separate, expiring preview.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {concat, formatEther, keccak256} from 'ethers';
import {load, same, save} from '../common.mjs';
import {verifyPreview} from '../engine.mjs';
import {hasPreviewRisks} from '../preview-risks.mjs';
import {TAX_BSC_SALE, activeDeployment} from './bsc.mjs';
import {DEPLOY_PROXY, INIT_HASH, PROXY_HASH, personalExecutor, personalSalt} from './personal-address.mjs';

const pending = state => ['SUBMITTING', 'SUBMITTED'].includes(state);
export function deploymentInput(payer) {
  const init = fs.readFileSync(new URL('./executor-init.txt', import.meta.url), 'utf8').trim();
  if (keccak256(init) !== INIT_HASH) throw Error('部署包代码指纹不符');
  return concat([personalSalt(payer), init]);
}
export async function inspectDeployment(rpc, executor) {
  const [chain, proxy, code] = await Promise.all([
    rpc.send('eth_chainId', []),
    rpc.send('eth_getCode', [DEPLOY_PROXY, 'latest']),
    rpc.send('eth_getCode', [executor, 'latest'])
  ]);
  if (BigInt(chain) !== 56n || keccak256(proxy) !== PROXY_HASH) throw Error('BNB 主网或部署入口指纹不符');
  if (code === '0x') return false;
  if (keccak256(code) !== TAX_BSC_SALE.executorHash) throw Error('个人合约的链上代码指纹不符');
  return true;
}
export class PersonalDeployment {
  constructor({data, rpc, witness, bridge, bindings, activate, enabled}) {
    Object.assign(this, {data, rpc, witness, bridge, bindings, activate, enabled});
    this.manifest = path.join(data, 'fast-deployment.json');
    this.file = path.join(data, 'personal-deployment.json');
    this.lock = this.file + '.dispatch';
  }
  status() {
    const manifest = load(this.manifest);
    if (manifest) {
      if (manifest.payer && !this.bindings().some(w=>same(w.address,manifest.payer))) return {state:'OTHER_WALLET', executor:manifest.executor};
      return {state:manifest.payer?'PERSONAL':'EXISTING', executor:manifest.executor, payer:manifest.payer};
    }
    const r = load(this.file, {});
    return {state:fs.existsSync(this.lock) && !pending(r.state) ? 'SUBMITTING' : r.state || 'NEW', account:r.account, executor:r.executor, fee:r.fee, available:this.enabled()};
  }
  async run(action, input) {
    if (!this.enabled()) throw Error('当前看板未启用主网部署');
    if (this.busy) throw Error('正在处理本机部署，请稍候核对原单');
    this.busy = true;
    try { return await this.process(action, input); } finally { this.busy = false; }
  }
  async process(action, {account, ticket}) {
    if (!['preview','execute','check'].includes(action)) throw Error('部署操作无效');
    const prior = load(this.file, {});
    if (load(this.manifest)) throw Error('本机已配置执行合约，请沿用现有部署');
    if (action === 'check') account = prior.account;
    const bound = this.bindings().find(w => w.account === account);
    if (!bound) throw Error('请选择已绑定的部署付款钱包');
    const payer = bound.address, executor = personalExecutor(payer);
    const manifest = {chainId:56, executor, payer, executorHash:TAX_BSC_SALE.executorHash};
    const jobs = load(path.join(this.data, 'fast-sale-mainnet-jobs.json'), []);
    if (!activeDeployment(manifest, jobs)) throw Error('本机还有其他执行合约的任务或原单，请先处理');
    const locked = fs.existsSync(this.lock) || pending(prior.state);
    if ((locked || action !== 'preview') && (prior.account !== account || !same(prior.payer,payer) || !same(prior.executor,executor))) throw Error('请核对原部署钱包及绑定地址');
    const input = deploymentInput(payer);
    const seen = await Promise.all([this.rpc,this.witness].map(rpc => inspectDeployment(rpc, executor)));
    if (seen[0] !== seen[1]) throw Error('两个节点的部署状态尚未一致，请稍后核对');
    if (prior.hash && locked) {
      const [tx,receipt] = await Promise.all([this.rpc.send('eth_getTransactionByHash',[prior.hash]),this.rpc.send('eth_getTransactionReceipt',[prior.hash])]);
      if (!tx || !receipt) return this.status();
      if (!same(tx.hash,prior.hash) || !same(receipt.transactionHash,prior.hash) || !same(tx.from,payer) || !same(tx.to,DEPLOY_PROXY) ||
          BigInt(tx.value)!==0n || !same(tx.input,input)) throw Error('部署交易与原预览不符');
      if (BigInt(receipt.status)===0n && !seen[0]) {
        save(this.file,{...prior,state:'REVERTED'}); fs.rmSync(this.lock,{force:true});
        return this.status();
      }
      if (BigInt(receipt.status)!==1n && !seen[0]) throw Error('原部署回执状态未识别');
    }
    if (seen[0]) {
      this.activate(manifest);
      fs.rmSync(this.lock,{force:true});
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
      if (preview.simulationResult.allowanceChanges?.length || hasPreviewRisks(preview.risks)) throw Error('部署预览包含意外授权或风险提示');
      const review = {state:'PREVIEWED',account,payer,executor,ticket:randomUUID(),at:Date.now(),requestId:preview.requestId,fee:formatEther(BigInt(gas)*BigInt(price))};
      save(this.file,review);
      return {...this.status(),ticket:review.ticket};
    }
    if (prior.state!=='PREVIEWED' || !ticket || ticket!==prior.ticket || Date.now()-prior.at>180000) throw Error('请重新预览部署费用后确认');
    await this.bridge.ready(account,{external:true});
    if (!this.bindings().some(w=>w.account===account && same(w.address,payer))) throw Error('部署钱包绑定已变化');
    // Atomic across processes. Persist the request ID before dispatch and only follow this attempt.
    fs.closeSync(fs.openSync(this.lock,'wx',0o600));
    save(this.file,{...prior,state:'SUBMITTING'});
    const record = res => {
      const original = load(this.file);
      if (original?.ticket !== ticket || !pending(original.state)) return;
      save(this.file,{...original,state:'SUBMITTED',hash:res?.txHash||res?.transactionHash||original.hash,orderId:res?.orderId||original.orderId});
    };
    try {
      record(await this.bridge.call(account,['contract-call','execute','--requestId',prior.requestId],{onLateResponse:r=>{if(r.data)record(r.data);}}));
    } catch (err) {
      if (err.dispatched===false) {
        save(this.file,{...prior,state:'NOT_SENT'});fs.rmSync(this.lock,{force:true});throw err;
      }
    }
    return this.status();
  }
}
