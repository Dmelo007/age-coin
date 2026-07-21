const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AGECoin — Circuit Breaker", function () {
  const GREEN = 0n, YELLOW = 1n, RED = 2n;

  // Trips the breaker into Yellow, then keeps every rolling window's
  // volume above threshold (dense, frequent transfers) until it
  // escalates to Red, stopping as soon as it does since Red itself
  // then blocks further transfers.
  async function tripToRed(token, alice, bob) {
    await token.connect(alice).transfer(bob.address, ethers.parseUnits("600000", 18));
    for (let i = 0; i < 15; i++) {
      if ((await token.currentMode()) === RED) return;
      await time.increase(600);
      await token.connect(bob).transfer(alice.address, ethers.parseUnits("90000", 18));
    }
  }

  async function deployFixture() {
    const [owner, carbonWallet, communityWallet, alice, bob, carol] = await ethers.getSigners();
    const AGECoin = await ethers.getContractFactory("AGECoin");
    const token = await AGECoin.deploy(carbonWallet.address, communityWallet.address);
    await token.waitForDeployment();

    // Fund alice and bob generously (both non-exempt) so they can
    // generate large transfer volume between each other.
    await token.transfer(alice.address, ethers.parseUnits("2000000", 18));
    await token.transfer(bob.address, ethers.parseUnits("2000000", 18));

    return { token, owner, carbonWallet, communityWallet, alice, bob, carol };
  }

  it("stays Green under normal transfer volume", async function () {
    const { token, alice, bob } = await loadFixture(deployFixture);
    await token.connect(alice).transfer(bob.address, ethers.parseUnits("1000", 18));
    expect(await token.currentMode()).to.equal(GREEN);
  });

  it("trips to Yellow when a single transfer exceeds the volume threshold", async function () {
    const { token, alice, bob } = await loadFixture(deployFixture);
    // 5% of 10,000,000 = 500,000 AGE triggers Yellow.
    await expect(token.connect(alice).transfer(bob.address, ethers.parseUnits("600000", 18)))
      .to.emit(token, "ModeChanged")
      .withArgs(GREEN, YELLOW, "transfer volume anomaly detected");
    expect(await token.currentMode()).to.equal(YELLOW);
  });

  it("caps individual transfer size while in Yellow mode", async function () {
    const { token, alice, bob, carol } = await loadFixture(deployFixture);
    await token.connect(alice).transfer(bob.address, ethers.parseUnits("600000", 18));
    expect(await token.currentMode()).to.equal(YELLOW);

    // Cap is 1% of supply = 100,000 AGE.
    await expect(
      token.connect(bob).transfer(carol.address, ethers.parseUnits("100001", 18))
    ).to.be.revertedWith("AGE: exceeds Yellow-mode transfer cap");

    // A transfer under the cap still works.
    await expect(token.connect(bob).transfer(carol.address, ethers.parseUnits("50000", 18))).to.not.be.reverted;
  });

  it("blocks new staking while in Yellow mode", async function () {
    const { token, alice, bob } = await loadFixture(deployFixture);
    await token.connect(alice).transfer(bob.address, ethers.parseUnits("600000", 18));
    expect(await token.currentMode()).to.equal(YELLOW);

    await expect(token.connect(alice).stake(ethers.parseUnits("100", 18)))
      .to.be.revertedWith("AGE: new staking paused by circuit breaker");
  });

  it("returns to Green automatically once volume normalizes in a fresh window", async function () {
    const { token, alice, bob } = await loadFixture(deployFixture);
    await token.connect(alice).transfer(bob.address, ethers.parseUnits("600000", 18));
    expect(await token.currentMode()).to.equal(YELLOW);

    // Move to a new rolling window with no further big transfers.
    await time.increase(3600 + 1);
    await expect(token.connect(bob).transfer(alice.address, ethers.parseUnits("100", 18)))
      .to.emit(token, "ModeChanged")
      .withArgs(YELLOW, GREEN, "transfer volume normalized");
    expect(await token.currentMode()).to.equal(GREEN);
  });

  it("escalates to Red if the anomaly persists past the escalation delay", async function () {
    const { token, alice, bob } = await loadFixture(deployFixture);
    await tripToRed(token, alice, bob);
    expect(await token.currentMode()).to.equal(RED);
  });

  it("blocks all non-exempt transfers and new staking in Red mode, but allows unstake and claim", async function () {
    const { token, alice, bob } = await loadFixture(deployFixture);
    await token.connect(alice).stake(ethers.parseUnits("1000", 18));

    await tripToRed(token, alice, bob);
    expect(await token.currentMode()).to.equal(RED);

    await expect(token.connect(alice).transfer(bob.address, 1))
      .to.be.revertedWith("AGE: transfers paused, circuit breaker in Red mode");
    await expect(token.connect(alice).stake(ethers.parseUnits("10", 18)))
      .to.be.revertedWith("AGE: new staking paused by circuit breaker");

    // Unstaking must always work, even in Red mode.
    await expect(token.connect(alice).unstake(ethers.parseUnits("500", 18))).to.not.be.reverted;
  });

  it("auto-recovers from Red to Yellow after the cooldown with no further anomaly", async function () {
    const { token, alice, bob } = await loadFixture(deployFixture);
    await tripToRed(token, alice, bob);
    expect(await token.currentMode()).to.equal(RED);

    await time.increase(72 * 3600 + 1);
    await expect(token.connect(bob).transfer(alice.address, ethers.parseUnits("10", 18)))
      .to.emit(token, "ModeChanged")
      .withArgs(RED, YELLOW, "cooldown elapsed, stepping down");
    expect(await token.currentMode()).to.equal(YELLOW);
  });

  it("lets the owner manually resolve a false positive back to Green", async function () {
    const { token, alice, bob } = await loadFixture(deployFixture);
    await token.connect(alice).transfer(bob.address, ethers.parseUnits("600000", 18));
    expect(await token.currentMode()).to.equal(YELLOW);

    await expect(token.resolveEmergency())
      .to.emit(token, "ModeChanged")
      .withArgs(YELLOW, GREEN, "manually resolved by owner");
    expect(await token.currentMode()).to.equal(GREEN);
  });

  it("reverts resolveEmergency for non-owners", async function () {
    const { token, alice, bob } = await loadFixture(deployFixture);
    await token.connect(alice).transfer(bob.address, ethers.parseUnits("600000", 18));
    await expect(token.connect(alice).resolveEmergency())
      .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
  });

  it("reverts resolveEmergency when already Green", async function () {
    const { token } = await loadFixture(deployFixture);
    await expect(token.resolveEmergency()).to.be.revertedWith("AGE: already in Green mode");
  });

  it("never restricts claimReward, in any mode", async function () {
    const { token, alice, bob } = await loadFixture(deployFixture);
    await token.connect(alice).stake(ethers.parseUnits("1000", 18));
    // Generate some fee volume (also seeds the reward pool) without tripping the breaker.
    await token.connect(bob).transfer(alice.address, ethers.parseUnits("50000", 18));
    await time.increase(10 * 24 * 3600);

    // Trip into Red.
    await tripToRed(token, alice, bob);
    expect(await token.currentMode()).to.equal(RED);

    const earned = await token.earned(alice.address);
    expect(earned).to.be.gt(0);
    await expect(token.connect(alice).claimReward()).to.not.be.reverted;
  });
});
