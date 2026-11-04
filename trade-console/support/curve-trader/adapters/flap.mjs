import { Interface, MaxUint256, ZeroAddress, getAddress } from 'ethers';

export const id = 'flap';
export const chainId = 56;
export const portal = getAddress('0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0');
export const agentIdNft = getAddress('0x60b9262456de011f7d15a54cdd8c48baaa8b022f');
export const CURVE_MAX_SUPPLY = 1_000_000_000n * 10n ** 18n;

// ABI and deployment source: https://docs.flap.sh/flap/developers/
// wallet-and-terminal-and-bot-developers/{inspect-a-token,trade-tokens}.md
export const portalAbi = new Interface([
  'function getTokenV8Safe(address token) view returns (tuple(uint8 status,uint256 reserve,uint256 circulatingSupply,uint256 price,uint8 tokenVersion,uint256 r,uint256 h,uint256 k,uint256 dexSupplyThresh,address quoteTokenAddress,bool nativeToQuoteSwapEnabled,bytes32 extensionID,uint256 buyTaxRate,uint256 sellTaxRate,address pool,uint256 progress,uint8 lpFeeProfile,uint8 dexId) state)',
  'function nftGate(address token) view returns (address nft)',
  'function maxBuyPerOrigin(address token) view returns (uint16 bps,uint256 maxBuyAmount)',
  'function buyQuotaOf(address token,address origin) view returns (uint256 bought,uint256 remaining)',
  'function getFeeRate() view returns (uint256 buyFeeRate,uint256 sellFeeRate)',
  'function quoteExactInput(tuple(address inputToken,address outputToken,uint256 inputAmount) params) returns (uint256 outputAmount)',
  'function swapExactInput(tuple(address inputToken,address outputToken,uint256 inputAmount,uint256 minOutputAmount,bytes permitData) params) payable returns (uint256 outputAmount)',
  'event TokenBought(uint256 ts,address token,address buyer,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)',
  'event TokenSold(uint256 ts,address token,address seller,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)',
]);

export const erc20Abi = new Interface([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
]);

function fail(code, message) {
  throw Object.assign(new Error(message), { code, platform: id });
}

function address(value) {
  return getAddress(value);
}

function same(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

function positive(value, field) {
  const n = BigInt(value);
  if (n <= 0n || n > MaxUint256) fail('INVALID_AMOUNT', `${field} must be a positive uint256`);
  return n;
}

async function read(rpc, to, abi, method, args, wallet, blockTag) {
  const tx = { to, from: wallet, data: abi.encodeFunctionData(method, args) };
  if (blockTag !== undefined) tx.blockTag = blockTag;
  return abi.decodeFunctionResult(method, await rpc.call(tx));
}

export function matchesUrl(value) {
  try {
    const url = value instanceof URL ? value : new URL(value);
    return url.protocol === 'https:' && ['flap.sh', 'www.flap.sh'].includes(url.hostname.toLowerCase()) &&
      /^\/bnb\/0x[0-9a-f]{40}\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export async function inspect({ rpc, token, wallet, blockTag, nativeBalancePromise, onQuoteToken }) {
  token = address(token);
  wallet = address(wallet);
  const p = (method, args = []) => read(rpc, portal, portalAbi, method, args, wallet, blockTag);
  const t = (method, args = []) => read(rpc, token, erc20Abi, method, args, wallet, blockTag);
  const [tokenState, gateResult, quotaLimit, quotaUsed, fees, supply, balance, decimals, allowance, tokenCode, portalCode, symbol] = await Promise.all([
    p('getTokenV8Safe', [token]), p('nftGate', [token]),
    p('maxBuyPerOrigin', [token]), p('buyQuotaOf', [token, wallet]), p('getFeeRate'),
    t('totalSupply'), t('balanceOf', [wallet]), t('decimals'), t('allowance', [wallet, portal]),
    rpc.getCode(token, blockTag), rpc.getCode(portal, blockTag),
    t('symbol').then(r => r[0]).catch(() => 'FLAP_TOKEN'),
  ]);
  if (tokenCode === '0x' || portalCode === '0x') fail('UNVERIFIED_TARGET', 'Flap token or Portal has no deployed code');
  const s = tokenState[0];
  const status = Number(s.status);
  if (status === 0) fail('NOT_FLAP_TOKEN', 'The official Flap Portal does not recognize this token');
  if (Number(decimals[0]) !== 18) fail('UNSUPPORTED_DECIMALS', 'Flap curve base token must use 18 decimals');
  const gate = address(gateResult[0]);
  const gateSupported = same(gate, ZeroAddress) || same(gate, agentIdNft);
  const quoteToken = address(s.quoteTokenAddress);
  const nativeQuote = same(quoteToken, ZeroAddress);
  if(nativeQuote)onQuoteToken?.({quoteToken,quoteDecimals:18});
  const [nftBalance, quoteInfo] = await Promise.all([
    same(gate, ZeroAddress) || !gateSupported ? Promise.resolve(null) :
      read(rpc, gate, erc20Abi, 'balanceOf', [wallet], wallet, blockTag).then(r => r[0]),
    nativeQuote ? (nativeBalancePromise??rpc.getBalance(wallet, blockTag)).then(b => [18, 'BNB', b, MaxUint256]) :
      Promise.all([
        read(rpc, quoteToken, erc20Abi, 'decimals', [], wallet, blockTag).then(r => Number(r[0])),
        read(rpc, quoteToken, erc20Abi, 'symbol', [], wallet, blockTag).then(r => r[0]).catch(() => 'QUOTE'),
        read(rpc, quoteToken, erc20Abi, 'balanceOf', [wallet], wallet, blockTag).then(r => r[0]),
        read(rpc, quoteToken, erc20Abi, 'allowance', [wallet, portal], wallet, blockTag).then(r => r[0]),
      ]),
  ]);
  if (quoteInfo[0] > 18) fail('UNSUPPORTED_DECIMALS', 'Flap quote decimals exceed the verified curve math range');
  const maxBuyTokens = quotaLimit[0] === 0n || quotaLimit[1] === 0n ? null : quotaLimit[1];
  const remainingBuyTokens = maxBuyTokens === null || quotaUsed[1] === MaxUint256 ? null : quotaUsed[1];
  return {
    platform: id, chainId, token, wallet, spender: portal, quoteToken,
    quoteDecimals: quoteInfo[0], quoteSymbol: quoteInfo[1], quoteBalance: quoteInfo[2], quoteAllowance: quoteInfo[3],
    symbol, decimals: 18, totalSupply: supply[0], maxSupply: CURVE_MAX_SUPPLY, balance: balance[0], allowance: allowance[0],
    status, migrated: status === 4, tradable: status === 1,
    gate, gateSupported, agentOnly: same(gate, agentIdNft),
    eligible: gateSupported && (same(gate, ZeroAddress) || nftBalance > 0n), agentIdBalance: nftBalance,
    maxBuyBps: Number(quotaLimit[0]), maxBuyTokens, remainingBuyTokens, boughtTokens: quotaUsed[0],
    curveRemainingTokens: s.dexSupplyThresh > s.circulatingSupply ? s.dexSupplyThresh - s.circulatingSupply : 0n,
    nativeToQuoteSwapEnabled: s.nativeToQuoteSwapEnabled,
    buyFeeBps: fees[0], sellFeeBps: fees[1], buyTaxBps: s.buyTaxRate, sellTaxBps: s.sellTaxRate,
    curve: { reserve: s.reserve, supply: s.circulatingSupply, r: s.r, h: s.h, k: s.k, dexSupplyThresh: s.dexSupplyThresh },
    pool: s.pool, progress: s.progress, tokenVersion: Number(s.tokenVersion),
    inspectedAt: Date.now(),
    metadata: { source: 'Flap Portal getTokenV8Safe+nftGate+buyQuotaOf', quotaKey: 'tx.origin', quotaResetsOnSell: false, blockTag: blockTag ?? 'latest' },
  };
}

export function assertTradable({ state, token, wallet, side }) {
  if (!state || state.platform !== id || !same(state.token, address(token)) || !same(state.wallet, address(wallet)) || !same(state.spender, portal)) {
    fail('STATE_MISMATCH', 'Flap state does not match token, wallet, and official Portal');
  }
  if (state.migrated || state.status === 4) fail('TOKEN_MIGRATED', 'Token graduated from the Flap curve; a DEX trade is a different route');
  if (state.status !== 1) fail('CURVE_NOT_TRADABLE', `Flap status ${state.status} is not Tradable`);
  if (!state.gateSupported || !state.eligible) fail('AGENT_ID_REQUIRED', 'Wallet does not satisfy this token\'s verified Agent ID gate');
  if (side === 'buy' && (state.remainingBuyTokens === 0n || state.curveRemainingTokens === 0n)) {
    fail('BUY_QUOTA_EXHAUSTED', 'No remaining per-origin or curve buy quota');
  }
}

function buyInputToken(state, inputToken) {
  const result = address(inputToken ?? state.quoteToken);
  if (same(result, state.quoteToken)) return result;
  if (same(result, ZeroAddress) && state.nativeToQuoteSwapEnabled) return result;
  fail('UNSUPPORTED_PAYMENT_TOKEN', 'Pay with this curve\'s quote asset, or its enabled native-to-quote route');
}

export async function quoteBuy({ rpc, token, wallet, amountIn, state, inputToken, blockTag }) {
  assertTradable({ state, token, wallet, side: 'buy' });
  const input = buyInputToken(state, inputToken);
  const result = await read(rpc, portal, portalAbi, 'quoteExactInput', [[input, address(token), positive(amountIn, 'amountIn')]], address(wallet), blockTag);
  if (result[0] <= 0n) fail('ZERO_QUOTE', 'Flap buy quote returns zero output');
  return { amountOut: result[0], inputToken: input, outputToken: address(token), quotaAware: true };
}

export async function quoteSell({ rpc, token, wallet, amountIn, state, blockTag }) {
  assertTradable({ state, token, wallet, side: 'sell' });
  const amount = positive(amountIn, 'amountIn');
  const result = await read(rpc, portal, portalAbi, 'quoteExactInput', [[address(token), state.quoteToken, amount]], address(wallet), blockTag);
  if (result[0] <= 0n) fail('ZERO_QUOTE', 'Flap sell quote returns zero output');
  return { amountOut: result[0], inputToken: address(token), outputToken: state.quoteToken };
}

function buildSwap({ inputToken, outputToken, amountIn, minAmountOut, permitData = '0x' }) {
  const amount = positive(amountIn, 'amountIn');
  const minimum = BigInt(minAmountOut);
  // An explicitly aggressive sell may set the minimum to 1 smallest unit.
  // Keeping it positive prevents an exhausted curve producing a zero-fill success.
  if (minimum <= 0n || minimum > MaxUint256) fail('INVALID_MIN_OUTPUT', 'minAmountOut must be a positive uint256');
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(permitData)) fail('INVALID_PERMIT', 'permitData must be hex bytes');
  return {
    to: portal,
    value: same(inputToken, ZeroAddress) ? amount : 0n,
    data: portalAbi.encodeFunctionData('swapExactInput', [[inputToken, outputToken, amount, minimum, permitData]]),
  };
}

export function buildBuy({ token, wallet, amountIn, minAmountOut, state, inputToken, permitData }) {
  assertTradable({ state, token, wallet, side: 'buy' });
  return buildSwap({ inputToken: buyInputToken(state, inputToken), outputToken: address(token), amountIn, minAmountOut, permitData });
}

export function buildSell({ token, wallet, amountIn, minAmountOut, state, permitData }) {
  assertTradable({ state, token, wallet, side: 'sell' });
  if (BigInt(amountIn) > state.balance) fail('INSUFFICIENT_BALANCE', 'Requested sell exceeds token balance');
  return buildSwap({ inputToken: address(token), outputToken: state.quoteToken, amountIn, minAmountOut, permitData });
}

export function buildApproval({ token, amount }) {
  return { to: address(token), value: 0n, data: erc20Abi.encodeFunctionData('approve', [portal, positive(amount, 'amount')]) };
}

/** Read the one Portal trade event from an already transaction-verified receipt.
 * `eth` and `fee` are quote-token raw units, including for ERC20 quote markets.
 * TokenSold.eth is net recipient output; do not deduct fee again. TokenBought
 * does prove the bought quantity, but does not prove wallet gross input/refunds
 * for every native-to-quote route. Its amountIn deliberately remains unknown.
 */
export function settlement({ receipt, wallet, token, side, state }) {
  if (!['buy', 'sell'].includes(side)) fail('FLAP_INVALID_TRADE_SIDE', 'Expected buy or sell');
  token = address(token); wallet = address(wallet);
  if (!state || state.platform !== id || !state.token || !state.wallet || !state.spender ||
      !same(state.token, token) || !same(state.wallet, wallet) || !same(state.spender, portal)) {
    fail('FLAP_STATE_MISMATCH', 'Settlement state does not identify this token, wallet and official Portal');
  }
  const quoteToken = address(state.quoteToken);
  if (!receipt || ![1, 1n, '1', '0x1'].includes(receipt.status)) fail('FLAP_RECEIPT_NOT_SUCCESS', 'Receipt is not a successful transaction');
  if (receipt.to && !same(address(receipt.to), portal)) fail('FLAP_RECEIPT_TARGET_MISMATCH', 'Receipt target is not the official Portal');
  if (receipt.from && !same(address(receipt.from), wallet)) fail('FLAP_RECEIPT_WALLET_MISMATCH', 'Receipt sender differs from the requested wallet');
  if (!Array.isArray(receipt.logs)) fail('FLAP_INVALID_RECEIPT_LOGS', 'Receipt logs are missing');
  const wanted = side === 'buy' ? 'TokenBought' : 'TokenSold';
  const boughtTopic = portalAbi.getEvent('TokenBought').topicHash.toLowerCase();
  const soldTopic = portalAbi.getEvent('TokenSold').topicHash.toLowerCase();
  const events = [];
  for (const log of receipt.logs) {
    if (typeof log.address !== 'string' || !same(log.address, portal) || log.removed) continue;
    const eventTopic = log.topics?.[0]?.toLowerCase();
    if (eventTopic !== boughtTopic && eventTopic !== soldTopic) continue;
    // Both verified events have seven non-indexed static words and one topic.
    if (!Array.isArray(log.topics) || log.topics.length !== 1 || typeof log.data !== 'string' || !/^0x[0-9a-f]{448}$/i.test(log.data)) {
      fail('FLAP_SETTLEMENT_EVENT_SCHEMA', 'Portal trade event does not match its verified ABI');
    }
    let event;
    try {
      event = portalAbi.parseLog(log);
      if (portalAbi.encodeEventLog(event.fragment, [...event.args]).data.toLowerCase() !== log.data.toLowerCase()) throw new Error('Noncanonical event data');
    } catch {
      fail('FLAP_SETTLEMENT_EVENT_SCHEMA', 'Portal trade event cannot be decoded canonically');
    }
    if (event.name !== wanted) fail('FLAP_SETTLEMENT_SIDE_MISMATCH', 'Portal trade event has the wrong direction');
    if (!same(event.args.token, token)) fail('FLAP_SETTLEMENT_TOKEN_MISMATCH', 'Portal trade event has the wrong token');
    if (!same(event.args[2], wallet)) fail('FLAP_SETTLEMENT_WALLET_MISMATCH', 'Portal trade event has the wrong buyer or seller');
    events.push(event);
  }
  if (events.length === 0) fail('FLAP_SETTLEMENT_EVENT_MISSING', 'No matching official Portal trade event');
  if (events.length !== 1) fail('FLAP_SETTLEMENT_EVENT_AMBIGUOUS', 'More than one matching official Portal trade event');
  const a = events[0].args;
  if (a.amount <= 0n || a.eth <= 0n) fail('FLAP_INVALID_SETTLEMENT_AMOUNT', 'Portal trade event has zero input or output');
  return {
    amountIn: side === 'sell' ? a.amount : null,
    amountOut: side === 'sell' ? a.eth : a.amount,
    fee: a.fee,
    inputToken: side === 'sell' ? token : null,
    outputToken: side === 'sell' ? quoteToken : token,
    feeToken: quoteToken,
    quoteToken,
  };
}

function divUp(a, b) {
  if (b <= 0n) fail('INVALID_CURVE', 'Invalid curve denominator');
  return (a + b - 1n) / b;
}

// Exact integer inverse of the documented curve, rounded up. This is an estimate,
// not a substitute for quoteExactInput: per-token fee profiles/exemptions and a
// moved block can differ. The caller must verify the resulting on-chain quote.
export function estimateInputForTokens({ state, amountOut }) {
  const amount = positive(amountOut, 'amountOut');
  if (state.status !== 1 || state.migrated) fail('CURVE_NOT_TRADABLE', 'Curve inverse is unavailable after migration');
  if (amount > state.curveRemainingTokens || (state.remainingBuyTokens !== null && amount > state.remainingBuyTokens)) {
    fail('BUY_QUOTA_EXCEEDED', 'Requested output exceeds remaining quota');
  }
  const { supply, reserve, r, h, k } = state.curve;
  const scale = 10n ** BigInt(18 - state.quoteDecimals);
  const targetReserveWad = divUp(k * 10n ** 18n, CURVE_MAX_SUPPLY + h - supply - amount) - r;
  const targetReserve = divUp(targetReserveWad, scale);
  const delta = targetReserve > reserve ? targetReserve - reserve : 0n;
  const effectiveBps = BigInt(state.buyFeeBps) + BigInt(state.buyTaxBps);
  if (effectiveBps >= 10_000n) fail('INVALID_FEE', 'Effective curve buy fee reaches 100%');
  return divUp(delta * 10_000n, 10_000n - effectiveBps) + 1n;
}
