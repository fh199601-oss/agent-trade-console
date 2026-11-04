import { randomUUID } from 'node:crypto';
import { fail } from './lib.mjs';

export async function auditToken(token, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl('https://web3.binance.com/bapi/defi/v1/public/wallet-direct/security/token/audit', {
    method: 'POST', headers: { 'content-type': 'application/json', source: 'agent', 'accept-encoding': 'identity', 'user-agent': 'binance-web3/1.4 (Skill)' },
    body: JSON.stringify({ binanceChainId: '56', contractAddress: token, requestId: randomUUID() }), signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) fail('AUDIT_UNAVAILABLE', `Token security audit HTTP ${r.status}`);
  const body = await r.json(), d = body.data;
  if (body.success!==true || d?.hasResult!==true || d?.isSupported!==true) return { available: false, reason: 'Security audit data is not available for this token on this chain.' };
  if(!['number','string'].includes(typeof d.riskLevel)||!/^\d$/.test(String(d.riskLevel))||Number(d.riskLevel)>5)return {available:false,reason:'Security audit returned an unrecognized risk level.'};
  return { available: true, level: Number(d.riskLevel), taxes: d.extraInfo, items: d.riskItems, checkedAt: Date.now() };
}

export function checkAudit(audit, { acknowledgeUnavailable = false, acknowledgeHigh = false } = {}) {
  if(audit?.available && (!Number.isInteger(audit.level)||audit.level<0||audit.level>5))fail('AUDIT_UNAVAILABLE','安全审计风险等级无法解析');
  if (!audit?.available && !acknowledgeUnavailable) fail('AUDIT_UNAVAILABLE', audit?.reason || 'Token security audit is temporarily unavailable.');
  if (audit?.available && audit.level >= 5) fail('AUDIT_BLOCKED', '代币安全审计为 5 级');
  if (audit?.available && audit.level >= 4 && !acknowledgeHigh) fail('AUDIT_HIGH_RISK', '代币安全审计为 4 级，需明确知悉该风险', { audit });
}
