// Shared by reports and UI. Unknown reverts never imply a sold-out/ended sale.
export const failureLabels={site_proof:'需要本钱包官网凭证',deferred:'认购后另行领取',input_needed:'请明确铸造份数',proof_pending:'工作量证明尚未完成',ended:'铸造已结束',no_quota:'当前无可用额度',ineligible:'钱包资格不足',not_open:'铸造尚未开放',paused:'合约暂停',budget:'本次预算不足',route_choice:'待选择铸造方式',adapter_needed:'此类型仍需适配',network:'网络查询失败',wallet_or_simulation:'钱包或模拟检查未通过',eligibility_or_state:'合约状态不允许',validation:'预览未通过'};
export function failureKind(error){
 const code=error?.code||'',message=error?.message||'';
 if(['CHAIN_HISTORY_INCOMPLETE','WEBSITE_UNAVAILABLE'].includes(code))return 'network';
 if(code==='NO_FREE_MINT')return 'no_quota';
 if(['SITE_PROOF_REQUIRED','SITE_PROOF_INVALID'].includes(code))return 'site_proof';
 if(code==='DEFERRED_MINT_REQUIRED')return 'deferred';
 if(/请(?:指定|填写明确)份数|请指定铸造份数|请填写明确份数/.test(message))return 'input_needed';
 if(code==='MINT_PROOF_TIMEOUT')return 'proof_pending';
 if(code==='MINT_PROOF_INVALID')return 'adapter_needed';
 if(/ROUTE_REQUIRED|MULTIPLE_MINT/.test(code))return 'route_choice';
 if(/VOUCHER_REQUIRED|REFERRAL_NOT_VERIFIED/.test(code))return 'adapter_needed';
 if(code==='MINT_ENDED'||/阶段已结束|铸造已结束|项目已结束|铸造阶段已关闭|\b(?:sale ended|mint ended|presale ended)\b/i.test(message))return 'ended';
 if(code==='NO_QUOTA'||/额度.*(?:为 0|用完|耗尽)|已售罄|(?:free|paid) (?:pool )?(?:exhausted|sold out)/i.test(message))return 'no_quota';
 if(code==='BUDGET_LIMIT'||/预算不足|超过.*预算|没有符合预算|没有零费用|不属于零费用/.test(message))return 'budget';
 if(code==='MINT_INELIGIBLE'||/资格不足|没有.*Agent ID|NotAgentIdHolder|NotAgent\b|不满足.*资格|未通过.*资格/i.test(message))return 'ineligible';
 if(code==='MINT_PAUSED'||/合约暂停|合约当前暂停|铸造已暂停|合约已暂停/.test(message))return 'paused';
 if(code==='MINT_NOT_OPEN'||/未开放|未开始|尚未开放/.test(message))return 'not_open';
 if(/timeout|timed out|fetch failed|HTTP (?:429|5\d\d)|network|超时|网络/i.test(message))return 'network';
 if(/钱包.*(?:登录|连接|模拟)|CONNECTED|developer|session/i.test(message))return 'wallet_or_simulation';
 if(code==='MINT_STATE')return 'eligibility_or_state';
 if(/UNSUPPORTED|NOT_VERIFIED|NEEDS|NO_CONTRACT|ADAPTER_INCOMPLETE/.test(code)||/未.*(?:核验|识别)|未知|需要.*适配|无法.*(?:识别|核实)|签名.*参数/.test(message))return 'adapter_needed';
 return 'validation';
}
