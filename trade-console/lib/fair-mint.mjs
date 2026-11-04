import {Interface} from 'ethers';
import {runtimeShape} from './bytecode.mjs';
import {formatUnits} from './common.mjs';
import {noQuota} from './mint-policy.mjs';
// A read-only capability family. A known-looking selector is not sufficient to
// infer the three-argument mint's parameter meanings or referral binding.
const ABI=['function FREE_SHARES() view returns(uint256)','function FREE_PER_WALLET() view returns(uint256)','function freeMinted() view returns(uint256)','function freeClaimed(address) view returns(uint256)','function totalMinted() view returns(uint256)','function TOTAL_SHARES() view returns(uint256)','function MAX_PER_TX() view returns(uint256)','function opened() view returns(bool)','function paused() view returns(bool)','function token() view returns(address)','function costOf(uint256) view returns(uint256)','function quotaOf(uint256) view returns(uint256)','function mintedCount(uint256) view returns(uint256)','function mintWithBnb(uint256,address,uint256) payable'];
const abi=new Interface(ABI);
export function recognizeFairMint(meta){const s=runtimeShape(meta.runtimeCode);return !meta.proxy&&!s.delegate&&abi.fragments.every(f=>s.selectors.has(f.selector))?{kind:'agent-share-fair-mint'}:null;}
export async function fairMintState(rpc,meta,w){
 const block=await rpc.getBlockNumber(),get=async(n,args=[])=>{const raw=await rpc.call({to:meta.address,data:abi.encodeFunctionData(n,args)},block);if(!/^0x[0-9a-f]{64}$/i.test(raw))throw Error('份额铸造返回值格式不匹配');return abi.decodeFunctionResult(n,raw)[0];};
 const [cap,minted,per,used,total,supply,max,opened,paused,token,price]=await Promise.all([get('FREE_SHARES'),get('freeMinted'),get('FREE_PER_WALLET'),get('freeClaimed',[w.address]),get('totalMinted'),get('TOTAL_SHARES'),get('MAX_PER_TX'),get('opened'),get('paused'),get('token'),get('costOf',[1n])]);
 if(minted>cap||total>supply||used>per)throw Error('份额额度计数不一致');
 const remaining=opened||paused?0n:(cap-minted<per-used?cap-minted:per-used);
 const note='已核验免费池、开盘状态和当前报价；三参数铸造的参数含义、到账数量及邀请绑定尚未完整核验，付费构造暂不开放。';
 return {name:'agent-share-fair-mint',token,assetKind:'Erc20',info:{block,freeRemaining:String(remaining),paidRemaining:null,globalFreeRemaining:String(cap-minted),globalRemaining:String(supply-total),globalTotal:String(supply),globalMinted:String(total),maxPerTx:String(max),nextUnitPriceBnb:formatUnits(price,18),opened,paused,notes:[note]},blocked:opened?'项目已开盘，Mint 阶段已结束':paused?'合约暂停铸造':null};
}
export async function fairMintPlan(rpc,intent,meta,w){
 if(!recognizeFairMint(meta))return null;
 const s=await fairMintState(rpc,meta,w);
 if(s.blocked)throw Object.assign(Error(s.blocked),{details:{quota:s.info}});
 if(intent.scope==='free'&&s.info.freeRemaining==='0')throw noQuota(s.info.globalFreeRemaining==='0'?'全局免费份额已领完，本钱包免费可用 0 份；不会自动改成付费。':'本钱包免费份额已领取，没有重复铸造。',{quota:s.info});
 throw Object.assign(Error(s.info.notes[0]),{code:'MINT_ADAPTER_INCOMPLETE',details:{quota:s.info}});
}
