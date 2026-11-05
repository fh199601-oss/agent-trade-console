import test from 'node:test';import assert from 'node:assert/strict';import {Interface} from 'ethers';
import {mintPlan} from '../lib/mint.mjs';import {bindings} from '../lib/common.mjs';
test('free intent selects public claim before a matching legacy paid template',async()=>{
 const target='0x'+'a'.repeat(40),token='0x'+'b'.repeat(40),abi=new Interface(['function claimFree()','function mintWithBnb(uint256 shares,address referrer,uint256 maxCost) payable','function costOf(uint256) view returns(uint256)','function tokensPerMint() view returns(uint256)','function token() view returns(address)','function walletRemaining(address) view returns(uint256)']);
 const meta={address:target,hash:'fixture',verified:true,abi:JSON.parse(abi.formatJson()),runtimeCode:'0x63e38fd34963fd32659200',sources:{s:{content:'contract T { function claimFree() external {} function mintWithBnb(uint256 shares,address referrer,uint256 maxCost) external payable { require(shares > 0 && maxCost > 0); } }'}},identity:{target}};
 const rpc={getBlockNumber:async()=>123,send:async(m,p)=>{if(m==='eth_getBlockByNumber')return {timestamp:'0x123'};if(m==='eth_estimateGas')return '0x10000';assert.equal(m,'eth_call');const f=abi.parseTransaction(p[0]);assert.notEqual(f.name,'costOf','free scope must not enter paid template');if(f.name==='claimFree'){assert.equal(BigInt(p[0].value),0n);return '0x';}return abi.encodeFunctionResult(f.name,[{tokensPerMint:100n,token,walletRemaining:1n}[f.name]]);}};
 const plan=await mintPlan(rpc,{}, {account:bindings()[0].account,side:'mint',scope:'free',quantity:'max',maxBnb:'0',referral:'none'},target,{source:'用户输入 CA'},null,{sourceLoader:async()=>meta});
 assert.equal(plan.route,'mint:claimFree()');assert.equal(plan.amountIn,'0');assert.equal(plan.quantity,1);
});
