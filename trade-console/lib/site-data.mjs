import {websiteUrl} from './network.mjs';

// Bundlers put lazy routes in static dependency arrays as well as import().
// Fetch only observed same-origin JS paths; never evaluate a bundle or guess
// filenames. Discovery applies its shared depth and request budget afterwards.
export function observedModuleLinks(rows,source){
 const base=websiteUrl(source),links=new Set();
 for(const row of rows)for(const m of (row.text||'').matchAll(/["'`]((?:\.{1,2}\/|\/)[^"'`\s\\]{1,240}\.m?js(?:\?[^"'`\s\\]*)?)["'`]/g)){
  if(/[${}]/.test(m[1]))continue;
  let u;try{u=new URL(m[1],row.url);}catch{continue;}
  if(u.origin!==base.origin||u.username||u.password||u.hash||/(?:ethers|web3|vendor|react|analytics|beacon)[-.]/i.test(u.pathname))continue;
  links.add(u.href);
 }
 return [...links].sort((a,b)=>Number(/config|mint|contract|deployment|page[-.]/i.test(b))-Number(/config|mint|contract|deployment|page[-.]/i.test(a)));
}

// Read linked mint documentation/configuration, never arbitrary agent tasks.
export function mintDocumentLinks(rows,source){
 const base=websiteUrl(source),links=new Set();
 for(const row of rows)for(const m of (row.text||'').matchAll(/\[[^\]\n]{1,160}\]\(([^\s)]+)\)/g)){
  let u;try{u=new URL(m[1],row.url);}catch{continue;}
  if(u.origin!==base.origin||u.username||u.password||u.search||u.hash)continue;
  if(/(?:mint|contract|deployment|config)[^/]*\.(?:md|txt|json)$/i.test(u.pathname)||/\/agent\/[^/]+\.json$/i.test(u.pathname))links.add(u.href);
 }
 return [...links].slice(0,4);
}

// Follow only references actually present in the page. Never evaluate scripts,
// call a site's login/prepare/execute API, or forward wallet sessions/cookies.
export function publicDataLinks(rows,source){
 const base=websiteUrl(source),links=new Set();
 // Some frontends use a shared fetch(`/api/v1${path}`) client, then call a
 // resource hook with authentication explicitly disabled. Resolve only observed
 // public status/config paths; never probe login, quote, voucher or write APIs.
 const prefixes=new Set();
 for(const row of rows)for(const m of (row.text||'').matchAll(/\bfetch\s*\(\s*`(\/api(?:\/v\d+)?)\$\{[\w$]+\}`/g))prefixes.add(m[1]);
 if(prefixes.size===1)for(const row of rows)for(const m of (row.text||'').matchAll(/\buseResource\)?\s*\(\s*["'](\/(?:status|config|contracts|deployments|launch\/campaign))["']\s*,\s*(?:false|!1)\s*[,)]/g))links.add(new URL([...prefixes][0]+m[1],base).href);
 for(const row of rows)for(const m of (row.text||'').matchAll(/["'`]([^"'`\s]{1,240})["'`]/g)){
  let value=m[1];
  if(value.startsWith('~/'))continue; // Local config examples are not website endpoints.
  // One explicit quantity placeholder in a public read-only quote is supported.
  value=value.replace(/\$\{(?:qty|quantity)\}/g,'1');
  if(/[${}]/.test(value))continue;
  let u;try{u=new URL(value,row.url);}catch{continue;}
  if(u.origin!==base.origin||u.username||u.password||u.hash)continue;
  const config=/\/(?:[^/]*(?:config|deployment|contracts|addresses)[^/]*\/)?[^/]*\.json$/i.test(u.pathname)&&/(?:config|deployment|contracts|addresses)/i.test(u.pathname)&&!u.search;
  const snapshot=(/^\/api\/public\/(?:mint\/)?(?:snapshot|config)$/.test(u.pathname)||/^\/api(?:\/v\d+)?\/(?:status|config|contracts|deployments|launch\/campaign)$/.test(u.pathname))&&[...u.searchParams].every(([k,v])=>k==='quantity'&&/^\d{1,3}$/.test(v));
  if(config||snapshot)links.add(u.href);
 }
 return [...links].slice(0,4);
}

export function siteAccess(rows,source){
 const joined=rows.map(r=>r.text||'').join('\n');
 const privateSnapshot=/["'`]\/api\/(?!public\/)(?:mint\/)?snapshot(?:\?[^"'`]*)?["'`]/.test(joined);
 const walletLogin=/\/api\/(?:aw|wallet)\/login/.test(joined)&&/\b[\w$]+\.connected/.test(joined);
 const targets=/validAddress\(\s*[\w$]+\.token\s*\)/.test(joined)&&/validAddress\(\s*[\w$]+\.mint\s*\)/.test(joined);
 if(!privateSnapshot||!walletLogin||!targets)return null;
 return {kind:'site-session-targets',source:websiteUrl(source).href,
  note:'网站通过登录后的钱包快照返回 Mint 合约和代币 CA；本地钱包已连接不等于已登录该网站。请提供官网登录后显示的 Mint 合约地址或代币 CA，以继续链上核验。'};
}

export function discoveryFailure(resolved){
 if(resolved.pageError)return {code:'WEBSITE_UNAVAILABLE',message:'项目网页读取失败：'+resolved.pageError+'。本次未完成识别，请稍后重试或输入完整合约地址。'};
 if(resolved.access?.kind==='site-session-targets')return {code:'SITE_SESSION_REQUIRED',message:resolved.access.note};
 if(!resolved.addresses?.length)return {code:'CONTRACT_NOT_PUBLISHED',message:'公开网页和已引用配置中未找到合约地址；请提供项目 Mint 合约地址或代币 CA。'};
 if(!resolved.candidates?.length&&['unavailable','time-budget'].includes(resolved.chainLearning?.status))return {code:'CHAIN_HISTORY_INCOMPLETE',message:'已发现候选地址，但链上记录读取未完成'+(resolved.chainLearning.status==='time-budget'?'（达到本次回查时限）':'（RPC 查询失败）')+'，尚不能判断 Mint 入口。可点击回查链上 Mint 重试。'};
 if(!resolved.candidates?.length)return {code:'MINT_NOT_VERIFIED',message:'发现了网站地址，但尚未核验到可用 Mint 入口；不是多个可选合约。'};
 return {code:'CONTRACT_SELECTION_REQUIRED',message:'尚未确定唯一 Mint 入口，请在项目卡片中选择候选合约。'};
}
