const hre = require("hardhat");

const CONTRACT_ADDRESS = "0x7EF335D8E3CF1b87DfD1a00521F595EDCdb8e23e";
const CARBON_WALLET = "0xec994b9220a4eC0A12F9625192B545Af8D2179a1";
const COMMUNITY_WALLET = "0x6f72Aa8FDb351743B4B2bA33Cd45027AAb86D84F";

function fmt(x) {
  return hre.ethers.formatUnits(x, 18);
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const token = await hre.ethers.getContractAt("AGECoin", CONTRACT_ADDRESS);

  const walletA = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);
  const walletB = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);

  console.log("Test wallet A (sender):", walletA.address);
  console.log("Test wallet B (recipient):", walletB.address);

  console.log("\n--- Funding test wallets from deployer ---");
  let tx = await deployer.sendTransaction({ to: walletA.address, value: hre.ethers.parseEther("0.005") });
  await tx.wait();
  tx = await token.connect(deployer).transfer(walletA.address, hre.ethers.parseUnits("1000", 18));
  await tx.wait();
  console.log("Wallet A funded with 0.005 ETH and 1000 AGE");

  console.log("\n--- Test 1: Transfer with fees (A -> B, both non-exempt) ---");
  const carbonBefore = await token.balanceOf(CARBON_WALLET);
  const communityBefore = await token.balanceOf(COMMUNITY_WALLET);

  tx = await token.connect(walletA).transfer(walletB.address, hre.ethers.parseUnits("100", 18));
  await tx.wait();

  const carbonAfter = await token.balanceOf(CARBON_WALLET);
  const communityAfter = await token.balanceOf(COMMUNITY_WALLET);
  const bBalance = await token.balanceOf(walletB.address);

  console.log("Sent: 100 AGE from A to B");
  console.log("B received:", fmt(bBalance), "AGE (expect 98.5)");
  console.log("Carbon wallet gained:", fmt(carbonAfter - carbonBefore), "AGE (expect 0.5)");
  console.log("Community wallet gained:", fmt(communityAfter - communityBefore), "AGE (expect 1.0)");

  console.log("\n--- Test 2: Staking ---");
  const aBalanceBeforeStake = await token.balanceOf(walletA.address);
  tx = await token.connect(walletA).stake(hre.ethers.parseUnits("200", 18));
  await tx.wait();
  const staked = await token.stakedBalance(walletA.address);
  const aBalanceAfterStake = await token.balanceOf(walletA.address);
  console.log("Staked amount recorded:", fmt(staked), "AGE (expect 200)");
  console.log("A balance dropped by:", fmt(aBalanceBeforeStake - aBalanceAfterStake), "AGE (expect 200, no fee)");

  console.log("\n--- Test 3: Unstaking ---");
  tx = await token.connect(walletA).unstake(hre.ethers.parseUnits("200", 18));
  await tx.wait();
  const stakedAfter = await token.stakedBalance(walletA.address);
  const aBalanceAfterUnstake = await token.balanceOf(walletA.address);
  console.log("Staked amount after unstake:", fmt(stakedAfter), "AGE (expect 0)");
  console.log("A balance restored to:", fmt(aBalanceAfterUnstake), "AGE (expect back to pre-stake amount, no fee)");

  console.log("\nAll tests complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
