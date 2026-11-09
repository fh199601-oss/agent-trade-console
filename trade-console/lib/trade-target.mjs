import {address} from './common.mjs';

// Buying/selling names the asset being debited/credited. Mint discovery may
// resolve the very same CA to a different issuance contract and must never run.
export function tradeTarget(asset){
 if(!/^0x[\da-f]{40}$/i.test(asset))throw Error('买卖请使用到账代币的完整 CA，不能使用项目网址或 Mint 入口');
 return {address:address(asset),source:'用户输入代币 CA'};
}
