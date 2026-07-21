/// A.G.E. CO. — SUI TREASURY TIMELOCK
///
/// Holds SUI and releases the full balance to a fixed beneficiary only
/// once the Sui network clock reaches release_time_ms. There is no
/// admin, no owner, and no early-withdrawal path of any kind — once
/// locked, nobody (including A.G.E. CO. itself) can move these funds
/// before the release time. This mirrors the LINK-side Ethereum
/// timelock so both halves of the treasury are code-enforced the
/// same way, not just a written promise.
module age_treasury_timelock::treasury_timelock {
    use sui::coin::{Self, Coin};
    use sui::balance::{Self, Balance};
    use sui::sui::SUI;
    use sui::clock::{Self, Clock};
    use sui::transfer;

    /// Thrown when release() is called before release_time_ms.
    const ELockedStillActive: u64 = 0;
    /// Thrown when trying to create a lock whose release time is not
    /// actually in the future.
    const EReleaseTimeNotInFuture: u64 = 1;

    public struct LockedTreasury has key {
        id: UID,
        balance: Balance<SUI>,
        beneficiary: address,
        release_time_ms: u64,
    }

    /// Creates a new locked treasury as a shared object so anyone can
    /// later call `release` — funds still only ever go to the fixed
    /// beneficiary chosen here at creation time.
    public fun lock(
        payment: Coin<SUI>,
        beneficiary: address,
        release_time_ms: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(release_time_ms > clock::timestamp_ms(clock), EReleaseTimeNotInFuture);
        let treasury = LockedTreasury {
            id: object::new(ctx),
            balance: coin::into_balance(payment),
            beneficiary,
            release_time_ms,
        };
        transfer::share_object(treasury);
    }

    /// Anyone may add more SUI to an existing lock before it's released.
    public fun deposit_more(treasury: &mut LockedTreasury, payment: Coin<SUI>) {
        balance::join(&mut treasury.balance, coin::into_balance(payment));
    }

    /// Anyone may call this once unlocked; funds always go to the
    /// fixed beneficiary recorded at creation time. Consumes the
    /// treasury object — this is a one-time, final release.
    public fun release(treasury: LockedTreasury, clock: &Clock, ctx: &mut TxContext) {
        assert!(clock::timestamp_ms(clock) >= treasury.release_time_ms, ELockedStillActive);
        let LockedTreasury { id, balance, beneficiary, release_time_ms: _ } = treasury;
        object::delete(id);
        transfer::public_transfer(coin::from_balance(balance, ctx), beneficiary);
    }

    public fun beneficiary(treasury: &LockedTreasury): address {
        treasury.beneficiary
    }

    public fun release_time_ms(treasury: &LockedTreasury): u64 {
        treasury.release_time_ms
    }

    public fun locked_amount(treasury: &LockedTreasury): u64 {
        balance::value(&treasury.balance)
    }
}
