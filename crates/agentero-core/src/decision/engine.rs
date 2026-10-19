//! The decision engine: routes a [`DecisionRequest`] to a provider and applies
//! fallback per the schema's [`DecisionRouting`].

use super::registry::DecisionRegistry;
use super::types::{
    DecisionOutcome, DecisionProvider, DecisionRequest, DecisionSchema, ProviderCall,
};
use crate::error::AppError;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

/// Owns the schema registry and the available providers.
///
/// The engine is stateless with respect to business data: it holds only the
/// registrations. Providers may themselves hold clients/credentials.
pub struct DecisionEngine {
    registry: DecisionRegistry,
    providers: HashMap<&'static str, Arc<dyn DecisionProvider>>,
}

/// Fluent builder for [`DecisionEngine`].
#[derive(Default)]
pub struct DecisionEngineBuilder {
    registry: DecisionRegistry,
    providers: HashMap<&'static str, Arc<dyn DecisionProvider>>,
}

impl DecisionEngineBuilder {
    pub fn provider(mut self, provider: Arc<dyn DecisionProvider>) -> Self {
        self.providers.insert(provider.name(), provider);
        self
    }

    pub fn register(mut self, schema: DecisionSchema) -> Self {
        self.registry.register(schema);
        self
    }

    pub fn build(self) -> DecisionEngine {
        DecisionEngine {
            registry: self.registry,
            providers: self.providers,
        }
    }
}

impl DecisionEngine {
    pub fn builder() -> DecisionEngineBuilder {
        DecisionEngineBuilder::default()
    }

    /// Answer `request`, applying the schema's fallback policy.
    ///
    /// Fallback is attempted when:
    /// - the primary provider returned no opinion (`Ok(None)`), or
    /// - the primary returned a confidence below `fallback_threshold` *and* the
    ///   outcome is inside the threshold's provider/version calibration scope, or
    /// - the primary errored *and* a fallback is configured (errors are
    ///   swallowed so a deterministic fallback can still answer).
    ///
    /// A fallback that also has no opinion leaves the primary outcome intact;
    /// if neither produced one the schema's `default_action` (or `null`) wins.
    pub async fn decide(&self, request: &DecisionRequest) -> Result<DecisionOutcome, AppError> {
        let schema = self.registry.get(&request.decision_id).ok_or_else(|| {
            AppError::message(format!("unknown decision '{}'", request.decision_id))
        })?;
        let state = request.state_value();

        let primary = match self
            .run_provider(&schema.routing.primary, schema, state)
            .await
        {
            Ok(outcome) => outcome,
            Err(err) => {
                if schema.routing.fallback.is_some() {
                    None
                } else {
                    return Err(err);
                }
            }
        };

        if self.needs_fallback(schema, &primary) {
            if let Some(fallback) = &schema.routing.fallback {
                match self.run_provider(fallback, schema, state).await {
                    Ok(Some(outcome)) => return Ok(outcome),
                    // No opinion: keep whatever the primary produced.
                    Ok(None) => {}
                    Err(err) => {
                        if primary.is_none() {
                            return Err(err);
                        }
                    }
                }
            }
        }

        if let Some(outcome) = primary {
            return Ok(outcome);
        }

        Ok(match &schema.default_action {
            Some(action) => DecisionOutcome::defaulted(action.clone()),
            None => DecisionOutcome::no_opinion(),
        })
    }

    fn needs_fallback(&self, schema: &DecisionSchema, primary: &Option<DecisionOutcome>) -> bool {
        match primary {
            None => schema.routing.fallback.is_some(),
            Some(outcome) => match &schema.routing.fallback_threshold {
                // No threshold, or the threshold was calibrated for a different
                // provider/version: a confidence-based fallback would compare
                // incomparable numbers, so don't.
                Some(threshold) if threshold.applies_to(outcome) => outcome
                    .confidence()
                    .map(|confidence| confidence < threshold.value)
                    // Threshold scoped to this provider but no calibrated
                    // confidence came back: treat as weak.
                    .unwrap_or(true),
                _ => false,
            },
        }
    }

    async fn run_provider(
        &self,
        name: &str,
        schema: &DecisionSchema,
        state: &Value,
    ) -> Result<Option<DecisionOutcome>, AppError> {
        let provider = self.providers.get(name).ok_or_else(|| {
            AppError::message(format!("decision provider '{name}' is not registered"))
        })?;
        let call = ProviderCall {
            decision_id: &schema.id,
            state,
            config: schema.provider_configs.get(name).map(Box::as_ref),
            rules: &schema.rules,
        };
        provider.decide(call).await
    }
}
