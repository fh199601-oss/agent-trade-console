import {setImmediate as nextTurn} from 'node:timers/promises';

// Start every wallet independently; never wait for an earlier wallet's result.
// Between small bursts, let ready socket/fs callbacks run. A 100-wallet burst
// must not monopolize the JS thread while an earlier wallet is ready to send.
export async function parallelWallets(rows,run){
 const pending=[];
 for(let n=0;n<rows.length;n++){
  if(n&&n%8===0)await nextTurn();
  let task;try{task=Promise.resolve(run(rows[n],n));}catch(e){task=Promise.reject(e);}
  task.catch(()=>{});pending.push(task);
 }
 return Promise.all(pending);
}
