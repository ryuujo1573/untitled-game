//! Append-only string interner.
//!
//! Used by the registry and hot paths that want to talk in `u32`
//! symbols instead of strings. Entries are never removed, so a
//! returned [`Sym`] is valid for the entire lifetime of the
//! interner.

use ahash::AHashMap;
use parking_lot::RwLock;

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub struct Sym(pub u32);

#[derive(Default)]
pub struct Interner {
    inner: RwLock<Inner>,
}

#[derive(Default)]
struct Inner {
    strings: Vec<String>,
    map: AHashMap<String, Sym>,
}

impl Interner {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn intern(&self, s: &str) -> Sym {
        if let Some(sym) = self.inner.read().map.get(s).copied() {
            return sym;
        }
        let mut inner = self.inner.write();
        // Re-check after acquiring the write lock.
        if let Some(sym) = inner.map.get(s).copied() {
            return sym;
        }
        let sym = Sym(inner.strings.len() as u32);
        inner.strings.push(s.to_owned());
        inner.map.insert(s.to_owned(), sym);
        sym
    }

    pub fn get(&self, s: &str) -> Option<Sym> {
        self.inner.read().map.get(s).copied()
    }

    pub fn resolve(&self, sym: Sym) -> Option<String> {
        self.inner.read().strings.get(sym.0 as usize).cloned()
    }

    pub fn len(&self) -> usize {
        self.inner.read().strings.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intern_is_idempotent() {
        let i = Interner::new();
        let a = i.intern("stone");
        let b = i.intern("stone");
        assert_eq!(a, b);
        assert_eq!(i.len(), 1);
    }

    #[test]
    fn resolves_back_to_original() {
        let i = Interner::new();
        let s = i.intern("voidborne:grass_block");
        assert_eq!(
            i.resolve(s).unwrap(),
            "voidborne:grass_block".to_string()
        );
    }

    #[test]
    fn distinct_strings_get_distinct_syms() {
        let i = Interner::new();
        let a = i.intern("a");
        let b = i.intern("b");
        assert_ne!(a, b);
    }
}
