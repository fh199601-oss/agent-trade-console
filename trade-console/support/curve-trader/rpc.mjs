// Read-only, batched JSON-RPC. Signing remains in the numbered Binance wrapper.
import {configureHttpTransport} from './transport.mjs';
const ALLOWED = new Set(['eth_chainId','eth_blockNumber','eth_call','eth_getCode','eth_getBalance','eth_gasPrice','eth_getBlockByNumber','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getLogs','eth_getTransactionCount','eth_estimateGas']);
const tag = value => typeof value === 'number' || typeof value === 'bigint' ? '0x' + BigInt(value).toString(16) : value;
export class ReadRpc {
  constructor(url = 'https://bsc-dataseed.bnbchain.org', { timeoutMs = 8000, fetchImpl = fetch } = {}) {
    configureHttpTransport();
    this.url = url; this.timeoutMs = timeoutMs; this.fetch = fetchImpl;
    this.queue = []; this.nextId = 0; this.timer = null; this.calls = 0; this.batches = 0;
  }
  send(method, params) {
    if (!ALLOWED.has(method)) return Promise.reject(new Error('RPC signing/broadcast is forbidden'));
    return new Promise((resolve, reject) => {
      this.queue.push({ jsonrpc: '2.0', id: ++this.nextId, method, params, resolve, reject });
      this.timer ??= setTimeout(() => { this.timer = null; this.flush(); }, 0);
    });
  }
  async flush() {
    const items = this.queue.splice(0); if (!items.length) return;
    this.calls += items.length; this.batches++;
    try {
      const res = await this.fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(items.map(({ resolve, reject, ...q }) => q)), signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
      const data = await res.json(); const responses = new Map((Array.isArray(data) ? data : [data]).map(x => [x.id, x]));
      for (const item of items) {
        const r = responses.get(item.id);
        if (!r) item.reject(new Error('RPC batch response missing'));
        else if (r.error) item.reject(Object.assign(new Error(r.error.message), { code: r.error.code, data: r.error.data }));
        else item.resolve(r.result);
      }
    } catch (e) { for (const item of items) item.reject(e); }
  }
  call(tx, blockTag = 'latest') {
    const { blockTag: requestedTag, ...request } = tx;
    if (typeof request.value === 'bigint') request.value = '0x' + request.value.toString(16);
    return this.send('eth_call', [request, tag(requestedTag ?? blockTag)]);
  }
  getCode(address, blockTag = 'latest') { return this.send('eth_getCode', [address, tag(blockTag)]); }
  async getBalance(address, blockTag = 'latest') { return BigInt(await this.send('eth_getBalance', [address, tag(blockTag)])); }
  async getBlockNumber() { return Number(BigInt(await this.send('eth_blockNumber', []))); }
  getTransactionReceipt(hash) { return this.send('eth_getTransactionReceipt', [hash]); }
  getTransaction(hash) { return this.send('eth_getTransactionByHash', [hash]); }
  async verifyChain() {
    if (this.chainVerified) return;
    if(!this.chainVerification)this.chainVerification=(async()=>{
      if (BigInt(await this.send('eth_chainId', [])) !== 56n) throw new Error('Wrong RPC chain: expected BSC 56');
      this.chainVerified = true;
    })().catch(e=>{this.chainVerification=null;throw e;});
    return this.chainVerification;
  }
}
