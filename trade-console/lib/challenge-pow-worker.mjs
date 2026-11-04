import {parentPort,workerData} from 'node:worker_threads';import {createHash} from 'node:crypto';
const {address,challenge,prefix,target,start,budgetMs}=workerData,buf=Buffer.concat([...(prefix?[Buffer.from(prefix.slice(2),'hex')]:[Buffer.from(address.slice(2),'hex'),Buffer.from(challenge.slice(2),'hex')]),Buffer.alloc(32)]),limit=Buffer.from(BigInt(target).toString(16).padStart(64,'0'),'hex');
let nonce=BigInt(start),attempts=0,found=null;const began=performance.now();
do{buf.writeBigUInt64BE(nonce,buf.length-8);if(Buffer.compare(createHash('sha256').update(buf).digest(),limit)<=0){found=String(nonce);nonce++;attempts++;break;}nonce++;attempts++;}while(attempts<10000000&&(attempts%4096!==0||performance.now()-began<budgetMs));
parentPort.postMessage({nonce:found,next:String(nonce),attempts,elapsedMs:performance.now()-began,backend:'local-sha256'});
