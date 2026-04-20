//! voidborne-util — cross-cutting utilities: logging setup, namespaced
//! identifiers, string interner, and common error types.

pub mod ident;
pub mod intern;
pub mod log;

pub use ident::{Ident, IdentParseError};
pub use intern::Interner;
