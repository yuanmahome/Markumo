pub mod guard;
pub mod ignore;
pub mod search;
pub mod replace;
pub mod preview;
#[cfg(test)]
mod search_tests;
pub mod service;
mod watch;

pub use search::{SearchManager, SearchMatch, SearchQuery, WorkspaceSearcher};
pub use service::{WorkspaceInfo, WorkspaceNode, WorkspaceService};
