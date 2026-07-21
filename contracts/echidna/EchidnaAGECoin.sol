// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../AGECoin.sol";

/// Echidna fuzzing harness — test tooling only, never deployed for
/// real. Throws random sequences of stake/unstake/claim/transfer
/// calls at a real AGECoin instance and checks core accounting
/// invariants hold no matter what order or amounts are used.
///
/// This harness deploys AGECoin (making itself the fee-exempt owner
/// by default), then immediately strips its own fee exemption so
/// fuzzing actually exercises the fee-bearing transfer path — the
/// interesting logic — rather than only the free owner path.
///
/// Time-dependent behavior (halving, circuit breaker escalation) is
/// covered separately by the Hardhat suite's explicit time-travel
/// tests, since Echidna doesn't warp time the way some other fuzzers
/// do — this harness focuses on amount/sequence fuzzing instead.
contract EchidnaAGECoin {
    AGECoin public token;
    address constant OTHER = address(0xB0B);

    constructor() {
        token = new AGECoin(address(0xC0FFEE), address(0xCA11AB1E));
        token.setFeeExempt(address(this), false);
    }

    function fuzzStake(uint256 amount) public {
        uint256 bal = token.balanceOf(address(this));
        if (bal == 0) return;
        amount = (amount % bal) + 1;
        try token.stake(amount) {} catch {}
    }

    function fuzzUnstake(uint256 amount) public {
        uint256 staked = token.stakedBalance(address(this));
        if (staked == 0) return;
        amount = (amount % staked) + 1;
        try token.unstake(amount) {} catch {}
    }

    function fuzzClaim() public {
        try token.claimReward() {} catch {}
    }

    function fuzzTransferToOther(uint256 amount) public {
        uint256 bal = token.balanceOf(address(this));
        if (bal == 0) return;
        amount = (amount % bal) + 1;
        try token.transfer(OTHER, amount) {} catch {}
    }

    // ---- Invariants: must hold after every single call, in any order ----

    function echidna_total_supply_never_changes() public view returns (bool) {
        return token.totalSupply() == token.TOTAL_SUPPLY();
    }

    function echidna_contract_covers_obligations() public view returns (bool) {
        uint256 contractBal = token.balanceOf(address(token));
        uint256 obligations = token.totalStaked() + token.stakingPool();
        return contractBal >= obligations;
    }

    function echidna_staked_never_exceeds_supply() public view returns (bool) {
        return token.totalStaked() <= token.TOTAL_SUPPLY();
    }

    function echidna_staking_pool_never_exceeds_supply() public view returns (bool) {
        return token.stakingPool() <= token.TOTAL_SUPPLY();
    }
}
