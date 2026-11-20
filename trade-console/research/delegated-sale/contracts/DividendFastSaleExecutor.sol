// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;
import {FastSaleExecutor} from "./FastSaleExecutor.sol";

/// @notice Separate deployment for tokens that run distribution logic during a sale.
contract DividendFastSaleExecutor is FastSaleExecutor {
    uint256 public constant DIVIDEND_ITEM_GAS = 1_400_000;

    constructor(address f, bytes32 factoryHash_, bytes32 pairHash_, address w)
        FastSaleExecutor(f, factoryHash_, pairHash_, w) {}

    // executeOne still checks the original trigger, plan, primary pool and holder's minimum.
    function executeDividendBatch(bytes32[] calldata ids) external nonReentrant {
        if (ids.length == 0 || ids.length > 8) revert BadBatch();
        for (uint256 i; i < ids.length; ++i) {
            if (gasleft() < DIVIDEND_ITEM_GAS + DIVIDEND_ITEM_GAS / 63 + 60_000) {
                emit BatchDeferred(i);
                break;
            }
            bytes memory input = abi.encodeCall(this.executeOne, (ids[i], msg.sender));
            bool ok;
            bytes4 reason;
            assembly ("memory-safe") {
                ok := call(DIVIDEND_ITEM_GAS, address(), 0, add(input, 32), mload(input), 0, 0)
                if and(iszero(ok), gt(returndatasize(), 3)) {
                    returndatacopy(0, 0, 4)
                    reason := mload(0)
                }
            }
            if (!ok) emit ItemFailed(ids[i], reason == bytes4(0) ? ItemError.selector : reason);
        }
    }
}
