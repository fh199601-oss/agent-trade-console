// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ILaunch {
    function token() external view returns (address);
    function wrappedNative() external view returns (address);
    function factory() external view returns (address);
    function pair() external view returns (address);
    function phase() external view returns (uint8);
}
interface IToken is IERC20 { function tradingOpen() external view returns (bool); }
interface IWrapped is IERC20 {
    function deposit() external payable;
    function withdraw(uint256) external;
}
interface IFactory { function getPair(address,address) external view returns (address); }
interface IPair {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112,uint112,uint32);
    function swap(uint256,uint256,address,bytes calldata) external;
}

/// @notice Offline research only. Intentionally cannot deploy on BSC chain ID 56.
/// @dev One immutable, reviewed launch / primary V2 pair per instance. No admin,
///      upgrade, arbitrary calls, fee extraction, recipient override or asset rescue.
///      This is NOT a production audit or a generic token/DEX adapter.
contract ResearchExecutor is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant MAX_BATCH = 64;
    uint256 public constant ITEM_GAS = 450_000;
    uint256 public constant TAIL_GAS = 55_000;
    ILaunch public immutable launch;
    IToken public immutable token;
    IWrapped public immutable quote;
    address public immutable factory;
    address public immutable primaryPair;
    bytes32 public immutable pairCodeHash;
    bytes32 private immutable launchHash;
    bytes32 private immutable tokenHash;
    bytes32 private immutable quoteHash;
    bytes32 private immutable factoryHash;

    enum State { Missing, Active, Filled, Cancelled }
    struct Plan {
        address owner;
        address trigger;
        uint112 amount;
        uint128 minOut;
        uint48 notBefore;
        uint48 deadline;
        State state;
        bool paused;
        bool nativeOutput;
        bool allowWrappedFallback;
    }
    mapping(bytes32 => Plan) public plans;
    mapping(address => uint256) public nextNonce;
    error ResearchOnly();
    error InvalidPlan();
    error NotOwner();
    error NotActive();
    error Paused();
    error WrongTrigger();
    error OutsideWindow();
    error WrongPrimary();
    error NotOpen();
    error OnlySelf();
    error UnsupportedTransfer();
    error MinimumNotMet();
    error NoLiquidity();
    error NativeRejected();
    error BadBatch();
    error UnknownItemFailure();
    event Registered(bytes32 indexed id, address indexed owner, address trigger, uint256 amount, uint256 minOut);
    event Cancelled(bytes32 indexed id);
    event PauseChanged(bytes32 indexed id, bool paused);
    event Sold(bytes32 indexed id, address indexed owner, uint256 amount, uint256 output, bool nativeOutput);
    event ItemFailed(bytes32 indexed id, bytes4 reason);
    event BatchDeferred(uint256 nextIndex);

    constructor(address launch_, address expectedPair_, bytes32 expectedPairHash_) {
        if (block.chainid != 31337) revert ResearchOnly();
        if (launch_.code.length == 0 || expectedPair_ == address(0) || expectedPairHash_ == bytes32(0)) revert WrongPrimary();
        launch = ILaunch(launch_);
        address t = launch.token();
        address q = launch.wrappedNative();
        address f = launch.factory();
        if (t.code.length == 0 || q.code.length == 0 || f.code.length == 0 || t == q) revert WrongPrimary();
        token = IToken(t);
        quote = IWrapped(q);
        factory = f;
        primaryPair = expectedPair_;
        pairCodeHash = expectedPairHash_;
        launchHash = launch_.codehash;
        tokenHash = t.codehash;
        quoteHash = q.codehash;
        factoryHash = f.codehash;
    }

    // Only the holder can register. ERC20 approve alone grants no executable plan.
    function registerPlan(uint112 amount, uint128 minOut, uint48 notBefore, uint48 deadline, address trigger, bool nativeOutput, bool allowWrappedFallback)
        external nonReentrant returns (bytes32 id)
    {
        if (amount == 0 || minOut == 0 || trigger == address(0) || deadline <= block.timestamp ||
            deadline > block.timestamp + 7 days || notBefore > deadline || (!nativeOutput && allowWrappedFallback)) revert InvalidPlan();
        id = keccak256(abi.encode(block.chainid, address(this), msg.sender, nextNonce[msg.sender]++));
        plans[id] = Plan(msg.sender, trigger, amount, minOut, notBefore, deadline, State.Active, false, nativeOutput, allowWrappedFallback);
        emit Registered(id, msg.sender, trigger, amount, minOut);
    }

    function cancel(bytes32 id) external nonReentrant {
        Plan storage p = plans[id];
        if (p.owner != msg.sender) revert NotOwner();
        if (p.state != State.Active) revert NotActive();
        p.state = State.Cancelled;
        emit Cancelled(id);
    }

    function setPaused(bytes32 id, bool paused) external nonReentrant {
        Plan storage p = plans[id];
        if (p.owner != msg.sender) revert NotOwner();
        if (p.state != State.Active) revert NotActive();
        p.paused = paused;
        emit PauseChanged(id, paused);
    }

    function verifyVenue() public view returns (bool tokenIs0) {
        if (address(launch).codehash != launchHash || address(token).codehash != tokenHash ||
            address(quote).codehash != quoteHash || factory.codehash != factoryHash || primaryPair.codehash != pairCodeHash)
            revert WrongPrimary();
        if (launch.phase() != 1 || !token.tradingOpen()) revert NotOpen();
        if (launch.pair() != primaryPair || launch.token() != address(token) || launch.factory() != factory ||
            launch.wrappedNative() != address(quote) || IFactory(factory).getPair(address(token), address(quote)) != primaryPair)
            revert WrongPrimary();
        IPair p = IPair(primaryPair);
        if (p.factory() != factory) revert WrongPrimary();
        address t0 = p.token0();
        address t1 = p.token1();
        tokenIs0 = t0 == address(token);
        if (!(tokenIs0 && t1 == address(quote) || t0 == address(quote) && t1 == address(token))) revert WrongPrimary();
    }

    function executeBatch(bytes32[] calldata ids) external nonReentrant {
        if (ids.length == 0 || ids.length > MAX_BATCH) revert BadBatch();
        bool tokenIs0 = verifyVenue();
        for (uint256 i; i < ids.length; ++i) {
            // Keep enough gas to forward the whole cap under EIP-150 and report
            // a deferred tail. An underfunded batch must not undo earlier sales.
            if (gasleft() < ITEM_GAS + ITEM_GAS / 63 + TAIL_GAS) {
                emit BatchDeferred(i);
                break;
            }
            bytes memory input = abi.encodeCall(this.executeOne, (ids[i], msg.sender, tokenIs0));
            bool ok;
            bytes4 reason;
            // Do not copy arbitrary return data: a token can otherwise grief
            // the outer batch with a huge revert payload, even with a gas cap.
            assembly ("memory-safe") {
                ok := call(ITEM_GAS, address(), 0, add(input, 32), mload(input), 0, 0)
                if iszero(ok) {
                    if gt(returndatasize(), 3) {
                        returndatacopy(0, 0, 4)
                        reason := mload(0)
                    }
                }
            }
            if (!ok) emit ItemFailed(ids[i], reason == bytes4(0) ? UnknownItemFailure.selector : reason);
        }
    }

    // Every item is its own reverting call frame. A failed transfer, minimum,
    // or settlement restores THIS item's plan, token transfer and pair swap.
    function executeOne(bytes32 id, address caller, bool tokenIs0) external {
        if (msg.sender != address(this) || !_reentrancyGuardEntered()) revert OnlySelf();
        Plan storage p = plans[id];
        if (p.state != State.Active) revert NotActive();
        if (p.paused) revert Paused();
        if (caller != p.trigger) revert WrongTrigger();
        if (block.timestamp < p.notBefore || block.timestamp > p.deadline) revert OutsideWindow();
        (uint112 r0, uint112 r1,) = IPair(primaryPair).getReserves();
        (uint256 reserveIn, uint256 reserveOut) = tokenIs0 ? (r0, r1) : (r1, r0);
        if (reserveIn == 0 || reserveOut == 0) revert NoLiquidity();
        uint256 inWithFee = uint256(p.amount) * 9975;
        uint256 output = inWithFee * reserveOut / (reserveIn * 10000 + inWithFee);
        if (output == 0 || output < p.minOut) revert MinimumNotMet();
        p.state = State.Filled;
        uint256 beforeIn = token.balanceOf(primaryPair);
        IERC20(address(token)).safeTransferFrom(p.owner, primaryPair, p.amount);
        if (token.balanceOf(primaryPair) != beforeIn + p.amount) revert UnsupportedTransfer();
        address recipient = p.nativeOutput ? address(this) : p.owner;
        uint256 beforeOut = quote.balanceOf(recipient);
        IPair(primaryPair).swap(tokenIs0 ? 0 : output, tokenIs0 ? output : 0, recipient, "");
        if (quote.balanceOf(recipient) != beforeOut + output) revert UnsupportedTransfer();
        bool nativePaid;
        if (p.nativeOutput) {
            quote.withdraw(output);
            address owner = p.owner;
            assembly ("memory-safe") { nativePaid := call(50000, owner, output, 0, 0, 0, 0) }
            // A contract wallet rejecting BNB gets exactly the same amount of
            // WBNB, to the same owner. This fallback is part of the owner's plan.
            if (!nativePaid) {
                if (!p.allowWrappedFallback) revert NativeRejected();
                uint256 beforeOwner = quote.balanceOf(owner);
                quote.deposit{value: output}();
                IERC20(address(quote)).safeTransfer(owner, output);
                if (quote.balanceOf(owner) != beforeOwner + output) revert UnsupportedTransfer();
            }
        }
        emit Sold(id, p.owner, p.amount, output, nativePaid);
    }

    receive() external payable {
        if (msg.sender != address(quote) || !_reentrancyGuardEntered()) revert OnlySelf();
    }
}
