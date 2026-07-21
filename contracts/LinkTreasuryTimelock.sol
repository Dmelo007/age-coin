// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
//  A.G.E. CO. — LINK TREASURY TIMELOCK
//
//  Holds an ERC-20 token (LINK) and releases the entire balance
//  to a fixed beneficiary only once block.timestamp >= releaseTime.
//  There is no owner, no admin override, and no early-withdrawal
//  path of any kind — once deployed, nobody (including A.G.E. CO.
//  itself) can move these funds before the release time. This is
//  what makes the lock code-enforced rather than a written promise.
// ============================================================

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract LinkTreasuryTimelock {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public immutable beneficiary;
    uint256 public immutable releaseTime;

    event Released(uint256 amount, address indexed to);

    constructor(IERC20 _token, address _beneficiary, uint256 _releaseTime) {
        require(address(_token) != address(0), "AGE: token is zero address");
        require(_beneficiary != address(0), "AGE: beneficiary is zero address");
        require(_releaseTime > block.timestamp, "AGE: release time must be in the future");
        token = _token;
        beneficiary = _beneficiary;
        releaseTime = _releaseTime;
    }

    /// Anyone may call this — funds always go to the fixed beneficiary,
    /// never to the caller. Safe to call multiple times if additional
    /// funds arrive after the first release.
    function release() external {
        require(block.timestamp >= releaseTime, "AGE: still locked");
        uint256 amount = token.balanceOf(address(this));
        require(amount > 0, "AGE: nothing to release");
        token.safeTransfer(beneficiary, amount);
        emit Released(amount, beneficiary);
    }
}
