import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {solidityPackedKeccak256} from 'ethers';
const run=promisify(execFile);let compiled;
async function build(){
 if(!['darwin','linux'].includes(process.platform)||!fs.existsSync('/usr/bin/clang'))return null;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mint-proof-cpu-'));fs.chmodSync(dir,0o700);const file=path.join(dir,'proof');
 process.once('exit',()=>{try{fs.rmSync(dir,{recursive:true,force:true});}catch{}});
 try{
  const sdk=process.platform==='darwin'?(await run('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],{timeout:3000,maxBuffer:4096})).stdout.trim():null;
  if(sdk&&(!path.isAbsolute(sdk)||!fs.existsSync(sdk)))throw Error('No matching SDK');
  await run('/usr/bin/clang',['-O3','-std=c11','-Wall','-Wextra',...(sdk?['-isysroot',sdk]:[]),fileURLToPath(new URL('./pow-cpu.c',import.meta.url)),'-o',file],{timeout:10000,maxBuffer:128<<10});
  // Independent ethers test vectors before using the optional accelerator.
  for(const [address,nonce]of [['0x'+'00'.repeat(20),'0'],['0x'+'ff'.repeat(20),'1844674407370955161'],['0x1234567890abcdef1234567890abcdef12345678','902381']]){
   const {stdout}=await run(file,['--digest',address,nonce],{timeout:1000,maxBuffer:256});if('0x'+stdout.trim()!==solidityPackedKeccak256(['address','uint256'],[address,nonce]))throw Error('Local Keccak test vector mismatch');
  }
  return file;
 }catch{return null;}
}
export async function cpuWalletNonce(address,bits,{start,budgetMs}){
 const binary=await(compiled??=build());if(!binary)return null;
 const {stdout}=await run(binary,[address,String(bits),start,String(budgetMs)],{timeout:budgetMs+1000,maxBuffer:4096}),r=JSON.parse(stdout);
 if(!/^\d+$/.test(r.next)||r.nonce!==null&&!/^\d+$/.test(r.nonce))throw Error('本地 PoW 输出无效');
 if(r.nonce!==null&&BigInt(solidityPackedKeccak256(['address','uint256'],[address,r.nonce]))>=(1n<<BigInt(256-bits)))throw Error('本地 PoW 摘要校验不一致');
 return r;
}
export async function cpuChallengeNonce(address,challenge,target,{start,budgetMs}){
 if(process.platform!=='darwin')return null;const binary=await(compiled??=build());if(!binary)return null;
 const {stdout}=await run(binary,['--sha256',address,challenge,'0x'+BigInt(target).toString(16).padStart(64,'0'),start,String(budgetMs)],{timeout:budgetMs+1000,maxBuffer:4096});
 return JSON.parse(stdout); // The caller independently verifies SHA256 + target.
}
export async function cpuPrefixNonce(prefix,target,{start,budgetMs}){
 if(process.platform!=='darwin')return null;const binary=await(compiled??=build());if(!binary)return null;
 const {stdout}=await run(binary,['--sha256-prefix',prefix,'0x'+BigInt(target).toString(16).padStart(64,'0'),start,String(budgetMs)],{timeout:budgetMs+1000,maxBuffer:4096});return JSON.parse(stdout);
}
