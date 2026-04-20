//! `Ident` — namespaced string identifier, shaped after Minecraft's
//! `ResourceLocation`: `"<namespace>:<path>"`.
//!
//! Used as the public name for every registry entry (blocks, items,
//! recipes, biomes, …). Validation is strict up-front so bad IDs
//! never reach the registry or the wire protocol.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Ident {
    namespace: String,
    path: String,
}

#[derive(Debug, Error)]
pub enum IdentParseError {
    #[error("missing ':' separator in identifier `{0}`")]
    MissingSeparator(String),
    #[error("empty namespace in identifier `{0}`")]
    EmptyNamespace(String),
    #[error("empty path in identifier `{0}`")]
    EmptyPath(String),
    #[error(
        "invalid character {ch:?} in {part} of identifier `{full}`"
    )]
    InvalidChar {
        ch: char,
        part: &'static str,
        full: String,
    },
}

impl Ident {
    pub fn new(
        namespace: impl Into<String>,
        path: impl Into<String>,
    ) -> Result<Self, IdentParseError> {
        let namespace = namespace.into();
        let path = path.into();
        let full = format!("{namespace}:{path}");
        validate(&namespace, is_namespace_char, "namespace", &full)?;
        validate(&path, is_path_char, "path", &full)?;
        if namespace.is_empty() {
            return Err(IdentParseError::EmptyNamespace(full));
        }
        if path.is_empty() {
            return Err(IdentParseError::EmptyPath(full));
        }
        Ok(Self { namespace, path })
    }

    #[inline]
    pub fn namespace(&self) -> &str {
        &self.namespace
    }

    #[inline]
    pub fn path(&self) -> &str {
        &self.path
    }
}

fn validate(
    s: &str,
    ok: fn(char) -> bool,
    part: &'static str,
    full: &str,
) -> Result<(), IdentParseError> {
    if let Some(ch) = s.chars().find(|c| !ok(*c)) {
        return Err(IdentParseError::InvalidChar {
            ch,
            part,
            full: full.to_string(),
        });
    }
    Ok(())
}

fn is_namespace_char(c: char) -> bool {
    c.is_ascii_lowercase()
        || c.is_ascii_digit()
        || matches!(c, '_' | '-' | '.')
}

fn is_path_char(c: char) -> bool {
    is_namespace_char(c) || c == '/'
}

impl FromStr for Ident {
    type Err = IdentParseError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let (ns, path) = s
            .split_once(':')
            .ok_or_else(|| IdentParseError::MissingSeparator(s.to_string()))?;
        Self::new(ns, path)
    }
}

impl TryFrom<String> for Ident {
    type Error = IdentParseError;

    fn try_from(s: String) -> Result<Self, Self::Error> {
        s.parse()
    }
}

impl From<Ident> for String {
    fn from(id: Ident) -> Self {
        id.to_string()
    }
}

impl fmt::Display for Ident {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.namespace, self.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic() {
        let id: Ident = "voidborne:stone".parse().unwrap();
        assert_eq!(id.namespace(), "voidborne");
        assert_eq!(id.path(), "stone");
        assert_eq!(id.to_string(), "voidborne:stone");
    }

    #[test]
    fn allows_slashes_in_path() {
        let id: Ident = "mymod:block/machines/smelter".parse().unwrap();
        assert_eq!(id.path(), "block/machines/smelter");
    }

    #[test]
    fn rejects_uppercase() {
        assert!("Voidborne:stone".parse::<Ident>().is_err());
    }

    #[test]
    fn rejects_missing_separator() {
        assert!("stone".parse::<Ident>().is_err());
    }

    #[test]
    fn rejects_empty_parts() {
        assert!(":stone".parse::<Ident>().is_err());
        assert!("voidborne:".parse::<Ident>().is_err());
    }
}
