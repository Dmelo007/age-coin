// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
//  AGE COIN — A.G.E. CO.
//  Master Yourself. Master Relationships. Master Legacy.
//
//  ERC-20 token with automatic impact fees and staking.
//  - Total supply: 10,000,000 AGE (fixed, no minting after launch)
//  - 0.5% of every transfer -> Carbon Offset wallet
//  - 1.0% of every transfer -> Community Fund wallet
//  - Holders can stake AGE in the contract (no fees on staking)
//
//  Built on OpenZeppelin v5 audited libraries.
// ============================================================

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract AGECoin is ERC20, Ownable, ReentrancyGuard {

    // ---------------- TOKENOMICS ----------------
    uint256 public constant TOTAL_SUPPLY = 10_000_000 * 1e18;

    // ---------------- IMPACT FEES ----------------
    // Fees are in basis points (1 bp = 0.01%)
    uint256 public constant CARBON_FEE = 50;      // 0.50%
    uint256 public constant TREASURY_FEE = 100;   // 1.00%
    uint256 public constant FEE_DENOMINATOR = 10_000;

    address public carbonOffsetWallet;
    address public communityFund;

    // Addresses that transfer without fees (owner, this contract,
    // and the impact wallets themselves).
    mapping(address => bool) public feeExempt;

    // ---------------- STAKING ----------------
    mapping(address => uint256) public stakedBalance;
    mapping(address => uint256) public stakeStart;
    uint256 public totalStaked;

    // ---------------- EVENTS ----------------
    event ImpactFeesPaid(address indexed from, uint256 carbonAmount, uint256 treasuryAmount);
    event Staked(address indexed account, uint256 amount);
    event Unstaked(address indexed account, uint256 amount);
    event ImpactWalletsUpdated(address carbonOffsetWallet, address communityFund);
    event FeeExemptionSet(address indexed account, bool exempt);

    constructor(address _carbonOffsetWallet, address _communityFund)
        ERC20("AGE Coin", "AGE")
        Ownable(msg.sender)
    {
        require(_carbonOffsetWallet != address(0), "AGE: carbon wallet is zero address");
        require(_communityFund != address(0), "AGE: community fund is zero address");

        carbonOffsetWallet = _carbonOffsetWallet;
        communityFund = _communityFund;

        feeExempt[msg.sender] = true;
        feeExempt[address(this)] = true;
        feeExempt[_carbonOffsetWallet] = true;
        feeExempt[_communityFund] = true;

        _mint(msg.sender, TOTAL_SUPPLY);
    }

    // ---------------- TRANSFER LOGIC ----------------
    // Every normal transfer automatically routes 0.5% to carbon
    // offset and 1.0% to the community fund. Minting, burning,
    // and fee-exempt addresses transfer at full value.
    function _update(address from, address to, uint256 value) internal override {
        bool skipFees =
            from == address(0) ||          // minting
            to == address(0) ||            // burning
            feeExempt[from] ||
            feeExempt[to];

        if (skipFees || value == 0) {
            super._update(from, to, value);
            return;
        }

        uint256 carbonAmount = (value * CARBON_FEE) / FEE_DENOMINATOR;
        uint256 treasuryAmount = (value * TREASURY_FEE) / FEE_DENOMINATOR;
        uint256 sendAmount = value - carbonAmount - treasuryAmount;

        super._update(from, carbonOffsetWallet, carbonAmount);
        super._update(from, communityFund, treasuryAmount);
        super._update(from, to, sendAmount);

        emit ImpactFeesPaid(from, carbonAmount, treasuryAmount);
    }

    // ---------------- STAKING ----------------
    // Staking moves tokens into the contract (fee-free) and
    // records the amount and start time. No lock-up: holders
    // can unstake at any time.
    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, "AGE: cannot stake zero");

        _transfer(msg.sender, address(this), amount);

        if (stakedBalance[msg.sender] == 0) {
            stakeStart[msg.sender] = block.timestamp;
        }
        stakedBalance[msg.sender] += amount;
        totalStaked += amount;

        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external nonReentrant {
        require(amount > 0, "AGE: cannot unstake zero");
        require(stakedBalance[msg.sender] >= amount, "AGE: unstake exceeds staked balance");

        stakedBalance[msg.sender] -= amount;
        totalStaked -= amount;
        if (stakedBalance[msg.sender] == 0) {
            stakeStart[msg.sender] = 0;
        }

        _transfer(address(this), msg.sender, amount);

        emit Unstaked(msg.sender, amount);
    }

    /// How long an account's current stake has been active, in seconds.
    function stakingDuration(address account) external view returns (uint256) {
        if (stakeStart[account] == 0) return 0;
        return block.timestamp - stakeStart[account];
    }

    // ---------------- ADMIN ----------------
    function setImpactWallets(address _carbonOffsetWallet, address _communityFund) external onlyOwner {
        require(_carbonOffsetWallet != address(0), "AGE: carbon wallet is zero address");
        require(_communityFund != address(0), "AGE: community fund is zero address");

        feeExempt[carbonOffsetWallet] = false;
        feeExempt[communityFund] = false;

        carbonOffsetWallet = _carbonOffsetWallet;
        communityFund = _communityFund;

        feeExempt[_carbonOffsetWallet] = true;
        feeExempt[_communityFund] = true;

        emit ImpactWalletsUpdated(_carbonOffsetWallet, _communityFund);
    }

    function setFeeExempt(address account, bool exempt) external onlyOwner {
        feeExempt[account] = exempt;
        emit FeeExemptionSet(account, exempt);
    }
}
