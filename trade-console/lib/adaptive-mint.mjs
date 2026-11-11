import {Interface,FunctionFragment,id,formatUnits,ZeroAddress} from 'ethers';
import parser from '@solidity-parser/parser';
import {referralParameter} from './referral.mjs';
import {runtimeShape} from './bytecode.mjs';
import {measure} from './diagnostics.mjs';
import {mintError} from './mint-errors.mjs';
import {walletParameterPrograms,evaluateWalletProgram} from './source-values.mjs';
import {nativePriceProgram,evaluateNativePrice} from './source-price.mjs';
import {frontendCallsFor,sourceMintName} from './frontend-mint.mjs';
import {recognizeFairMint} from './fair-mint.mjs';
import {sourceLimitPrograms,evaluateSourceLimits} from './source-limits.mjs';
export {runtimeShape} from './bytecode.mjs';

const NATIVE='0x'+'e'.repeat(40),UINT='uint256',MAX=500n;
const MINT_NAMES=['mintWithBnb','mintWithBNB','mintNative','mint','publicMint','mintPublic','agentMint','mintPass','freeMint','mintFree','claimFree','paidMint','mintPaid'];
const TX=['MAX_BATCH','MAX_MINT_PER_TRANSACTION','MAX_PER_TX','maxPerTx','MAX_MINT_PER_TX','maxMintPerTx','MAX_BATCH_SIZE','maxBatchSize'];
const REMAIN=['walletRemaining','quotaLeft','quotaRemaining','remainingQuota','remainingMints','mintsRemaining','remainingMintAllowance','remainingFor'];
const WALLET_CAP=['maxPerWallet','MAX_PER_WALLET','MAX_MINT_PER_WALLET','WALLET_LIMIT','WALLET_CAP','perWalletCap','maxMintPerWallet','maxPerAddress','MAX_PER_ADDRESS','MAX_MINT_PER_ADDRESS','maxMintPerAddress'];
const WALLET_USED=['walletMinted','mintedBy','mintedByWallet','mintedPerWallet','mintedCount','mintCount','walletMints','minted','mintedShares'];
const COUNTERS=[['TOTAL_SHARES','sold'],['TOTAL_SHARES','totalMinted'],['MAX_SHARES','sharesSold'],['MAX_SHARES','totalMinted'],['totalCards','cardsSold'],['publicSupply','publicMinted'],['MAX_SUPPLY','totalMinted'],['maxSupply','totalMinted'],['MAX_SUPPLY','totalSupply'],['maxSupply','totalSupply']];
const STOCK=['remainingShares','cardsRemaining','remainingSupply','remaining'];
const UNITS=['TOKENS_PER_SHARE','tokensPerShare','TOKENS_PER_MINT','tokensPerMint','MINT_AMOUNT','AMOUNT_PER_MINT','REWARD_PER_MINT','USER_SHARE'];
const MINT_END=['mintDeadline','mintEndTime','saleEndTime','MINT_END','mintEnd','saleEnd'];
const MINT_START=['mintStartTime','MINT_START_TIME','SALE_START','saleStartTime','MINT_START','mintStart'];
const TOKEN=['token','mintToken','TOKEN'];
const OPEN=['mintOpen','mintingOpen','saleActive','isMintOpen','publicSaleActive','mintEnabled'];
const PAUSED=['paused','isPaused','mintPaused'];
const ONCE=['hasMinted','hasPass','claimed','hasClaimed'];
const UNIT_PRICE=['currentPrice','unitPriceWei','mintPriceBnb','mintPriceBNB','priceWei','mintPrice','price','PRICE','MINT_PRICE','PASS_PRICE','cost','mintFee','nextPrice'];
const PAID_PRICE=['PAID_MINT_PRICE','PAID_PRICE','paidMintPrice','paidPrice'];
const QUOTES=['mintPrice','currentMintPrice','quote','quoteFor','priceFor','quoteMint','getMintPrice','bnbQuote','quoteBnb','quoteBNB','getBnbPrice','cost','costOf','costFor'];
const quantityName=/^_?(q|qty|quantity|amount|count|n|shares|cards|tokens|numTokens|num|numberOfTokens|mintAmount|mints)$/i;
const nativeUnitName=n=>/^(?:(?:mint|sale|public|current|unit|perToken|perNft)_?){1,3}(?:price|fee|cost)(?:_?(?:wei|bnb))?$/i.test(n);
const costName=/^_?(maxCost|maxTotalCost|maxPayment)$/i;
const money=n=>({raw:String(n),symbol:'BNB',decimals:18,formatted:formatUnits(n,18)});
const remaining=(cap,used)=>cap>used?cap-used:0n;
const smallest=values=>values.filter(v=>v!==null&&v!==undefined).reduce((a,b)=>a===null||b<a?b:a,null);
const number=v=>v===null?null:v>BigInt(Number.MAX_SAFE_INTEGER)?String(v):Number(v);
const normalizedName=n=>n.replace(/_/g,'').toLowerCase();
const quotaNames=new Set([...TX,...REMAIN,...WALLET_CAP,...WALLET_USED,...COUNTERS.flat(),...STOCK,'quotaOf','maxQuotaOf','maxMintable','freeRemaining','paidRemaining'].map(normalizedName));
function walk(node,fn){if(!node||typeof node!=='object')return;if(node.type)fn(node);for(const [k,v]of Object.entries(node))if(!['loc','range'].includes(k)){if(Array.isArray(v))v.forEach(n=>walk(n,fn));else if(v&&typeof v==='object')walk(v,fn);}}

function runtimeAbi(code,hints=[],frontend=[]){
 const shape=runtimeShape(code),functions=[];
 const add=s=>{const f=new Interface(['function '+s]).fragments[0];if(shape.selectors.has(f.selector))functions.push(JSON.parse(f.format('json')));};
 for(const name of MINT_NAMES){add(name+'() payable');add(name+'(uint256 quantity) payable');}
 for(const name of ['mint','mintWithBnb','mintWithBNB']){add(name+'(uint256 quantity,uint256 maxCost) payable');add(name+'(uint256 quantity,address referrer,uint256 maxCost) payable');}
 // An address argument is not inherently an inviter. This runtime-only family
 // requires its referral getter, then successful historical state-transition
 // evidence before any nonzero inviter can be supplied.
 if(shape.selectors.has(id('referrerOf(address)').slice(0,10)))for(const name of ['mint','mintWithBnb','mintWithBNB'])add(name+'(uint256 quantity,address referrer) payable');
 for(const name of QUOTES){add(name+'(address wallet,uint256 quantity) view returns(uint256)');add(name+'(uint256 quantity) view returns(uint256)');add(name+'(address wallet) view returns(uint256)');}
 for(const name of new Set([...TX,...WALLET_CAP,...COUNTERS.flat(),...STOCK,...UNITS,...MINT_END,...MINT_START,...UNIT_PRICE,...PAID_PRICE,'FREE_SUPPLY','FREE_SHARES','FREE_PER_WALLET','PAID_PER_WALLET','freeMinted','PAID_SUPPLY','paidMinted','decimals','freeRemaining','freeSharesRemaining','paidRemaining']))add(name+'() view returns(uint256)');
 for(const name of [...REMAIN,...WALLET_USED,'quotaOf','maxQuotaOf','maxMintPerWallet','freeClaimedCount','paidMintedCount','maxMintable','freeRemaining','paidRemaining'])add(name+'(address wallet) view returns(uint256)');
 for(const name of [...OPEN,...PAUSED,'freeOpen','paidOpen','opened'])add(name+'() view returns(bool)');
 for(const name of [...ONCE,'freeClaimed','hasAgentId','freeShareAvailable','canMint'])add(name+'(address wallet) view returns(bool)');
 for(const name of TOKEN)add(name+'() view returns(address)');
 add('supportsInterface(bytes4) view returns(bool)');add('ownerOf(uint256) view returns(address)');add('balanceOf(address) view returns(uint256)');
 add('getApproved(uint256) view returns(address)');add('isApprovedForAll(address,address) view returns(bool)');add('safeTransferFrom(address,address,uint256)');
 // Hints may refine return arity/mutability only for dispatched signatures
 // already in the bounded runtime vocabulary. They never assert verification.
 const bySelector=new Map(functions.map(f=>[FunctionFragment.from(f).selector,f]));
 // A site's actual bound call may use a new Mint name. Accept only the simple
 // no-argument / named-quantity form with a deployed selector. Signature/proof,
 // recipient, token ID and payment-token parameters still need explicit support.
 for(const c of frontend)try{const f=new Interface(c.abi).getFunction(c.method);if(f&&sourceMintName(f.name)&&f.selector===c.selector&&shape.selectors.has(f.selector)&&['payable','nonpayable'].includes(f.stateMutability)&&(!f.inputs.length||f.inputs.length===1&&f.inputs[0].type===UINT&&quantityName.test(f.inputs[0].name)))bySelector.set(f.selector,JSON.parse(f.format('json')));}catch{}
 for(const c of frontend)try{const f=FunctionFragment.from(c.price?.abi);if(f.format('sighash')===c.price?.method&&shape.selectors.has(f.selector)&&['view','pure'].includes(f.stateMutability)&&f.inputs.length===1&&f.inputs[0].type===UINT&&f.outputs.length===1&&f.outputs[0].type===UINT)bySelector.set(f.selector,JSON.parse(f.format('json')));}catch{}
 for(const value of hints)try{const f=FunctionFragment.from(value);let prior=bySelector.get(f.selector);
  // Frontends vary mintUnitPriceWei / unit_price_bnb spelling. A name supplies
  // only a candidate getter: deployed dispatch, canonical decoding, exact
  // payment, underpayment rejection and official credit remain mandatory.
  if(!prior&&shape.selectors.has(f.selector)&&['view','pure'].includes(f.stateMutability)&&!f.inputs.length&&f.outputs.length===1&&f.outputs[0].type===UINT&&nativeUnitName(f.name))prior=JSON.parse(f.format('json'));
  // Case/underscore spelling varies across new deployments. Only bounded quota
  // vocabulary, read-only scalar uint getters, and deployed selectors qualify.
  if(!prior&&shape.selectors.has(f.selector)&&['view','pure'].includes(f.stateMutability)&&quotaNames.has(normalizedName(f.name))&&['','address'].includes(f.inputs.map(p=>p.type).join(','))&&f.outputs.length===1&&f.outputs[0].type===UINT)prior=JSON.parse(f.format('json'));
  if(!prior||f.format('sighash')!==FunctionFragment.from(prior).format('sighash'))continue;
  if(!f.outputs.every(o=>/^(uint(?:256|64|8)|bool|address)$/.test(o.type))||f.outputs.length>4)continue;
  const write=MINT_NAMES.includes(f.name)||frontend.some(c=>c.selector===f.selector&&c.method===f.format('sighash'));if(write&&!['payable','nonpayable'].includes(f.stateMutability)||!write&&!['view','pure'].includes(f.stateMutability))continue;
  // Keep proven parameter roles from the built-in signature vocabulary.
  bySelector.set(f.selector,{...JSON.parse(f.format('json')),inputs:prior.inputs});
 }catch{}
 return {abi:[...bySelector.values()],proxy:shape.delegate};
}
function sourceFacts(meta){
 const functions=[];for(const s of Object.values(meta.sources||{})){try{walk(parser.parse(s.content),n=>{if(n.type==='FunctionDefinition'&&n.body)functions.push(n);});}catch{}}
 const usage=f=>{const body=functions.find(n=>n.name===f.name&&n.parameters?.length===f.inputs.length&&n.parameters.every((p,i)=>p.name===f.inputs[i].name));const used=new Set();if(body)walk(body.body,n=>{if(n.type==='Identifier')used.add(n.name);});return used;};
 const paid=f=>{const seen=new Set();const visit=n=>{if(seen.has(n))return false;seen.add(n);let found=false;walk(n.body,x=>{if(x.type!=='FunctionCall')return;const e=x.expression;if(e?.type==='MemberAccess'&&/^(safeTransferFrom|transferFrom)$/.test(e.memberName))found=true;if(e?.type==='Identifier')for(const helper of functions.filter(fn=>fn.name===e.name))if(visit(helper))found=true;});return found;};return functions.filter(n=>n.name===f.name&&n.parameters?.length===f.inputs.length).some(visit);};
 // A direct comparison of msg.value to a view call proves denomination and
 // links an unfamiliar quote name to this entry. No frontend labels required.
 const nativeQuotes=f=>{const names=new Set();for(const fn of functions.filter(n=>n.name===f.name&&n.parameters?.length===f.inputs.length)){
  const aliases=new Map();for(const s of fn.body.statements||[])if(s.type==='VariableDeclarationStatement'&&s.variables.length===1)aliases.set(s.variables[0]?.name,s.initialValue);
  const resolve=(n,d=0)=>d<8&&n?.type==='Identifier'&&aliases.has(n.name)?resolve(aliases.get(n.name),d+1):n;
  walk(fn.body,n=>{if(n.type!=='BinaryOperation'||!['==','!=','>=','<','>','<='].includes(n.operator))return;const native=x=>x?.type==='MemberAccess'&&x.expression?.name==='msg'&&x.memberName==='value';let other=resolve(native(n.left)?n.right:native(n.right)?n.left:null);
   // Verified exact price * quantity comparisons also identify the native
   // unit getter. Do not evaluate arbitrary frontend pricing expressions.
   if(other?.type==='BinaryOperation'&&other.operator==='*'){const quantity=x=>x?.type==='Identifier'&&f.inputs.some(p=>p.name===x.name&&quantityName.test(p.name)&&/^uint/.test(p.type));other=quantity(other.left)?resolve(other.right):quantity(other.right)?resolve(other.left):null;}
   if(other?.type==='FunctionCall'&&other.expression?.type==='Identifier')names.add(other.expression.name);else if(other?.type==='Identifier')names.add(other.name);});
 }return [...names];};
 const zeroOptions=f=>{
  if(f.inputs.length!==2||f.inputs[0].type!=='uint256'||f.inputs[1].type!=='bool')return false;
  let zeroBranch=false;for(const fn of functions.filter(n=>n.name===f.name&&n.parameters?.length===2))walk(fn.body,n=>{if(n.type==='IfStatement'&&n.condition?.type==='BinaryOperation'&&n.condition.operator==='=='&&n.condition.left?.name===f.inputs[0].name&&n.condition.right?.type==='NumberLiteral'&&n.condition.right.number==='0')zeroBranch=true;});return zeroBranch;
 };
 const revertQuote=f=>{
  const matches=[];const native=x=>x?.type==='MemberAccess'&&x.expression?.name==='msg'&&x.memberName==='value';
  const seen=new Set(),visit=fn=>{if(seen.has(fn)||seen.size>=12)return;seen.add(fn);walk(fn.body,n=>{
   // The current wallet's zero-value eth_call must actually reach this guard.
   // We never reuse the payment value from a historical transaction. Helpers
   // can hold a phase/tuple price without exposing a scalar price() getter.
   if(n.type==='FunctionCall'&&n.expression?.type==='Identifier'){
    const helpers=functions.filter(h=>h.name===n.expression.name&&h.parameters?.length===n.arguments.length&&['private','internal'].includes(h.visibility));
    if(helpers.length===1)visit(helpers[0]);
   }
   if(n.type!=='IfStatement'||n.falseBody||n.condition?.type!=='BinaryOperation'||!['<','!='].includes(n.condition.operator)||!native(n.condition.left))return;
   const r=n.trueBody?.type==='Block'&&n.trueBody.statements.length===1?n.trueBody.statements[0]:n.trueBody;
   if(r?.type!=='RevertStatement'||r.revertCall?.expression?.type!=='Identifier')return;
   const call=r.revertCall,index=call.arguments.findIndex(a=>JSON.stringify(a)===JSON.stringify(n.condition.right));
   const defs=(meta.abi||[]).filter(e=>e.type==='error'&&e.name===call.expression.name&&e.inputs.length===call.arguments.length&&e.inputs[index]?.type==='uint256');
   if(index>=0&&defs.length===1)matches.push({name:call.expression.name,index});
  });};for(const fn of functions.filter(n=>n.name===f.name&&n.parameters?.length===f.inputs.length))visit(fn);
  const unique=[...new Map(matches.map(m=>[m.name+':'+m.index,m])).values()];return unique.length===1?unique[0]:null;
 };
 return {usage,paid,nativeQuotes,zeroOptions,revertQuote};
}
export function recognizeMint(meta,{observedSelectors=[]}={}){
 const frontend=frontendCallsFor(meta),boundHints=frontend.length?frontend.flatMap(c=>c.abi||[]):meta.abiHints;
 const runtime=!meta.verified,shape=runtime?runtimeAbi(meta.runtimeCode,boundHints,frontend):null;
 if(meta.proxy||shape?.proxy)return {abi:meta.abi||shape?.abi||[],routes:[],reason:'代理或动态转发合约需核验当前实现，暂不自动构造 Mint'};
 const abi=runtime?shape.abi:meta.abi||[],iface=new Interface(abi),facts=runtime?null:sourceFacts(meta),has=s=>!!iface.getFunction(s),routes=[];
 for(const f of abi.filter(f=>f.type==='function'&&!['view','pure'].includes(f.stateMutability)&&(MINT_NAMES.includes(f.name)||sourceMintName(f.name)&&frontend.some(c=>c.method===FunctionFragment.from(f).format('sighash'))||!runtime&&observedSelectors.length&&observedSelectors.includes(FunctionFragment.from(f).selector)))){
  const used=facts?.usage(f),roles=[],programs=runtime?{}:walletParameterPrograms(meta,f);let qty=false,invalid=false;
  for(let i=0;i<f.inputs.length;i++){const p=f.inputs[i];if(programs[i])roles.push('computed:'+i);
   else if(/^uint\d*$/.test(p.type)&&i===0&&quantityName.test(p.name)&&(!used||used.has(p.name))){roles.push('quantity');qty=true;}
   else if(/^uint\d*$/.test(p.type)&&costName.test(p.name)&&(!used||used.has(p.name)))roles.push('cost');
   else if(p.type==='address'&&referralParameter(p.name)&&(!used||used.has(p.name)))roles.push('zero');
   else if(!runtime&&p.type==='address'&&/^_?(to|recipient|receiver|beneficiary)$/i.test(p.name))roles.push('wallet');
   else {invalid=true;break;}}
  if(invalid&&!runtime&&facts.zeroOptions(f)&&has('ownerOf(uint256)')&&has('supportsInterface(bytes4)')&&!facts.paid(f)){
   // A verified zero/default selection branch, with optional add-on disabled.
   // This is one NFT, not zero quantity. Only zero payment is attempted, and
   // actual ERC721 credit to this wallet is mandatory in the official preview.
   routes.push({id:'auto:'+f.name+'(uint256,bool)',method:f.name+'(uint256,bool)',payment:NATIVE,pricing:'adaptive',quantity:false,roles:['default-zero','default-false'],quotes:[],units:[],runtime:false,lane:'free',freeEntry:true,zeroOnly:true,defaultOptions:true});continue;
  }
  if(invalid||(!runtime&&facts.paid(f)))continue; // ERC20 payment needs its own bounded payment adapter.
  const boundCalls=frontend.filter(c=>c.selector===FunctionFragment.from(f).selector),boundCall=boundCalls[0],sitePrices=[...new Set(boundCalls.map(c=>c.price?.method).filter(Boolean))],sitePrice=sitePrices.length===1&&!boundCalls.some(c=>c.priceAmbiguous)?sitePrices[0]:null,quotes=[];
  if(f.stateMutability==='payable')for(const qname of new Set([...(sitePrice?[sitePrice.split('(')[0]]:[]),...(facts?.nativeQuotes(f)||[]),...QUOTES]))for(const g of abi.filter(g=>g.type==='function'&&g.name===qname&&['view','pure'].includes(g.stateMutability))){
   const types=g.inputs.map(p=>p.type).join(','),args=types==='address,uint256'?['wallet','quantity']:types==='uint256'?['quantity']:types==='address'&&!qty?['wallet']:null;if(!args)continue;
   const outputs=g.outputs||[];let index=-1;
   if(outputs.length===1&&outputs[0].type===UINT)index=0;
   else {index=outputs.findIndex(p=>p.type===UINT&&/^(costWei|costBNB|costBnb|bnbWei|bnbDue|bnbCost|bnbAmount|nativeCost|totalWei)$/i.test(p.name));if(index<0&&!outputs.some(p=>/usdt|usd|tokenCost|tokenPrice|erc20/i.test(p.name)))index=outputs.findIndex(p=>p.type===UINT&&/^(cost|totalCost|totalPrice)$/i.test(p.name));}
   if(index<0)continue;quotes.push({method:g.name+'('+types+')',args,index,paid:!runtime?outputs.findIndex(p=>p.type===UINT&&/^(paid|paidShares|paidCount|paidUnits|paidMints)$/i.test(p.name)):-1,free:!runtime?outputs.findIndex(p=>p.type===UINT&&/^(free|freeShares|freeCount|freeUnits|freeMints)$/i.test(p.name)):-1});
  }
  // Explicit native quote names take precedence over generic/token-denominated quotes.
  // Wallet-specific quotes include first-share discounts; prefer them over a
  // generic quote at the same denomination. Runtime tuple prices remain only
  // candidates until exact-value + one-wei-underpayment simulation succeeds.
  quotes.sort((a,b)=>Number(b.method===sitePrice)-Number(a.method===sitePrice)||Number(/bnb/i.test(b.method))-Number(/bnb/i.test(a.method))||Number(b.args.includes('wallet'))-Number(a.args.includes('wallet')));
  if(sitePrice&&quotes.some(q=>q.method===sitePrice))quotes.splice(0,quotes.length,...quotes.filter(q=>q.method===sitePrice));
  const separateFree=abi.some(g=>g.type==='function'&&/^(mintFree|freeMint|claimFree)$/.test(g.name));
  const explicitPaidPrice=PAID_PRICE.some(n=>has(n+'()'))||!!facts?.nativeQuotes(f).length||!!boundCall&&f.stateMutability==='payable'&&quotes.length>0;
  const lane=/^(mintFree|freeMint|claimFree)$/.test(f.name)?'free':/^(paidMint|mintPaid)$/.test(f.name)||separateFree&&explicitPaidPrice&&/^(mint|publicMint|mintWithBnb|mintWithBNB)$/.test(f.name)?'paid':null;
  const units=f.stateMutability==='payable'?[...new Set([...(facts?.nativeQuotes(f)||[]),...(lane==='paid'?[...PAID_PRICE,...UNIT_PRICE]:UNIT_PRICE),...abi.filter(g=>g.type==='function'&&nativeUnitName(g.name)).map(g=>g.name)])].filter(n=>{const g=iface.getFunction(n+'()');return g&&['view','pure'].includes(g.stateMutability)&&g.outputs.length===1&&g.outputs[0].type===UINT;}).map(n=>n+'()'):[];
  const method=f.name+'('+f.inputs.map(p=>p.type).join(',')+')';
  const revertQuote=f.stateMutability==='payable'?facts?.revertQuote(f):null;
  const sourcePrice=f.stateMutability==='payable'&&!runtime?nativePriceProgram(meta,f):null;
  const nftZeroProbe=runtime&&f.inputs.length===1&&roles[0]==='quantity'&&has('ownerOf(uint256)')&&has('balanceOf(address)')&&has('supportsInterface(bytes4)');
  if(f.inputs.length&&f.stateMutability==='payable'&&quotes.length===0&&units.length===0&&lane!=='free'&&!revertQuote&&!sourcePrice&&!nftZeroProbe)continue;
  const sourceLimits=runtime?[]:sourceLimitPrograms(meta,f,roles);
  routes.push({id:'auto:'+method,method,payment:NATIVE,pricing:'adaptive',quantity:qty,roles,programs,quotes,units,revertQuote,sourcePrice,sourceLimits,runtime,lane,freeEntry:lane==='free',zeroOnly:f.stateMutability!=='payable'||quotes.length===0&&units.length===0&&!revertQuote&&!sourcePrice,...(boundCall?{frontend:{source:boundCall.source,method:boundCall.method,price:sitePrice},closedOnOpened:!!recognizeFairMint(meta)}:{})});
 }
 // Prefer the site's actual entry within each lane, without hiding a missing
 // free/paid lane. Missing evidence never causes us to invent a write method.
 const used=routes.filter(r=>r.frontend||!routes.some(x=>x.frontend&&(x.lane===r.lane||x.lane==='paid'&&r.lane===null)));
 return {abi,routes:used,reason:used.length?null:abi.some(f=>f.type==='function'&&/mint/i.test(f.name)&&f.inputs?.some(p=>/bytes|tuple/.test(p.type)))?'项目包含签名、白名单证明或组合参数，需要进一步适配':'当前通用识别器未找到可安全构造的铸造方法，需要适配该项目的参数和报价'};
}

export async function adaptiveQuote(meta,route,wallet,quantity,block,rpc,referrer=ZeroAddress){
 return measure('mintQuoteAndSimulation',()=>quoteImpl(meta,route,wallet,quantity,block,rpc,referrer));
}
async function quoteImpl(meta,route,wallet,quantity,block,rpc,referrer){
 const iface=new Interface(meta.abi),wa=wallet.address,c=meta.address,q=BigInt(quantity),cache=new Map(),evidence=[];let reads=0;
 const has=s=>!!iface.getFunction(s);
 const read=async(method,args=[])=>{const key=method+args.map(String).join(',');if(!cache.has(key))cache.set(key,(async()=>{if(++reads>70)throw Error('识别调用达到上限，请稍后重试');const raw=await rpc('eth_call',[{from:wa,to:c,data:iface.encodeFunctionData(method,args)},block.tag]);const f=iface.getFunction(method);if(!/^0x[0-9a-f]*$/i.test(raw)||raw.length>65538)throw Error('报价返回字段格式异常：'+method);const values=iface.decodeFunctionResult(method,raw);if(iface.encodeFunctionResult(method,values).toLowerCase()!==raw.toLowerCase())throw Error('报价返回字段数量不匹配：'+method);return values;})());return cache.get(key);};
 const first=async(list,args=[])=>{for(const s of list){if(!has(s))continue;try{const v=(await read(s,args))[0];evidence.push(s);return {value:v,method:s};}catch(e){if(!route.runtime)throw e;}}return null;};
 const getters=(names,signature='()')=>[...new Set(names.flatMap(n=>[n+signature,...(quotaNames.has(normalizedName(n))?iface.fragments.filter(f=>f.type==='function'&&normalizedName(f.name)===normalizedName(n)&&'('+f.inputs.map(p=>p.type).join(',')+')'===signature).map(f=>f.format('sighash')):[])]))];
 const typed=(list,type)=>list.filter(s=>{const f=iface.getFunction(s);return f&&['view','pure'].includes(f.stateMutability)&&f.outputs.length===1&&type.test(f.outputs[0].type);});
 const uint=async(names,args=[],sig='()')=>{const r=await first(typed(getters(names,sig),/^uint\d*$/),args);return r?BigInt(r.value):null;};
 const bool=(names,args=[],sig='()')=>first(typed(getters(names,sig),/^bool$/),args);
 // Independent state reads share one fixed block, and Rpc coalesces identical
 // requests across wallets. Only dependent quota fallbacks wait for round two.
 const [open,paused,agent,eligible,initialTx,initialWallet,initialPublic,callable,perUnit,token,end,start,opened,sourceLimits]=await Promise.all([
  bool(route.lane?[route.lane+'Open',...OPEN]:OPEN),bool(PAUSED),bool(['hasAgentId'],[wa],'(address)'),bool(['canMint'],[wa],'(address)'),
  route.quantity?uint(TX):1n,uint(route.lane?[route.lane+'Remaining',...(route.lane==='free'?['freeMintsLeft','freeMintsRemaining']:[]),...REMAIN]:REMAIN,[wa],'(address)'),uint(route.lane?[route.lane+'Remaining',...STOCK]:STOCK),uint(['maxMintable'],[wa],'(address)'),uint(UNITS),first(typed(getters(TOKEN),/^address$/)),uint(MINT_END),uint(MINT_START),route.closedOnOpened?bool(['opened']):null,
  evaluateSourceLimits(route.sourceLimits||[],{wallet:wa,read})
 ]);
 if(opened?.value===true)throw Object.assign(Error('项目已开盘，Mint 阶段已结束'),{code:'MINT_ENDED'});
 if(end!==null&&end>0n&&BigInt(block.timestamp)>=end)throw Object.assign(Error('链上铸造截止时间已到，铸造阶段已结束'),{code:'MINT_ENDED',details:{endTime:String(end),chainTimestamp:block.timestamp}});
 if(start!==null&&start>BigInt(block.timestamp))throw Object.assign(Error('链上铸造开始时间尚未到达'),{code:'MINT_NOT_OPEN',details:{startTime:String(start),chainTimestamp:block.timestamp}});
 let available=(!open||open.value===true)&&paused?.value!==true,reason=available?null:paused?.value===true?'铸造已暂停':'铸造未开放';
 if(agent&&agent.value!==true){available=false;reason='此钱包没有该项目要求的 Agent ID';}
 if(eligible&&eligible.value!==true){available=false;reason='当前钱包未通过 canMint 资格检查';}
 const txLimit=initialTx;let walletRemaining=initialWallet,publicRemaining=initialPublic,publicQuotaScope=route.lane==='paid'&&initialPublic!==null&&has('paidRemaining()')?'paid':'project';
 for(const scope of ['wallet','public']){const values=sourceLimits.filter(p=>p.scope===scope);if(!values.length)continue;const value=smallest(values.map(p=>p.remaining));evidence.push('已核验源码 '+route.method+' · '+scope+' 剩余额度');if(scope==='wallet')walletRemaining=value;else {publicRemaining=value;publicQuotaScope=route.lane||'project';}}
 if(walletRemaining===null&&route.lane){const [cap,used]=await Promise.all([uint([route.lane==='free'?'FREE_PER_WALLET':'PAID_PER_WALLET']),uint([route.lane==='free'?'freeClaimedCount':'paidMintedCount'],[wa],'(address)')]);if(cap!==null&&used!==null)walletRemaining=remaining(cap,used);}
 if(walletRemaining===null){const [globalCap,addressCap,used]=await Promise.all([uint(WALLET_CAP),uint(['maxQuotaOf','maxMintPerWallet','quotaOf'],[wa],'(address)'),uint(WALLET_USED,[wa],'(address)')]);const cap=smallest([globalCap,addressCap]);if(cap!==null&&used!==null)walletRemaining=remaining(cap,used);}
 if(walletRemaining===null){const once=await bool(route.lane==='free'?['freeClaimed',...ONCE]:ONCE,[wa],'(address)');if(once)walletRemaining=once.value?0n:1n;}
 const counters=route.lane?[...(route.lane==='free'?[['FREE_SUPPLY','freeMinted'],['FREE_SHARES','freeMinted']]:[['PAID_SUPPLY','paidMinted']]),...COUNTERS]:COUNTERS;
 if(publicRemaining===null)for(const [cap,count]of counters){if(!getters([cap]).some(has)||!getters([count]).some(has))continue;const [a,b]=await Promise.all([uint([cap]),uint([count])]);if(a!==null&&b!==null){publicRemaining=remaining(a,b);publicQuotaScope=['FREE_SUPPLY','FREE_SHARES'].includes(cap)?'free':cap==='PAID_SUPPLY'?'paid':'project';break;}}
 // Verified contracts often expose issuance counters as fields of stats(),
 // not separate getters. Match one unambiguous used/cap pair in the same tuple;
 // unknown frontend ABI names alone cannot add an availability assertion.
 if(publicRemaining===null&&meta.verified){
  const pairs=[];for(const f of iface.fragments.filter(f=>f.type==='function'&&['view','pure'].includes(f.stateMutability)&&f.inputs.length===0&&f.outputs.length<=16))for(let used=0;used<f.outputs.length;used++){
   const field=f.outputs[used],match=/^(genesis|public|mint|total)(?:Minted|Sold)$/i.exec(field.name);if(!match||!/^uint\d*$/.test(field.type))continue;
   const cap=f.outputs.findIndex(o=>o.name.toLowerCase()===(match[1]+'Cap').toLowerCase()&&/^uint\d*$/.test(o.type));if(cap>=0)pairs.push({method:f.format('sighash'),used,cap});
  }
  if(pairs.length===1){const p=pairs[0],values=await read(p.method);publicRemaining=remaining(BigInt(values[p.cap]),BigInt(values[p.used]));evidence.push(p.method+' · '+iface.getFunction(p.method).outputs[p.used].name+'/'+iface.getFunction(p.method).outputs[p.cap].name);}
 }
 let asset=null;
 if(perUnit!==null&&perUnit>0n){const target=token?.value||((has('decimals()')&&has('balanceOf(address)'))?c:null);if(/^0x[0-9a-f]{40}$/i.test(target||'')&&target!==ZeroAddress)asset={token:target.toLowerCase(),amount:String(perUnit*q),kind:'Erc20'};}
 if(!asset&&has('supportsInterface(bytes4)')){try{if((await read('supportsInterface(bytes4)',['0x80ac58cd']))[0]===true)asset={token:c,amount:String(q),kind:'Erc721'};}catch{}}
 if(!asset&&has('supportsInterface(bytes4)')){try{if((await read('supportsInterface(bytes4)',['0xd9b67a26']))[0]===true)asset={token:c,amount:String(q),kind:'Erc1155'};}catch{}}
 if(!asset&&!route.runtime&&has('ownerOf(uint256)'))asset={token:c,amount:String(q),kind:'Erc721'};
 // Some legacy ERC721 collections omit ERC165. Interface evidence is tentative;
 // the plan still requires exact, typed NFT credits from the official preview.
 if(!asset&&route.runtime&&['ownerOf(uint256)','balanceOf(address)','getApproved(uint256)','isApprovedForAll(address,address)','safeTransferFrom(address,address,uint256)'].every(has))asset={token:c,amount:String(q),kind:'Erc721'};
 if(route.observedAsset){
  const observed=route.observedAsset;
  if(asset&&(asset.token.toLowerCase()!==observed.token.toLowerCase()||asset.kind!==observed.kind))throw Error('当前到账资产与链上成功样本不一致，需要重新识别');
  if(!asset||observed.kind==='Erc721')asset={token:observed.token,kind:observed.kind,amount:String(BigInt(observed.minPerUnit)*q)};
 }
 if(route.runtime&&!asset)throw Object.assign(Error('已找到候选 Mint，但无法核实到账资产及每份数量，暂不提供下单'),{code:'MINT_ASSET_UNKNOWN'});
 const knownMax=smallest([txLimit,walletRemaining,publicRemaining,callable,route.maxQuantity?BigInt(route.maxQuantity):null]);
 // Unknown wallet/transaction limits are not an invitation to probe 500 paid mints.
 const cap=smallest([knownMax,MAX,route.freeProbe?10n:route.runtime&&txLimit===null&&walletRemaining===null&&callable===null?1n:null]);
 const stockReason=publicQuotaScope==='free'?'全局免费名额已用完；付费入口需按预算单独检查':publicQuotaScope==='paid'?'付费库存已售罄':'项目总库存已售罄';
 if(cap<q){available=false;reason=walletRemaining===0n?(route.lane==='free'?'本钱包免费额度已用完':'本钱包额度已用完'):publicRemaining===0n?stockReason:'数量超过当前剩余额度或单笔上限';}
 if(walletRemaining===0n||publicRemaining===0n)throw Object.assign(Error(reason||'当前可核验铸造额度为 0'),{code:'NO_QUOTA',details:{quotaScope:walletRemaining===0n?'wallet':publicQuotaScope,lane:route.lane||null,walletRemaining:number(walletRemaining),publicRemaining:number(publicRemaining)}});
 if(!available&&paused?.value===true)throw Object.assign(Error('链上暂停标志已开启，当前不能铸造'),{code:'MINT_PAUSED'});
 if(!available&&open?.value===false)throw Object.assign(Error('链上铸造开放标志为 false，当前未开放或已关闭'),{code:'MINT_NOT_OPEN'});
 if(!available&&(agent?.value===false||eligible?.value===false))throw Object.assign(Error(reason),{code:'MINT_INELIGIBLE'});
 const computed=new Map(await Promise.all(Object.entries(route.programs||{}).map(async([index,program])=>['computed:'+index,await evaluateWalletProgram(program,iface,wa,read)])));
 const args=(n,cost)=>route.roles.map(role=>computed.has(role)?computed.get(role):role==='quantity'?n:role==='cost'?cost:role==='wallet'?wa:role==='default-zero'?0n:role==='default-false'?false:referrer);
 const call=(n,cost,value=cost)=>({from:wa,to:c,data:route.rawSelector||iface.encodeFunctionData(route.method,args(n,cost)),value:'0x'+value.toString(16)});
 const simulate=async(n,cost,value=cost)=>rpc('eth_call',[call(n,cost,value),block.tag]);
 const zeroCache=new Map();const isZero=async n=>{const k=String(n);if(!zeroCache.has(k))zeroCache.set(k,simulate(n,0n).then(()=>true,e=>{if(e.executionError||/revert|insufficient payment|priceabove|payment/i.test(e.message))return false;throw e;}));return zeroCache.get(k);};
 const price=async n=>{
  // A separate free entry must never inherit another method's PRICE/quote
  // after an eligibility or stock failure. Fee-bearing "free" entries require
  // their own bounded adapter; a name alone cannot authorize payment.
  if(route.freeEntry){try{await simulate(n,0n);}catch(e){const cause=mintError(e,meta.verified?meta.abi:null);throw Object.assign(Error(cause.message+'；免费入口零付款模拟未通过，未套用付费价格'),{code:cause.code,data:cause.data});}return {cost:0n,free:n,method:'独立免费入口零付款模拟'};}
  if(route.zeroOnly)return {cost:0n,free:n,method:'零付款调用'};
  if(route.revertQuote){try{await simulate(n,0n);return {cost:0n,free:n,method:'本钱包零付款模拟'};}catch(e){
   const data=typeof e.data==='string'?e.data:e.message?.match(/execution reverted:\s*(0x[0-9a-f]+)/i)?.[1];let parsed;try{parsed=iface.parseError(data);}catch{}
   if(parsed?.name!==route.revertQuote.name)throw mintError(e,meta.abi);
   const cost=BigInt(parsed.args[route.revertQuote.index]);if(cost<=0n)throw Error('合约返回的必要付款金额无效');return {cost,free:null,method:'本钱包当前模拟的必要付款金额（源码与错误参数交叉核验）'};
  }}
  if(route.sourcePrice){const cost=await evaluateNativePrice(route.sourcePrice,{wallet:wa,quantity:n,read});return {cost,free:cost===0n?n:null,method:'已核验源码的原生币付款表达式（当前钱包 / 当前区块）'};}
  for(const desc of route.quotes){try{const v=await read(desc.method,desc.args.map(a=>a==='wallet'?wa:n)),cost=BigInt(v[desc.index]);let free=null;if(desc.paid>=0){const paid=BigInt(v[desc.paid]);if(paid>n)throw Error('报价中的付费数量异常');free=n-paid;}if(desc.free>=0){const f=BigInt(v[desc.free]);if(f>n||free!==null&&free!==f)throw Error('报价中的免费数量异常');free=f;}return {cost,free,method:desc.method};}catch(e){if(!route.runtime||desc.method===route.frontend?.price)throw e;}}
  const unit=await first(route.units);if(!unit)throw Object.assign(Error('未读取到与付款币一致的有效报价，需要适配该报价方式'),{code:'MINT_ADAPTER_INCOMPLETE'});
  // Zero-payment simulation detects free entitlements. Binary search is bounded by
  // the user's requested quantity, not a guessed global cap. Nonlinear paid tiers
  // must still pass exact-value simulation and the underpayment check. This
  // checks the advertised quote, not a mathematical global minimum price.
  if(await isZero(n))return {cost:0n,free:n,method:unit.method+' + 零付款模拟'};
  let free=0n;if(n>1n&&await isZero(1n)){let low=1n,high=n-1n;while(low<high){const mid=(low+high+1n)/2n;if(await isZero(mid))low=mid;else high=mid-1n;}free=low;}
  return {cost:BigInt(unit.value)*(n-free),free,method:unit.method+' + 免费额度模拟'};
 };
 let total,unit;try{[total,unit]=await Promise.all([price(q),price(1n)]);}catch(e){throw Object.assign(Error(e.code==='NO_QUOTA'?e.message:'价格识别未完成：'+e.message),{code:e.code,data:e.data});}
 if(route.freeProbe&&total.cost!==0n)throw Object.assign(Error('此数量需要付款，继续检查更少的免费份数'),{code:'FREE_PROBE_REJECTED'});
 let simulated=false,gas=null;
 if(available){try{await simulate(q,total.cost);simulated=true;
  if(total.cost>0n){let rejected=false;try{await simulate(q,total.cost,total.cost-1n);}catch(e){if(e.executionError||/revert/i.test(e.message))rejected=true;else throw e;}if(!rejected)throw Error('少付 1 wei 仍可执行，报价与付款需求尚未一致，暂不提供该金额下单');}
  gas=String(BigInt(await rpc('eth_estimateGas',[call(q,total.cost)])));
 }catch(e){if(route.freeProbe&&!e.executionError&&!/revert/i.test(e.message||''))throw e;const cause=mintError(e,meta.verified?meta.abi:null);if(['NO_QUOTA','MINT_ENDED','MINT_INELIGIBLE','MINT_NOT_OPEN','MINT_PAUSED'].includes(cause.code))throw cause;available=false;reason='当前调用不可执行：'+cause.message;
  if(route.runtime&&/insufficient funds/i.test(cause.message))throw Object.assign(Error('候选 BNB 报价未通过模拟，付款币或报价参数仍待核验；不能据此判断项目需要这笔 BNB：'+cause.message),{code:'MINT_ADAPTER_INCOMPLETE'});
  if(route.runtime&&(!simulated||/少付 1 wei/.test(e.message)))throw Object.assign(Error(reason),{code:/少付 1 wei/.test(e.message)?'MINT_ADAPTER_INCOMPLETE':cause.code});}}
 let free=total.free??(total.cost===0n?q:null);
 if(free===null&&unit.cost===0n&&q>1n){let low=1n,high=q-1n;while(low<high){const mid=(low+high+1n)/2n;if((await price(mid)).cost===0n)low=mid;else high=mid-1n;}free=low;}
 if(free===null&&unit.cost>0n&&total.cost===unit.cost*q)free=0n;
 const transaction=call(q,total.cost);
 let paidUnit=unit.cost>0n?money(unit.cost):null;if(free!==null&&free>0n&&free<q){const [a,b]=await Promise.all([price(free),price(free+1n)]);paidUnit=money(b.cost-a.cost);}
 return {account:wallet.account,address:wa,name:wallet.name,quantity,unit:money(unit.cost),paidUnit,total:money(total.cost),paymentToken:NATIVE,freeUnits:free===null?null:Number(free),paidUnits:free===null?null:Number(q-free),available,reason,simulated,approval:null,balance:null,gas,limits:{max:Number(cap),known:knownMax!==null,txLimit:number(txLimit),walletRemaining:number(walletRemaining),publicRemaining:number(publicRemaining),callRemaining:number(callable),localLimit:route.runtime&&knownMax===null?1:500},call:{to:c,data:transaction.data,value:String(total.cost)},runtimeHash:meta.hash,block:block.number,chainTimestamp:block.timestamp,deadline:null,quoteAt:Date.now(),routeId:route.id,routeMethod:route.method,quantityUnit:'份',expectedNftQuantity:asset?.kind==='Erc721'&&asset.token.toLowerCase()===c.toLowerCase()?quantity:null,expectedAsset:asset,recognition:{level:route.runtime?'runtime':'source',manualOnly:route.runtime,method:route.method,price:total.method,limits:[...new Set(evidence)],assetValidated:!!asset}};
}
