import {flapHost} from './corla-input.mjs';
// Only the entire pasted value may be a CA. Never extract one from a URL.
export function mintTradeCA(value){const s=typeof value==='string'?value.trim():'';return /^0x[\da-f]{40}$/i.test(s)&&!/^0x0{40}$/i.test(s)?s:null;}
// Shared by the dashboard and server: preserve paths, queries and hashes while
// accepting a bare public domain. Network access still pins a public DNS result.
export function normalizeAssetInput(value){
 if(typeof value!=='string')throw Error('请输入项目域名、网址或完整 CA');
 let s=value.trim();if(!s||s.length>2048||/[\s\\\u0000-\u001f\u007f]/u.test(s))throw Error('请输入有效域名或网址，不要包含空格');
 // Repair only identical concatenated full URLs/CA. Different URLs must not
 // silently select a different project. Redirect URLs inside queries survive.
 for(let n=2;n<=4;n++){if(s.length%n===0){const part=s.slice(0,s.length/n);if((/^https:\/\//i.test(part)||/^0x[\da-f]{40}$/i.test(part))&&part.repeat(n)===s){s=part;break;}}}
 if(/^0x[0-9a-f]{40}$/i.test(s))return s;
 if(/^0x[0-9a-f]*$/i.test(s))throw Error('请输入完整的 42 字符 CA');
 const explicit=/^[a-z][a-z\d+.-]*:/i.test(s)&&!/^([^/?#:]+):\d+(?:[/?#]|$)/.test(s);
 let u;try{u=new URL(s.startsWith('//')?'https:'+s:explicit?s:'https://'+s);}catch{throw Error('无法识别网址，请输入完整域名，例如 example.com');}
 if(u.protocol==='http:'&&flapHost(u.hostname.replace(/\.$/,''))&&!u.port)u.protocol='https:';
 if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443'))throw Error('项目网站只支持无账号信息的 HTTPS 地址；省略协议时会自动补全');
 if(/https?:\/\//i.test(u.pathname))throw Error('输入中包含多条拼接网址，请只保留一个项目网址');
 const host=u.hostname.replace(/\.$/,'');
 if(!host.includes('.')||host.split('.').some(part=>!part||part.length>63||! /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(part)))throw Error('请输入有效的公开域名，例如 example.com');
 u.hostname=host;return u.href;
}
export function pasteAsset(input,event,{caOnly=false}={}){
 const text=event.clipboardData?.getData('text/plain');if(!text)return false;
 let value;try{value=caOnly?mintTradeCA(text):normalizeAssetInput(text);}catch{return false;}
 if(!value)return false;event.preventDefault();input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));return true;
}
export function resolvedTradeAsset(project,input,current){
 // Correct only the Mint CA that was just mirrored into Quick Trade. Never
 // overwrite an unrelated token explicitly entered in that panel.
 const ca=mintTradeCA(input);return project?.platform==='binancians'&&ca&&project.token&&ca.toLowerCase()===String(project.address).toLowerCase()&&String(current).toLowerCase()===ca.toLowerCase()?project.token:null;
}
