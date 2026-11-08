// Host/path hints select a reader; only the on-chain factory proves membership.
export function binanciansInput(input){
 const s=String(input).trim();if(/^0x[\da-f]{40}$/i.test(s))return {address:s,explicit:false};
 let u;try{u=new URL(s.startsWith('//')?'https:'+s:/^https?:/i.test(s)?s:'https://'+s);}catch{return null;}
 if(!['binanciansai.meme','www.binanciansai.meme'].includes(u.hostname.toLowerCase().replace(/\.$/,''))||u.username||u.password||u.port)return null;
 const m=u.pathname.match(/^\/project\/(0x[\da-f]{40})\/?$/i);
 return {address:m?.[1]||null,explicit:true,source:u.href};
}
