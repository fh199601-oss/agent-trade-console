import {Interface,ZeroAddress} from 'ethers';
import {wallet,same,read} from './common.mjs';
import {websiteUrl} from './network.mjs';

const PARAM=/^(?:r|ref|refid|refagentid|referrer|referreraddress|referral|referralid|referralcode|refcode|invite|invitecode|inviter|inviterid|inviteraddress|sponsor|sponsoraddress|recommend|recommendcode)$/i;
export const referralParameter=name=>/^_?(?:ref|referrer|referral|inviter|sponsor|recommender|referrerAddress|inviterAddress|sponsorAddress)$/i.test(name);
const kindOf=value=>{
 // Encoding is syntax, not the value's meaning: encodeURIComponent(walletAddress)
 // is an address, whereas encodeURIComponent(inviteCode) is still an opaque code.
 const s=String(value).replace(/\b(?:encodeURIComponent|encodeURI|String)\s*\(/g,'');
 return /code/i.test(s)?'code':/\.ai(?:\b|$)|domain/i.test(s)?'domain':/token.?id|agent.?id|ref.?id|inviter.?id/i.test(s)?'agentId':/address|addr|wallet|account/i.test(s)?'address':/handle|label|name/i.test(s)?'label':'unknown';
};
const cleanText=s=>String(s).replace(/&amp;/g,'&');
const decode=s=>{try{return decodeURIComponent(s);}catch{return '';}};

// Parse only bounded text evidence. No website JavaScript or API instructions run.
export function detectReferralHints(rows,source){
 const base=websiteUrl(source),templates=[],signals=[];
 const add=t=>{const key=JSON.stringify([t.transport,t.key,t.path,t.kind]);if(!templates.some(x=>x.keyId===key))templates.push({...t,keyId:key});};
 for(const row of rows){
  let origin;try{origin=new URL(row.url).origin;}catch{continue;}if(origin!==base.origin)continue;
  const text=cleanText(row.text||'');
  // Documented complete URLs support query, fragment, and path-based invitations.
  for(const m of text.matchAll(/https:\/\/[^\s"'`<>\\]+/g)){
   let u;try{u=new URL(m[0]);}catch{continue;}if(u.origin!==base.origin)continue;
   for(const [transport,params] of [['query',u.searchParams],['hash-query',new URLSearchParams(u.hash.slice(1))]])for(const [key,value] of params){
    if(!PARAM.test(key))continue;const kind=/^0x[\da-f]{40}$/i.test(value)?'address':/^\d{1,78}$/.test(value)?'agentId':kindOf(value);
    add({transport,key,path:u.pathname,kind,score:3,source:row.url,evidence:'官网文档中的邀请网址'});
   }
   const p=u.pathname.match(/^(.*\/(?:i|r|ref|invite|referral)\/)([^/]+)\/?$/i);
   if(p&&/\{|\$|code|address|wallet|agent|name|handle|your/i.test(decode(p[2])))add({transport:'path',path:p[1],kind:kindOf(decode(p[2])),score:3,source:row.url,evidence:'官网文档中的邀请路径'});
   if(/\.ai$/i.test(u.hash)&&/invite|referral|邀请|推荐/i.test(text.slice(Math.max(0,m.index-90),m.index)))add({transport:'hash',path:u.pathname,kind:'domain',score:3,source:row.url,evidence:'官网文档中的域名片段邀请'});
  }
  // Explicit URL producers. A different key is preserved, never forced to ?ref=.
  for(const m of text.matchAll(/["'`](?:\/)?([?#&])([\w]{1,40})=["'`]\s*\+\s*(?:encodeURIComponent\s*\(\s*)?([\w.$]+)/g)){
   if(!PARAM.test(m[2]))continue;
   const suffix=text.slice(m.index+m[0].length,m.index+m[0].length+30),kind=/^\s*\+\s*["'`]\.ai["'`]/i.test(suffix)?'domain':kindOf(m[3]);
   add({transport:m[1]==='#'?'hash-query':'query',key:m[2],path:base.pathname,kind,score:2,source:row.url,evidence:'官网前端邀请参数拼接'});
  }
  for(const m of text.matchAll(/[?&#]([\w]{1,40})=\$\{([^}]{1,120})\}/g))if(PARAM.test(m[1]))add({transport:m[0][0]==='#'?'hash-query':'query',key:m[1],path:base.pathname,kind:/^\.ai/i.test(text.slice(m.index+m[0].length))?'domain':kindOf(m[2]),score:2,source:row.url,evidence:'官网前端邀请模板'});
  for(const m of text.matchAll(/searchParams\.set\(\s*["'`]([^"'`]+)["'`]\s*,\s*([\w.$]+)/g))if(PARAM.test(m[1]))add({transport:'query',key:m[1],path:base.pathname,kind:kindOf(m[2]),score:2,source:row.url,evidence:'官网前端设置邀请参数'});
  if(/URLSearchParams|searchParams/.test(text))for(const m of text.matchAll(/\.get\(\s*["'`]([^"'`]+)["'`]\s*\)/g))if(PARAM.test(m[1]))add({transport:'query',key:m[1],path:base.pathname,kind:'unknown',score:1,source:row.url,evidence:'官网前端读取邀请参数'});
  for(const m of text.matchAll(/["'`](\/(?:i|r|ref|invite|referral)\/)["'`]\s*\+\s*([\w.$]+)/gi))add({transport:'path',path:m[1],kind:kindOf(m[2]),score:2,source:row.url,evidence:'官网前端生成邀请路径'});
  for(const m of text.matchAll(/(?:invite|referral|ref)Link\s*=\s*[^;\n]{0,160}?["'`]\/?#["'`]\s*\+\s*(?:encodeURIComponent\s*\(\s*)?([\w.$]+)/gi))add({transport:'hash',path:base.pathname,kind:kindOf(m[1]),score:2,source:row.url,evidence:'官网前端生成片段邀请链接'});
  if(/(?:fetch|request|post)\s*\([^;\n]{0,200}(?:invite|referral)|["'`](?:invite|referral)["'`]\s*,|(?:invite|referral)Code/i.test(text))signals.push({source:row.url,kind:'code-or-api'});
  if(/\binvite quotas\b|\breferral limits\b|邀请(?:额度|奖励|制度)|推荐(?:额度|奖励|制度)/i.test(text))signals.push({source:row.url,kind:'documented-program'});
 }
 return {detected:templates.length>0||signals.length>0,templates:templates.slice(0,24).map(({keyId,...x})=>x),signals:signals.slice(0,8)};
}

export function addressReferral(meta,route,intent){
 if(!route.roles.includes('zero'))return null;
 const inviter=wallet(1),use=intent.referral!=='none'&&[2,3].includes(intent.account);
 if(use&&!meta.verified)throw Error('检测到邀请参数，但源码未核验；不能猜测邀请含义或静默使用零地址');
 if(use&&same(wallet(intent.account).address,inviter.address))throw Error('邀请钱包与当前钱包相同');
 return {detected:true,account:1,address:inviter.address,appliesTo:[2,3],valueKind:'address',linkValue:inviter.address,bindingVerified:!!meta.verified,
  callValue:use?inviter.address:ZeroAddress,active:intent.referral!=='none',note:'按已核验 ABI 将 1 号地址传入邀请参数；资格、首次绑定和奖励仍以实际模拟与合约规则为准'};
}

function linkFrom(template,source,value){
 const u=websiteUrl(source);u.hash='';
 for(const key of [...u.searchParams.keys()])if(PARAM.test(key))u.searchParams.delete(key);
 u.pathname=template.path||u.pathname;
 if(template.transport==='query')u.searchParams.set(template.key,value);
 else if(template.transport==='hash-query')u.hash=new URLSearchParams({[template.key]:value}).toString();
 else if(template.transport==='hash')u.hash=encodeURIComponent(value);
 else {u.pathname=(template.path||'/')+encodeURIComponent(value);u.search='';}
 return u.href;
}
export async function resolveReferral(rpc,bridge,resolved,meta,prior=null){
 const hints=resolved.referralHints||{templates:[],signals:[]};
 const functions=meta?.abi?new Interface(meta.abi).fragments.filter(f=>f.type==='function'):[];
 const addressArgs=functions.filter(f=>!['view','pure'].includes(f.stateMutability)&&/mint|claim|buy/i.test(f.name)&&f.inputs.some(p=>p.type==='address'&&referralParameter(p.name)));
 if(!prior&&!hints.detected&&!addressArgs.length)return resolved.pageError?{detected:null,status:'unavailable',url:null,note:'网站未成功读取，本次无法判断是否存在邀请制度'}:{detected:false,status:'not-detected',url:null,note:'本次未检测到邀请制度；后续若发现新规则会重新核验'};
 const inviter=wallet(1),r={detected:true,account:1,address:inviter.address,appliesTo:[2,3],bindingVerified:false,...prior};
 if(r.active===false)return {...r,status:'inactive',url:null};
 let source;try{source=websiteUrl(resolved.source).href;}catch{}
 if(!source)return {...r,status:r.url?'ready':'needs-website',note:r.note||'请用项目网址识别邀请链接格式'};
 // A pinned adapter supplies the meaning of its ID, not the hostname of a clone.
 if(!r.valueKind&&r.url){const val=new URL(r.url).searchParams.get('ref');if(val){r.linkValue=val;r.valueKind=/^0x[\da-f]{40}$/i.test(val)?'address':/^\d+$/.test(val)?'agentId':val.endsWith('.ai')?'domain':'label';}}
 if(!r.valueKind&&addressArgs.length&&meta.verified){r.valueKind='address';r.linkValue=inviter.address;r.note='合约包含地址型邀请参数；实际铸造方式仍须完成适配和模拟';}
 // A complete website URL producer proves formatting only. It must not promote
 // unknown contract binding or rewards to verified, or supply an opaque code.
 if(!r.valueKind&&(hints.templates||[]).some(t=>t.kind==='address'&&t.score>=2)){
  r.valueKind='address';r.linkValue=inviter.address;
  r.note='已按官网的钱包地址邀请格式生成链接；邀请资格、合约绑定和奖励尚未核验';
 }
 const candidates=(hints.templates||[]).filter(t=>t.kind==='unknown'||t.kind===r.valueKind||['label','domain'].includes(t.kind)&&['label','domain'].includes(r.valueKind));
 let choices=candidates;
 if(!r.linkValue){
  // Opaque codes may be read only from a matching, verified on-chain getter.
  const code=functions.filter(f=>['view','pure'].includes(f.stateMutability)&&/^(?:inviteCode|referralCode|refCode)(?:Of|For)?$/i.test(f.name)&&f.inputs.length===1&&f.inputs[0].type==='address'&&f.outputs.length===1&&/^(?:string|uint\d*)$/.test(f.outputs[0].type));
  if(meta.verified&&code.length===1&&(hints.templates||[]).some(t=>t.kind==='code')){
   try{const abi=new Interface(meta.abi),[value]=await read(rpc,meta.address,abi,code[0].format('sighash'),[inviter.address]);const str=String(value);
    if(!/^[\w-]{1,128}$/.test(str)||str==='0')throw Error('项目没有返回可用邀请码');r.valueKind='code';r.linkValue=str;choices=hints.templates.filter(t=>t.kind==='code');r.codeSource=code[0].format('sighash');
   }catch(e){return {...r,url:null,status:'needs-adapter',note:'邀请码读取未通过：'+e.message};}
  }
 }
 choices=choices.filter(t=>t.kind==='unknown'||t.kind===r.valueKind||['label','domain'].includes(t.kind)&&['label','domain'].includes(r.valueKind)).sort((a,b)=>b.score-a.score);
 if(choices.length&&r.linkValue){
  const score=choices[0].score,top=choices.filter(t=>t.score===score),urls=[...new Set(top.map(t=>linkFrom(t,source,t.kind==='domain'?r.linkValue.replace(/\.ai$/i,'')+'.ai':t.kind==='label'?r.linkValue.replace(/\.ai$/i,''):r.linkValue)))];
  if(urls.length===1)return {...r,url:urls[0],status:'ready',linkEvidence:top.map(t=>({source:t.source,evidence:t.evidence,transport:t.transport,key:t.key||null})),note:r.note||'已根据官网格式生成 1 号邀请链接；铸造绑定以预览为准'};
  return {...r,url:null,status:'ambiguous',note:'网站出现多个不同邀请格式，尚不能确定当前入口；不会任选一个或替换邀请人'};
 }
 if(r.url&&new URL(r.url).origin===new URL(source).origin)return {...r,status:'ready',linkEvidence:[{source:r.url,evidence:'已核验项目适配器中的邀请格式'}]};
 return {...r,url:null,status:hints.signals?.some(s=>s.kind==='code-or-api')||hints.templates?.some(t=>t.kind==='code')?'needs-code':'needs-adapter',note:r.note?(r.note+'；邀请网址格式待核验'):'检测到邀请功能，但邀请码或接口绑定尚未核验；不会用钱包地址冒充邀请码'};
}
