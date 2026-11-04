import {parentPort,workerData} from 'node:worker_threads';
import {keccak_256} from '@noble/hashes/sha3';
// Local, bounded CPU work. No network, filesystem, wallet or downloaded miner.
const {address,bits,start,budgetMs}=workerData,input=new Uint8Array(52),view=new DataView(input.buffer);
input.set(Buffer.from(address.slice(2),'hex'));let nonce=BigInt(start),attempts=0;const began=Date.now(),full=Math.floor(bits/8),mask=bits%8?256-(1<<(8-bits%8)):0;
while(attempts<4000000&&Date.now()-began<budgetMs){
 view.setBigUint64(44,nonce);const digest=keccak_256(input);let ok=true;for(let j=0;j<full;j++)if(digest[j]!==0){ok=false;break;}
 if(ok&&(!mask||(digest[full]&mask)===0)){parentPort.postMessage({nonce:String(nonce),next:String(nonce+1n),attempts,elapsedMs:Date.now()-began});process.exit(0);}
 nonce++;attempts++;
}
parentPort.postMessage({nonce:null,next:String(nonce),attempts,elapsedMs:Date.now()-began});
