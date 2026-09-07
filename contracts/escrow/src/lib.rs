#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, Env};

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OrderStatus {
    Created,
    Attested,
    Claimed,
    Reclaimed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Order {
    pub buyer: Address,
    pub seller: Address,
    pub attestor: Address,
    pub token: Address,
    pub amount: i128,
    pub deadline: u64,
    pub status: OrderStatus,
}

#[contracttype]
enum DataKey {
    Order,
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    AmountNotPositive = 3,
    DeadlineNotInFuture = 4,
    WrongStatus = 5,
    DeadlineNotYetPassed = 6,
    DeadlinePassed = 7,
}

const LEDGERS_PER_DAY: u32 = 17280; // ~5s ledger close time
const STORAGE_TTL_DAYS: u32 = 30;
const STORAGE_TTL_LEDGERS: u32 = LEDGERS_PER_DAY * STORAGE_TTL_DAYS;
const STORAGE_TTL_THRESHOLD: u32 = STORAGE_TTL_LEDGERS - LEDGERS_PER_DAY;

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Buyer funds a new order. Pulls `amount` of `token` from `buyer` into
    /// this contract. One order per deployed contract instance.
    pub fn create(
        env: Env,
        buyer: Address,
        seller: Address,
        attestor: Address,
        token: Address,
        amount: i128,
        deadline: u64,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Order) {
            return Err(Error::AlreadyInitialized);
        }
        if amount <= 0 {
            return Err(Error::AmountNotPositive);
        }
        if deadline <= env.ledger().timestamp() {
            return Err(Error::DeadlineNotInFuture);
        }

        buyer.require_auth();

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&buyer, &env.current_contract_address(), &amount);

        let order = Order {
            buyer,
            seller,
            attestor,
            token,
            amount,
            deadline,
            status: OrderStatus::Created,
        };
        env.storage().instance().set(&DataKey::Order, &order);
        env.storage()
            .instance()
            .extend_ttl(STORAGE_TTL_THRESHOLD, STORAGE_TTL_LEDGERS);

        Ok(())
    }

    /// The designated attestor confirms delivery. Must happen before the
    /// deadline and while the order is still in `Created` status.
    pub fn attest(env: Env) -> Result<(), Error> {
        let mut order = Self::load(&env)?;

        if order.status != OrderStatus::Created {
            return Err(Error::WrongStatus);
        }
        if env.ledger().timestamp() >= order.deadline {
            return Err(Error::DeadlinePassed);
        }

        order.attestor.require_auth();

        order.status = OrderStatus::Attested;
        env.storage().instance().set(&DataKey::Order, &order);
        env.storage()
            .instance()
            .extend_ttl(STORAGE_TTL_THRESHOLD, STORAGE_TTL_LEDGERS);

        Ok(())
    }

    /// The seller claims the escrowed funds once delivery has been attested.
    pub fn claim(env: Env) -> Result<(), Error> {
        let mut order = Self::load(&env)?;

        if order.status != OrderStatus::Attested {
            return Err(Error::WrongStatus);
        }

        order.seller.require_auth();

        let token_client = token::Client::new(&env, &order.token);
        token_client.transfer(&env.current_contract_address(), &order.seller, &order.amount);

        order.status = OrderStatus::Claimed;
        env.storage().instance().set(&DataKey::Order, &order);

        Ok(())
    }

    /// The buyer reclaims the escrowed funds if the deadline has passed
    /// without an attestation.
    pub fn reclaim(env: Env) -> Result<(), Error> {
        let mut order = Self::load(&env)?;

        if order.status != OrderStatus::Created {
            return Err(Error::WrongStatus);
        }
        if env.ledger().timestamp() < order.deadline {
            return Err(Error::DeadlineNotYetPassed);
        }

        order.buyer.require_auth();

        let token_client = token::Client::new(&env, &order.token);
        token_client.transfer(&env.current_contract_address(), &order.buyer, &order.amount);

        order.status = OrderStatus::Reclaimed;
        env.storage().instance().set(&DataKey::Order, &order);

        Ok(())
    }

    /// Buyer and seller mutually agree to cancel an order before attestation.
    /// Requires authorization from both `buyer` and `seller`.
    /// Valid only while `status == Created`.
    /// Returns funds to the buyer and transitions status to `Cancelled`.
    pub fn cancel(env: Env) -> Result<(), Error> {
        let mut order = Self::load(&env)?;

        if order.status != OrderStatus::Created {
            return Err(Error::WrongStatus);
        }

        order.buyer.require_auth();
        order.seller.require_auth();

        let token_client = token::Client::new(&env, &order.token);
        token_client.transfer(&env.current_contract_address(), &order.buyer, &order.amount);

        order.status = OrderStatus::Cancelled;
        env.storage().instance().set(&DataKey::Order, &order);

        Ok(())
    }

    /// Read-only view of the current order state.
    pub fn get_order(env: Env) -> Result<Order, Error> {
        Self::load(&env)
    }

    fn load(env: &Env) -> Result<Order, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Order)
            .ok_or(Error::NotInitialized)
    }
}

#[cfg(test)]
mod test;
