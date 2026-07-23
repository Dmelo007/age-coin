const hre = require("hardhat");

const CONTRACT_ADDRESS = "0x9AE145086b43Fd0d7D0Eef3e53284457EA177eCa";

function fmt(x) {
  return hre.ethers.formatUnits(x, 18);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const token = await hre.ethers.getContractAt("AGECoin", CONTRACT_ADDRESS);

  const walletA = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);
  const walletB = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);
  console.log("Staker (A):", walletA.address);
  console.log("Fee counterparty (B):", walletB.address);

  console.log("\n--- Funding test wallets ---");
  let tx = await deployer.sendTransaction({ to: walletA.address, value: hre.ethers.parseEther("0.01") });
  await tx.wait();
  tx = await deployer.sendTransaction({ to: walletB.address, value: hre.ethers.parseEther("0.005") });
  await tx.wait();
  tx = await token.connect(deployer).transfer(walletA.address, hre.ethers.parseUnits("50000", 18));
  await tx.wait();
  console.log("Wallet A funded with 0.01 ETH and 50,000 AGE");

  console.log("\n--- Seeding staking pool with real fee revenue (A -> B, both non-exempt) ---");
  const poolBefore = await token.stakingPool();
  tx = await token.connect(walletA).transfer(walletB.address, hre.ethers.parseUnits("20000", 18));
  await tx.wait();
  const poolAfterSeed = await token.stakingPool();
  console.log("Staking pool:", fmt(poolBefore), "->", fmt(poolAfterSeed), "AGE");

  console.log("\n--- Staking ---");
  tx = await token.connect(walletA).stake(hre.ethers.parseUnits("1000", 18));
  await tx.wait();
  const earnedImmediately = await token.earned(walletA.address);
  console.log("Staked 1000 AGE. Earned immediately after staking:", fmt(earnedImmediately), "AGE (expect ~0)");

  console.log("\n--- Waiting 90 real seconds for reward accrual ---");
  await sleep(90000);

  // Send a trivial transfer just to mine a new block so block.timestamp advances.
  tx = await token.connect(walletB).transfer(walletA.address, 1n);
  await tx.wait();

  const earnedAfterWait = await token.earned(walletA.address);
  console.log("Earned after waiting:", fmt(earnedAfterWait), "AGE (expect > 0)");

  console.log("\n--- Claiming reward ---");
  const balBefore = await token.balanceOf(walletA.address);
  tx = await token.connect(walletA).claimReward();
  await tx.wait();
  const balAfter = await token.balanceOf(walletA.address);
  console.log("Balance before claim:", fmt(balBefore), "AGE");
  console.log("Balance after claim:", fmt(balAfter), "AGE");
  console.log("Reward received:", fmt(balAfter - balBefore), "AGE");

  console.log("\nAll staking reward checks complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
