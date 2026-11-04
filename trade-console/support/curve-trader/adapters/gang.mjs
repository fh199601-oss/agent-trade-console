import { Interface, ZeroAddress, getAddress } from 'ethers';

// Sources: gang.fun's linked gangfun/cli v0.8.0 (chain.js and abi.js).
// No wallet credentials, signing, HTTP notes, or transaction submission live here.
export const id = 'gang';
export const AGENT_ID = '0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F';
export const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
export const GANG = '0x0c6302401aa5325C2E36F170f52C00B1d220B405';
export const PADS = Object.freeze([
  { id: 'v2', kind: 'v2', address: '0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E' },
  { id: 'soft', kind: 'soft', address: '0x4E6f13c8A453c1b8b4E20b590082bb233a5b80d7' },
  // Independently corroborated by gang.fun/api/health and the official web/.env.example.
  { id: 'soft-315b', kind: 'soft', address: '0x315Ba2e8952D06094CC636b2B84229FA32fb23A7' },
  { id: 'u', kind: 'v2', address: '0xF81C4E51c48466c6025B0165b1Ea0F6978c712cb' },
  { id: 's', kind: 'v2', address: '0x60aee38576035E757deD30fF8db8A8DA476430C1' },
]);

const COMMON_ABI = [
  'function isAgent(address) view returns (bool)',
  'function walletRoom(address,address) view returns (uint256)',
  'function MAX_PER_WALLET() view returns (uint256)',
  'function VIRTUAL_TOKEN() view returns (uint256)',
  'function PROTOCOL_FEE_BPS() view returns (uint256)',
  'function DIVIDEND_TAX_BPS() view returns (uint256)',
  'function PLATFORM_TAX_BPS() view returns (uint256)',
  'function sell(address,uint256,uint256) returns (uint256)',
];
export const V2_ABI = new Interface([
  ...COMMON_ABI,
  'function curves(address) view returns (address creator,address quote,uint128 realQuote,uint128 sold,uint128 gradAmt,uint128 virtualQuote,bool graduated,bool taxed,address pair,address refPair)',
  'function buy(address,uint256,uint256) returns (uint256)',
  'event Buy(address indexed token,address indexed buyer,uint256 quoteIn,uint256 taxDividend,uint256 taxPlatform,uint256 tokensOut,uint256 realQuote)',
  'event Sell(address indexed token,address indexed seller,uint256 tokensIn,uint256 taxDividend,uint256 taxPlatform,uint256 quoteOut,uint256 realQuote)',
]);
// S has no `taxed` tuple field: every token is taxed. The official CLI's V2 alias
// cannot decode this getter and must not be used for registry discovery.
export const S_ABI = new Interface([
  ...V2_ABI.fragments.filter((f) => !(f.type === 'function' && f.name === 'curves')),
  'function curves(address) view returns (address creator,address quote,uint128 realQuote,uint128 sold,uint128 gradAmt,uint128 virtualQuote,bool graduated,address pair,address refPair)',
]);
export const SOFT_ABI = new Interface([
  ...COMMON_ABI,
  'function curves(address) view returns (address creator,uint128 realBnb,uint128 sold,bool graduated,address pair)',
  'function GRADUATION_BNB() view returns (uint256)',
  'function VIRTUAL_BNB() view returns (uint256)',
  'function FEE_BPS() view returns (uint256)',
  'function buy(address,uint256) payable returns (uint256)',
  'function quoteBuy(address,address,uint256) view returns (uint256 tokensOut,uint256 bnbIn,uint256 fee,uint256 refund)',
  'function quoteSell(address,uint256) view returns (uint256 bnbToUser,uint256 fee)',
  'event Buy(address indexed token,address indexed buyer,uint256 bnbIn,uint256 fee,uint256 tokensOut,uint256 realBnb)',
  'event Sell(address indexed token,address indexed seller,uint256 tokensIn,uint256 fee,uint256 bnbOut,uint256 realBnb)',
  'event PaymentDeferred(address indexed to,uint256 amount)',
]);
const ERC20 = new Interface([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
const knownTokens = new Map(); // Identity only; never caches curve or balances.
const BPS = 10000n;
const DEFAULT_VIRTUAL_TOKEN = 1066666666666666666666666667n;
const normalize = (a) => getAddress(String(a).toLowerCase());
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const abiFor = (pad) => pad.kind === 'soft' ? SOFT_ABI : pad.id === 's' ? S_ABI : V2_ABI;
const ceil = (a, b) => {
  if (b <= 0n || a < 0n) throw new Error('GANG_INVALID_CURVE_ARITHMETIC');
  return (a + b - 1n) / b;
};
function fail(code, detail = '') {
  const error = new Error(`${code}${detail ? `: ${detail}` : ''}`);
  error.code = code;
  throw error;
}
async function read(rpc, to, abi, method, args = [], blockTag = 'latest') {
  const result = await rpc.call({ to, data: abi.encodeFunctionData(method, args), blockTag });
  return abi.decodeFunctionResult(method, result);
}

export function matchesUrl(value) {
  try {
    const url = value instanceof URL ? value : new URL(value);
    return url.protocol === 'https:' && ['gang.fun', 'www.gang.fun'].includes(url.hostname.toLowerCase()) &&
      /^\/token\/0x[0-9a-fA-F]{40}\/?$/.test(url.pathname);
  } catch { return false; }
}

async function resolvePad(rpc, token, blockTag) {
  const cached = knownTokens.get(token.toLowerCase());
  if (cached) {
    const raw = await read(rpc, cached.address, abiFor(cached), 'curves', [token], blockTag);
    if (raw[0] !== ZeroAddress) return { pad: cached, raw };
    knownTokens.delete(token.toLowerCase());
    fail('GANG_TOKEN_REGISTRATION_CHANGED');
  }
  const results = await Promise.allSettled(PADS.map(async (pad) => {
    const raw = await read(rpc, pad.address, abiFor(pad), 'curves', [token], blockTag);
    return raw[0] === ZeroAddress ? null : { pad, raw };
  }));
  const found = results.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
  if (found.length > 1) fail('GANG_AMBIGUOUS_TOKEN_REGISTRATION');
  if (!found.length) {
    if (results.every((r) => r.status === 'rejected')) fail('GANG_DISCOVERY_FAILED', 'All known pad reads failed');
    fail('GANG_UNKNOWN_TOKEN', 'Not registered on known V2/Soft/U/S pads; V3/fair-mint are separate routes');
  }
  knownTokens.set(token.toLowerCase(), found[0].pad);
  return found[0];
}

export async function inspect({ rpc, token, wallet, blockTag }) {
  token = normalize(token);
  wallet = normalize(wallet);
  const block = blockTag ?? await rpc.getBlockNumber();
  const startedAt = Date.now();
  const [{ pad, raw }, [totalSupply], [balance], [decimals], [symbol]] = await Promise.all([
    resolvePad(rpc, token, block),
    read(rpc, token, ERC20, 'totalSupply', [], block),
    read(rpc, token, ERC20, 'balanceOf', [wallet], block),
    read(rpc, token, ERC20, 'decimals', [], block),
    read(rpc, token, ERC20, 'symbol', [], block),
  ]);
  if (Number(decimals) !== 18 || totalSupply <= 0n) fail('GANG_UNSUPPORTED_TOKEN_FORMAT');
  const soft = pad.kind === 'soft';
  const curve = soft ? {
    creator: raw[0], raised: raw[1], sold: raw[2], graduated: raw[3], pair: raw[4],
    virtualQuote: null, graduationAmount: null, taxed: false,
  } : {
    creator: raw[0], raised: raw[2], sold: raw[3], graduationAmount: raw[4], virtualQuote: raw[5],
    graduated: raw[6], taxed: pad.id === 's' ? true : raw[7],
    pair: raw[pad.id === 's' ? 7 : 8], refPair: raw[pad.id === 's' ? 8 : 9],
  };
  const quoteToken = soft ? ZeroAddress : normalize(raw[1]);
  if (!soft && quoteToken === ZeroAddress) fail('GANG_INVALID_QUOTE_TOKEN', 'V2 uses ERC20, not payable BNB');
  const padAbi = abiFor(pad);
  const [[eligible], [room], [maxBuy], [allowance], quoteInfo, parameters, code] = await Promise.all([
    read(rpc, pad.address, padAbi, 'isAgent', [wallet], block),
    read(rpc, pad.address, padAbi, 'walletRoom', [token, wallet], block),
    read(rpc, pad.address, padAbi, 'MAX_PER_WALLET', [], block),
    read(rpc, token, ERC20, 'allowance', [wallet, pad.address], block),
    soft ? rpc.getBalance(wallet, block).then((bal) => [18, 'BNB', bal, 0n]) : Promise.all([
      read(rpc, quoteToken, ERC20, 'decimals', [], block).then((r) => Number(r[0])),
      read(rpc, quoteToken, ERC20, 'symbol', [], block).then((r) => r[0]),
      read(rpc, quoteToken, ERC20, 'balanceOf', [wallet], block).then((r) => r[0]),
      read(rpc, quoteToken, ERC20, 'allowance', [wallet, pad.address], block).then((r) => r[0]),
    ]),
    soft ? Promise.all([
      read(rpc, pad.address, SOFT_ABI, 'GRADUATION_BNB', [], block),
      read(rpc, pad.address, SOFT_ABI, 'VIRTUAL_BNB', [], block),
      read(rpc, pad.address, SOFT_ABI, 'VIRTUAL_TOKEN', [], block),
      read(rpc, pad.address, SOFT_ABI, 'FEE_BPS', [], block),
    ]).then(([g, q, v, f]) => ({ graduationAmount: g[0], virtualQuote: q[0], virtualTokens: v[0], feeBps: f[0] })) :
      Promise.all([
        read(rpc, pad.address, padAbi, 'VIRTUAL_TOKEN', [], block),
        (pad.id === 's' || (pad.id === 'u' && curve.taxed)) ? Promise.all([
          read(rpc, pad.address, padAbi, 'DIVIDEND_TAX_BPS', [], block),
          read(rpc, pad.address, padAbi, 'PLATFORM_TAX_BPS', [], block),
        ]).then((rows) => rows.map((r) => r[0])) :
          read(rpc, pad.address, padAbi, 'PROTOCOL_FEE_BPS', [], block).then((r) => [r[0]]),
      ]).then(([v, fs]) => ({ virtualTokens: v[0], feeBps: fs.reduce((a, b) => a + b, 0n), feeComponents: fs })),
    rpc.getCode(pad.address, block),
  ]);
  if (code === '0x') fail('GANG_PAD_HAS_NO_CODE');
  if (room > maxBuy || maxBuy <= 0n || maxBuy > totalSupply) fail('GANG_INVALID_WALLET_CAP');
  if (!soft && (parameters.virtualTokens !== DEFAULT_VIRTUAL_TOKEN || parameters.feeBps !== 100n)) {
    fail('GANG_UNSUPPORTED_CURVE_PARAMETERS', 'On-chain constants differ from reviewed V2 math');
  }
  if (!soft && parameters.feeComponents.length === 2 && parameters.feeComponents.some((f) => f !== 50n)) {
    fail('GANG_UNSUPPORTED_CURVE_PARAMETERS', 'U/S split fees differ from reviewed 50 + 50 bps');
  }
  if (soft) {
    curve.graduationAmount = parameters.graduationAmount;
    curve.virtualQuote = parameters.virtualQuote;
    if (parameters.virtualTokens !== DEFAULT_VIRTUAL_TOKEN || parameters.feeBps !== 100n) {
      fail('GANG_UNSUPPORTED_CURVE_PARAMETERS', 'Soft constants differ from verified inverse quote');
    }
  }
  return {
    platform: id, token, wallet, spender: normalize(pad.address), pad: pad.id, kind: pad.kind,
    quoteToken, quoteDecimals: Number(quoteInfo[0]), quoteSymbol: quoteInfo[1], quoteBalance: quoteInfo[2],
    quoteAllowance: quoteInfo[3], buyAllowance: quoteInfo[3], allowance, sellAllowance: allowance,
    status: curve.graduated ? 'graduated' : 'curve', migrated: curve.graduated,
    gate: AGENT_ID, eligible: Boolean(eligible), totalSupply, balance, decimals: Number(decimals), symbol,
    maxBuyTokens: maxBuy, remainingBuyTokens: room, virtualTokens: parameters.virtualTokens,
    feeBps: parameters.feeBps ?? 100n, feeComponents: parameters.feeComponents ?? [100n],
    curve, blockNumber: block, observedAt: startedAt,
    metadata: {
      sources: ['https://gang.fun', 'https://gang.fun/api/health', 'https://github.com/gangfun/cli/blob/main/src/chain.js'],
      mathVersion: soft ? 'soft-onchain-quote' : 'gang-cli-0.8.0-v2', paymentKind: soft ? 'native' : 'erc20',
      wrapSupported: !soft && eq(quoteToken, WBNB), notes: false,
    },
  };
}

const feeFor = (state, gross) => (state.feeComponents ?? [BigInt(state.feeBps)])
  .reduce((fee, component) => fee + gross * BigInt(component) / BPS, 0n);

function checkState(state, token, wallet, side) {
  if (!state || state.platform !== id || !eq(state.token, token) || !eq(state.wallet, wallet)) fail('GANG_STATE_MISMATCH');
  const pad = PADS.find((p) => p.id === state.pad && eq(p.address, state.spender));
  if (!pad || pad.kind !== state.kind) fail('GANG_UNVERIFIED_PAD');
  if (state.migrated || state.curve.graduated) fail('GANG_GRADUATED', 'Curve closed; no automatic DEX fallback');
  if (!state.eligible) fail('GANG_NO_AGENT_ID');
  if (side === 'buy' && state.remainingBuyTokens <= 0n) fail('GANG_WALLET_CAP_REACHED');
  return pad;
}

/** BigInt arithmetic mirroring the reviewed V2 constant-product/rounding semantics. */
export function v2QuoteBuy(state, amountIn) {
  amountIn = BigInt(amountIn);
  if (amountIn <= 0n) fail('GANG_ZERO_AMOUNT');
  const c = state.curve, v = BigInt(state.virtualTokens), f = BigInt(state.feeBps);
  const reserveQ = c.virtualQuote + c.raised, reserveT = v - c.sold, k = c.virtualQuote * v;
  if (reserveT <= 0n || reserveQ <= 0n || f < 0n || f >= BPS) fail('GANG_INVALID_CURVE');
  const graduationRoom = c.graduationAmount > c.raised ? c.graduationAmount - c.raised : 0n;
  if (graduationRoom === 0n) fail('GANG_GRADUATION_PENDING');
  let spent = amountIn, fee = feeFor(state, amountIn), net = amountIn - fee;
  const adjustNet = (targetNet) => {
    spent = ceil(targetNet * BPS, BPS - f);
    if (spent > amountIn) spent = amountIn;
    fee = feeFor(state, spent);
    net = spent - fee;
  };
  if (net > graduationRoom) {
    adjustNet(graduationRoom);
    if (net > graduationRoom) net = graduationRoom;
  }
  let amountOut = reserveT - ceil(k, reserveQ + net);
  if (amountOut > state.remainingBuyTokens) {
    amountOut = state.remainingBuyTokens;
    if (amountOut >= reserveT) fail('GANG_INVALID_WALLET_CAP');
    adjustNet(ceil(k, reserveT - amountOut) - reserveQ);
  }
  if (amountOut <= 0n) fail('GANG_NO_OUTPUT');
  return { amountOut, spent, fee, refund: amountIn - spent, quotePath: 'V2-constant-product', deterministic: true };
}

export function v2QuoteSell(state, amountIn) {
  amountIn = BigInt(amountIn);
  if (amountIn <= 0n) fail('GANG_ZERO_AMOUNT');
  if (amountIn > state.balance) fail('GANG_INSUFFICIENT_TOKEN_BALANCE');
  const c = state.curve, v = BigInt(state.virtualTokens), f = BigInt(state.feeBps);
  if (amountIn > c.sold) fail('GANG_INVALID_SELL_AMOUNT');
  const gross = c.virtualQuote + c.raised - ceil(c.virtualQuote * v, v - c.sold + amountIn);
  if (gross <= 0n || gross > c.raised) fail('GANG_INSUFFICIENT_CURVE_RESERVE');
  const fee = feeFor(state, gross);
  return { amountOut: gross - fee, fee, spent: amountIn, refund: 0n, quotePath: 'V2-constant-product', deterministic: true };
}

export async function quoteBuy({ rpc, token, wallet, amountIn, state }) {
  const pad = checkState(state, token, wallet, 'buy');
  if (state.kind !== 'soft') return v2QuoteBuy(state, amountIn);
  if (BigInt(amountIn) <= 0n) fail('GANG_ZERO_AMOUNT');
  const q = await read(rpc, pad.address, SOFT_ABI, 'quoteBuy', [token, wallet, amountIn]);
  if (q[0] <= 0n) fail('GANG_NO_OUTPUT');
  // Soft's bnbIn is net reserve input, unlike V2's gross spent field.
  return { amountOut: q[0], spent: q[1] + q[2], netSpend: q[1], fee: q[2], refund: q[3], quotePath: 'onchain-quoteBuy' };
}

export async function quoteSell({ rpc, token, wallet, amountIn, state }) {
  const pad = checkState(state, token, wallet, 'sell');
  if (state.kind !== 'soft') return v2QuoteSell(state, amountIn);
  if (BigInt(amountIn) <= 0n) fail('GANG_ZERO_AMOUNT');
  if (BigInt(amountIn) > state.balance) fail('GANG_INSUFFICIENT_TOKEN_BALANCE');
  const q = await read(rpc, pad.address, SOFT_ABI, 'quoteSell', [token, amountIn]);
  if (q[0] <= 0n) fail('GANG_NO_OUTPUT');
  return { amountOut: q[0], fee: q[1], spent: BigInt(amountIn), refund: 0n, quotePath: 'onchain-quoteSell' };
}

// Returns a conservative inverse estimate. Soft estimates are checked by its on-chain quote.
export function estimateInputForTokens({ state, amountOut }) {
  if (state.kind === 'soft' && (state.virtualTokens == null || state.curve.virtualQuote == null)) return null;
  amountOut = BigInt(amountOut);
  if (amountOut <= 0n || amountOut > state.remainingBuyTokens) fail('GANG_TARGET_EXCEEDS_ROOM');
  const c = state.curve, v = BigInt(state.virtualTokens), f = BigInt(state.feeBps);
  const targetT = v - c.sold - amountOut;
  if (targetT <= 0n) fail('GANG_TARGET_EXCEEDS_CURVE');
  const net = ceil(c.virtualQuote * v, targetT) - (c.virtualQuote + c.raised);
  if (net <= 0n || net > c.graduationAmount - c.raised) fail('GANG_TARGET_EXCEEDS_GRADUATION');
  return ceil(net * BPS, BPS - f);
}

export async function quoteExactOutput({ rpc, token, wallet, amountOut, state }) {
  checkState(state, token, wallet, 'buy');
  const amountIn = estimateInputForTokens({ state, amountOut });
  if (amountIn === null) return null;
  const q = await quoteBuy({ rpc, token, wallet, amountIn, state });
  if (q.amountOut < BigInt(amountOut)) fail('GANG_EXACT_OUTPUT_QUOTE_SHORT');
  return { amountIn, ...q };
}

export async function buildBuy({ token, wallet, amountIn, minAmountOut, state }) {
  const pad = checkState(state, token, wallet, 'buy');
  amountIn = BigInt(amountIn); minAmountOut = BigInt(minAmountOut);
  if (amountIn <= 0n || minAmountOut < 0n) fail('GANG_INVALID_TRADE_AMOUNT');
  if (minAmountOut > state.remainingBuyTokens) fail('GANG_TARGET_EXCEEDS_ROOM');
  return state.kind === 'soft' ?
    { to: normalize(pad.address), value: amountIn, data: SOFT_ABI.encodeFunctionData('buy', [token, minAmountOut]) } :
    { to: normalize(pad.address), value: 0n, data: V2_ABI.encodeFunctionData('buy', [token, amountIn, minAmountOut]) };
}

export async function buildSell({ token, wallet, amountIn, minAmountOut, state }) {
  const pad = checkState(state, token, wallet, 'sell');
  amountIn = BigInt(amountIn); minAmountOut = BigInt(minAmountOut);
  if (amountIn <= 0n || amountIn > state.balance || minAmountOut < 0n) fail('GANG_INVALID_TRADE_AMOUNT');
  return { to: normalize(pad.address), value: 0n, data: abiFor(pad).encodeFunctionData('sell', [token, amountIn, minAmountOut]) };
}

/** Normalize the single verified pad trade event; fees are in quote units.
 * Buy event quoteIn/bnbIn is NET reserve input; sell event quoteOut/bnbOut is NET
 * recipient output. Receipts alone do not expose the submitted buy value/refund.
 */
export function settlement({ receipt, wallet, token, side, state }) {
  if (!['buy', 'sell'].includes(side)) fail('GANG_INVALID_TRADE_SIDE');
  if (!state || state.platform !== id || !eq(state.token, token) || !eq(state.wallet, wallet)) fail('GANG_STATE_MISMATCH');
  const pad = PADS.find((p) => p.id === state.pad && eq(p.address, state.spender) && p.kind === state.kind);
  if (!pad) fail('GANG_UNVERIFIED_PAD');
  if (!receipt || ![1, 1n, '1', '0x1', true].includes(receipt.status)) fail('GANG_RECEIPT_NOT_SUCCESS');
  if (receipt.to && !eq(receipt.to, pad.address)) fail('GANG_RECEIPT_TARGET_MISMATCH');
  const abi = abiFor(pad), wanted = side === 'buy' ? 'Buy' : 'Sell';
  const events = [];
  for (const log of receipt.logs ?? []) {
    if (!eq(log.address, pad.address) || log.removed) continue;
    let event;
    try { event = abi.parseLog(log); } catch { continue; }
    if (!event) continue;
    if (event.name === 'PaymentDeferred' && eq(event.args[0], wallet) && event.args[1] > 0n) {
      fail('GANG_PAYMENT_DEFERRED', 'Native payout/refund was credited for withdrawal, not transferred');
    }
    if (event.name === wanted && eq(event.args[0], token) && eq(event.args[1], wallet)) events.push(event);
  }
  if (!events.length) fail('GANG_SETTLEMENT_EVENT_MISSING');
  if (events.length !== 1) fail('GANG_SETTLEMENT_EVENT_AMBIGUOUS');
  const a = events[0].args, soft = pad.kind === 'soft';
  const fee = soft ? a[3] : a[3] + a[4];
  const amountIn = side === 'buy' ? a[2] + fee : a[2];
  const amountOut = soft ? a[4] : a[5];
  if (amountIn <= 0n || amountOut <= 0n) fail('GANG_INVALID_SETTLEMENT_AMOUNT');
  return { amountIn, amountOut, fee };
}

export function clearIdentityCache() { knownTokens.clear(); }
