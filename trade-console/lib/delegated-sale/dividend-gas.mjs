// Limits include EIP-150 forwarding headroom. The signing process also caps each BSC batch at 12M.
export const dividendInitHash='0x6b1f2156898561ad6764c00d8b2ca21926638f04305d1cbab0f27e92591886dd';
export const dividendRuntimeHash='0xd3172f9c65c327c58353ff257d60ba8aa2431e902280e9314d539eba2eb9b929';
export const standardBatch=Object.freeze({method:'executeBatch',size:20,gasPerRow:530000n});
export const dividendBatch=Object.freeze({method:'executeDividendBatch',size:8,gasPerRow:1420000n});
export const batchGas=(spec,count)=>600000n+BigInt(count)*spec.gasPerRow;
const heels='0xc54c3ef2ff9e34095c526f051cb3e117868c8cec';
export const heelsIdentity=Object.freeze({
 token:heels,tokenHash:'0xd042ad75adc6a88a42260931c62e43312bf3078f36fbd1850514ba204eb73e22',
 source:'0x5f92e0741d2a9143e15b15447437da4071bb26f8',sourceHash:'0x9b99d7e7c553df1fd6a93ae40e261a63b11dcc63d9cf1434b9456ba0615bbc38',
 pair:'0x4542bb04678ac9a00fca665eaf01bb8cd9e5daee'
});
export function isHeels(token){return token?.toLowerCase()===heels;}
export function needsDividendGas(v){return isHeels(v?.token);}
export function checkHeelsIdentity(v){
 if(!Object.entries(heelsIdentity).every(([k,value])=>v[k]?.toLowerCase()===value))throw Error('HEELS 的代币、发行合约或主池指纹已变化，请重新核验。');
}
export const incompatibleGas='当前极速合约每个钱包限 50 万 Gas，HEELS 触发分红时，代币合约内至少要剩 90 万 Gas。请先启用支持分红的个人极速合约，再给新合约授权并登记。';
