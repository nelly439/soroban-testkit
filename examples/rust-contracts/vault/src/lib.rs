//! Example "vault" contract for soroban-testkit.
//!
//! Built normally it is the CLEAN contract. Built with `--features buggy`
//! it carries six planted defects, each marked `PLANTED BUG`, one per
//! soroban-testkit check:
//!
//! | function   | planted defect                               | check              |
//! |------------|----------------------------------------------|--------------------|
//! | `div_by`   | traps when `amount == 0`                     | no-unexpected-trap |
//! | `first`    | traps when `items` is empty                  | no-unexpected-trap |
//! | `balance`  | a getter that writes to storage              | read-only          |
//! | `roll`     | result depends on the PRNG                   | deterministic      |
//! | `compute`  | does 40% more work                           | cost-regression    |
//! | `transfer` | no balance check; balance can go negative    | custom-property    |
#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Bytes, Env, Vec};

/// Errors returned by the vault.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VaultError {
    DivByZero = 1,
    NegativeAmount = 2,
    InsufficientBalance = 3,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Balance(Address),
    LastSeen(Address),
}

/// Every account starts with this balance.
const START_BALANCE: i128 = 1000;

#[contract]
pub struct Vault;

fn balance_of(env: &Env, who: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Balance(who.clone()))
        .unwrap_or(START_BALANCE)
}

#[contractimpl]
impl Vault {
    /// Returns 1_000_000 / amount.
    pub fn div_by(_env: Env, amount: i128) -> Result<i128, VaultError> {
        #[cfg(not(feature = "buggy"))]
        if amount == 0 {
            return Err(VaultError::DivByZero);
        }
        // PLANTED BUG (buggy build): no zero check, so this panics on 0.
        Ok(1_000_000 / amount)
    }

    /// Returns the first element, if any.
    pub fn first(_env: Env, items: Vec<u32>) -> Option<u32> {
        #[cfg(not(feature = "buggy"))]
        {
            items.first()
        }
        // PLANTED BUG (buggy build): unwraps the first element of a possibly empty vec.
        #[cfg(feature = "buggy")]
        {
            Some(items.get(0).unwrap())
        }
    }

    /// Reads the balance of an account.
    pub fn balance(env: Env, who: Address) -> i128 {
        // PLANTED BUG (buggy build): a getter that also writes.
        #[cfg(feature = "buggy")]
        env.storage()
            .temporary()
            .set(&DataKey::LastSeen(who.clone()), &env.ledger().sequence());
        balance_of(&env, &who)
    }

    /// Derives a number from a salt.
    pub fn roll(env: Env, salt: u32) -> u64 {
        let digest = env.crypto().sha256(&Bytes::from_array(&env, &salt.to_be_bytes()));
        let bytes = digest.to_array();
        let mut out = [0u8; 8];
        out.copy_from_slice(&bytes[..8]);
        let value = u64::from_be_bytes(out);
        // PLANTED BUG (buggy build): mixes in the PRNG, so repeated calls differ.
        #[cfg(feature = "buggy")]
        let value = value ^ env.prng().gen::<u64>();
        value
    }

    /// Does some arithmetic.
    pub fn compute(_env: Env, n: u32) -> u64 {
        let base: u64 = 20_000 + (n % 1000) as u64;
        // PLANTED BUG (buggy build): 40% more iterations.
        #[cfg(feature = "buggy")]
        let base = base * 14 / 10;
        let mut x: u64 = n as u64 | 1;
        let mut i: u64 = 0;
        while i < base {
            // xorshift: data-dependent, so the optimiser cannot remove the loop
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            i += 1;
        }
        x
    }

    /// Moves `amount` from `from` to `to`; returns the sender balance after the transfer.
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) -> Result<i128, VaultError> {
        from.require_auth();
        if amount < 0 {
            return Err(VaultError::NegativeAmount);
        }
        let from_balance = balance_of(&env, &from);
        #[cfg(not(feature = "buggy"))]
        if amount > from_balance {
            return Err(VaultError::InsufficientBalance);
        }
        // PLANTED BUG (buggy build): without the check above the balance can go negative.
        let new_from = from_balance - amount;
        let new_to = balance_of(&env, &to).saturating_add(amount);
        env.storage().persistent().set(&DataKey::Balance(from), &new_from);
        env.storage().persistent().set(&DataKey::Balance(to), &new_to);
        Ok(new_from)
    }
}
