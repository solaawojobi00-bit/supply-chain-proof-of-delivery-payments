#![cfg(test)]
extern crate std;

use ::proptest::prelude::*;
use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{BytesN, Env, Vec};
use std::vec::Vec as StdVec;

fn create_token(
    env: &Env,
    admin: &Address,
) -> (
    Address,
    token::StellarAssetClient<'static>,
    token::Client<'static>,
) {
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let asset_client = token::StellarAssetClient::new(env, &sac.address());
    let token_client = token::Client::new(env, &sac.address());
    (sac.address(), asset_client, token_client)
}

struct FuzzContext {
    env: Env,
    contract_id: Address,
    client: EscrowRegistryContractClient<'static>,
    token_address: Address,
    token_client: token::Client<'static>,
    buyers: [Address; 3],
    sellers: [Address; 3],
    attestor_pool: [Address; 6],
    arbiter: Address,
    initial_buyer_mint: i128,
}

impl FuzzContext {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let buyers = [
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
        ];
        let sellers = [
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
        ];
        let attestor_pool = [
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
        ];

        let (token_address, asset_client, token_client) = create_token(&env, &admin);
        let initial_buyer_mint: i128 = 100_000_000_000; // Large pool
        for buyer in &buyers {
            asset_client.mint(buyer, &initial_buyer_mint);
        }

        let contract_id = env.register(EscrowRegistryContract, ());
        let client = EscrowRegistryContractClient::new(&env, &contract_id);

        Self {
            env,
            contract_id,
            client,
            token_address,
            token_client,
            buyers,
            sellers,
            attestor_pool,
            arbiter,
            initial_buyer_mint,
        }
    }

    fn check_all_invariants(&self, active_order_ids: &[u64]) {
        self.assert_invariant_funds_conservation();
        self.assert_invariant_contract_balance_equals_active_escrows(active_order_ids);
        for &id in active_order_ids {
            if let Ok(order) = self.client.try_get_order(&id) {
                let order = order.unwrap();
                self.assert_order_invariants(&order);
            }
        }
    }

    fn assert_invariant_funds_conservation(&self) {
        let total_initial = self.initial_buyer_mint * (self.buyers.len() as i128);
        let mut total_now = self.token_client.balance(&self.contract_id);
        for b in &self.buyers {
            total_now += self.token_client.balance(b);
        }
        for s in &self.sellers {
            total_now += self.token_client.balance(s);
        }
        assert_eq!(
            total_now, total_initial,
            "Invariant Violation: Total funds conservation failed"
        );
    }

    fn assert_invariant_contract_balance_equals_active_escrows(&self, active_order_ids: &[u64]) {
        let mut sum_active_escrows: i128 = 0;
        for &id in active_order_ids {
            if let Ok(order) = self.client.try_get_order(&id) {
                let order = order.unwrap();
                if order.status == OrderStatus::Created
                    || order.status == OrderStatus::Attested
                    || order.status == OrderStatus::Disputed
                {
                    sum_active_escrows += order.amount;
                }
            }
        }
        let contract_balance = self.token_client.balance(&self.contract_id);
        assert_eq!(
            contract_balance, sum_active_escrows,
            "Invariant Violation: Contract token balance does not equal sum of active orders"
        );
    }

    fn assert_order_invariants(&self, order: &Order) {
        // Invariant 3: Confirmations count is bounded by attestors set size
        assert!(
            order.confirmations.len() <= order.attestors.len(),
            "Invariant Violation: Confirmations exceed attestor set size"
        );

        // All confirmations must be members of the order's attestor set
        for conf in order.confirmations.iter() {
            assert!(
                order.attestors.contains(&conf),
                "Invariant Violation: Confirmation exists from non-member attestor"
            );
        }
    }
}

#[derive(Clone, Debug)]
enum FuzzAction {
    CreateOrder {
        order_id: u64,
        buyer_idx: usize,
        seller_idx: usize,
        threshold: u32,
        num_attestors: usize,
        amount: i128,
        deadline_offset: u64,
    },
    Attest {
        order_id: u64,
        attestor_idx: usize,
    },
    RotateAttestor {
        order_id: u64,
        old_attestor_idx: usize,
        new_attestor_idx: usize,
    },
    ExtendDeadline {
        order_id: u64,
        extension_secs: u64,
    },
    Dispute {
        order_id: u64,
        with_evidence: bool,
    },
    ResolveDispute {
        order_id: u64,
        release_to_seller: bool,
    },
    Claim {
        order_id: u64,
    },
    Reclaim {
        order_id: u64,
    },
    Cancel {
        order_id: u64,
    },
    AdvanceTime {
        seconds: u64,
    },
}

fn action_strategy() -> impl Strategy<Value = FuzzAction> {
    prop_oneof![
        // CreateOrder
        (
            1u64..10u64,
            0usize..3usize,
            0usize..3usize,
            1u32..4u32,
            1usize..5usize,
            1_000_000i128..50_000_000i128,
            100u64..5000u64,
        )
            .prop_map(
                |(
                    order_id,
                    buyer_idx,
                    seller_idx,
                    threshold,
                    num_attestors,
                    amount,
                    deadline_offset,
                )| {
                    FuzzAction::CreateOrder {
                        order_id,
                        buyer_idx,
                        seller_idx,
                        threshold,
                        num_attestors,
                        amount,
                        deadline_offset,
                    }
                }
            ),
        // Attest
        (1u64..10u64, 0usize..6usize)
            .prop_map(|(order_id, attestor_idx)| FuzzAction::Attest {
                order_id,
                attestor_idx
            }),
        // RotateAttestor
        (1u64..10u64, 0usize..6usize, 0usize..6usize).prop_map(
            |(order_id, old_attestor_idx, new_attestor_idx)| FuzzAction::RotateAttestor {
                order_id,
                old_attestor_idx,
                new_attestor_idx,
            }
        ),
        // ExtendDeadline
        (1u64..10u64, 100u64..3000u64).prop_map(|(order_id, extension_secs)| {
            FuzzAction::ExtendDeadline {
                order_id,
                extension_secs,
            }
        }),
        // Dispute
        (1u64..10u64, any::<bool>()).prop_map(|(order_id, with_evidence)| FuzzAction::Dispute {
            order_id,
            with_evidence
        }),
        // ResolveDispute
        (1u64..10u64, any::<bool>()).prop_map(|(order_id, release_to_seller)| {
            FuzzAction::ResolveDispute {
                order_id,
                release_to_seller,
            }
        }),
        // Claim
        (1u64..10u64).prop_map(|order_id| FuzzAction::Claim { order_id }),
        // Reclaim
        (1u64..10u64).prop_map(|order_id| FuzzAction::Reclaim { order_id }),
        // Cancel
        (1u64..10u64).prop_map(|order_id| FuzzAction::Cancel { order_id }),
        // AdvanceTime
        (10u64..2000u64).prop_map(|seconds| FuzzAction::AdvanceTime { seconds }),
    ]
}

fn apply_fuzz_action(ctx: &mut FuzzContext, action: FuzzAction, active_orders: &mut StdVec<u64>) {
    match action {
        FuzzAction::CreateOrder {
            order_id,
            buyer_idx,
            seller_idx,
            threshold,
            num_attestors,
            amount,
            deadline_offset,
        } => {
            let num = num_attestors.max(1).min(ctx.attestor_pool.len());
            let clamped_threshold = threshold.max(1).min(num as u32);
            let mut attestors_vec = Vec::new(&ctx.env);
            for i in 0..num {
                attestors_vec.push_back(ctx.attestor_pool[i].clone());
            }
            let deadline = ctx.env.ledger().timestamp() + deadline_offset.max(10);
            let res = ctx.client.try_create_order(
                &order_id,
                &ctx.buyers[buyer_idx % ctx.buyers.len()],
                &ctx.sellers[seller_idx % ctx.sellers.len()],
                &attestors_vec,
                &clamped_threshold,
                &ctx.arbiter,
                &ctx.token_address,
                &amount,
                &deadline,
            );
            if res.is_ok() && !active_orders.contains(&order_id) {
                active_orders.push(order_id);
            }
        }
        FuzzAction::Attest {
            order_id,
            attestor_idx,
        } => {
            let attestor = ctx.attestor_pool[attestor_idx % ctx.attestor_pool.len()].clone();
            let _ = ctx.client.try_attest(&order_id, &attestor);
        }
        FuzzAction::RotateAttestor {
            order_id,
            old_attestor_idx,
            new_attestor_idx,
        } => {
            let old_attestor = ctx.attestor_pool[old_attestor_idx % ctx.attestor_pool.len()].clone();
            let new_attestor = ctx.attestor_pool[new_attestor_idx % ctx.attestor_pool.len()].clone();
            let _ = ctx.client.try_rotate_attestor(&order_id, &old_attestor, &new_attestor);
        }
        FuzzAction::ExtendDeadline {
            order_id,
            extension_secs,
        } => {
            if let Ok(order_res) = ctx.client.try_get_order(&order_id) {
                if let Ok(order) = order_res {
                    let new_deadline = order.deadline + extension_secs.max(1);
                    let _ = ctx.client.try_extend_deadline(&order_id, &new_deadline);
                }
            }
        }
        FuzzAction::Dispute {
            order_id,
            with_evidence,
        } => {
            let evidence_hash = if with_evidence {
                Some(BytesN::from_array(&ctx.env, &[99u8; 32]))
            } else {
                None
            };
            let _ = ctx.client.try_dispute(&order_id, &evidence_hash);
        }
        FuzzAction::ResolveDispute {
            order_id,
            release_to_seller,
        } => {
            let _ = ctx.client.try_resolve_dispute(&order_id, &release_to_seller);
        }
        FuzzAction::Claim { order_id } => {
            let _ = ctx.client.try_claim(&order_id);
        }
        FuzzAction::Reclaim { order_id } => {
            let _ = ctx.client.try_reclaim(&order_id);
        }
        FuzzAction::Cancel { order_id } => {
            let _ = ctx.client.try_cancel(&order_id);
        }
        FuzzAction::AdvanceTime { seconds } => {
            ctx.env.ledger().with_mut(|l| l.timestamp += seconds);
        }
    }
}

// ---------------------------------------------------------------------------
// Named Invariant Tests (Issue #68 Requirements)
// ---------------------------------------------------------------------------

#[test]
fn test_invariant_funds_conservation() {
    let mut ctx = FuzzContext::new();
    let mut active_orders = StdVec::new();

    // Create 3 orders
    for id in 1..=3 {
        apply_fuzz_action(
            &mut ctx,
            FuzzAction::CreateOrder {
                order_id: id,
                buyer_idx: (id - 1) as usize,
                seller_idx: (id - 1) as usize,
                threshold: 2,
                num_attestors: 3,
                amount: 10_000_000,
                deadline_offset: 1000,
            },
            &mut active_orders,
        );
        ctx.check_all_invariants(&active_orders);
    }

    // Progress Order 1 to Claimed
    apply_fuzz_action(&mut ctx, FuzzAction::Attest { order_id: 1, attestor_idx: 0 }, &mut active_orders);
    apply_fuzz_action(&mut ctx, FuzzAction::Attest { order_id: 1, attestor_idx: 1 }, &mut active_orders);
    apply_fuzz_action(&mut ctx, FuzzAction::Claim { order_id: 1 }, &mut active_orders);
    ctx.check_all_invariants(&active_orders);

    // Progress Order 2 to Cancelled
    apply_fuzz_action(&mut ctx, FuzzAction::Cancel { order_id: 2 }, &mut active_orders);
    ctx.check_all_invariants(&active_orders);

    // Progress Order 3 to Reclaimed after timeout
    apply_fuzz_action(&mut ctx, FuzzAction::AdvanceTime { seconds: 2000 }, &mut active_orders);
    apply_fuzz_action(&mut ctx, FuzzAction::Reclaim { order_id: 3 }, &mut active_orders);
    ctx.check_all_invariants(&active_orders);
}

#[test]
fn test_invariant_terminal_states_absorbing() {
    let mut ctx = FuzzContext::new();
    let mut active_orders = StdVec::new();

    // Order 1 -> Claimed
    apply_fuzz_action(
        &mut ctx,
        FuzzAction::CreateOrder {
            order_id: 1,
            buyer_idx: 0,
            seller_idx: 0,
            threshold: 1,
            num_attestors: 2,
            amount: 5_000_000,
            deadline_offset: 500,
        },
        &mut active_orders,
    );
    apply_fuzz_action(&mut ctx, FuzzAction::Attest { order_id: 1, attestor_idx: 0 }, &mut active_orders);
    apply_fuzz_action(&mut ctx, FuzzAction::Claim { order_id: 1 }, &mut active_orders);
    let order = ctx.client.get_order(&1);
    assert_eq!(order.status, OrderStatus::Claimed);

    // Every state-mutating operation on a Claimed order must fail
    assert_eq!(ctx.client.try_attest(&1, &ctx.attestor_pool[1]), Err(Ok(Error::WrongStatus)));
    assert_eq!(ctx.client.try_claim(&1), Err(Ok(Error::WrongStatus)));
    assert_eq!(ctx.client.try_reclaim(&1), Err(Ok(Error::WrongStatus)));
    assert_eq!(ctx.client.try_cancel(&1), Err(Ok(Error::WrongStatus)));
    assert_eq!(ctx.client.try_dispute(&1, &None), Err(Ok(Error::WrongStatus)));
    assert_eq!(ctx.client.try_resolve_dispute(&1, &true), Err(Ok(Error::WrongStatus)));
    assert_eq!(
        ctx.client.try_extend_deadline(&1, &(order.deadline + 100)),
        Err(Ok(Error::WrongStatus))
    );
    assert_eq!(
        ctx.client.try_rotate_attestor(&1, &ctx.attestor_pool[0], &ctx.attestor_pool[2]),
        Err(Ok(Error::WrongStatus))
    );

    // Status remains Claimed
    assert_eq!(ctx.client.get_order(&1).status, OrderStatus::Claimed);
}

#[test]
fn test_invariant_confirmations_bounded_by_attestors() {
    let mut ctx = FuzzContext::new();
    let mut active_orders = StdVec::new();

    apply_fuzz_action(
        &mut ctx,
        FuzzAction::CreateOrder {
            order_id: 10,
            buyer_idx: 0,
            seller_idx: 1,
            threshold: 2,
            num_attestors: 3,
            amount: 1_000_000,
            deadline_offset: 1000,
        },
        &mut active_orders,
    );

    let order = ctx.client.get_order(&10);
    assert_eq!(order.attestors.len(), 3);
    assert_eq!(order.confirmations.len(), 0);

    // Attest with all 3 attestors
    apply_fuzz_action(&mut ctx, FuzzAction::Attest { order_id: 10, attestor_idx: 0 }, &mut active_orders);
    apply_fuzz_action(&mut ctx, FuzzAction::Attest { order_id: 10, attestor_idx: 1 }, &mut active_orders);

    // 3rd attestor fails because threshold was 2 and status changed to Attested
    let res = ctx.client.try_attest(&10, &ctx.attestor_pool[2]);
    assert_eq!(res, Err(Ok(Error::WrongStatus)));

    let order_final = ctx.client.get_order(&10);
    assert!(order_final.confirmations.len() <= order_final.attestors.len());
}

#[test]
fn test_invariant_confirmations_monotonicity_except_rotation() {
    let mut ctx = FuzzContext::new();
    let mut active_orders = StdVec::new();

    apply_fuzz_action(
        &mut ctx,
        FuzzAction::CreateOrder {
            order_id: 20,
            buyer_idx: 0,
            seller_idx: 1,
            threshold: 3,
            num_attestors: 4,
            amount: 2_000_000,
            deadline_offset: 1000,
        },
        &mut active_orders,
    );

    // Add 2 confirmations
    apply_fuzz_action(&mut ctx, FuzzAction::Attest { order_id: 20, attestor_idx: 0 }, &mut active_orders);
    assert_eq!(ctx.client.get_order(&20).confirmations.len(), 1);

    apply_fuzz_action(&mut ctx, FuzzAction::Attest { order_id: 20, attestor_idx: 1 }, &mut active_orders);
    assert_eq!(ctx.client.get_order(&20).confirmations.len(), 2);

    // Rotating attestor 0 (who confirmed) drops its confirmation -> count decreases from 2 to 1
    apply_fuzz_action(
        &mut ctx,
        FuzzAction::RotateAttestor {
            order_id: 20,
            old_attestor_idx: 0,
            new_attestor_idx: 5,
        },
        &mut active_orders,
    );
    assert_eq!(ctx.client.get_order(&20).confirmations.len(), 1);

    // Rotating an attestor that did NOT confirm does NOT decrease confirmations
    apply_fuzz_action(
        &mut ctx,
        FuzzAction::RotateAttestor {
            order_id: 20,
            old_attestor_idx: 2,
            new_attestor_idx: 4,
        },
        &mut active_orders,
    );
    assert_eq!(ctx.client.get_order(&20).confirmations.len(), 1);
}

#[test]
fn test_invariant_claim_requires_threshold() {
    let mut ctx = FuzzContext::new();
    let mut active_orders = StdVec::new();

    apply_fuzz_action(
        &mut ctx,
        FuzzAction::CreateOrder {
            order_id: 30,
            buyer_idx: 0,
            seller_idx: 0,
            threshold: 2,
            num_attestors: 3,
            amount: 5_000_000,
            deadline_offset: 1000,
        },
        &mut active_orders,
    );

    // 0 confirmations
    assert_eq!(ctx.client.try_claim(&30), Err(Ok(Error::WrongStatus)));

    // 1 of 2 confirmations
    apply_fuzz_action(&mut ctx, FuzzAction::Attest { order_id: 30, attestor_idx: 0 }, &mut active_orders);
    assert_eq!(ctx.client.try_claim(&30), Err(Ok(Error::WrongStatus)));

    // 2 of 2 confirmations reached -> Claim now succeeds
    apply_fuzz_action(&mut ctx, FuzzAction::Attest { order_id: 30, attestor_idx: 1 }, &mut active_orders);
    assert_eq!(ctx.client.get_order(&30).status, OrderStatus::Attested);
    assert_eq!(ctx.client.try_claim(&30), Ok(Ok(())));
}

#[test]
fn test_invariant_reclaim_requires_deadline_passed() {
    let mut ctx = FuzzContext::new();
    let mut active_orders = StdVec::new();

    apply_fuzz_action(
        &mut ctx,
        FuzzAction::CreateOrder {
            order_id: 40,
            buyer_idx: 0,
            seller_idx: 0,
            threshold: 2,
            num_attestors: 3,
            amount: 5_000_000,
            deadline_offset: 1000,
        },
        &mut active_orders,
    );

    // Reclaim before deadline fails with DeadlineNotYetPassed
    assert_eq!(ctx.client.try_reclaim(&40), Err(Ok(Error::DeadlineNotYetPassed)));

    // Advance time past deadline
    apply_fuzz_action(&mut ctx, FuzzAction::AdvanceTime { seconds: 1500 }, &mut active_orders);

    // Reclaim now succeeds
    assert_eq!(ctx.client.try_reclaim(&40), Ok(Ok(())));
    assert_eq!(ctx.client.get_order(&40).status, OrderStatus::Reclaimed);
}

#[test]
fn test_invariant_contract_balance_equals_active_escrow_sum() {
    let mut ctx = FuzzContext::new();
    let mut active_orders = StdVec::new();

    // Create 4 orders of varying amounts
    let amounts = [1_000_000i128, 2_500_000i128, 4_000_000i128, 7_500_000i128];
    for (idx, &amt) in amounts.iter().enumerate() {
        let id = (idx + 50) as u64;
        apply_fuzz_action(
            &mut ctx,
            FuzzAction::CreateOrder {
                order_id: id,
                buyer_idx: idx % 3,
                seller_idx: idx % 3,
                threshold: 1,
                num_attestors: 2,
                amount: amt,
                deadline_offset: 1000,
            },
            &mut active_orders,
        );
        ctx.assert_invariant_contract_balance_equals_active_escrows(&active_orders);
    }

    assert_eq!(ctx.token_client.balance(&ctx.contract_id), 15_000_000);

    // Settle order 50 (Claimed)
    apply_fuzz_action(&mut ctx, FuzzAction::Attest { order_id: 50, attestor_idx: 0 }, &mut active_orders);
    apply_fuzz_action(&mut ctx, FuzzAction::Claim { order_id: 50 }, &mut active_orders);
    ctx.assert_invariant_contract_balance_equals_active_escrows(&active_orders);
    assert_eq!(ctx.token_client.balance(&ctx.contract_id), 14_000_000);

    // Settle order 51 (Cancelled)
    apply_fuzz_action(&mut ctx, FuzzAction::Cancel { order_id: 51 }, &mut active_orders);
    ctx.assert_invariant_contract_balance_equals_active_escrows(&active_orders);
    assert_eq!(ctx.token_client.balance(&ctx.contract_id), 11_500_000);
}

// ---------------------------------------------------------------------------
// Proptest Generative State Machine Fuzz Suite
// ---------------------------------------------------------------------------

::proptest::proptest! {
    #![proptest_config(::proptest::test_runner::Config {
        cases: 64,
        max_shrink_iters: 100,
        .. ::proptest::test_runner::Config::default()
    })]

    #[test]
    fn test_state_machine_fuzz_proptest(actions in ::proptest::collection::vec(action_strategy(), 1..25)) {
        let mut ctx = FuzzContext::new();
        let mut active_orders = StdVec::new();

        for action in actions {
            apply_fuzz_action(&mut ctx, action, &mut active_orders);
            ctx.check_all_invariants(&active_orders);
        }
    }
}
