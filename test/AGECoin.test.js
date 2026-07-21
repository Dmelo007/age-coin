const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AGECoin", function () {
  const TOTAL_SUPPLY = ethers.parseUnits("10000000", 18);
  const CARBON_FEE_BP = 50n;
  const TREASURY_FEE_BP = 100n;
  const STAKING_FEE_BP = 20n;
  const DENOM = 10000n;

  async function deployFixture() {
    const [owner, carbonWallet, communityWallet, alice, bob, carol] = await ethers.getSigners();
    const AGECoin = await ethers.getContractFactory("AGECoin");
    const token = await AGECoin.deploy(carbonWallet.address, communityWallet.address);
    await token.waitForDeployment();
    return { token, owner, carbonWallet, communityWallet, alice, bob, carol };
  }

  function calcFees(amount) {
    const carbon = (amount * CARBON_FEE_BP) / DENOM;
    const treasury = (amount * TREASURY_FEE_BP) / DENOM;
    const staking = (amount * STAKING_FEE_BP) / DENOM;
    const net = amount - carbon - treasury - staking;
    return { carbon, treasury, staking, net };
  }


  describe("Deployment", function () {
    it("sets correct name and symbol", async function () {
      const { token } = await loadFixture(deployFixture);
      expect(await token.name()).to.equal("AGE Coin");
      expect(await token.symbol()).to.equal("AGE");
    });

    it("mints total supply to deployer", async function () {
      const { token, owner } = await loadFixture(deployFixture);
      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY);
      expect(await token.balanceOf(owner.address)).to.equal(TOTAL_SUPPLY);
    });

    it("sets impact wallets correctly", async function () {
      const { token, carbonWallet, communityWallet } = await loadFixture(deployFixture);
      expect(await token.carbonOffsetWallet()).to.equal(carbonWallet.address);
      expect(await token.communityFund()).to.equal(communityWallet.address);
    });

    it("marks owner, contract, and impact wallets as fee-exempt", async function () {
      const { token, owner, carbonWallet, communityWallet } = await loadFixture(deployFixture);
      expect(await token.feeExempt(owner.address)).to.equal(true);
      expect(await token.feeExempt(await token.getAddress())).to.equal(true);
      expect(await token.feeExempt(carbonWallet.address)).to.equal(true);
      expect(await token.feeExempt(communityWallet.address)).to.equal(true);
    });

    it("reverts if carbon wallet is zero address", async function () {
      const AGECoin = await ethers.getContractFactory("AGECoin");
      const [, , communityWallet] = await ethers.getSigners();
      await expect(
        AGECoin.deploy(ethers.ZeroAddress, communityWallet.address)
      ).to.be.revertedWith("AGE: carbon wallet is zero address");
    });

    it("reverts if community wallet is zero address", async function () {
      const AGECoin = await ethers.getContractFactory("AGECoin");
      const [, carbonWallet] = await ethers.getSigners();
      await expect(
        AGECoin.deploy(carbonWallet.address, ethers.ZeroAddress)
      ).to.be.revertedWith("AGE: community fund is zero address");
    });
  });

  describe("Transfer fees", function () {
    it("applies fees on a normal transfer between non-exempt accounts", async function () {
      const { token, carbonWallet, communityWallet, alice, bob } = await loadFixture(deployFixture);
      await token.transfer(alice.address, ethers.parseUnits("1000", 18));

      const amount = ethers.parseUnits("100", 18);
      const { carbon, treasury, staking, net } = calcFees(amount);
      const carbonBefore = await token.balanceOf(carbonWallet.address);
      const communityBefore = await token.balanceOf(communityWallet.address);
      const poolBefore = await token.stakingPool();

      await expect(token.connect(alice).transfer(bob.address, amount))
        .to.emit(token, "ImpactFeesPaid")
        .withArgs(alice.address, carbon, treasury, staking);

      expect(await token.balanceOf(bob.address)).to.equal(net);
      expect(await token.balanceOf(carbonWallet.address)).to.equal(carbonBefore + carbon);
      expect(await token.balanceOf(communityWallet.address)).to.equal(communityBefore + treasury);
      expect(await token.stakingPool()).to.equal(poolBefore + staking);
    });

    it("skips fees when sender is fee-exempt", async function () {
      const { token, bob, carbonWallet, communityWallet } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("500", 18);
      const carbonBefore = await token.balanceOf(carbonWallet.address);
      const communityBefore = await token.balanceOf(communityWallet.address);

      await token.transfer(bob.address, amount);
      expect(await token.balanceOf(bob.address)).to.equal(amount);
      expect(await token.balanceOf(carbonWallet.address)).to.equal(carbonBefore);
      expect(await token.balanceOf(communityWallet.address)).to.equal(communityBefore);
    });

    it("skips fees when recipient is fee-exempt", async function () {
      const { token, alice, owner } = await loadFixture(deployFixture);
      await token.transfer(alice.address, ethers.parseUnits("1000", 18));
      const amount = ethers.parseUnits("200", 18);
      const before = await token.balanceOf(owner.address);
      await token.connect(alice).transfer(owner.address, amount);
      expect(await token.balanceOf(owner.address)).to.equal(before + amount);
    });

    it("handles zero-value transfers without applying fees or reverting", async function () {
      const { token, alice, bob } = await loadFixture(deployFixture);
      await token.transfer(alice.address, ethers.parseUnits("100", 18));
      await expect(token.connect(alice).transfer(bob.address, 0)).to.not.be.reverted;
      expect(await token.balanceOf(bob.address)).to.equal(0);
    });

    it("handles dust amounts where fee rounds down to zero", async function () {
      const { token, alice, bob, carbonWallet } = await loadFixture(deployFixture);
      await token.transfer(alice.address, ethers.parseUnits("1", 18));
      const tinyAmount = 10n;
      const carbonBefore = await token.balanceOf(carbonWallet.address);
      await token.connect(alice).transfer(bob.address, tinyAmount);
      expect(await token.balanceOf(carbonWallet.address)).to.equal(carbonBefore);
      expect(await token.balanceOf(bob.address)).to.equal(tinyAmount);
    });

    it("correctly transfers full balance accounting for fees", async function () {
      const { token, alice, bob } = await loadFixture(deployFixture);
      const seed = ethers.parseUnits("1000", 18);
      await token.transfer(alice.address, seed);
      await token.connect(alice).transfer(bob.address, seed);
      expect(await token.balanceOf(alice.address)).to.equal(0);
    });

    it("reverts transfer exceeding balance", async function () {
      const { token, alice, bob } = await loadFixture(deployFixture);
      await expect(token.connect(alice).transfer(bob.address, 1)).to.be.reverted;
    });
  });

  describe("transferFrom and allowances", function () {
    it("applies fees correctly via transferFrom", async function () {
      const { token, alice, bob, carol } = await loadFixture(deployFixture);
      await token.transfer(alice.address, ethers.parseUnits("1000", 18));
      const amount = ethers.parseUnits("100", 18);
      const { net } = calcFees(amount);
      await token.connect(alice).approve(bob.address, amount);
      await token.connect(bob).transferFrom(alice.address, carol.address, amount);
      expect(await token.balanceOf(carol.address)).to.equal(net);
    });

    it("reduces allowance after transferFrom", async function () {
      const { token, alice, bob, carol } = await loadFixture(deployFixture);
      await token.transfer(alice.address, ethers.parseUnits("1000", 18));
      const amount = ethers.parseUnits("100", 18);
      await token.connect(alice).approve(bob.address, amount);
      await token.connect(bob).transferFrom(alice.address, carol.address, amount);
      expect(await token.allowance(alice.address, bob.address)).to.equal(0);
    });

    it("reverts transferFrom exceeding allowance", async function () {
      const { token, alice, bob, carol } = await loadFixture(deployFixture);
      await token.transfer(alice.address, ethers.parseUnits("1000", 18));
      await token.connect(alice).approve(bob.address, ethers.parseUnits("50", 18));
      await expect(
        token.connect(bob).transferFrom(alice.address, carol.address, ethers.parseUnits("51", 18))
      ).to.be.reverted;
    });
  });

  describe("Access control", function () {
    it("only owner can call setImpactWallets", async function () {
      const { token, alice, bob, carol } = await loadFixture(deployFixture);
      await expect(token.connect(alice).setImpactWallets(bob.address, carol.address))
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });

    it("only owner can call setFeeExempt", async function () {
      const { token, alice, bob } = await loadFixture(deployFixture);
      await expect(token.connect(alice).setFeeExempt(bob.address, true))
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });

    it("owner can update impact wallets; old wallets lose exemption, new ones gain it", async function () {
      const { token, carbonWallet, communityWallet, alice, bob } = await loadFixture(deployFixture);
      await expect(token.setImpactWallets(alice.address, bob.address))
        .to.emit(token, "ImpactWalletsUpdated")
        .withArgs(alice.address, bob.address);

      expect(await token.carbonOffsetWallet()).to.equal(alice.address);
      expect(await token.communityFund()).to.equal(bob.address);
      expect(await token.feeExempt(carbonWallet.address)).to.equal(false);
      expect(await token.feeExempt(communityWallet.address)).to.equal(false);
      expect(await token.feeExempt(alice.address)).to.equal(true);
      expect(await token.feeExempt(bob.address)).to.equal(true);
    });

    it("reverts setImpactWallets with zero addresses", async function () {
      const { token, bob } = await loadFixture(deployFixture);
      await expect(token.setImpactWallets(ethers.ZeroAddress, bob.address))
        .to.be.revertedWith("AGE: carbon wallet is zero address");
      await expect(token.setImpactWallets(bob.address, ethers.ZeroAddress))
        .to.be.revertedWith("AGE: community fund is zero address");
    });

    it("owner can grant and revoke fee exemption", async function () {
      const { token, alice, bob } = await loadFixture(deployFixture);
      await token.transfer(alice.address, ethers.parseUnits("1000", 18));
      await expect(token.setFeeExempt(alice.address, true))
        .to.emit(token, "FeeExemptionSet")
        .withArgs(alice.address, true);

      const amount = ethers.parseUnits("100", 18);
      await token.connect(alice).transfer(bob.address, amount);
      expect(await token.balanceOf(bob.address)).to.equal(amount);

      await token.setFeeExempt(alice.address, false);
      const { net } = calcFees(amount);
      await token.connect(alice).transfer(bob.address, amount);
      expect(await token.balanceOf(bob.address)).to.equal(amount + net);
    });
  });

  describe("Staking", function () {
    it("stakes tokens without fees and updates accounting", async function () {
      const { token, alice } = await loadFixture(deployFixture);
      await token.transfer(alice.address, ethers.parseUnits("1000", 18));
      const stakeAmt = ethers.parseUnits("200", 18);
      await expect(token.connect(alice).stake(stakeAmt))
        .to.emit(token, "Staked")
        .withArgs(alice.address, stakeAmt);
      expect(await token.stakedBalance(alice.address)).to.equal(stakeAmt);
      expect(await token.totalStaked()).to.equal(stakeAmt);
      expect(await token.balanceOf(alice.address)).to.equal(ethers.parseUnits("800", 18));
    });

    it("reverts staking zero", async function () {
      const { token, alice } = await loadFixture(deployFixture);
      await token.transfer(alice.address, ethers.parseUnits("100", 18));
      await expect(token.connect(alice).stake(0)).to.be.revertedWith("AGE: cannot stake zero");
    });

    it("reverts staking more than balance", async function () {
      const { token, alice } = await loadFixture(deployFixture);
      await token.transfer(alice.address, ethers.parseUnits("100", 18));
      await expect(token.connect(alice).stake(ethers.parseUnits("101", 18))).to.be.reverted;
    });

    it("accumulates additional stakes without resetting start time", async function () {
      const { token, alice } = await loadFixture(deployFixture);
      await token.transfer(alice.address, ethers.parseUnits("1000", 18));
      await token.connect(alice).stake(ethers.parseUnits("100", 18));
      const startBefore = await token.stakeStart(alice.address);
      await token.connect(alice).stake(ethers.parseUnits("100", 18));
      const startAfter = await token.stakeStart(alice.address);
      expect(startAfter).to.equal(startBefore);
      expect(await token.stakedBalance(alice.address)).to.equal(ethers.parseUnits("200", 18));
    });

    it("unstakes tokens without fees and resets start time when fully unstaked", async function () {
      const { token, alice } = await loadFixture(deployFixture);
      await token.transfer(alice.address, ethers.parseUnits("1000", 18));
      await token.connect(alice).stake(ethers.parseUnits("200", 18));
      await expect(token.connect(alice).unstake(ethers.parseUnits("200", 18)))
        .to.emit(token, "Unstaked")
        .withArgs(alice.address, ethers.parseUnits("200", 18));
      expect(await token.stakedBalance(alice.address)).to.equal(0);
      expect(await token.balanceOf(alice.address)).to.equal(ethers.parseUnits("1000", 18));
      expect(await token.stakeStart(alice.address)).to.equal(0);
    });

    it("reverts unstaking zero", async function () {
      const { token, alice } = await loadFixture(deployFixture);
      await token.transfer(alice.address, ethers.parseUnits("100", 18));
      await token.connect(alice).stake(ethers.parseUnits("50", 18));
      await expect(token.connect(alice).unstake(0)).to.be.revertedWith("AGE: cannot unstake zero");
    });

    it("reverts unstaking more than staked balance", async function () {
      const { token, alice } = await loadFixture(deployFixture);
      await token.transfer(alice.address, ethers.parseUnits("100", 18));
      await token.connect(alice).stake(ethers.parseUnits("50", 18));
      await expect(token.connect(alice).unstake(ethers.parseUnits("51", 18)))
        .to.be.revertedWith("AGE: unstake exceeds staked balance");
    });

    it("allows partial unstake and keeps remaining stake with same start time", async function () {
      const { token, alice } = await loadFixture(deployFixture);
      await token.transfer(alice.address, ethers.parseUnits("1000", 18));
      await token.connect(alice).stake(ethers.parseUnits("200", 18));
      const startBefore = await token.stakeStart(alice.address);
      await token.connect(alice).unstake(ethers.parseUnits("50", 18));
      expect(await token.stakedBalance(alice.address)).to.equal(ethers.parseUnits("150", 18));
      expect(await token.stakeStart(alice.address)).to.equal(startBefore);
    });

    it("tracks staking duration correctly, including zero when not staked", async function () {
      const { token, alice } = await loadFixture(deployFixture);
      await token.transfer(alice.address, ethers.parseUnits("100", 18));
      expect(await token.stakingDuration(alice.address)).to.equal(0);
      await token.connect(alice).stake(ethers.parseUnits("50", 18));
      const duration1 = await token.stakingDuration(alice.address);
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine");
      const duration2 = await token.stakingDuration(alice.address);
      expect(duration2).to.be.greaterThan(duration1);
    });
  });

  describe("Ownership", function () {
    it("owner can transfer ownership", async function () {
      const { token, alice } = await loadFixture(deployFixture);
      await token.transferOwnership(alice.address);
      expect(await token.owner()).to.equal(alice.address);
    });

    it("after renouncing ownership, admin functions become permanently uncallable", async function () {
      const { token, bob } = await loadFixture(deployFixture);
      await token.renounceOwnership();
      expect(await token.owner()).to.equal(ethers.ZeroAddress);
      await expect(token.setFeeExempt(bob.address, true)).to.be.reverted;
      await expect(token.setImpactWallets(bob.address, bob.address)).to.be.reverted;
    });
  });

  describe("Invariants", function () {
    it("conserves total supply across many fee-generating transfers and staking", async function () {
      const { token, owner, alice, bob, carol, carbonWallet, communityWallet } = await loadFixture(deployFixture);
      await token.transfer(alice.address, ethers.parseUnits("5000", 18));
      await token.connect(alice).transfer(bob.address, ethers.parseUnits("1234.567", 18));
      await token.connect(bob).transfer(carol.address, ethers.parseUnits("321.111", 18));
      await token.connect(alice).stake(ethers.parseUnits("100", 18));
      await token.connect(alice).unstake(ethers.parseUnits("30", 18));

      const addresses = [
        owner.address,
        alice.address,
        bob.address,
        carol.address,
        carbonWallet.address,
        communityWallet.address,
        await token.getAddress(),
      ];
      let sum = 0n;
      for (const addr of addresses) {
        sum += await token.balanceOf(addr);
      }
      expect(sum).to.equal(TOTAL_SUPPLY);
    });

    it("never mints beyond the fixed total supply (no public mint function exists)", async function () {
      const { token } = await loadFixture(deployFixture);
      expect(token.mint).to.equal(undefined);
      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY);
    });

    it("contract's real AGE balance always covers staked principal + pool + unclaimed rewards", async function () {
      const { token, owner, alice, bob, carol } = await loadFixture(deployFixture);
      await token.transfer(alice.address, ethers.parseUnits("10000", 18));
      await token.transfer(bob.address, ethers.parseUnits("10000", 18));

      await token.connect(alice).stake(ethers.parseUnits("1000", 18));
      // Route real fee volume through a non-exempt account to fund the pool.
      await token.connect(bob).transfer(carol.address, ethers.parseUnits("5000", 18));
      await time.increase(3600);
      await token.connect(bob).stake(ethers.parseUnits("500", 18));
      await time.increase(3600);
      await token.connect(alice).claimReward();

      const contractBal = await token.balanceOf(await token.getAddress());
      const totalStaked = await token.totalStaked();
      const pool = await token.stakingPool();
      const unclaimedAlice = await token.earned(alice.address);
      const unclaimedBob = await token.earned(bob.address);

      // The contract must always hold at least enough to cover principal,
      // the remaining pool, and whatever's owed but not yet claimed.
      expect(contractBal).to.be.gte(totalStaked + pool + unclaimedAlice + unclaimedBob);
    });
  });

  describe("Staking rewards", function () {
    async function seedAndStake(token, owner, alice, bob, mule) {
      await token.transfer(alice.address, ethers.parseUnits("10000", 18));
      await token.transfer(bob.address, ethers.parseUnits("10000", 18));
      // Push a large transfer between two NON-exempt wallets to fund
      // stakingPool with real fee revenue (mirrors production behavior).
      // Both owner->mule and mule->owner would skip fees since owner is
      // exempt, so route it through alice instead, who is not exempt.
      await token.transfer(mule.address, ethers.parseUnits("1000000", 18));
      await token.connect(mule).transfer(alice.address, ethers.parseUnits("500000", 18));
      // That transfer is 5% of total supply and legitimately trips the
      // circuit breaker into Yellow mode. Clear it so the rest of the
      // test can proceed — mirrors the real owner/multisig resolving
      // a false positive caused by a single large, legitimate transfer.
      if ((await token.currentMode()) !== 0n) {
        await token.resolveEmergency();
      }
    }

    it("pays no rewards while nobody is staked, even as the pool fills", async function () {
      const { token, owner, alice, bob, carol } = await loadFixture(deployFixture);
      await seedAndStake(token, owner, alice, bob, carol);
      expect(await token.totalStaked()).to.equal(0);
      const poolBefore = await token.stakingPool();
      expect(poolBefore).to.be.gt(0);

      await time.increase(30 * 24 * 3600);
      await ethers.provider.send("evm_mine");

      // No accrual should have happened with nobody staked.
      expect(await token.rewardPerToken()).to.equal(0);
      expect(await token.stakingPool()).to.equal(poolBefore);
    });

    it("a lone staker earns rewards over time, bounded by the pool", async function () {
      const { token, owner, alice, bob, carol } = await loadFixture(deployFixture);
      await seedAndStake(token, owner, alice, bob, carol);
      const pool = await token.stakingPool();

      await token.connect(alice).stake(ethers.parseUnits("1000", 18));
      expect(await token.earned(alice.address)).to.equal(0);

      await time.increase(30 * 24 * 3600); // 30 days
      await ethers.provider.send("evm_mine");

      const earned = await token.earned(alice.address);
      expect(earned).to.be.gt(0);
      expect(earned).to.be.lte(pool);
    });

    it("splits rewards proportionally between two stakers who joined at the same time", async function () {
      const { token, owner, alice, bob, carol } = await loadFixture(deployFixture);
      await seedAndStake(token, owner, alice, bob, carol);

      await token.connect(alice).stake(ethers.parseUnits("2000", 18)); // 2x bob
      await token.connect(bob).stake(ethers.parseUnits("1000", 18));

      await time.increase(30 * 24 * 3600);
      await ethers.provider.send("evm_mine");

      const earnedAlice = await token.earned(alice.address);
      const earnedBob = await token.earned(bob.address);
      expect(earnedAlice).to.be.gt(0);
      expect(earnedBob).to.be.gt(0);

      // Alice staked exactly 2x bob's amount for the same period, so her
      // reward should be ~2x bob's (allow tiny rounding tolerance).
      const ratio = (earnedAlice * 1000n) / earnedBob;
      expect(ratio).to.be.closeTo(2000n, 5n);
    });

    it("prevents reward-sniping: a late staker earns nothing from time before they joined", async function () {
      const { token, owner, alice, bob, carol } = await loadFixture(deployFixture);
      await seedAndStake(token, owner, alice, bob, carol);

      await token.connect(alice).stake(ethers.parseUnits("1000", 18));
      await time.increase(15 * 24 * 3600);
      await ethers.provider.send("evm_mine");

      const aliceEarnedBeforeBobJoins = await token.earned(alice.address);
      expect(aliceEarnedBeforeBobJoins).to.be.gt(0);

      await token.connect(bob).stake(ethers.parseUnits("1000", 18));
      // Bob just joined; he shouldn't have earned anything yet.
      expect(await token.earned(bob.address)).to.equal(0);
      // Alice's already-accrued rewards must not have been diluted by Bob joining.
      expect(await token.earned(alice.address)).to.be.gte(aliceEarnedBeforeBobJoins);
    });

    it("claimReward pays out exactly the earned amount and resets it to zero", async function () {
      const { token, owner, alice, bob, carol } = await loadFixture(deployFixture);
      await seedAndStake(token, owner, alice, bob, carol);
      await token.connect(alice).stake(ethers.parseUnits("1000", 18));
      await time.increase(10 * 24 * 3600);
      await ethers.provider.send("evm_mine");

      const earnedBefore = await token.earned(alice.address);
      expect(earnedBefore).to.be.gt(0);
      const balBefore = await token.balanceOf(alice.address);

      await expect(token.connect(alice).claimReward())
        .to.emit(token, "RewardClaimed");

      const balAfter = await token.balanceOf(alice.address);
      expect(balAfter - balBefore).to.be.gte(earnedBefore);
      expect(await token.earned(alice.address)).to.equal(0);
    });

    it("reverts claimReward when there is nothing to claim", async function () {
      const { token, alice } = await loadFixture(deployFixture);
      await token.transfer(alice.address, ethers.parseUnits("100", 18));
      await token.connect(alice).stake(ethers.parseUnits("50", 18));
      await expect(token.connect(alice).claimReward()).to.be.revertedWith("AGE: no rewards to claim");
    });

    it("unstaking preserves already-accrued but unclaimed rewards", async function () {
      const { token, owner, alice, bob, carol } = await loadFixture(deployFixture);
      await seedAndStake(token, owner, alice, bob, carol);
      await token.connect(alice).stake(ethers.parseUnits("1000", 18));
      await time.increase(10 * 24 * 3600);
      await ethers.provider.send("evm_mine");

      const earnedBefore = await token.earned(alice.address);
      expect(earnedBefore).to.be.gt(0);

      await token.connect(alice).unstake(ethers.parseUnits("500", 18));
      // Unstaking partially shouldn't wipe out what was already earned.
      expect(await token.earned(alice.address)).to.be.gte(earnedBefore);
    });

    it("halves the reward rate after each halving period", async function () {
      const { token } = await loadFixture(deployFixture);
      const deployTime = await token.deployTime();
      const initialRate = await token.rewardRateAt(deployTime);
      const halvingPeriod = await token.HALVING_PERIOD();

      const afterOneHalving = await token.rewardRateAt(deployTime + halvingPeriod);
      const afterTwoHalvings = await token.rewardRateAt(deployTime + halvingPeriod * 2n);

      expect(afterOneHalving).to.equal(initialRate / 2n);
      expect(afterTwoHalvings).to.equal(initialRate / 4n);
    });
  });
});
