//! voidborne-registry — typed, freezable registries shared between the
//! core engine and mods.
//!
//! ## Lifecycle
//!
//! A registry has two phases:
//!
//! 1. **Open** — mods may `register` new entries. Each entry gets a
//!    stable `RawId` assigned in insertion order.
//! 2. **Frozen** — calling [`Registry::freeze`] seals the registry;
//!    further writes return an error. All lookups are lock-free and
//!    O(1) once frozen.
//!
//! Registries are frozen at the end of the "Register" mod-load phase
//! and stay frozen for the rest of the session. Save files record
//! the namespaced `Ident` of each entry so `RawId`s may differ
//! between runs without breaking persistence.
//!
//! ## Tags
//!
//! A [`TagMap`] groups entries under a named tag (e.g.
//! `#voidborne:ores`). Tags are populated during the same register
//! phase and frozen alongside the registry they describe.

use std::fmt;

use ahash::AHashMap;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use voidborne_util::Ident;

/// Numeric handle into a [`Registry`].
///
/// The raw value is an implementation detail: it is stable **within
/// a single run**, but may be reassigned the next time the registry
/// is built (e.g. after adding a mod). Persist the entry's [`Ident`]
/// instead.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub struct RawId(pub u32);

impl RawId {
    #[inline]
    pub const fn raw(self) -> u32 {
        self.0
    }
}

impl fmt::Display for RawId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "#{}", self.0)
    }
}

#[derive(Debug, Error)]
pub enum RegistryError {
    #[error("registry `{registry}` is frozen")]
    Frozen { registry: &'static str },
    #[error("duplicate identifier `{id}` in registry `{registry}`")]
    Duplicate {
        registry: &'static str,
        id: Ident,
    },
    #[error("unknown identifier `{id}` in registry `{registry}`")]
    Unknown {
        registry: &'static str,
        id: Ident,
    },
}

/// Typed registry storing one `T` per namespaced [`Ident`].
pub struct Registry<T> {
    name: &'static str,
    entries: Vec<Entry<T>>,
    by_ident: AHashMap<Ident, RawId>,
    frozen: bool,
}

struct Entry<T> {
    id: Ident,
    value: T,
}

impl<T> Registry<T> {
    pub fn new(name: &'static str) -> Self {
        Self {
            name,
            entries: Vec::new(),
            by_ident: AHashMap::new(),
            frozen: false,
        }
    }

    #[inline]
    pub fn name(&self) -> &'static str {
        self.name
    }

    #[inline]
    pub fn is_frozen(&self) -> bool {
        self.frozen
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Register a new entry. Fails if the registry is frozen or the
    /// identifier is already taken.
    pub fn register(
        &mut self,
        id: Ident,
        value: T,
    ) -> Result<RawId, RegistryError> {
        if self.frozen {
            return Err(RegistryError::Frozen { registry: self.name });
        }
        if self.by_ident.contains_key(&id) {
            return Err(RegistryError::Duplicate {
                registry: self.name,
                id,
            });
        }
        let raw = RawId(self.entries.len() as u32);
        self.by_ident.insert(id.clone(), raw);
        self.entries.push(Entry { id, value });
        Ok(raw)
    }

    /// Seal the registry. Subsequent `register` calls fail.
    pub fn freeze(&mut self) {
        self.frozen = true;
    }

    pub fn get(&self, raw: RawId) -> Option<&T> {
        self.entries.get(raw.0 as usize).map(|e| &e.value)
    }

    pub fn get_by_ident(&self, id: &Ident) -> Option<(RawId, &T)> {
        let raw = *self.by_ident.get(id)?;
        self.entries.get(raw.0 as usize).map(|e| (raw, &e.value))
    }

    pub fn ident_of(&self, raw: RawId) -> Option<&Ident> {
        self.entries.get(raw.0 as usize).map(|e| &e.id)
    }

    pub fn raw_of(&self, id: &Ident) -> Option<RawId> {
        self.by_ident.get(id).copied()
    }

    pub fn iter(&self) -> impl Iterator<Item = (RawId, &Ident, &T)> {
        self.entries
            .iter()
            .enumerate()
            .map(|(i, e)| (RawId(i as u32), &e.id, &e.value))
    }
}

/// Named group of registry entries (`#voidborne:ores`, `#energy:cables`, …).
pub struct TagMap<T> {
    name: &'static str,
    tags: AHashMap<Ident, Vec<RawId>>,
    frozen: bool,
    _marker: std::marker::PhantomData<fn() -> T>,
}

impl<T> TagMap<T> {
    pub fn new(name: &'static str) -> Self {
        Self {
            name,
            tags: AHashMap::new(),
            frozen: false,
            _marker: std::marker::PhantomData,
        }
    }

    pub fn add(
        &mut self,
        tag: Ident,
        entry: RawId,
    ) -> Result<(), RegistryError> {
        if self.frozen {
            return Err(RegistryError::Frozen { registry: self.name });
        }
        let members = self.tags.entry(tag).or_default();
        if !members.contains(&entry) {
            members.push(entry);
        }
        Ok(())
    }

    pub fn freeze(&mut self) {
        self.frozen = true;
        for members in self.tags.values_mut() {
            members.sort_by_key(|r| r.0);
        }
    }

    pub fn members(&self, tag: &Ident) -> &[RawId] {
        self.tags.get(tag).map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn contains(&self, tag: &Ident, entry: RawId) -> bool {
        self.members(tag).iter().any(|r| *r == entry)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ident(s: &str) -> Ident {
        s.parse().unwrap()
    }

    #[test]
    fn register_and_lookup() {
        let mut reg: Registry<&'static str> = Registry::new("block");
        let a = reg.register(ident("voidborne:stone"), "stone").unwrap();
        let b = reg.register(ident("voidborne:dirt"), "dirt").unwrap();
        assert_ne!(a, b);
        assert_eq!(reg.get(a).copied(), Some("stone"));
        assert_eq!(
            reg.get_by_ident(&ident("voidborne:dirt")).map(|(_, v)| *v),
            Some("dirt"),
        );
    }

    #[test]
    fn duplicate_registration_fails() {
        let mut reg: Registry<u32> = Registry::new("item");
        reg.register(ident("voidborne:pick"), 1).unwrap();
        let err = reg
            .register(ident("voidborne:pick"), 2)
            .expect_err("duplicate should fail");
        matches!(err, RegistryError::Duplicate { .. });
    }

    #[test]
    fn freeze_blocks_further_writes() {
        let mut reg: Registry<u32> = Registry::new("item");
        reg.register(ident("voidborne:rock"), 1).unwrap();
        reg.freeze();
        let err = reg
            .register(ident("voidborne:leaf"), 2)
            .expect_err("frozen should reject");
        matches!(err, RegistryError::Frozen { .. });
    }

    #[test]
    fn tags_group_entries() {
        let mut reg: Registry<u32> = Registry::new("block");
        let coal = reg.register(ident("voidborne:coal_ore"), 1).unwrap();
        let iron = reg.register(ident("voidborne:iron_ore"), 2).unwrap();
        let stone = reg.register(ident("voidborne:stone"), 3).unwrap();

        let mut tags: TagMap<u32> = TagMap::new("block");
        let ores = ident("voidborne:ores");
        tags.add(ores.clone(), coal).unwrap();
        tags.add(ores.clone(), iron).unwrap();
        tags.freeze();

        assert!(tags.contains(&ores, coal));
        assert!(tags.contains(&ores, iron));
        assert!(!tags.contains(&ores, stone));
        assert_eq!(tags.members(&ores).len(), 2);
    }
}
