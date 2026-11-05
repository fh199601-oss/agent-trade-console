import test from 'node:test';import assert from 'node:assert/strict';import {Interface} from 'ethers';import {mintError} from '../lib/mint-errors.mjs';
test('standard revert reasons survive decoding instead of becoming the word Error',()=>{
 const abi=new Interface(['error Error(string)','error Panic(uint256)','error WrongPhase()','error FreeGone()']);
 const error=message=>({message:'execution reverted',data:abi.encodeErrorResult('Error',[message])});
 assert.match(mintError(error('Free pool empty')).message,/Free pool empty/);assert.equal(mintError(error('x'.repeat(1000))).message.length<330,true);
 assert.match(mintError({data:abi.encodeErrorResult('Panic',[0x11])}).message,/0x11/);
 assert.equal(mintError({data:abi.encodeErrorResult('WrongPhase',[])},abi.fragments).code,'MINT_STATE');assert.equal(mintError({data:abi.encodeErrorResult('FreeGone',[])},abi.fragments).code,'NO_QUOTA');
 const unknown={message:'RPC unavailable'};assert.equal(mintError(unknown),unknown);
});
test('exact no-quota and eligibility reverts are separated from unknown reverts and RPC errors',()=>{
 const abi=new Interface(['error Error(string)','error AlreadyMinted()']);
 for(const [message,code]of [['AlreadyMinted','NO_QUOTA'],['AlreadyRegistered','NO_QUOTA'],['Not a free mint ID','MINT_INELIGIBLE'],['Sale ended','MINT_ENDED'],['RPC timeout says AlreadyMinted','MINT_REVERT']])assert.equal(mintError({data:abi.encodeErrorResult('Error',[message])}).code,code);
 assert.equal(mintError({data:abi.encodeErrorResult('AlreadyMinted',[])},abi.fragments).code,'NO_QUOTA');assert.equal(mintError({message:'AlreadyMinted'}).code,undefined);
});
