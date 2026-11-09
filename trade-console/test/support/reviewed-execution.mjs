// Lifecycle tests model an explicit operator accepting the fee dialog. This is
// test-only; production quick mode never supplies this acknowledgement. The
// real no-consent/automatic/UI boundaries are exercised in trade-fees.test.mjs.
export async function executeReviewed(engine,id,options={}){
 const o=engine.get(id),onlyFeeReview=(o?.review||[]).every(s=>s.startsWith('费用核对：'));
 return engine.execute(id,{...options,...(o?.feeReview?.required?{feeAcknowledgement:o.feeReview.id,acknowledgeReview:options.acknowledgeReview||onlyFeeReview}:{})});
}
export async function runReviewed(engine,intent,id,options={}){
 const o=await engine.prepare(intent,id);
 return options.execute&&['PREPARED','READY_TO_CONTINUE'].includes(o.status)?executeReviewed(engine,id,options):o;
}
