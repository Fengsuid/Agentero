//! In-memory registry of decision schemas.

use super::types::DecisionSchema;
use std::collections::HashMap;

/// Stores decision schemas by id. Registration is explicit: a decision only
/// exists once a business module registers it at assembly time.
#[derive(Default)]
pub struct DecisionRegistry {
    schemas: HashMap<String, DecisionSchema>,
}

impl DecisionRegistry {
    /// Register a schema, replacing any previous definition with the same id.
    pub fn register(&mut self, schema: DecisionSchema) -> Option<DecisionSchema> {
        self.schemas.insert(schema.id.clone(), schema)
    }

    pub fn get(&self, id: &str) -> Option<&DecisionSchema> {
        self.schemas.get(id)
    }
}
