// Descriptions are hints, not promises about price or eligibility. Quotes and
// wallet simulation still validate the selected method before any execution.
export function mintRouteOptions(routes){
 return routes.map(r=>({id:r.id,method:r.method,lane:r.lane||null,title:r.chainEvidence?'链上样本辅助识别':/^(freeMint|mintFree|claimFree)\(/.test(r.method)?'免费铸造入口（名称提示）':r.lane==='paid'?'付费铸造入口（名称提示）':r.quantity?'按份数铸造':'单次铸造',description:(r.quantity?'支持输入份数':'每次调用一份')+'；费用、资格以本次预览为准',runtime:!!r.runtime}));
}
export function selectMintRoute(recognized,routeId,experienceRouteId=null,scope=null){
 if(recognized.failure)throw Object.assign(Error(recognized.failure.message),{code:recognized.failure.code,details:recognized.failure.details});
 const options=mintRouteOptions(recognized.routes);
 if(routeId){const route=recognized.routes.find(r=>r.id===routeId);if(route)return route;
  throw Object.assign(Error('所选铸造方式已失效，请从当前选项重新选择'),{code:'MINT_ROUTE_INVALID',details:{routes:options}});
 }
 if(recognized.routes.length===1)return recognized.routes[0];
 // Scope disambiguates explicit free/paid lanes only. The chosen lane is still
 // quoted and simulated; names never prove that a mint is actually free.
 if(scope==='free'||scope==='paid'){const matching=recognized.routes.filter(r=>r.lane===scope);if(matching.length===1)return matching[0];}
 if(scope==='all'&&recognized.routes.length===2&&recognized.routes.filter(r=>r.lane==='free').length===1&&recognized.routes.filter(r=>r.lane==='paid').length===1)return recognized.routes.find(r=>r.lane==='free');
 // History is only a route hint. The caller still re-quotes and simulates it.
 if(experienceRouteId){const previous=recognized.routes.find(r=>r.id===experienceRouteId);if(previous&&(!scope||!previous.lane||scope==='all'||previous.lane===scope))return previous;}
 if(options.length)throw Object.assign(Error('请选择一种铸造方式，再重新预览'),{code:'MINT_ROUTE_REQUIRED',details:{routes:options}});
 throw Object.assign(Error('暂不能构造 Mint：'+recognized.reason),{code:'MINT_UNSUPPORTED',details:{routes:[]}});
}
