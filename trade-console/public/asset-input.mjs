// Shared by the dashboard and server: preserve paths, queries and hashes while
// accepting a bare public domain. Network access still pins a public DNS result.
export function normalizeAssetInput(value){
 if(typeof value!=='string')throw Error('请输入项目域名、网址或完整 CA');
 const s=value.trim();if(!s||s.length>2048||/[\s\\\u0000-\u001f\u007f]/u.test(s))throw Error('请输入有效域名或网址，不要包含空格');
 if(/^0x[0-9a-f]{40}$/i.test(s))return s;
 if(/^0x[0-9a-f]*$/i.test(s))throw Error('请输入完整的 42 字符 CA');
 const explicit=/^[a-z][a-z\d+.-]*:/i.test(s)&&!/^([^/?#:]+):\d+(?:[/?#]|$)/.test(s);
 let u;try{u=new URL(s.startsWith('//')?'https:'+s:explicit?s:'https://'+s);}catch{throw Error('无法识别网址，请输入完整域名，例如 example.com');}
 if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443'))throw Error('项目网站只支持无账号信息的 HTTPS 地址；省略协议时会自动补全');
 const host=u.hostname.replace(/\.$/,'');
 if(!host.includes('.')||host.split('.').some(part=>!part||part.length>63||! /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(part)))throw Error('请输入有效的公开域名，例如 example.com');
 u.hostname=host;return u.href;
}
