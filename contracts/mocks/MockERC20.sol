// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Test-only stand-in for a real ERC-20 token (e.g. LINK). Never deploy
// this to mainnet — it exists purely so we can test
// LinkTreasuryTimelock.sol without touching any real token.

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol, uint256 initialSupply) ERC20(name, symbol) {
        _mint(msg.sender, initialSupply);
    }
}
