const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("LinkTreasuryTimelock", function () {
  async function deployFixture() {
    const [deployer, beneficiary, stranger] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mockLink = await MockERC20.deploy("Mock LINK", "mLINK", ethers.parseUnits("1000000", 18));
    await mockLink.waitForDeployment();

    const releaseTime = (await time.latest()) + 5 * 365 * 24 * 3600; // ~5 years out
    const Timelock = await ethers.getContractFactory("LinkTreasuryTimelock");
    const timelock = await Timelock.deploy(await mockLink.getAddress(), beneficiary.address, releaseTime);
    await timelock.waitForDeployment();

    return { mockLink, timelock, deployer, beneficiary, stranger, releaseTime };
  }

  describe("Deployment", function () {
    it("sets token, beneficiary, and releaseTime correctly", async function () {
      const { mockLink, timelock, beneficiary, releaseTime } = await loadFixture(deployFixture);
      expect(await timelock.token()).to.equal(await mockLink.getAddress());
      expect(await timelock.beneficiary()).to.equal(beneficiary.address);
      expect(await timelock.releaseTime()).to.equal(releaseTime);
    });

    it("reverts with zero token address", async function () {
      const { beneficiary, releaseTime } = await loadFixture(deployFixture);
      const Timelock = await ethers.getContractFactory("LinkTreasuryTimelock");
      await expect(
        Timelock.deploy(ethers.ZeroAddress, beneficiary.address, releaseTime)
      ).to.be.revertedWith("AGE: token is zero address");
    });

    it("reverts with zero beneficiary address", async function () {
      const { mockLink, releaseTime } = await loadFixture(deployFixture);
      const Timelock = await ethers.getContractFactory("LinkTreasuryTimelock");
      await expect(
        Timelock.deploy(await mockLink.getAddress(), ethers.ZeroAddress, releaseTime)
      ).to.be.revertedWith("AGE: beneficiary is zero address");
    });

    it("reverts if release time is not in the future", async function () {
      const { mockLink, beneficiary } = await loadFixture(deployFixture);
      const Timelock = await ethers.getContractFactory("LinkTreasuryTimelock");
      const now = await time.latest();
      await expect(
        Timelock.deploy(await mockLink.getAddress(), beneficiary.address, now)
      ).to.be.revertedWith("AGE: release time must be in the future");
    });
  });

  describe("Locking behavior", function () {
    it("reverts release() before the release time, even if funded", async function () {
      const { mockLink, timelock, deployer } = await loadFixture(deployFixture);
      await mockLink.transfer(await timelock.getAddress(), ethers.parseUnits("1000", 18));
      await expect(timelock.release()).to.be.revertedWith("AGE: still locked");
    });

    it("reverts release() after the release time if nothing was ever deposited", async function () {
      const { timelock, releaseTime } = await loadFixture(deployFixture);
      await time.increaseTo(releaseTime + 1);
      await expect(timelock.release()).to.be.revertedWith("AGE: nothing to release");
    });

    it("releases the full balance to the beneficiary after the release time", async function () {
      const { mockLink, timelock, deployer, beneficiary, releaseTime } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("50000", 18);
      await mockLink.transfer(await timelock.getAddress(), amount);

      await time.increaseTo(releaseTime + 1);
      const balBefore = await mockLink.balanceOf(beneficiary.address);

      await expect(timelock.release())
        .to.emit(timelock, "Released")
        .withArgs(amount, beneficiary.address);

      expect(await mockLink.balanceOf(beneficiary.address)).to.equal(balBefore + amount);
      expect(await mockLink.balanceOf(await timelock.getAddress())).to.equal(0);
    });

    it("can be called by anyone, but funds always go to the fixed beneficiary", async function () {
      const { mockLink, timelock, beneficiary, stranger, releaseTime } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("1000", 18);
      await mockLink.transfer(await timelock.getAddress(), amount);
      await time.increaseTo(releaseTime + 1);

      // A completely unrelated account triggers release.
      await timelock.connect(stranger).release();

      expect(await mockLink.balanceOf(beneficiary.address)).to.equal(amount);
      expect(await mockLink.balanceOf(stranger.address)).to.equal(0);
    });

    it("supports multiple releases if more funds arrive later", async function () {
      const { mockLink, timelock, beneficiary, releaseTime } = await loadFixture(deployFixture);
      const first = ethers.parseUnits("1000", 18);
      const second = ethers.parseUnits("2000", 18);

      await mockLink.transfer(await timelock.getAddress(), first);
      await time.increaseTo(releaseTime + 1);
      await timelock.release();
      expect(await mockLink.balanceOf(beneficiary.address)).to.equal(first);

      // More funds arrive after the first release.
      await mockLink.transfer(await timelock.getAddress(), second);
      await timelock.release();
      expect(await mockLink.balanceOf(beneficiary.address)).to.equal(first + second);
    });

    it("has no owner, admin, or early-withdrawal function of any kind", async function () {
      const { timelock } = await loadFixture(deployFixture);
      expect(timelock.owner).to.equal(undefined);
      expect(timelock.withdraw).to.equal(undefined);
      expect(timelock.emergencyRelease).to.equal(undefined);
      expect(timelock.transferOwnership).to.equal(undefined);
    });
  });
});
