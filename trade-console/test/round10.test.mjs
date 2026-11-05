// All providers are fakes; no network, wallet subprocess or signing.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {Interface} from 'ethers';import {unavailableMintState} from '../lib/source-constraints.mjs';
import {recognizeSourceSale,sourceSalePlan} from '../lib/source-sale.mjs';import {USDT,ERC20,wallet,BNB} from '../lib/common.mjs';
const address='0x'+'1'.repeat(40),asset='0x'+'2'.repeat(40),w=wallet(1);
function guardFixture(body,extra='',values={}){
 const abi=new Interface(['function mint(uint256)', 'function endTime() view returns(uint256)','function startTime() view returns(uint256)','function finished() view returns(bool)','function total() view returns(uint256)','function cap() view returns(uint256)',...(extra?['function paidMint(uint256)']:[])]);
 const meta={address,verified:true,abi:JSON.parse(abi.formatJson()),sources:{'Sale.sol':{content:`contract Sale { uint256 public endTime; uint256 public startTime; bool public finished; uint256 public total; uint256 public cap; function mint(uint256 n) external {${body}} ${extra} }`}}};
 const rpc={getBlockNumber:async()=>12,send:async()=>({timestamp:'0x64'}),call:async(tx,block)=>{assert.equal(block,12);const f=abi.parseTransaction(tx);return abi.encodeFunctionResult(f.fragment,[{endTime:99n,startTime:0n,finished:false,total:0n,cap:10n,...values}[f.name]]);}};return {meta,rpc};
}
test('require state guards classify ended, not-open, sold-out, paused and do not hide an open paid lane',async()=>{
 for(const [body,values,code]of [
  ['require(n>0,"bad quantity"); require(block.timestamp < endTime,"mint ended");',{},'MINT_ENDED'],
  ['require(block.timestamp >= startTime,"not started");',{startTime:200n},'MINT_NOT_OPEN'],
  ['require(total < cap,"sold out");',{total:10n},'NO_QUOTA'],
  ['require(!finished,"mint paused");',{finished:true},'MINT_PAUSED']]){const f=guardFixture(body,'',values);assert.equal((await unavailableMintState(f.rpc,f.meta))?.code,code);}
 const f=guardFixture('require(block.timestamp < endTime,"mint ended");','function paidMint(uint256 n) external {}');assert.equal(await unavailableMintState(f.rpc,f.meta),null);
});
test('source stop inference does not cross mutating branches, assignments or unknown require calls',async()=>{
 for(const prefix of ['if (finished) { endTime=200; }','endTime=200;','require(updateState(),"ok");','if (updateState()) revert Closed();','uint256 x=updateState();','uint256 endTime=200;','return;']){const f=guardFixture(prefix+'require(block.timestamp < endTime,"mint ended");');assert.equal(await unavailableMintState(f.rpc,f.meta),null);}
});
const base=JSON.parse(fs.readFileSync(new URL('./fixtures/source-sale.json',import.meta.url)));
function sale({native=false,capName=null,guard='require',nested=false,badCap=false}={}){
 const m=structuredClone(base),replace=(a,b)=>{for(const s of Object.values(m.sources))s.content=s.content.replaceAll(a,b);};
 const mint=m.abi.find(f=>f.type==='function'&&f.name==='mint');
 if(native){mint.stateMutability='payable';replace('external nonReentrant live onlyAgent','external payable nonReentrant live onlyAgent');replace('usdt.safeTransferFrom(msg.sender, address(this), cost);',guard==='require'?'require(msg.value >= cost, "underpaid");':'if (cost > msg.value) { revert Underpaid(); }');}
 if(capName){mint.inputs.push({name:capName,type:'uint256'});replace('function mint(uint256 shares)','function mint(uint256 shares, uint256 '+capName+')');replace('uint256 cost = costOf(shares);','uint256 cost = costOf(shares); '+(guard==='require'?`require(cost <= ${capName}${badCap?' + 1':''}, "payment too high");`:`if (${capName}${badCap?' + 1':''} < cost) revert Ceiling();`));}
 if(nested){replace('paidMinted[msg.sender]','paidMinted[msg.sender][epoch]');replace('mapping(address => uint256) public paidMinted','mapping(address => mapping(uint256 => uint256)) public paidMinted');const g=m.abi.find(f=>f.type==='function'&&f.name==='paidMinted');g.inputs.push({name:'',type:'uint256'});m.abi.push(JSON.parse(new Interface(['function epoch() view returns(uint256)']).formatJson())[0]);}
 const abi=new Interface(m.abi);m.runtimeCode='0x'+abi.fragments.filter(f=>f.type==='function').map(f=>'63'+f.selector.slice(2)+'14600057').join('')+'00';
 const state={price:2n*10n**18n,used:1n,mints:[]},rpc={getBlockNumber:async()=>12,send:async()=>({timestamp:'0x5dc'}),call:async(tx,block)=>{assert.equal(block,12);const i=tx.to.toLowerCase()===m.address.toLowerCase()?abi:ERC20,f=i.parseTransaction(tx);if(f.name==='mint'){state.mints.push(f.args);assert.equal(BigInt(tx.value),native?state.price*f.args[0]:0n);return '0x';}
 const values={usdt:USDT,token:asset,TOKENS_PER_SHARE:100n,MAX_PER_TX:5n,TARGET_SHARES:5000n,totalMinted:96n,paidMinted:state.used,quotaOf:5n,OPEN_AT:1000n,DEADLINE:2000n,poolOpened:false,isAgent:true,decimals:18n,balanceOf:10n**24n,allowance:10n**24n,costOf:state.price*(f.args.length && typeof f.args[0]==='bigint'?f.args[0]:1n),epoch:7n};assert.ok(f.name in values,f.name);if(nested&&f.name==='paidMinted')assert.equal(f.args[1],7n);return i.encodeFunctionResult(f.fragment,[values[f.name]]);}};
 return {m,rpc,state,abi};
}
const intent={account:1,scope:'paid',quantity:'max',maxUsdt:'6',maxBnb:'6',referral:'account1'};
test('native source sale supports require payment and reversed block revert with fresh bounded value',async()=>{
 for(const guard of ['require','revert']){const f=sale({native:true,guard}),p=recognizeSourceSale(f.m);assert.ok(p);const plan=await sourceSalePlan(f.rpc,intent,f.m,w,{});assert.equal(plan.inputToken,BNB);assert.equal(plan.quantity,3);assert.equal(plan.amountIn,String(6n*10n**18n));assert.equal(f.state.mints.length,1);await assert.rejects(sourceSalePlan(f.rpc,{...intent,maxBnb:'0'},f.m,w,{}),e=>e.code==='BUDGET_LIMIT');}
});
test('payment ceilings are inferred from debit comparisons, independent of parameter name, and rebound on quote change',async()=>{
 for(const [capName,guard,native]of [['opaqueLimit','require',false],['x99','revert',false],['ceiling','require',true]]){
  const f=sale({capName,guard,native});assert.deepEqual(recognizeSourceSale(f.m)?.roles,['quantity','cost']);let p=await sourceSalePlan(f.rpc,intent,f.m,w,{});assert.equal(f.abi.parseTransaction(p.steps.at(-1)).args[1],6n*10n**18n);
  f.state.price=4n*10n**18n;p=await sourceSalePlan(f.rpc,intent,f.m,w,{});assert.equal(p.quantity,1);assert.equal(f.abi.parseTransaction(p.steps.at(-1)).args[1],4n*10n**18n);
 }
 const bad=sale({capName:'anything',badCap:true});assert.equal(recognizeSourceSale(bad.m),null);
 const unknown=sale({capName:'x'});for(const s of Object.values(unknown.m.sources))s.content=s.content.replace('require(cost <= x, "payment too high");','');assert.equal(recognizeSourceSale(unknown.m),null);
});
test('nested wallet/epoch quotas use both live getter keys and remaining balance',async()=>{
 const f=sale({nested:true}),p=recognizeSourceSale(f.m);assert.ok(p);const plan=await sourceSalePlan(f.rpc,{...intent,maxUsdt:'100'},f.m,w,{});assert.equal(plan.quantity,4);assert.equal(plan.quota.walletRemaining,'4');
});
test('separate free-pool exhaustion is not reported as total project sold out',async()=>{
 const {recognizeMint,adaptiveQuote}=await import('../lib/adaptive-mint.mjs');const abi=new Interface(['function freeMint()','function FREE_SUPPLY() view returns(uint256)','function freeMinted() view returns(uint256)','function MAX_SUPPLY() view returns(uint256)','function totalMinted() view returns(uint256)']),meta={address,verified:true,abi:JSON.parse(abi.formatJson()),sources:{}},route=recognizeMint(meta).routes[0];
 const rpc=async(method,params)=>{assert.equal(method,'eth_call');const f=abi.parseTransaction(params[0]);return abi.encodeFunctionResult(f.fragment,[{FREE_SUPPLY:10n,freeMinted:10n,MAX_SUPPLY:20n,totalMinted:12n}[f.name]]);};
 await assert.rejects(adaptiveQuote(meta,route,w,1,{tag:'0x1',timestamp:100},rpc),e=>e.code==='NO_QUOTA'&&e.details.quotaScope==='free'&&/免费名额/.test(e.message)&&!/^项目.*售罄/.test(e.message));
});
