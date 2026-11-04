import {StringDecoder} from 'node:string_decoder';
// Ignore only embedded image payloads, not scripts, ABI strings or footer text.
// Raw network bytes and retained text both have independent hard bounds.
export async function boundedPageText(body,{maxRaw=16*1024*1024,maxText=2*1024*1024}={}){
 const decoder=new StringDecoder('utf8'),chunks=[];let raw=0,kept=0,pending='',image=false;
 const append=s=>{kept+=Buffer.byteLength(s);if(kept>maxText)throw Error('网页文本内容超过 2MB');chunks.push(s);};
 const consume=(final=false)=>{while(pending.length){
  if(image){const n=pending.match(/^[A-Za-z0-9+/=\r\n]+/)?.[0].length||0;pending=pending.slice(n);if(!pending.length)return;image=false;}
  const match=/data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml|x-icon);base64,/i.exec(pending);
  if(match){const end=match.index+match[0].length;append(pending.slice(0,end));pending=pending.slice(end);image=true;continue;}
  const end=final?pending.length:Math.max(0,pending.length-96);if(end){append(pending.slice(0,end));pending=pending.slice(end);}return;
 }};
 for await(const c of body){raw+=c.length;if(raw>maxRaw)throw Error('网页原始内容超过 16MB');pending+=decoder.write(c);consume();}
 pending+=decoder.end();consume(true);return chunks.join('');
}
