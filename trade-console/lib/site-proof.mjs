// Proofs must come from the site's actual response. This validator never
// creates signatures, logs in to sites, or copies another participant's proof.
export function validateSiteProof(p){
 const fields=p?.kind==='social-voucher'?['kind','wallet','agentId','xUsernameHash','xPostIdHash','voucherDeadline','signature']:p?.kind==='social-task'?['kind','wallet','agentId','task','signature']:['agent','index','seed','attempts','solveSecs','deadline','signature'];
 const bad=()=>{throw Object.assign(Error('官网凭证字段无效或整数不是精确十进制字符串'),{code:'SITE_PROOF_INVALID'});};
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).length!==fields.length||fields.some(k=>!(k in p)))bad();
 const addr=p.kind?p.wallet:p.agent;if(!/^0x[0-9a-f]{40}$/i.test(addr||''))bad();
 if(!/^0x(?:[0-9a-f]{2}){1,4096}$/i.test(p.signature||''))bad();
 for(const k of fields.filter(k=>['seed','task','xUsernameHash','xPostIdHash'].includes(k)))if(!/^0x[0-9a-f]{64}$/i.test(p[k]))bad();
 for(const k of fields.filter(k=>['agentId','index','attempts','solveSecs','deadline','voucherDeadline'].includes(k)))if(typeof p[k]!=='string'||!/^\d{1,78}$/.test(p[k])||BigInt(p[k])>=1n<<256n)bad();
 return p;
}
