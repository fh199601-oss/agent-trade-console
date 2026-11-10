import test from 'node:test';import assert from 'node:assert/strict';
import {walletOverview} from '../lib/wallet-overview.mjs';
import {bindings} from '../lib/common.mjs';
test('不选择代币也能读取各钱包 BNB，刷新同时检查独立连接',async()=>{
 const calls=[],readiness=new Map(),rpc={getBlockNumber:async()=>123,getBalance:async(a,b)=>{assert.equal(b,123);return 10n**17n;}},bridge={ready:async(a,o)=>{calls.push(a);assert.equal(o.force,true);return {status:'CONNECTED',checkedAt:100};}};
 const r=await walletOverview(rpc,bridge,readiness,{checkConnection:true});assert.equal(r.wallets.length,bindings().length);assert.deepEqual(calls,bindings().map(w=>w.account));assert.ok(r.wallets.every(w=>w.bnb==='0.1'&&w.status==='CONNECTED'));assert.equal(readiness.size,bindings().length);
});
test('连接异常不隐藏可读余额，一个钱包余额失败不影响其他钱包',async()=>{
 const ws=bindings(),rpc={getBlockNumber:async()=>100,getBalance:async a=>{if(a===ws[1].address)throw Error('RPC timeout');return 5n*10n**17n;}},bridge={ready:async a=>{if(a===ws[0].account)throw Error('会话已过期');return {status:'CONNECTED'};}};
 const r=await walletOverview(rpc,bridge,new Map(),{checkConnection:true});assert.equal(r.wallets[0].bnb,'0.5');assert.equal(r.wallets[0].status,'ERROR');assert.equal(r.wallets[1].bnb,null);assert.match(r.wallets[1].balanceError,/timeout/);assert.equal(r.wallets[1].status,'CONNECTED');assert.equal(r.wallets[2].bnb,'0.5');
});
test('自动 BNB 刷新复用连接状态，区块查询失败明确返回未知余额',async()=>{
 const readiness=new Map(bindings().map(w=>[w.account,{status:'CONNECTED',checkedAt:3}]));let calls=0;
 const r=await walletOverview({getBlockNumber:async()=>{throw Error('链上不可用');},getBalance:async()=>{throw Error('链上不可用');}},{ready:async()=>{calls++;}},readiness);
 assert.equal(calls,0);assert.ok(r.wallets.every(w=>w.bnb===null&&w.status==='CONNECTED'&&w.balanceError==='链上不可用'));
});
test('区块高度接口故障不遮掉可独立读取的 BNB 余额，也不修改钱包连接状态',async()=>{
 const readiness=new Map(bindings().map(w=>[w.account,{status:'CONNECTED',checkedAt:3}]));
 const r=await walletOverview({getBlockNumber:async()=>{throw Error('height limited');},getBalance:async(a,b)=>{assert.equal(b,'latest');return 10n**18n;}},{},readiness);
 assert.equal(r.block,null);assert.equal(r.blockError,'height limited');assert.ok(r.wallets.every(w=>w.bnb==='1.0'&&w.status==='CONNECTED'&&!w.balanceError));
});
