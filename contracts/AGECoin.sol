// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
//  AGE COIN — A.G.E. CO.
//  Master Yourself. Master Relationships. Master Legacy.
//
//  ERC-20 token with automatic impact fees and self-funding staking.
//  - Total supply: 10,000,000 AGE (fixed, no minting after launch)
//  - 0.5% of every transfer -> Carbon Offset wallet
//  - 1.0% of every transfer -> Community Fund wallet
//  - 0.2% of every transfer -> Staking reward pool
//  - Holders can stake AGE in the contract (no fees on staking)
//  - Staking rewards are funded entirely by the 0.2% fee pool above,
//    never minted, and can never exceed what the pool actually holds.
//  - The reward rate halves every 2 years and requires no manual
//    "start a new period" step — it is a pure function of time.
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
    uint256 public constant STAKING_FEE = 20;     // 0.20%
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

    // ---------------- STAKING REWARDS ----------------
    // Funded solely by STAKING_FEE revenue. Never minted. Reward
    // rate halves every 2 years, computed purely from elapsed time
    // (no manual funding calls needed). Actual payouts are always
    // capped by what's really sitting in stakingPool, so this can
    // never pay out more than it has actually collected.
    uint256 public immutable deployTime;
    uint256 public constant HALVING_PERIOD = 730 days;
    // Emission ceiling: at most ~200,000 AGE/year before the first
    // halving, IF the pool holds enough. Real payout is also capped
    // by actual fee revenue collected (see rewardPerToken below).
    uint256 public immutable INITIAL_REWARD_RATE;

    uint256 public stakingPool;
    uint256 public rewardPerTokenStored;
    uint256 public lastUpdateTime;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    // ---------------- EVENTS ----------------
    event ImpactFeesPaid(address indexed from, uint256 carbonAmount, uint256 treasuryAmount, uint256 stakingAmount);
    event Staked(address indexed account, uint256 amount);
    event Unstaked(address indexed account, uint256 amount);
    event RewardClaimed(address indexed account, uint256 amount);
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

        deployTime = block.timestamp;
        lastUpdateTime = block.timestamp;
        INITIAL_REWARD_RATE = uint256(200_000 * (10 ** 18)) / 365 days;

        _mint(msg.sender, TOTAL_SUPPLY);
    }

    // ---------------- TRANSFER LOGIC ----------------
    // Every normal transfer automatically routes 0.5% to carbon
    // offset, 1.0% to the community fund, and 0.2% to the staking
    // reward pool. Minting, burning, and fee-exempt addresses
    // transfer at full value.
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
        uint256 stakingAmount = (value * STAKING_FEE) / FEE_DENOMINATOR;
        uint256 sendAmount = value - carbonAmount - treasuryAmount - stakingAmount;

        super._update(from, carbonOffsetWallet, carbonAmount);
        super._update(from, communityFund, treasuryAmount);
        super._update(from, address(this), stakingAmount);
        super._update(from, to, sendAmount);

        stakingPool += stakingAmount;

        emit ImpactFeesPaid(from, carbonAmount, treasuryAmount, stakingAmount);
    }

    // ---------------- STAKING REWARD ACCOUNTING ----------------
    // The reward rate in effect at a given timestamp, halving every
    // HALVING_PERIOD seconds since deployment.
    function rewardRateAt(uint256 timestamp) public view returns (uint256) {
        if (timestamp <= deployTime) return INITIAL_REWARD_RATE;
        uint256 halvings = (timestamp - deployTime) / HALVING_PERIOD;
        if (halvings >= 64) return 0;
        return INITIAL_REWARD_RATE >> halvings;
    }

    // How many reward tokens would accrue since lastUpdateTime,
    // capped by what stakingPool actually holds. Uses the rate in
    // effect at the start of the interval; if a halving boundary is
    // crossed mid-interval, the new lower rate takes full effect
    // starting from the next checkpoint. This is a deliberate,
    // bounded simplification rather than exact piecewise integration.
    function _pendingAccrual() internal view returns (uint256 accrued) {
        if (totalStaked == 0 || block.timestamp <= lastUpdateTime) {
            return 0;
        }
        uint256 elapsed = block.timestamp - lastUpdateTime;
        uint256 rate = rewardRateAt(lastUpdateTime);
        accrued = rate * elapsed;
        if (accrued > stakingPool) {
            accrued = stakingPool;
        }
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) return rewardPerTokenStored;
        uint256 accrued = _pendingAccrual();
        return rewardPerTokenStored + (accrued * 1e18) / totalStaked;
    }

    function earned(address account) public view returns (uint256) {
        return rewards[account] +
            (stakedBalance[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / 1e18;
    }

    function _updateReward(address account) internal {
        uint256 accrued = _pendingAccrual();
        if (accrued > 0) {
            stakingPool -= accrued;
            rewardPerTokenStored += (accrued * 1e18) / totalStaked;
        }
        lastUpdateTime = block.timestamp;
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
    }

    // ---------------- STAKING ----------------
    // Staking moves tokens into the contract (fee-free) and
    // records the amount and start time. No lock-up: holders
    // can unstake at any time. Rewards accrue continuously and
    // are claimed separately via claimReward().
    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, "AGE: cannot stake zero");
        _updateReward(msg.sender);

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
        _updateReward(msg.sender);

        stakedBalance[msg.sender] -= amount;
        totalStaked -= amount;
        if (stakedBalance[msg.sender] == 0) {
            stakeStart[msg.sender] = 0;
        }

        _transfer(address(this), msg.sender, amount);

        emit Unstaked(msg.sender, amount);
    }

    function claimReward() external nonReentrant {
        _updateReward(msg.sender);
        uint256 reward = rewards[msg.sender];
        require(reward > 0, "AGE: no rewards to claim");
        rewards[msg.sender] = 0;
        _transfer(address(this), msg.sender, reward);
        emit RewardClaimed(msg.sender, reward);
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
