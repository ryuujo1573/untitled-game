//! Shared `tracing` setup.

use tracing_subscriber::{fmt, prelude::*, EnvFilter};

/// Install a default tracing subscriber honouring `RUST_LOG`.
///
/// Safe to call multiple times — the second call is a no-op.
pub fn install_default() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(false))
        .try_init();
}
