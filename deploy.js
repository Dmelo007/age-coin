const hre = require("hardhat");

const CARBON_OFFSET_WALLET = "0xec994b9220a4eC0A12F9625192B545Af8D2179a1";
const COMMUNITY_FUND_WALLET = "0x6f72Aa8FDb351743B4B2bA33Cd45027AAb86D84F";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const AGECoin = await hre.ethers.getContractFactory("AGECoin");
  const token = await AGECoin.deploy(CARBON_OFFSET_WALLET, COMMUNITY_FUND_WALLET);
  await token.waitForDeployment();

  const address = await token.getAddress();
  console.log("AGECoin deployed to:", address);

  const supply = await token.totalSupply();
  const deployerBalance = await token.balanceOf(deployer.address);
  console.log("Total supply:", hre.ethers.formatUnits(supply, 18), "AGE");
  console.log("Deployer balance:", hre.ethers.formatUnits(deployerBalance, 18), "AGE");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
