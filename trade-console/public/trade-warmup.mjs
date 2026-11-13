// Optional read-only prefetch. No wallet, amount or execution parameter is sent.
// A failed/busy prefetch must never delay a user's buy or sell.
export function createTradeWarmup({api,allowed=()=>true,delayMs=250,now=Date.now}){
 let timer,last='',after=0;
 return value=>{
  clearTimeout(timer);
  const asset=String(value||'').trim();
  if(!/^0x[\da-f]{40}$/i.test(asset)||/^0x0{40}$/i.test(asset)||!allowed())return;
  const key=asset.toLowerCase();if(key===last&&now()<after)return;
  timer=setTimeout(()=>{
   if(!allowed())return;last=key;after=now()+15000;
   Promise.resolve().then(()=>api('trade-warm',{asset})).catch(()=>{});
  },delayMs);
 };
}

// Only read-only planning/preview. Never call run, prepare, execute or sign.
export function createSellPreparationWarmup({api,intents,allowed=()=>true,delayMs=300,now=Date.now,endpoint='sell-warm'}){
 let timer,pending=false,last='',after=0;
 return ()=>{
  clearTimeout(timer);if(!allowed()||pending)return;
  timer=setTimeout(()=>{
   if(!allowed()||pending)return;
   let rows;try{rows=intents();}catch{return;}if(!rows?.length)return;
   const key=JSON.stringify(rows);if(key===last&&now()<after)return;
   last=key;after=now()+4000;pending=true;
   Promise.resolve().then(()=>api(endpoint,{intents:rows})).catch(()=>{}).finally(()=>pending=false);
  },delayMs);
 };
}
