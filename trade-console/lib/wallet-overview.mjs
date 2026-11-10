import {bindings,formatUnits} from './common.mjs';

// Native balance is independent of project discovery and token metadata.
export async function walletOverview(rpc,bridge,readiness,{checkConnection=false}={}){
 const accounts=bindings(),at=Date.now();
 const blockResult=await rpc.getBlockNumber().then(block=>({block}),e=>({error:e.message}));
 const wallets=await Promise.all(accounts.map(async w=>{
  const [connection,balance]=await Promise.allSettled([
   checkConnection?bridge.ready(w.account,{force:true}):Promise.resolve(readiness.get(w.account)||bridge.readyCache?.get(w.account)||{status:'UNKNOWN'}),
   // Display-only reads may recover at latest when just eth_blockNumber fails.
   // Trade planning still uses its own fresh, verified snapshot.
   rpc.getBalance(w.address,blockResult.block??'latest')
  ]);
  const state=connection.status==='fulfilled'?connection.value:{status:'ERROR',error:connection.reason.message};
  if(checkConnection)readiness.set(w.account,{...w,...state,checkedAt:Date.now()});
  return {...w,status:state.status||'UNKNOWN',connectionError:state.error||null,checkedAt:state.checkedAt||null,sessionExpireTime:state.sessionExpireTime||null,
   bnb:balance.status==='fulfilled'?formatUnits(balance.value,18):null,balanceError:balance.status==='rejected'?balance.reason.message:null,balanceAt:at};
 }));
 return {wallets,block:blockResult.block??null,blockError:blockResult.error??null,at};
}
