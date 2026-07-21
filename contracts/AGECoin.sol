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
//  - A self-healing circuit breaker (Green/Yellow/Red) watches
//    transfer volume and automatically restricts, then automatically
//    recovers, without needing a human to intervene. Unstaking and
//    claiming rewards always work, in every mode, no exceptions.
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

    // ---------------- CIRCUIT BREAKER ----------------
    // Watches total non-exempt transfer volume in a rolling window.
    // No oracle, no external dependency — purely on-chain and
    // automatic. Unstaking and claiming rewards are NEVER affected
    // by this, in any mode.
    enum Mode { Green, Yellow, Red }
    Mode public currentMode;

    // Volume is tracked in a true sliding window made of fixed-size
    // buckets, not a single counter that resets all at once. A naive
    // "reset everything at the hour mark" design has a real flaw: a
    // reset landing right after a quiet moment can instantly erase a
    // genuinely sustained anomaly, letting a real attack slip through
    // on bad timing. Buckets age out gradually instead.
    uint256 public constant BUCKET_SIZE = 10 minutes;
    uint256 public constant NUM_BUCKETS = 6; // 6 * 10min = 1 hour rolling window
    uint256 public constant YELLOW_VOLUME_THRESHOLD = (TOTAL_SUPPLY * 5) / 100;  // 5% of supply/hour
    uint256 public constant YELLOW_TRANSFER_CAP = (TOTAL_SUPPLY * 1) / 100;      // 1% of supply per transfer while Yellow
    uint256 public constant RED_ESCALATION_DELAY = 2 hours;  // sustained Yellow before escalating
    uint256 public constant RED_COOLDOWN = 72 hours;         // auto-recovery time in Red
    uint256 public constant YELLOW_MIN_DURATION = 30 minutes; // minimum observation time in Yellow before it can clear to Green

    uint256[NUM_BUCKETS] public volumeBuckets;
    uint256 public lastBucketTimestamp;
    uint256 public yellowSince;
    uint256 public redSince;

    // ---------------- EVENTS ----------------
    event ImpactFeesPaid(address indexed from, uint256 carbonAmount, uint256 treasuryAmount, uint256 stakingAmount);
    event Staked(address indexed account, uint256 amount);
    event Unstaked(address indexed account, uint256 amount);
    event RewardClaimed(address indexed account, uint256 amount);
    event ImpactWalletsUpdated(address carbonOffsetWallet, address communityFund);
    event FeeExemptionSet(address indexed account, bool exempt);
    event ModeChanged(Mode indexed from, Mode indexed to, string reason);

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
        lastBucketTimestamp = block.timestamp;
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

        _checkAutoRecovery();

        require(currentMode != Mode.Red, "AGE: transfers paused, circuit breaker in Red mode");
        if (currentMode == Mode.Yellow) {
            require(value <= YELLOW_TRANSFER_CAP, "AGE: exceeds Yellow-mode transfer cap");
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
        _updateCircuitBreaker(value);

        emit ImpactFeesPaid(from, carbonAmount, treasuryAmount, stakingAmount);
    }

    // ---------------- CIRCUIT BREAKER LOGIC ----------------
    // Checked BEFORE mode-based restrictions are enforced, so a
    // due recovery is never blocked by the very mode it's supposed
    // to lift. Can only ever make things less restrictive (Red ->
    // Yellow), never more.
    function _checkAutoRecovery() internal {
        if (currentMode == Mode.Red) {
            bool anomalyActive = totalWindowVolume() >= YELLOW_VOLUME_THRESHOLD;
            if (!anomalyActive && block.timestamp >= redSince + RED_COOLDOWN) {
                currentMode = Mode.Yellow;
                yellowSince = block.timestamp;
                redSince = 0;
                emit ModeChanged(Mode.Red, Mode.Yellow, "cooldown elapsed, stepping down");
            }
        }
    }

    // Called after every fee-generating transfer that was actually
    // allowed through. By this point currentMode is only ever Green
    // or Yellow (Red already either blocked this transfer above, or
    // was just lifted by _checkAutoRecovery). Purely a function of
    // on-chain volume and elapsed time — no human input, no external
    // oracle. Automatically escalates.
    function _updateCircuitBreaker(uint256 value) internal {
        _recordVolume(value);
        bool anomalyActive = totalWindowVolume() >= YELLOW_VOLUME_THRESHOLD;

        if (currentMode == Mode.Green) {
            if (anomalyActive) {
                currentMode = Mode.Yellow;
                yellowSince = block.timestamp;
                emit ModeChanged(Mode.Green, Mode.Yellow, "transfer volume anomaly detected");
            }
        } else if (currentMode == Mode.Yellow) {
            if (anomalyActive && block.timestamp >= yellowSince + RED_ESCALATION_DELAY) {
                currentMode = Mode.Red;
                redSince = block.timestamp;
                emit ModeChanged(Mode.Yellow, Mode.Red, "anomaly sustained past escalation delay");
            } else if (!anomalyActive && block.timestamp >= yellowSince + YELLOW_MIN_DURATION) {
                currentMode = Mode.Green;
                yellowSince = 0;
                emit ModeChanged(Mode.Yellow, Mode.Green, "transfer volume normalized");
            }
        }
    }

    /// Records `value` into the bucket for the current BUCKET_SIZE
    /// slot, clearing any buckets that have aged out since the last
    /// recorded transfer. Buckets expire one at a time as time moves
    /// forward, rather than the whole window resetting to zero at
    /// once — this is what makes a sustained anomaly impossible to
    /// accidentally erase by unlucky timing.
    function _recordVolume(uint256 value) internal {
        uint256 currentBucket = block.timestamp / BUCKET_SIZE;
        uint256 lastBucket = lastBucketTimestamp / BUCKET_SIZE;

        if (currentBucket != lastBucket) {
            uint256 bucketsElapsed = currentBucket - lastBucket;
            uint256 bucketsToClear = bucketsElapsed > NUM_BUCKETS ? NUM_BUCKETS : bucketsElapsed;
            for (uint256 i = 1; i <= bucketsToClear; i++) {
                volumeBuckets[(lastBucket + i) % NUM_BUCKETS] = 0;
            }
        }

        volumeBuckets[currentBucket % NUM_BUCKETS] += value;
        lastBucketTimestamp = block.timestamp;
    }

    /// Sum of all buckets still within the trailing window. Buckets
    /// older than NUM_BUCKETS slots are treated as expired (zero)
    /// even if never explicitly cleared, since _recordVolume clears
    /// on the next write — this view just needs to not double-count
    /// stale data if read without a fresh write first.
    function totalWindowVolume() public view returns (uint256 total) {
        uint256 currentBucket = block.timestamp / BUCKET_SIZE;
        uint256 lastBucket = lastBucketTimestamp / BUCKET_SIZE;
        uint256 staleGap = currentBucket - lastBucket;

        for (uint256 i = 0; i < NUM_BUCKETS; i++) {
            // A bucket is stale (not yet cleared on-chain) if it's
            // one of the ones that would be wiped on the next write.
            if (staleGap >= NUM_BUCKETS) continue;
            bool isStale = false;
            for (uint256 j = 1; j <= staleGap; j++) {
                if (i == (lastBucket + j) % NUM_BUCKETS) {
                    isStale = true;
                    break;
                }
            }
            if (!isStale) total += volumeBuckets[i];
        }
    }

    /// Lets the multisig manually clear a false-positive early. Full
    /// reset to Green rather than per-function isolation, since this
    /// contract has no separable subsystems to isolate individually.
    function resolveEmergency() external onlyOwner {
        require(currentMode != Mode.Green, "AGE: already in Green mode");
        Mode previous = currentMode;
        currentMode = Mode.Green;
        yellowSince = 0;
        redSince = 0;
        for (uint256 i = 0; i < NUM_BUCKETS; i++) {
            volumeBuckets[i] = 0;
        }
        lastBucketTimestamp = block.timestamp;
        emit ModeChanged(previous, Mode.Green, "manually resolved by owner");
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
        _checkAutoRecovery();
        require(currentMode == Mode.Green, "AGE: new staking paused by circuit breaker");
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
