import {getAddress, getCreate2Address, id, solidityPackedKeccak256, ZeroAddress} from 'ethers';

export const DEPLOY_PROXY = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
export const INIT_HASH = '0x2c9ea019494b429a9064ff0a5fca33857a20fd41b98fb8732cff1969f73f5fff';
export const PROXY_HASH = '0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989';
const domain = id('Agent trade console / BSC / personal fast sale / v2');

export function personalSalt(payer) {
  const address = getAddress(payer);
  if (address === ZeroAddress) throw Error('部署钱包地址无效');
  return solidityPackedKeccak256(['bytes32', 'address'], [domain, address]);
}
export function personalExecutor(payer, initHash=INIT_HASH) {
  return getCreate2Address(DEPLOY_PROXY, personalSalt(payer), initHash);
}
