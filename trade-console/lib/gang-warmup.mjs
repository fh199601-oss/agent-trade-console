import {gangClient} from './gang-modern.mjs';
import {conversions} from './trade-conversion.mjs';
import {BNB,USDT,same,native} from './common.mjs';
// Background and foreground use separate RPC queues, but completed immutable
// metadata and factory-verified topology should not be rediscovered at click.
// Never share in-flight calls, balances, allowances, reserves or live quotes.
export function shareTradeMetadata(foregroundRpc,backgroundRpc){
 if(foregroundRpc===backgroundRpc)return;
 const foreground=gangClient(foregroundRpc),background=gangClient(backgroundRpc);
 for(const key of ['metadata','identities','known'])background[key]=foreground[key];
 const a=conversions(foregroundRpc),b=conversions(backgroundRpc);
 b.topologies=a.topologies;b.prep.entries=a.prep.entries;
}
// Bounded background READS. No wallet commands, funds, approvals or calldata.
export class GangWarmup{
 constructor({rpc,client=gangClient(rpc),converter=conversions(rpc),busy=()=>false,now=Date.now}={}){Object.assign(this,{client,converter,busy,now});this.after=new Map();this.pending=null;this.closed=false;}
 request(token){
  if(this.closed||this.pending||this.busy()||!/^0x[\da-f]{40}$/i.test(token)||(this.after.get(token.toLowerCase())||0)>this.now())return null;
  const key=token.toLowerCase();this.after.set(key,this.now()+15000);if(this.after.size>128)this.after.delete(this.after.keys().next().value);
  const busy=()=>this.closed||this.busy();
  this.pending=(async()=>{const state=await this.client.probe(token);if(!state||busy())return state;
   await Promise.all([this.client.meta(token),this.client.meta(state.quoteToken),this.client.identity(state)]);
   // One undirected factory graph serves both directions. Fresh liquidity,
   // amount, quote and allowance are still read by each real plan.
   for(const payment of [BNB,USDT]){if(busy())break;if(same(payment,state.quoteToken)||native(payment)&&native(state.quoteToken))continue;await this.converter.warm(payment,state.quoteToken,{busy});}
   return state;
  })().catch(()=>null).finally(()=>{this.pending=null;});return this.pending;
 }
 close(){this.closed=true;this.after.clear();}
}
