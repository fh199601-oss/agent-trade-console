// Only an exact, bounded operation can be reviewed when the wallet supplies address ratings alone.
import {getAddress} from 'ethers';
import {same} from '../common.mjs';
import {hasPreviewRisks} from '../preview-risks.mjs';

const emptyList = x => Array.isArray(x) && x.length === 0;
const addr = x => /^0x[0-9a-f]{40}$/i.test(x);
export function addressRatingReview(preview, job, row, field, step) {
 const risks=preview.risks;
 if(!hasPreviewRisks(risks))return null;
 const details=[risks?.riskDetails,risks?.riskBehaviors,...Object.values(risks?.addresses||{}).map(a=>a?.riskDetails)].flatMap(x=>Array.isArray(x)?x:[]);
 const description=details.map(x=>typeof x==='string'?x:[x?.code,x?.title,x?.description].filter(v=>typeof v==='string').join(' ')).filter(Boolean).join('；').slice(0,280);
 if(description)throw Error('币安钱包风险提示，已停止提交：'+description);
 const deny=()=>{throw Error('币安钱包返回了需核对的风险评级或未知风险字段，已停止提交');};
 if(!risks||Array.isArray(risks)||!emptyList(risks.riskDetails)||!emptyList(risks.riskBehaviors)||!risks.addresses||typeof risks.addresses!=='object'||Array.isArray(risks.addresses)||Object.keys(risks).some(k=>!['riskDetails','riskBehaviors','addresses'].includes(k)))deny();
 const allowed=[row.address,job.asset,job.executor];
 if(field==='registration')allowed.push(job.settings.trigger,job.venue.pair,job.venue.quote,job.venue.source);
 const levels=Object.entries(risks.addresses).map(([address,r])=>{
  if(!addr(address)||!allowed.some(a=>a&&same(a,address))||!r||typeof r!=='object'||!emptyList(r.riskDetails)||![-1,0,1].includes(r.riskLevel)||Object.keys(r).some(k=>!['riskDetails','riskLevel'].includes(k)))deny();
  return [getAddress(address),r.riskLevel];
 }).sort(([a],[b])=>a.localeCompare(b));
 if(!levels.length)deny();
 const s=preview.simulationResult;
 if(!s||!emptyList(s.authorityChanges)||!emptyList(s.balanceChanges))throw Error('钱包预览未证明本次操作没有资产或权限变更');
 if(field==='approval'){
  const changes=s.allowanceChanges;
  const c=Array.isArray(changes)&&changes.length===1&&changes[0];
  if(!same(step.to,job.asset)||!same(step.spender,job.executor)||!c||!same(c.owner,row.address)||!same(c.spender,job.executor)||!same(c.tokenAddress,job.asset)||!/^\d+$/.test(String(c.postAmount))||(typeof c.postAmount==='number'&&!Number.isSafeInteger(c.postAmount))||BigInt(c.postAmount)!==BigInt(row.cap)||!same(preview.parsedTx?.spender,job.executor)||!same(preview.parsedTx?.contractAddress,job.asset))throw Error('钱包预览未证明只向本机执行合约授权本钱包的准确数量');
 }else if(field!=='registration'||!same(step.to,job.executor)||!emptyList(s.allowanceChanges))throw Error('计划登记预览的目标或授权变更异常');
 return levels;
}
