import test from 'node:test';import assert from 'node:assert/strict';import {Interface,ZeroAddress} from 'ethers';
import {runtimeShape,executableBytes} from '../lib/bytecode.mjs';import {erc1155Received} from '../lib/erc1155-credit.mjs';import {verifyPreview} from '../lib/engine.mjs';import {recognizeMint,adaptiveQuote} from '../lib/adaptive-mint.mjs';
const token='0x'+'11'.repeat(20),wallet='0x'+'22'.repeat(20);
test('constant-data section before CBOR is unreachable, but a real JUMPDEST or PUSH-hidden INVALID is not trimmed',()=>{
 const trailer='a2646970667358221220'+'f4'+'00'.repeat(31)+'64736f6c63430008180033';
 const code='0x600000fe'+Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/').toString('hex')+trailer;
 assert.equal(runtimeShape(code).delegate,false);assert.equal(executableBytes(code).length,4);
 assert.equal(runtimeShape('0xf4'+code.slice(2)).delegate,true);
 const jumpable='0x600000fe5bf4'+trailer;assert.equal(executableBytes(jumpable).length,(jumpable.length-2)/2);assert.equal(runtimeShape(jumpable).delegate,true);
 const pushHidden='0x60fe'+trailer;assert.equal(executableBytes(pushHidden).length,(pushHidden.length-2)/2);
});
test('ERC1155 preview demands exact typed credits and settlement counts net units from single and batch logs',()=>{
 const plan={wallet,inputToken:token,outputToken:token,expectedAsset:{kind:'Erc1155',token,amount:'3'},minOutput:'3',amountIn:'0',metaVerified:true,requireAssetCredit:true},step={kind:'mint',to:token,value:'0'},preview=changes=>({requestId:'x',simulationResult:{simulationCode:'000000000',balanceChanges:changes}});
 const c=(id,n,type='Erc1155')=>({owner:wallet,contractAddress:token,tokenType:type,tokenId:id,change:String(n)});
 assert.doesNotThrow(()=>verifyPreview(preview([c(1,2),c(5,1)]),plan,step));assert.throws(()=>verifyPreview(preview([c(1,2),c(1,2)]),plan,step),/重复/);assert.throws(()=>verifyPreview(preview([c(1,3,'Erc20')]),plan,step),/ERC1155/);
 assert.doesNotThrow(()=>verifyPreview(preview([c(1,1,'Erc721'),c(2,1,'Erc721'),c(3,1,'Erc721')]),{...plan,erc1155InterfaceVerified:true},step));assert.throws(()=>verifyPreview(preview([c(1,3,'Erc721')]),{...plan,erc1155InterfaceVerified:true},step),/ERC1155/);
 const events=new Interface(['event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)','event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)']);
 const log=(name,args)=>({address:token,...events.encodeEventLog(events.getEvent(name),args)});
 assert.equal(erc1155Received([log('TransferSingle',[token,ZeroAddress,wallet,1,2]),log('TransferBatch',[token,ZeroAddress,wallet,[1,5],[3,1]]),log('TransferSingle',[token,wallet,ZeroAddress,1,1]),log('TransferSingle',[token,wallet,wallet,5,100])],token,wallet),5n);
});
test('multi-currency quote uses native bnbWei/bnbDue field, address quota, and excludes USD amount',async()=>{
 for(const nativeField of ['bnbWei','bnbDue']){
  const abi=new Interface(['function mint(uint256 shares,address referrer,uint256 maxCost) payable',`function bnbQuote(uint256 shares) view returns(uint256 costUsd,uint256 ${nativeField})`,'function maxQuotaOf(address) view returns(uint256)','function mintedBy(address) view returns(uint256)','function mintPaused() view returns(bool)','function MAX_SHARES() view returns(uint256)','function sharesSold() view returns(uint256)','function tokensPerShare() view returns(uint256)','function token() view returns(address)']);
  const meta={verified:true,address:token,abi:JSON.parse(abi.formatJson()),sources:{s:{content:'contract Mint { function mint(uint256 shares,address referrer,uint256 maxCost) external payable { doMint(shares,referrer,maxCost); } }'} }},route=recognizeMint(meta).routes[0];const rpc=async(m,params)=>{if(m==='eth_estimateGas')return '0x10000';const f=abi.parseTransaction(params[0]);if(f.name==='mint'){if(BigInt(params[0].value)<7n*f.args[0])throw Object.assign(Error('revert: fee'),{executionError:true});return '0x';}if(f.name==='bnbQuote')return abi.encodeFunctionResult(f.name,[1000000n*f.args[0],7n*f.args[0]]);const values={maxQuotaOf:10n,mintedBy:8n,mintPaused:false,MAX_SHARES:100n,sharesSold:90n,tokensPerShare:1000n,token};return abi.encodeFunctionResult(f.name,[values[f.name]]);};
  const q=await adaptiveQuote(meta,route,{address:wallet},2,{tag:'0x123',number:291,timestamp:100},rpc);assert.equal(q.total.raw,'14');assert.equal(q.limits.walletRemaining,2);assert.equal(q.limits.publicRemaining,10);assert.equal(q.available,true);
 }
});
