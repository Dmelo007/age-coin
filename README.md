# AGE Coin

A fixed-supply ERC-20 token with automatic impact fees, self-funding staking rewards, and a self-healing circuit breaker. Built with Hardhat 2 and OpenZeppelin v5.

- **Total supply:** 10,000,000 AGE, fixed forever — no minting function exists
- **Transfer fees:** 0.5% to a carbon offset wallet, 1.0% to a community fund, 0.2% to a staking reward pool — 1.7% total, automatic on every non-exempt transfer
- **Staking:** lock/unlock AGE in the contract any time, no lock-up period, rewards funded entirely by fee revenue (never minted), halving every 2 years
- **Circuit breaker:** watches transfer volume via a sliding time window and automatically restricts, then automatically recovers, without human intervention — unstaking and claiming rewards are never affected
- **Ownership:** a 2-of-2 multisig (Safe), not a single private key

Currently deployed and verified on the **Sepolia testnet** — see `dapp/index.html` for the live-connected interface, or open the whitepaper page from its footer for full details.

## Project layout

- `contracts/AGECoin.sol` — the main token contract
- `contracts/LinkTreasuryTimelock.sol` — a standalone, code-enforced timelock for treasury holdings (unrelated to the main token)
- `contracts/mocks/` — test-only stand-ins, never deployed for real
- `contracts/echidna/` — property-based fuzz testing harness
- `sui-contracts/` — a Move-language equivalent timelock for the Sui network
- `test/` — the Hardhat test suite
- `dapp/index.html` — the live dapp interface (wallet connect, staking, whitepaper)
- `deploy.js` — deployment script

## Commands

```shell
npx hardhat compile
npx hardhat test
npx hardhat run deploy.js --network sepolia
npx hardhat verify --network sepolia <address> <carbonWallet> <communityWallet>
```

Fuzz testing (requires Echidna installed separately):

```shell
echidna . --contract EchidnaAGECoin --config echidna.yaml
```
