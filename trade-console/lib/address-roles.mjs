import {recognizeVerifiedSale} from './verified-sale.mjs';
import {recognizeSpecialMint} from './special-mint.mjs';
import {Interface,ZeroAddress} from 'ethers';
import {address,read,same,USDT,WBNB} from './common.mjs';
import {runtimeShape} from './adaptive-mint.mjs';
import parser from '@solidity-parser/parser';
import {recognizeHandleMint} from './handle-mint.mjs';
import {recognizePrimaryHandleMint} from './primary-handle-mint.mjs';
import {recognizeSourceSale} from './source-sale.mjs';

export const ROLE_LABELS={mint:'Mint / 项目入口',token:'代币 CA',nft:'NFT / 领取凭证',registry:'Agent ID / 身份注册',treasury:'项目收款 / 金库',oracle:'价格预言机',art:'NFT 图像 / 元数据',multicall:'批量只读查询',router:'交易路由',factory:'交易池工厂',pool:'交易池 / LP',market:'NFT / 二级交易市场',payment:'付款 / 计价币',implementation:'代理实现',unknown:'用途待核验'};
const SUPPORT=new Set(['registry','treasury','oracle','art','multicall','router','factory','pool','market','payment','implementation']);
const KNOWN=new Map([
 ['0x60b9262456de011f7d15a54cdd8c48baaa8b022f','registry'],
 ['0xca11bde05977b3631167028862be2a173976ca11','multicall'],
 ['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','payment'],
 [USDT.toLowerCase(),'payment'],[WBNB.toLowerCase(),'payment']
]);
// Normalize aliases, but never treat a label as proof of its on-chain role.
export function labelRoles(label){
 const key=label.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g,'').toLowerCase().replace(/^get/,'');
 const aliases={
  mint:['mint','minter','mintcontract','mintaddress','mintcontractaddress','mintingcontract','sale','salecontract','saleaddress','presale','presalecontract','launch','launchpad','launchpadaddress','arena','city','铸造合约','铸币合约','发售合约','项目入口'],
  token:['coin','token','erc20','tokenaddress','tokencontract','tokencontractaddress','projecttoken','minttoken','rewardtoken','asset','币地址','代币','代币ca','代币地址','代币合约'],
  nft:['nft','nftaddress','nftcontract','nftcollection','collection','pass','passnft','passaddress','passcontract','ticket','receipt','凭证','凭证合约'],
  registry:['registry','agentid','agentidregistry','idcollection','identityregistry','注册合约','身份合约'],
  treasury:['treasury','treasurywallet','treasuryaddress','vault','vaultaddress','deployer','feeaddress','feerecipient','projectwallet','金库','金库地址','项目方','收款地址'],
  oracle:['oracle','oracleaddress','feed','pricefeed','priceoracle','bnbusdfeed','chainlink','预言机'],
  art:['art','renderer','render','artcontract','descriptor','metadata','metadatacontract','图像合约'],
  multicall:['multicall','multicall3','multicalladdress'],router:['router','routeraddress','swaprouter','pancakerouter','dexrouter','positionmanager','nonfungiblepositionmanager'],
  factory:['factory','factoryaddress','pairfactory'],pool:['pool','pair','lp','pairaddress','pooladdress','liquiditypool'],market:['market','marketplace','nftmarket','marketcontract','marketaddress'],payment:['wbnb','weth','usdt','usdc','quotetoken','quoteasset','paymenttoken','paytoken','basecurrency'],implementation:['implementation','implementationaddress','impl']
 };
 const direct=Object.entries(aliases).filter(([,names])=>names.includes(key)).map(([role])=>role);if(direct.length)return direct;
 // Project brands often prefix roles: goldMint, rodMarket, fishRenderer, etc.
 // These remain website hints; classifyAddresses still requires chain evidence.
 const words=label.replace(/([a-z0-9])([A-Z])/g,'$1 $2').split(/[^a-zA-Z0-9\u4e00-\u9fff]+/).filter(Boolean).map(s=>s.toLowerCase());
 const tail=words.at(-1);return Object.entries(aliases).filter(([,names])=>names.includes(tail)).map(([role])=>role);
}
export function descriptionRoles(label){
 const roles=new Set(labelRoles(label));
 const rules={mint:/\bmint(?:ing)?(?:\s|\b)|\bminter\b|铸造|铸币|发售合约/i,token:/erc[ -]?20|代币|\btoken\s*(?:address|contract|ca)\b/i,nft:/\bnft\b|\bpass\b|凭证/i,registry:/registry|注册|身份/i,treasury:/treasury|deployer|金库|收款|项目方/i,oracle:/chainlink|oracle|price\s*feed|预言机/i,art:/renderer|metadata|图像/i,multicall:/multicall/i,router:/router|路由/i,factory:/factory|工厂/i,pool:/liquidity\s*pool|\bpair\b|交易池/i};
 for(const [role,re]of Object.entries(rules))if(re.test(label))roles.add(role);
 if(/\bmarket(?:place)?\s*(?:contract|address)?\b|二级市场/i.test(label))roles.add('market');
 return [...roles];
}
export function mergeCandidates(rows){
 const merged=new Map();for(const r of rows){const a=address(r.address);if(same(a,ZeroAddress))continue;
  let item=merged.get(a);if(!item){item={address:a,priority:0,field:r.field,source:r.source,hints:[],roles:[],verifiedRoles:[],evidence:[]};merged.set(a,item);}
  if(r.priority>item.priority||r.priority===item.priority&&r.roles?.length&&!item.roles.length){item.priority=r.priority;item.field=r.field;item.source=r.source;}
  const roles=r.roles||[];if(!item.hints.some(h=>h.field===r.field&&h.source===r.source&&h.method===r.method))item.hints.push({field:r.field,source:r.source,roles,priority:r.priority||0,...(r.method?{method:r.method}:{})});
  for(const role of roles)if(!item.roles.includes(role))item.roles.push(role);
 }
 return [...merged.values()];
}
const MINT=/^(?:mint\w*|publicMint|freeMint|paidMint|agentMint|claimFree|takeGift|buy)$/;
function restrictedMethods(meta){
 const functions=[],modifiers=[],addressFields=new Set();const walk=n=>{if(!n||typeof n!=='object')return;if(n.type==='FunctionDefinition'&&n.body)functions.push(n);if(n.type==='ModifierDefinition'&&n.body)modifiers.push(n);if(n.type==='StateVariableDeclaration')for(const v of n.variables||[])if(v.typeName?.type==='ElementaryTypeName'&&v.typeName.name==='address')addressFields.add(v.name);for(const v of Object.values(n)){if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v);}};
 for(const s of Object.values(meta.sources||{}))try{walk(parser.parse(s.content));}catch{}
 const sender=n=>n?.type==='MemberAccess'&&n.expression?.name==='msg'&&n.memberName==='sender'||n?.type==='FunctionCall'&&n.expression?.name==='_msgSender';
 const authority=n=>n?.type==='Identifier'&&(addressFields.has(n.name)||/^_?(?:MINTER|MINER|MINING_POOL|OWNER|CONTROLLER|OPERATOR|ADMIN|ENGINE|GAME|CORE|FORGECORE|ISSUER)$/i.test(n.name))||n?.type==='FunctionCall'&&/^_?(?:owner|controller|admin)$/.test(n.expression?.name||'');
 const guard=(n,op)=>n?.type==='BinaryOperation'&&n.operator===op&&(sender(n.left)&&authority(n.right)||sender(n.right)&&authority(n.left));
 const guardedBody=n=>{
  for(const s of n.body?.statements||[]){
   const body=s.trueBody?.type==='Block'?s.trueBody.statements:s.trueBody?[s.trueBody]:[];
   if(s.type==='IfStatement'&&guard(s.condition,'!=')&&body.length===1&&body[0].type==='RevertStatement')return true;
   const e=s.expression;if(s.type==='ExpressionStatement'&&e?.type==='FunctionCall'&&e.expression?.name==='require'&&guard(e.arguments?.[0],'=='))return true;
  }return false;
 };
 const guarded=n=>{
  if(n.modifiers?.some(m=>/only(?:Owner|Admin|Minter|Controller|Operator|Role|Game|Core|Forge|Issuer)|requiresAuth/i.test(m.name)))return true;
  // Custom names such as onlySale/viaHatchery are not a public mint interface.
  // Prove the sender restriction inside the matching verified modifier body;
  // never infer permission from a website label or from its name alone.
  if(n.modifiers?.some(m=>{const definitions=modifiers.filter(d=>d.name===m.name&&d.parameters?.length===(m.arguments?.length||0));return definitions.length&&definitions.every(guardedBody);}))return true;
  return guardedBody(n);
 };
 return f=>{const matches=functions.filter(n=>n.name===f.name&&n.parameters?.length===f.inputs.length&&n.parameters.every((p,i)=>p.name===f.inputs[i].name));return matches.length&&matches.every(guarded);};
}
function abiRoles(abi,meta){
 const functions=abi.fragments.filter(f=>f.type==='function'),has=s=>{try{return !!abi.getFunction(s);}catch{return false;}},roles=[];
 if(['balanceOf(address)','transfer(address,uint256)','allowance(address,address)','decimals()','totalSupply()'].every(has))roles.push('token');
 if(has('ownerOf(uint256)')&&has('balanceOf(address)'))roles.push('nft');
 if(!roles.includes('nft')&&functions.some(f=>['svg','imageDataURI'].includes(f.name)&&['view','pure'].includes(f.stateMutability))&&functions.some(f=>f.name==='tokenURI'&&['view','pure'].includes(f.stateMutability)))roles.push('art');
 if(has('getReserves()')&&has('token0()')&&has('token1()'))roles.push('pool');
 if(has('latestRoundData()')&&has('decimals()'))roles.push('oracle');
 if(functions.some(f=>/^aggregate3?$|^tryAggregate$/.test(f.name)))roles.push('multicall');
 // NFT secondary-market buys transfer an existing ID. They are not issuance.
 const market=(has('buy(uint256)')&&['listingOf(uint256)','getListing(uint256)','listings(uint256)'].some(has)||has('buy(uint256,uint256)')&&has('orders(uint256)')&&has('orderCount()'))&&has('list(uint256,uint256)')||secondaryNftBuy(meta,abi);
 if(has('positions(uint256)')&&has('increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))'))roles.push('router');
 const restricted=restrictedMethods(meta);
 const methods=functions.filter(f=>!['view','pure'].includes(f.stateMutability)&&MINT.test(f.name)&&!restricted(f)&&!(market&&f.name==='buy')&&!roles.includes('router')).map(f=>f.format('sighash'));
 if(market&&!methods.length)roles.push('market');
 if(recognizeVerifiedSale(meta)?.kind==='native-receive-sale')methods.push('receive()');
 if(['priced-token-claim','random-token-claim','agent-random-token-claim'].includes(recognizeSpecialMint(meta)?.kind))methods.push('claim()');
 const sourceSale=recognizeSourceSale(meta);if(sourceSale&&!methods.includes(sourceSale.method))methods.push(sourceSale.method);
 if(methods.length)roles.push('mint');return {roles,methods};
}
// A marketplace may call its listing field anything. Verified ownerOf(id) +
// transferFrom(seller, caller, the same id) proves an existing NFT purchase;
// the existence of buy(uint256) alone is not evidence of an issuance entry.
function secondaryNftBuy(meta,abi){
 const buy=abi.getFunction('buy(uint256)');if(!buy)return false;let proven=false;
 const walk=(n,fn)=>{if(!n||typeof n!=='object')return;fn(n);for(const [k,v]of Object.entries(n))if(!['loc','range'].includes(k)){if(Array.isArray(v))v.forEach(x=>walk(x,fn));else if(v&&typeof v==='object')walk(v,fn);}};
 for(const s of Object.values(meta.sources||{}))try{walk(parser.parse(s.content),f=>{
  if(f.type!=='FunctionDefinition'||f.name!=='buy'||f.parameters?.length!==1||!f.body||f.parameters[0].name!==buy.inputs[0].name)return;
  const name=f.parameters[0].name,owners=new Set(),transfers=[];walk(f.body,n=>{
   if(n.type!=='FunctionCall'||n.expression?.type!=='MemberAccess')return;const e=n.expression,asset=JSON.stringify(e.expression),args=n.arguments||[];
   if(e.memberName==='ownerOf'&&args.length===1&&args[0]?.name===name)owners.add(asset);
   if(['safeTransferFrom','transferFrom'].includes(e.memberName)&&args.length===3&&args[1]?.type==='MemberAccess'&&args[1].expression?.name==='msg'&&args[1].memberName==='sender'&&args[2]?.name===name)transfers.push(asset);
  });if(transfers.some(a=>owners.has(a)))proven=true;
 });}catch{}
 return proven;
}
function addProof(row,role,proof){if(!row.roles.includes(role))row.roles.push(role);if(!row.verifiedRoles.includes(role))row.verifiedRoles.push(role);row.evidence.push({...proof,role});}
function supportive(row){return !!row.supersededBy||row.verifiedRoles.some(r=>SUPPORT.has(r))||row.roles.some(r=>SUPPORT.has(r))&&!row.verifiedMintFamily&&!(row.priority>=3&&row.verifiedRoles.includes('mint')&&row.roles.filter(r=>SUPPORT.has(r)).every(r=>r==='treasury'));}
export function selectPrimary(rows){
 const eligible=rows.filter(r=>r.hasCode&&r.verifiedRoles.includes('mint')&&!supportive(r));
 const strongest=Math.max(-1,...eligible.map(r=>r.priority));
 const top=eligible.filter(r=>r.priority===strongest);
 // If another plausible project address could not be inspected, do not hide ambiguity.
 const uncertain=rows.filter(r=>!r.inspected&&!supportive(r)&&r.priority>=strongest);
 if(top.length===1&&!uncertain.length)return {address:top[0].address,reason:'网页部署信息与链上 Mint 接口一致'};
 const tokens=rows.filter(r=>r.hasCode&&r.verifiedRoles.includes('token')&&!supportive(r));
 if(!eligible.length&&!uncertain.length&&tokens.length===1)return {address:tokens[0].address,reason:'已核验唯一项目代币；Mint 入口仍需适配'};
 return {address:null,reason:top.length>1?'存在多个可用 Mint 合约，无法唯一确定当前项目入口':'缺少足够的链上证据，保留待核验候选'};
}
// A bounded read-only pass: ABI/bytecode and no-argument view getters, never scripts or transactions.
export async function classifyAddresses(rpc,candidates,sourceLoader){
 await rpc.verifyChain();const rows=mergeCandidates(candidates).sort((a,b)=>b.priority-a.priority),metadata=new Map();
 for(const row of rows){const known=KNOWN.get(row.address.toLowerCase());if(known){row.hasCode=row.address.toLowerCase()!=='0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';row.inspected=true;addProof(row,known,{kind:'known-address',label:'已知 BSC 公共地址'});}}
 const inspect=async row=>{
  try{
   const code=await rpc.getCode(row.address);row.hasCode=!!code&&code!=='0x';row.inspected=true;
   const known=KNOWN.get(row.address.toLowerCase());if(known){addProof(row,known,{kind:'known-address',label:'已知 BSC 公共地址'});return;}
   if(!row.hasCode){row.kind='wallet';row.evidence.push({kind:'code',label:'链上无合约代码，属于普通地址'});return;}
   const meta=await sourceLoader(rpc,row.address);metadata.set(row.address,meta);row.verifiedSource=meta.verified;row.verifiedMintFamily=recognizeSpecialMint(meta)?.kind||null;
   if(meta.verified){const abi=new Interface(meta.abi),facts=abiRoles(abi,meta);row.methods=facts.methods;
    for(const role of facts.roles)addProof(row,role,{kind:'verified-abi',label:'当前运行代码匹配的 ABI'});
    const labels=await Promise.allSettled(['name','symbol'].map(async method=>{const f=abi.getFunction(method+'()');if(!f||!['view','pure'].includes(f.stateMutability)||f.outputs.length!==1||f.outputs[0].type!=='string')return null;return String((await read(rpc,row.address,abi,method))[0]).slice(0,120);}));
    for(const [n,key]of ['name','symbol'].entries())if(labels[n].status==='fulfilled'&&labels[n].value)row[key]=labels[n].value;
   }else{
    // Selectors give interface evidence only; no guessed ABI is used for a write.
    const shape=runtimeShape(meta.runtimeCode);if(!shape.delegate){const patterns=['mint()','mint(uint256)','mint(uint256,uint256)','mint(uint256,address,uint256)','mintFree()','freeMint()','freeMint(uint256)','paidMint(uint256)','mintPass()','mintNative(uint256)','mintWithBnb(uint256)','mintWithBnb(uint256,address,uint256)','mintFree(uint256,uint256)','mintPaid(uint256)','mintPaid(uint256,uint256,uint256)','claimFree()','publicMint(uint256)','mintPublic(uint256)'];
     const handle=recognizeHandleMint(meta)||recognizePrimaryHandleMint(meta),matched=patterns.filter(s=>shape.selectors.has(new Interface(['function '+s]).fragments[0].selector));
     if(handle)matched.push(handle.methods.free,handle.methods.paid);
     const special=recognizeSpecialMint(meta);if(special)matched.push(special.kind==='ordinal-vrf-nft'?'mintPaid((uint8,uint8,uint256,uint256,uint256,address))':'mint(address,uint256)');
     if(matched.length){row.methods=matched;addProof(row,'mint',{kind:'runtime-selector',label:handle?'运行代码匹配 Agent ID 名称铸造接口组；身份、额度与报价仍须逐钱包核验':'运行代码存在 Mint 分派；具体参数和费用仍须验证'});}
     if(shape.selectors.has('0x01ffc9a7'))try{const supports=new Interface(['function supportsInterface(bytes4) view returns(bool)']);if((await read(rpc,row.address,supports,'supportsInterface',['0x80ac58cd']))[0])addProof(row,'nft',{kind:'interface-call',label:'ERC-721 接口只读检查通过'});}catch{}
    }
   }
   if(row.hints.some(h=>h.method)){
    const matched=row.hints.filter(h=>!h.method||row.methods?.some(m=>m.startsWith(h.method+'(')));
    row.priority=Math.max(0,...matched.map(h=>h.priority));
    if(matched.some(h=>h.method))row.evidence.push({kind:'documented-call',label:'官网相邻的合约与调用说明匹配链上 Mint 接口'});
   }
  }catch(e){row.inspected=false;row.error=e.message;}
 };
 const unknown=rows.filter(r=>!r.inspected),strong=unknown.filter(r=>r.priority>=3).slice(0,12);
 for(let i=0;i<strong.length;i+=4)await Promise.all(strong.slice(i,i+4).map(inspect));
 const verifiedEntry=strong.some(r=>r.verifiedRoles.includes('mint')&&!supportive(r));
 const rest=unknown.filter(r=>!strong.includes(r));
 const follow=verifiedEntry?rest.filter(r=>r.priority>=3).slice(0,12-strong.length):rest.slice(0,12-strong.length);
 for(let i=0;i<follow.length;i+=4)await Promise.all(follow.slice(i,i+4).map(inspect));
 for(const row of rest.filter(r=>!follow.includes(r))){row.deferred=verifiedEntry&&row.priority<3;row.error=row.deferred?'已优先核验网站明确的 Mint 入口，此辅助地址用途尚未逐项核验':'地址过多，超出本轮链上核验上限';}
 // A versioned collection can expose old and current deployments together.
 // Suppress a predecessor only when the new contract identifies it on-chain,
 // activation is complete, and the old paused supply matches the frozen count.
 for(const row of rows.filter(r=>r.verifiedMintFamily==='ordinal-vrf-nft'))try{
  const abi=new Interface(['function legacy() view returns(address)','function activated() view returns(bool)','function legacySupplyAtActivation() view returns(uint256)','function totalMinted() view returns(uint256)','function paused() view returns(bool)']);
  const [[old],[active],[frozen]]=await Promise.all([read(rpc,row.address,abi,'legacy'),read(rpc,row.address,abi,'activated'),read(rpc,row.address,abi,'legacySupplyAtActivation')]);
  const previous=rows.find(r=>same(r.address,old));if(!previous||same(old,row.address)||!active)continue;
  const [[paused],[supply]]=await Promise.all([read(rpc,old,abi,'paused'),read(rpc,old,abi,'totalMinted')]);
  if(paused&&supply===frozen){previous.supersededBy=row.address;previous.evidence.push({kind:'version-link',label:'新版已激活；链上 legacy 与冻结发行量确认此地址为旧版',from:row.address});}
 }catch{}
 const primary=selectPrimary(rows),root=rows.find(r=>r.address===primary.address),meta=root&&metadata.get(root.address);
 let token=root?.verifiedRoles.includes('token')?root.address:root?.verifiedRoles.includes('nft')?root.address:null;
 if(meta?.verified){
  const abi=new Interface(meta.abi);
  const getters=abi.fragments.filter(f=>f.type==='function'&&['view','pure'].includes(f.stateMutability)&&!f.inputs.length&&f.outputs.length===1&&f.outputs[0].type==='address'&&labelRoles(f.name).length).slice(0,16);
  const links=await Promise.allSettled(getters.map(async f=>({method:f.name,roles:labelRoles(f.name),address:address((await read(rpc,root.address,abi,f.name))[0])})));
  const tokens=[];
  for(const r of links){if(r.status!=='fulfilled'||same(r.value.address,ZeroAddress))continue;const link=r.value;let row=rows.find(x=>same(x.address,link.address));
   if(!row){row={address:link.address,priority:0,field:link.method+'()',source:root.address,hints:[],roles:[],verifiedRoles:[],evidence:[]};rows.push(row);}
   // A getter called MINING_POOL/vault may point to the actual NFT issuer.
   // Its relationship name is not proof that the target is a DEX pool/treasury.
   for(const role of link.roles){if(SUPPORT.has(role)&&row.verifiedRoles.includes('mint')&&!row.verifiedRoles.includes(role)){row.evidence.push({kind:'onchain-reference',from:root.address,method:link.method,label:'主合约 '+link.method+'() 关联此铸造入口；名称不覆盖已核验用途'});continue;}addProof(row,role,{kind:'onchain-reference',from:root.address,method:link.method,label:'主合约 '+link.method+'() 实际返回'});}
   if(link.roles.includes('token'))tokens.push(link.address);
  }
  if(new Set(tokens).size===1)token=tokens[0];
 }
 for(const row of rows){if(!row.roles.length)row.roles.push('unknown');row.roleLabels=row.roles.map(r=>ROLE_LABELS[r]);row.selectable=!row.deferred&&!supportive(row)&&row.hasCode!==false&&(row.verifiedRoles.includes('mint')||row.verifiedRoles.includes('token')||!row.inspected);row.primary=row.address===primary.address;}
 return {...primary,token,addresses:rows,candidates:rows.filter(r=>r.selectable&&!r.primary),needsSelection:!primary.address};
}
