require("@nomicfoundation/hardhat-toolbox");
const { vars } = require("hardhat/config");

module.exports = {
  solidity: "0.8.28",
  networks: {
    sepolia: {
      url: "https://ethereum-sepolia-rpc.publicnode.com",
      accounts: vars.has("SEPOLIA_PRIVATE_KEY")
        ? [vars.get("SEPOLIA_PRIVATE_KEY")]
        : [],
    },
  },
};