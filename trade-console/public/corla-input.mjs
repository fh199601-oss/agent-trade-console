// Routing hints only. The server must verify official factory membership and
// implementation identity before constructing any transaction.
export const flapHost=host=>host==='flap.sh'||host.endsWith('.flap.sh');
export function corlaHint(value){
 if(typeof value!=='string')return null;
 const input=value.trim();if(/^0x[\da-f]{40}$/i.test(input))return {address:input,explicit:false,priority:input.toLowerCase().endsWith('7777')};
 let u;try{u=new URL(input.startsWith('//')?'https:'+input:/^[a-z][a-z\d+.-]*:/i.test(input)?input:'https://'+input);}catch{return null;}
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port)return null;
 u.hostname=u.hostname.replace(/\.$/,'');if(!flapHost(u.hostname))return null;u.protocol='https:';
 let path;try{path=decodeURIComponent(u.pathname)+(u.hash.startsWith('#/')?decodeURIComponent(u.hash.slice(1)):'');}catch{return null;}
 const explicit=/(?:^|\/)apps\/corla(?:\/|$)/i.test(path);
 let addresses=[...path.matchAll(/(?:^|\/)(0x[\da-f]{40})(?=\/|[?#]|$)/ig)].map(m=>m[1]);
 if(!addresses.length)for(const name of ['ca','token','address','mint'])for(const a of u.searchParams.getAll(name))if(/^0x[\da-f]{40}$/i.test(a))addresses.push(a);
 addresses=[...new Map(addresses.map(a=>[a.toLowerCase(),a])).values()];
 if(addresses.length>1)throw Object.assign(Error('链接包含多个项目地址，请输入一个项目详情链接或 CA'),{code:'CORLA_LINK'});
 if(!addresses.length){if(!explicit)return null;if(!/(?:^|\/)apps\/corla\/?$/i.test(path))throw Object.assign(Error('Corla 项目链接缺少完整 CA，请粘贴详情链接或完整合约地址'),{code:'CORLA_LINK'});}
 return {address:addresses[0]||null,explicit,priority:true,source:u.href};
}
