#[test_only]
module age_treasury_timelock::treasury_timelock_tests {
    use sui::test_scenario as ts;
    use sui::clock;
    use sui::coin;
    use sui::sui::SUI;
    use age_treasury_timelock::treasury_timelock::{Self, LockedTreasury};

    const ADMIN: address = @0xA11CE;
    const BENEFICIARY: address = @0xB0B;
    const STRANGER: address = @0xCAFE;

    #[test]
    fun test_lock_and_release_after_time() {
        let mut scenario = ts::begin(ADMIN);
        {
            let ctx = ts::ctx(&mut scenario);
            let mut clock_obj = clock::create_for_testing(ctx);
            clock::set_for_testing(&mut clock_obj, 1000);
            let payment = coin::mint_for_testing<SUI>(500, ctx);
            treasury_timelock::lock(payment, BENEFICIARY, 2000, &clock_obj, ctx);
            clock::destroy_for_testing(clock_obj);
        };
        ts::next_tx(&mut scenario, STRANGER);
        {
            let treasury = ts::take_shared<LockedTreasury>(&scenario);
            let ctx = ts::ctx(&mut scenario);
            let mut clock_obj = clock::create_for_testing(ctx);
            clock::set_for_testing(&mut clock_obj, 2500);
            treasury_timelock::release(treasury, &clock_obj, ctx);
            clock::destroy_for_testing(clock_obj);
        };
        ts::next_tx(&mut scenario, BENEFICIARY);
        {
            let received = ts::take_from_sender<coin::Coin<SUI>>(&scenario);
            assert!(coin::value(&received) == 500, 0);
            ts::return_to_sender(&scenario, received);
        };
        ts::end(scenario);
    }

    #[test, expected_failure(abort_code = 0)]
    fun test_release_before_time_fails() {
        let mut scenario = ts::begin(ADMIN);
        {
            let ctx = ts::ctx(&mut scenario);
            let mut clock_obj = clock::create_for_testing(ctx);
            clock::set_for_testing(&mut clock_obj, 1000);
            let payment = coin::mint_for_testing<SUI>(500, ctx);
            treasury_timelock::lock(payment, BENEFICIARY, 2000, &clock_obj, ctx);
            clock::destroy_for_testing(clock_obj);
        };
        ts::next_tx(&mut scenario, STRANGER);
        {
            let treasury = ts::take_shared<LockedTreasury>(&scenario);
            let ctx = ts::ctx(&mut scenario);
            let mut clock_obj = clock::create_for_testing(ctx);
            // Still before the 2000ms release time.
            clock::set_for_testing(&mut clock_obj, 1500);
            treasury_timelock::release(treasury, &clock_obj, ctx);
            clock::destroy_for_testing(clock_obj);
        };
        ts::end(scenario);
    }

    #[test, expected_failure(abort_code = 1)]
    fun test_lock_with_past_release_time_fails() {
        let mut scenario = ts::begin(ADMIN);
        {
            let ctx = ts::ctx(&mut scenario);
            let mut clock_obj = clock::create_for_testing(ctx);
            clock::set_for_testing(&mut clock_obj, 5000);
            let payment = coin::mint_for_testing<SUI>(500, ctx);
            // release time (1000) is not in the future relative to clock (5000).
            treasury_timelock::lock(payment, BENEFICIARY, 1000, &clock_obj, ctx);
            clock::destroy_for_testing(clock_obj);
        };
        ts::end(scenario);
    }

    #[test]
    fun test_deposit_more_increases_locked_amount() {
        let mut scenario = ts::begin(ADMIN);
        {
            let ctx = ts::ctx(&mut scenario);
            let mut clock_obj = clock::create_for_testing(ctx);
            clock::set_for_testing(&mut clock_obj, 1000);
            let payment = coin::mint_for_testing<SUI>(500, ctx);
            treasury_timelock::lock(payment, BENEFICIARY, 2000, &clock_obj, ctx);
            clock::destroy_for_testing(clock_obj);
        };
        ts::next_tx(&mut scenario, STRANGER);
        {
            let mut treasury = ts::take_shared<LockedTreasury>(&scenario);
            let ctx = ts::ctx(&mut scenario);
            let more = coin::mint_for_testing<SUI>(250, ctx);
            treasury_timelock::deposit_more(&mut treasury, more);
            assert!(treasury_timelock::locked_amount(&treasury) == 750, 0);
            ts::return_shared(treasury);
        };
        ts::end(scenario);
    }

    #[test]
    fun test_anyone_can_call_release_but_funds_go_to_beneficiary() {
        let mut scenario = ts::begin(ADMIN);
        {
            let ctx = ts::ctx(&mut scenario);
            let mut clock_obj = clock::create_for_testing(ctx);
            clock::set_for_testing(&mut clock_obj, 1000);
            let payment = coin::mint_for_testing<SUI>(500, ctx);
            treasury_timelock::lock(payment, BENEFICIARY, 2000, &clock_obj, ctx);
            clock::destroy_for_testing(clock_obj);
        };
        // A totally unrelated account triggers release.
        ts::next_tx(&mut scenario, STRANGER);
        {
            let treasury = ts::take_shared<LockedTreasury>(&scenario);
            let ctx = ts::ctx(&mut scenario);
            let mut clock_obj = clock::create_for_testing(ctx);
            clock::set_for_testing(&mut clock_obj, 9999);
            treasury_timelock::release(treasury, &clock_obj, ctx);
            clock::destroy_for_testing(clock_obj);
        };
        // Funds must have gone to BENEFICIARY, not STRANGER.
        ts::next_tx(&mut scenario, BENEFICIARY);
        {
            let received = ts::take_from_sender<coin::Coin<SUI>>(&scenario);
            assert!(coin::value(&received) == 500, 0);
            ts::return_to_sender(&scenario, received);
        };
        ts::end(scenario);
    }
}
