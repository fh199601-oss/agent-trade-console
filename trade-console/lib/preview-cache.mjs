// The official wallet owns expiration. Local age limits can only shorten it.
export function previewUsable(p,now=Date.now(),maxAge=15000){
 const age=now-p?.at,expiry=p?.raw?.expiresAt;
 return !!p?.raw?.requestId&&Number.isFinite(age)&&age>=0&&age<=maxAge&&
  (expiry===undefined||expiry===null||Number.isFinite(Number(expiry))&&Number(expiry)>now+1500);
}
