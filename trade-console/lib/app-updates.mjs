import fs from 'node:fs';
export const UPDATE_REPOSITORY='fh199601-oss/agent-trade-console';
const REPO='https://github.com/'+UPDATE_REPOSITORY;
export function versionParts(v){const m=/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);if(!m)throw Error('版本号格式无效');return {numbers:m.slice(1,4).map(Number),pre:m[4]||''};}
export function compareVersions(a,b){const x=versionParts(a),y=versionParts(b);for(let n=0;n<3;n++)if(x.numbers[n]!==y.numbers[n])return Math.sign(x.numbers[n]-y.numbers[n]);if(x.pre===y.pre)return 0;if(!x.pre)return 1;if(!y.pre)return -1;const xa=x.pre.split('.'),ya=y.pre.split('.');for(let i=0;i<Math.max(xa.length,ya.length);i++){if(xa[i]===ya[i])continue;if(xa[i]===undefined)return -1;if(ya[i]===undefined)return 1;const nx=/^\d+$/.test(xa[i]),ny=/^\d+$/.test(ya[i]);return nx&&ny?Math.sign(Number(xa[i])-Number(ya[i])):nx!==ny?nx?-1:1:xa[i]>ya[i]?1:-1;}return 0;}
export function updatePlatform(platform=process.platform,arch=process.arch){const os={darwin:'macos',win32:'windows'}[platform];return os&&['x64','arm64'].includes(arch)?os+'-'+arch:null;}
export function releaseInfo(release,currentVersion,platform){
 versionParts(currentVersion);if(!release||release.draft!==false||release.prerelease!==false||!/^v\d+\.\d+\.\d+$/.test(release.tag_name||''))throw Error('GitHub 未返回有效的正式发行版');
 const tag=release.tag_name,releaseUrl=REPO+'/releases/tag/'+tag;if(release.html_url!==releaseUrl)throw Error('更新来源与官方仓库不一致');
 const filename=platform?`agent-trade-console-${tag}-${platform}.zip`:null,asset=release.assets?.find(a=>a.name===filename&&a.state==='uploaded');
 const validAsset=a=>a&&a.browser_download_url===REPO+'/releases/download/'+tag+'/'+a.name;
 const checksum=release.assets?.find(a=>a.name===filename+'.sha256'&&a.state==='uploaded');
 const diff=compareVersions(tag,currentVersion),download=validAsset(asset)&&validAsset(checksum)?asset.browser_download_url:null;
 return {repository:UPDATE_REPOSITORY,currentVersion,latestVersion:tag.slice(1),state:diff>0?'available':diff<0?'ahead':'current',releaseUrl,publishedAt:release.published_at,notes:String(release.body||'暂无更新说明').slice(0,12000),platform,downloadUrl:download,checksumUrl:download?checksum.browser_download_url:null,sha256:/^sha256:[a-f0-9]{64}$/.test(asset?.digest||'')?asset.digest.slice(7):null,size:asset?.size||null,checkedAt:Date.now()};
}
export class AppUpdates{
 constructor({fetchImpl=globalThis.fetch,currentVersion,platform=updatePlatform(),now=Date.now}={}){
  this.fetch=fetchImpl;this.currentVersion=currentVersion||JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;this.platform=platform;this.now=now;this.cached=null;this.pending=null;
 }
 async check(){
  if(this.cached&&this.now()-this.cached.at<60000)return this.cached.value;if(this.pending)return this.pending;
  this.pending=(async()=>{
   // Anonymous, fixed public endpoint. No wallet/session data or credentials
   // are sent, and no remote JavaScript, installer or shell is executed.
   const r=await this.fetch('https://api.github.com/repos/'+UPDATE_REPOSITORY+'/releases/latest',{headers:{Accept:'application/vnd.github+json','User-Agent':'AgentTradeConsole-Updater'},redirect:'error',signal:AbortSignal.timeout(8000)});
   if(!r.ok)throw Error(r.status===403||r.status===429?'GitHub 查询暂时限流，请稍后重试':'无法查询 GitHub 更新（HTTP '+r.status+'）');
   if(Number(r.headers.get('content-length'))>1000000)throw Error('更新信息超出大小限制');const chunks=[];let size=0;for await(const chunk of r.body){size+=chunk.length;if(size>1000000)throw Error('更新信息超出大小限制');chunks.push(Buffer.from(chunk));}
   const value=releaseInfo(JSON.parse(Buffer.concat(chunks).toString('utf8')),this.currentVersion,this.platform);this.cached={at:this.now(),value};return value;
  })().finally(()=>this.pending=null);return this.pending;
 }
}
