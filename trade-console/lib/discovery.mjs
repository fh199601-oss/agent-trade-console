import {address,DATA,hash,load,save} from './common.mjs';
import {publicText,websiteUrl,getJson} from './network.mjs';
import {publishedAbiHints,publishedMintPuzzle} from './abi-hints.mjs';
import {publishedMintCalls} from './frontend-mint.mjs';
import {keccak256,id} from 'ethers';
import {measure,count} from './diagnostics.mjs';
import {labelRoles,descriptionRoles,mergeCandidates,classifyAddresses} from './address-roles.mjs';
import path from 'node:path';
import {detectReferralHints} from './referral.mjs';
import {publicDataLinks,mintDocumentLinks,observedModuleLinks,siteAccess,discoveryFailure} from './site-data.mjs';
import {learnerFor} from './chain-learning.mjs';
import {applyChainEvidence} from './chain-assist.mjs';
import {staticDeployments,deploymentIsBsc} from './static-config.mjs';
import {discoverCorla,corlaInput} from './corla.mjs';
import {discoverBinancians} from './binancians.mjs';
import {binanciansInput} from '../public/binancians-input.mjs';
import {normalizeAssetInput} from '../public/asset-input.mjs';
import {bagentInput,discoverBagent} from './bagent.mjs';
import {htmlAddressPairs} from './html-addresses.mjs';
const memory=new Map(),pending=new Map(),scopeIds=new WeakMap();let nextScope=0;
const scopeId=v=>{if(!v)return 0;if(!scopeIds.has(v))scopeIds.set(v,++nextScope);return scopeIds.get(v);};
const scopeKey=o=>[o.rpc,o.fetchText||publicText,o.sourceLoader||sourceFor,o.chainLearner].map(scopeId).join(':');
const ADDR='(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])';
function foreignJsonChain(text){if(text.trim().startsWith('{'))try{const data=JSON.parse(text),chain=data.chainId??data.data?.chainId;return chain!==undefined&&String(chain)!=='56'&&String(chain).toLowerCase()!=='0x38';}catch{}return false;}
export function websiteName(html){
 const raw=html.match(/<meta\b[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i)?.[1]||html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
 return raw?.replace(/<[^>]*>/g,' ').replace(/&amp;/gi,'&').replace(/&(?:nbsp|#160);/gi,' ').replace(/&quot;/gi,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim().slice(0,160)||null;
}
export function extractCandidates(text,source){
 if(foreignJsonChain(text))return [];
 const found=[],host=new URL(source).hostname;
 const scripts=/\.m?js$/i.test(new URL(source).pathname)?[text]:[...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].slice(0,8).map(m=>m[1]);
 const deployments=scripts.flatMap(staticDeployments);
 const active=deployments.filter(deploymentIsBsc),activeAddresses=new Set(active.map(r=>r.address.toLowerCase()));
 const excluded=new Set(deployments.filter(r=>!deploymentIsBsc(r)&&!activeAddresses.has(r.address.toLowerCase())).map(r=>r.address.toLowerCase()));
 const add=(a,field,roles,priority,method)=>found.push({address:address(a),field,roles,source,priority,...(method?{method}:{})});
 // Agent-facing instructions often use a branded contract name (Rig, Hatchery,
 // etc.), not a variable called NFT or MINT. Bind an adjacent Contract/Call pair
 // as a discovery hint only; the address classifier must match that method in
 // the deployed ABI before giving it precedence over a generic sale address.
 const declarations=/(?:^|\n)[ \t]*(?:Contract|Mint contract|合约|铸造合约)[ \t]*[:：][ \t]*([^\n<>]{0,180}?)\b(0x[\da-fA-F]{40})[ \t]*\r?\n[ \t]*(?:Call|Function|调用|函数)[ \t]*[:：][ \t]*([a-zA-Z_$][\w$]{0,60})[ \t]*\(/g;
 for(const m of text.matchAll(declarations))if(!/0x[\da-f]{40}/i.test(m[1])&&/^(?:mint\w*|publicMint|freeMint|paidMint|agentMint|claimFree|takeGift)$/.test(m[3]))add(m[2],(m[1].trim()||'Contract')+' · '+m[3]+'()',['mint'],5,m[3]);
 for(const r of active){const roles=labelRoles(r.field);add(r.address,r.field+' · '+r.path,roles,roles.includes('mint')?4:roles.includes('nft')?3:roles.includes('token')?1:0);}
 // Nested machine-readable deployment objects retain the enclosing role/name.
 if(text.trim().startsWith('{'))try{const visit=(v,key='',depth=0)=>{if(!v||typeof v!=='object'||depth>8)return;if(typeof v.address==='string'&&/^0x[0-9a-f]{40}$/i.test(v.address)){const label=[key,v.name,v.role].filter(x=>typeof x==='string').join(' ').slice(0,240),roles=[...new Set([...labelRoles(key),...descriptionRoles(label)])];add(v.address,label,roles,roles.includes('mint')?4:roles.includes('nft')?3:roles.includes('token')?1:0);}for(const [k,x]of Object.entries(v))visit(x,k,depth+1);};visit(JSON.parse(text));}catch{}
 const hints=host==='cryptosim.online'?[/const k3=["'](0x[0-9a-fA-F]{40})["']/g]:host==='minteragent.store'?[/TARGET_CHAIN_ID:56,CONTRACTS:\{56:\{nft:["'](0x[0-9a-fA-F]{40})["']/g]:host==='dpeg402.fun'?[/Mint · x402<\/span>[\s\S]{0,180}?bscscan\.com\/address\/(0x[0-9a-fA-F]{40})/g]:[];
 for(const re of hints)for(const m of text.matchAll(re))add(m[1],'网站当前部署配置',['mint'],4);
 // Keys may be camelCase, UPPER_SNAKE_CASE, JSON, Chinese, or differently branded.
 const assignments=new RegExp('(?:["\'`]([\\w\\u4e00-\\u9fff -]{1,60})["\'`]|\\b([a-zA-Z_$][\\w$]{0,59}))\\s*[:=]\\s*["\'`]'+ADDR+'["\'`]','g');
 for(const m of text.matchAll(assignments)){const field=m[1]||m[2],roles=labelRoles(field);const generic=/^(?:contract|contract_?address)$/i.test(field);
  // An unfamiliar variable name still supplies a candidate; its role is inferred on-chain.
  add(m[3],field,roles,roles.includes('mint')||roles.includes('nft')||generic?3:roles.includes('token')?1:0);
 }
 // Preserve labels across HTML cells / definition lists, without associating
 // addresses from an unrelated neighbouring section. Labels prioritize reads;
 // deployed bytecode and ABI still decide whether this is a mint entry.
 const plain=s=>s.replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/\s+/g,' ').trim();
 const htmlPair=(label,body)=>{label=plain(label);if(label.length>180)return;const roles=descriptionRoles(label),generic=/^(?:(?:(?:official|current|live|main|deployed|project)\s+)?(?:contract|contract\s+address|deployment)|(?:官方|当前|主|项目)?合约(?:地址)?)$/i.test(label);if(!roles.length&&!generic)return;for(const m of body.matchAll(new RegExp(ADDR,'g')))add(m[1],label,roles,roles.includes('mint')||roles.includes('nft')||generic?3:roles.includes('token')?1:0);};
 for(const m of text.matchAll(/<tr\b[^>]*>([\s\S]{0,6000}?)<\/tr>/gi)){const cells=[...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)];if(cells.length>=2)htmlPair(cells[0][1],cells.slice(1).map(c=>c[1]).join(' '));}
 for(const m of text.matchAll(/<dt\b[^>]*>([\s\S]{0,500}?)<\/dt>\s*<dd\b[^>]*>([\s\S]{0,3000}?)<\/dd>/gi))htmlPair(m[1],m[2]);
 if(/<[a-z][^>]*>/i.test(text))for(const p of htmlAddressPairs(text))htmlPair(p.label,p.address);
 for(const line of text.split('\n')){
  const table=line.match(new RegExp('^\\s*\\|\\s*([^|]{1,200})\\|\\s*[`"\']?'+ADDR));
  if(table){const roles=descriptionRoles(table[1]);add(table[2],table[1].trim(),roles,roles.includes('mint')?3:roles.includes('token')||roles.includes('nft')?1:0);}
  const labeled=line.match(new RegExp('^\\s*(?:[-*>]\\s*)?(?:\\*\\*)?((?:LIVE\\s+CONTRACT)|(?:Contract|Mint(?:\\s+contract)?|Token(?:\\s+(?:CA|address|contract))?|代币合约|铸造合约)(?:\\s*\\([^)]{0,140}\\))?)\\s*(?:\\*\\*)?\\s*[:：]?\\s*[`"\']?'+ADDR,'i'));
  if(labeled)add(labeled[2],labeled[1],descriptionRoles(labeled[1]),/LIVE\s+CONTRACT|mint|铸造/i.test(labeled[1])?3:1);
 }
 for(const m of text.matchAll(/href=["']https:\/\/bscscan\.com\/(?:address|token)\/(0x[0-9a-fA-F]{40})["'][^>]*>(.{0,500}?)<\/a>/gs)){
  const label=m[2].replace(/<[^>]+>/g,' ').trim(),roles=descriptionRoles(label);if(roles.length)add(m[1],label,roles,roles.includes('mint')||roles.includes('nft')?3:1);
 }
 return found.filter(r=>!excluded.has(r.address.toLowerCase()));
}
function rawCandidates(text,source){return foreignJsonChain(text)?[]:[...text.matchAll(new RegExp(ADDR,'g'))].slice(0,80).map(m=>({address:address(m[1]),priority:0,source,field:'网页提及地址',roles:[]}));}
export async function discover(asset,options={}){
 asset=normalizeAssetInput(asset);
 if(/^0x[0-9a-f]{40}$/i.test(asset))return discoverImpl(asset,options);
 const key=[websiteUrl(asset).href,scopeKey(options),!!options.chainFallback,!!options.learn,options.corlaRouting!==false].join('|');
 let task=pending.get(key);
 if(task)count('discoveryCoalescedReads');
 else{task=discoverImpl(asset,options);pending.set(key,task);}
 try{return structuredClone(await task);}finally{if(pending.get(key)===task)pending.delete(key);}
}
async function discoverImpl(asset,{rpc,fetchText=publicText,sourceLoader=sourceFor,chainFallback=false,learn=false,chainLearner=null,corlaRouting=true}={}){
 if(rpc&&corlaRouting&&bagentInput(asset))return measure('bagentDiscovery',()=>discoverBagent(rpc,asset));
 if(rpc&&corlaRouting&&binanciansInput(asset)?.explicit)return measure('binanciansDiscovery',()=>discoverBinancians(rpc,asset));
 // Platform dispatch precedes generic source/ABI/history discovery. A verified
 // Corla project never enters the unrelated mint-guessing fallback.
 if(rpc&&corlaRouting&&(chainFallback||learn||corlaInput(asset)?.priority)){
  const corla=await measure('corlaDiscovery',()=>discoverCorla(rpc,asset));if(corla)return corla;
 }
 if(rpc&&corlaRouting&&(chainFallback||learn)&&/^0x[\da-f]{40}$/i.test(asset)){
  const launchpad=await measure('binanciansDiscovery',()=>discoverBinancians(rpc,asset));if(launchpad)return launchpad;
 }
 const assist=async r=>applyChainEvidence(r,await (chainLearner||learnerFor(rpc)).learn(r.addresses?.length?r.addresses:[{address:r.address}],{sourceLoader,force:learn}));
 if(/^0x[0-9a-f]{40}$/i.test(asset)){const r={address:address(asset),source:'用户输入 CA',candidates:[]};return learn&&rpc?assist(r):r;}
 const u=websiteUrl(asset),key=u.href+'#'+scopeKey({rpc,fetchText,sourceLoader,chainLearner})+(chainFallback?'#fallback':''),cached=memory.get(key);if(!learn&&fetchText===publicText&&cached&&cached.until>Date.now()){count('discoveryCacheHits');return structuredClone(cached.value);}
 const pathCAs=[...u.pathname.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)].map(m=>address(m[0]));
 if(pathCAs.length===1){const r={address:pathCAs[0],source:u.href,platform:/(^|\.)flap.sh$/.test(u.hostname)?'flap':/(^|\.)gang.fun$/.test(u.hostname)?'gang':null,candidates:[{address:pathCAs[0],source:'网址路径'}]};return learn&&rpc?assist(r):r;}
 const fetchRow=async url=>{for(let attempt=0;attempt<2;attempt++){try{count('websiteReads');return {url,text:await measure('websiteRead',()=>fetchText(url)),attempts:attempt+1};}catch(e){
  // Retry the requested page or an observed JS resource once, never a transaction or
  // a site's prepare/login endpoint. A transient CDN failure is not no contract.
  if(attempt===0&&(url===u.href||/\.m?js$/i.test(new URL(url).pathname))&&/timeout|aborted|fetch failed|ECONNRESET|EAI_AGAIN|HTTP (?:429|5\d\d)/i.test(e.message)){count('websiteReadRetries');continue;}
  return {url,text:'',error:e.message};
 }}};
 const paths=[u.href,new URL('./llms.txt',u).href,new URL('./skill.md',u).href,new URL('./config.js',u).href],rows=await Promise.all(paths.map(fetchRow));
 const linked=[...rows[0].text.matchAll(/<(?:script|a|link)\b[^>]*(?:src|href)=["']([^"']+)["']/gi)].map(m=>{try{return new URL(m[1],u);}catch{return null;}}).filter(s=>s?.origin===u.origin&&!paths.includes(s.href));
 const documents=linked.filter(s=>/(?:skill|llms|agents|mint)[^/]*\.(?:md|txt)$/i.test(s.pathname)).slice(0,3);
 const scripts=[...new Map(linked.filter(s=>/\.m?js$/i.test(s.pathname)&&!/(?:ethers|web3|vendor|react|analytics|beacon)[-.]/i.test(s.pathname)).map(s=>[s.href,s])).values()].sort((a,b)=>Number(/config|mint/i.test(b.pathname))-Number(/config|mint/i.test(a.pathname))).slice(0,24);
 const extra=await Promise.all([...new Set([...documents,...scripts].map(s=>s.href))].map(fetchRow));
 const seen=new Set([...paths,...extra.map(r=>r.url)]);let frontier=[...rows,...extra],remaining=12;
 // Follow observed static modules/documents, two levels with a total request cap.
 // Lazy route chunks and modulepreload deployments are common in Vite/Next apps.
 for(let depth=0;depth<3&&remaining>0;depth++){
  const modules=observedModuleLinks(frontier,u.href);
  const links=[...new Set([...mintDocumentLinks(frontier,u.href),...modules])].filter(url=>!seen.has(url)).slice(0,remaining);
  links.forEach(url=>seen.add(url));remaining-=links.length;frontier=await Promise.all(links.map(fetchRow));extra.push(...frontier);
 }
 const dataLinks=publicDataLinks([...rows,...extra],u.href).filter(url=>!seen.has(url));
 extra.push(...await Promise.all(dataLinks.map(fetchRow)));
 // Script text is parsed only. It is never eval'ed or imported.
 const frontendCalls=publishedMintCalls([...rows,...extra]);
 const candidates=mergeCandidates([...rows.flatMap(r=>[...extractCandidates(r.text,r.url),...rawCandidates(r.text,r.url)]),...extra.flatMap(r=>extractCandidates(r.text,r.url)),...frontendCalls.map(c=>({address:c.address,field:'网页实际调用 · '+c.method,method:c.name,roles:['mint'],priority:5,source:c.source}))]);
 let resolved;
 if(rpc)resolved=await measure('addressRoles',()=>classifyAddresses(rpc,candidates.flatMap(c=>c.hints.map(h=>({...h,address:c.address}))),sourceLoader,{frontendCalls}));
 else{const project=candidates.filter(c=>!c.roles.some(r=>['registry','treasury','oracle','art','multicall','payment','router','factory','pool'].includes(r))),top=Math.max(-1,...project.map(x=>x.priority)),strong=project.filter(c=>c.priority===top);
  resolved={address:strong.length===1?strong[0].address:null,addresses:candidates,candidates:project,needsSelection:strong.length!==1};}
 const multipleKnownEntries=resolved.candidates?.filter(r=>r.verifiedRoles?.includes('mint')).length>1;
 if(rpc&&(learn||chainFallback&&!multipleKnownEntries&&(!resolved.address||!resolved.addresses?.find(r=>r.primary)?.verifiedRoles.includes('mint'))))resolved=await assist(resolved);
 const primary=resolved.addresses?.find(r=>r.primary);
 const access=!resolved.address&&!resolved.addresses?.length?siteAccess([...rows,...extra],u.href):null;
 const value={...resolved,access,pageError:rows[0].error||null,discovery:{documents:[...rows,...extra].filter(r=>r.text).map(r=>r.url),candidateCount:candidates.length},name:websiteName(rows[0].text)||primary?.name||u.hostname,nameSource:websiteName(rows[0].text)?'website':primary?.name?'onchain':'hostname',source:u.href,referralHints:detectReferralHints([...rows,...extra],u.href),errors:[...rows,...extra].filter(r=>r.error).map(r=>({url:r.url,error:r.error}))};
 value.abiHints=publishedAbiHints([...rows,...extra]);value.frontendCalls=frontendCalls;value.mintPuzzle=publishedMintPuzzle([...rows,...extra]);
 if(!value.address){value.failure=discoveryFailure(value);value.reason=value.failure.message;value.needsSelection=!!value.candidates?.length;}
 if(fetchText===publicText&&!value.pageError){if(memory.size>=256)memory.delete(memory.keys().next().value);const incomplete=value.chainLearning?.partial||['unavailable','time-budget'].includes(value.chainLearning?.status)||extra.some(r=>r.error&&/\.m?js$/i.test(new URL(r.url).pathname));memory.set(key,{until:Date.now()+(incomplete?5000:60000),value:structuredClone(value)});}return value;
}
export const IMPL_SLOT='0x'+(BigInt(id('eip1967.proxy.implementation'))-1n).toString(16).padStart(64,'0');
export const BEACON_SLOT='0x'+(BigInt(id('eip1967.proxy.beacon'))-1n).toString(16).padStart(64,'0');
function slotAddress(slot){if(!/^0x0{24}[0-9a-f]{40}$/i.test(slot||''))throw Error('代理存储地址格式异常');return BigInt(slot)?'0x'+slot.slice(-40).toLowerCase():null;}
export async function codeIdentity(rpc,target){
 const [code,slot,beaconSlot]=await Promise.all([rpc.getCode(target),rpc.send('eth_getStorageAt',[target,IMPL_SLOT,'latest']),rpc.send('eth_getStorageAt',[target,BEACON_SLOT,'latest'])]);
 if(!code||code==='0x')throw Error('地址没有部署合约');
 const clone=/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(code);
 let impl=clone?'0x'+clone[1]:slotAddress(slot);const beacon=slotAddress(beaconSlot);let beaconCode=null;
 if(beacon){
  if(impl)throw Error('代理同时存在实现与 Beacon，需专用适配器核验');
  const [bc,raw,fromProxy]=await Promise.all([rpc.getCode(beacon),rpc.send('eth_call',[{to:beacon,data:id('implementation()').slice(0,10)},'latest']),rpc.send('eth_call',[{from:target,to:beacon,data:id('implementation()').slice(0,10)},'latest'])]);
  if(slotAddress(raw)!==slotAddress(fromProxy))throw Error('Beacon 实现依赖调用者，需要专用适配器核验');
  beaconCode=bc;impl=slotAddress(raw);if(!bc||bc==='0x'||!impl)throw Error('Beacon 未返回有效的实现合约');
 }
 const implCode=impl?await rpc.getCode(impl):null;if(impl&&(!implCode||implCode==='0x'))throw Error('代理实现没有代码');
 // Preserve existing non-beacon fingerprints used by pinned sample adapters.
 const parts=[keccak256(code),impl,implCode?keccak256(implCode):null];if(beacon)parts.push(beacon,keccak256(beaconCode));
 return {target,code,implementation:impl,implementationCode:implCode,beacon,beaconCode,fingerprint:hash(parts)};
}
export class SourceCache{
 constructor({data=DATA,fetchJson=getJson,now=Date.now,missMs=30000}={}){Object.assign(this,{data,fetchJson,now,missMs});this.pending=new Map();this.misses=new Map();}
 async get(c,code){
  const key=hash(c.toLowerCase()+keccak256(code)),file=path.join(this.data,'sources',key+'.json');
  const valid=s=>s&&['match','exact_match'].includes(s.runtimeMatch)&&s.runtimeBytecode?.onchainBytecode?.toLowerCase()===code.toLowerCase()&&Array.isArray(s.abi)&&s.sources;
  let saved=null;try{saved=load(file);}catch{}if(valid(saved)){count('sourceCacheHits');return saved;}
  if(this.misses.get(key)>this.now()){count('sourceNegativeCacheHits');return null;}
  if(this.pending.has(key)){count('sourceCoalescedReads');return this.pending.get(key);}
  const task=(async()=>{try{const s=await this.fetchJson(`https://sourcify.dev/server/v2/contract/56/${c}?fields=abi,sources,runtimeBytecode.onchainBytecode`,{},4500);if(valid(s)){save(file,s);return s;}}catch{}
   this.misses.set(key,this.now()+this.missMs);if(this.misses.size>1000)this.misses.delete(this.misses.keys().next().value);return null;
  })();this.pending.set(key,task);try{return await task;}finally{this.pending.delete(key);}
 }
}
const sourceCache=new SourceCache();
export async function sourceFor(rpc,target,{cache=sourceCache}={}){
 const identity=await measure('codeIdentity',()=>codeIdentity(rpc,target)),code=identity.implementationCode||identity.code,c=identity.implementation||target;
 const source=await measure('verifiedSource',()=>cache.get(c,code));
 return {address:target,hash:identity.fingerprint,identity,runtimeCode:code,verified:!!source,abi:source?.abi,sources:source?.sources,proxy:!!identity.implementation&&!source};
}
