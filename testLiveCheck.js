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

  console.log("--- Circuit breaker status before ---");
  console.log("Mode:", await token.currentMode(), "(0=Green, 1=Yellow, 2=Red)");

  const walletA = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);
  const walletB = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);
  console.log("\nWallet A (staker):", walletA.address);
  console.log("Wallet B (counterparty):", walletB.address);

  console.log("\n--- Funding test wallets ---");
  let tx = await deployer.sendTransaction({ to: walletA.address, value: hre.ethers.parseEther("0.01") });
  await tx.wait();
  tx = await deployer.sendTransaction({ to: walletB.address, value: hre.ethers.parseEther("0.005") });
  await tx.wait();
  tx = await token.connect(deployer).transfer(walletA.address, hre.ethers.parseUnits("5000", 18));
  await tx.wait();
  console.log("Wallet A funded with 0.01 ETH and 5000 AGE");

  console.log("\n--- Normal-sized transfer (well under Yellow threshold) ---");
  const carbonBefore = await token.balanceOf(await token.carbonOffsetWallet());
  const communityBefore = await token.balanceOf(await token.communityFund());
  const poolBefore = await token.stakingPool();

  tx = await token.connect(walletA).transfer(walletB.address, hre.ethers.parseUnits("2000", 18));
  await tx.wait();

  const carbonAfter = await token.balanceOf(await token.carbonOffsetWallet());
  const communityAfter = await token.balanceOf(await token.communityFund());
  const poolAfter = await token.stakingPool();
  const bBalance = await token.balanceOf(walletB.address);

  console.log("B received:", fmt(bBalance), "AGE (expect 1966 = 2000 - 1.7%)");
  console.log("Carbon wallet gained:", fmt(carbonAfter - carbonBefore), "AGE (expect 10)");
  console.log("Community wallet gained:", fmt(communityAfter - communityBefore), "AGE (expect 20)");
  console.log("Staking pool gained:", fmt(poolAfter - poolBefore), "AGE (expect 4)");
  console.log("Circuit breaker mode after normal transfer:", await token.currentMode(), "(expect 0 = Green)");

  console.log("\n--- Staking ---");
  tx = await token.connect(walletA).stake(hre.ethers.parseUnits("500", 18));
  await tx.wait();
  console.log("Staked 500 AGE. Earned immediately:", fmt(await token.earned(walletA.address)), "(expect ~0)");

  console.log("\n--- Waiting 60 real seconds for reward accrual ---");
  await sleep(60000);
  tx = await token.connect(walletB).transfer(walletA.address, 1n);
  await tx.wait();
  console.log("Earned after waiting:", fmt(await token.earned(walletA.address)), "AGE (expect > 0)");

  console.log("\n--- Claiming reward ---");
  const balBefore = await token.balanceOf(walletA.address);
  tx = await token.connect(walletA).claimReward();
  await tx.wait();
  const balAfter = await token.balanceOf(walletA.address);
  console.log("Reward received:", fmt(balAfter - balBefore), "AGE");

  console.log("\n--- Unstaking ---");
  tx = await token.connect(walletA).unstake(hre.ethers.parseUnits("500", 18));
  await tx.wait();
  console.log("Unstaked successfully. Staked balance now:", fmt(await token.stakedBalance(walletA.address)));

  console.log("\n--- Final circuit breaker check ---");
  console.log("Mode:", await token.currentMode(), "(expect 0 = Green — normal usage never should trip it)");

  console.log("\nLive check complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
