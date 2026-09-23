//! A partition-local producer cache. Scope keys contain the complete admitted
//! principal, invocation and deployment; credentials never enter this module.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
    time::Instant,
};

use axum::body::Bytes;
use serde::Serialize;
use serde_json::{Value, json};

use super::{failure, json_patch};
use crate::{
    consensus::Snapshot,
    evaluator::HttpMethod,
    service::{
        ApiError, App, QueryAdmission, QueryEvaluation, QueryResult, admission,
        evaluate_query_authorized, unavailable,
    },
};

#[derive(Default)]
pub(crate) struct Registry(Arc<RegistryInner>);
#[derive(Default)]
struct RegistryInner(Mutex<HashMap<String, Weak<Hub>>>);

pub(super) struct Authorized {
    pub state: Snapshot,
    pub method: HttpMethod,
    pub input: Value,
    pub principal: Value,
    pub permit: admission::Permit,
}

impl Authorized {
    pub fn scope(&self) -> String {
        // The registry itself is owned by one resolved partition App. Include
        // alias as authorization can differ between aliases of one method.
        crate::evaluator::hash(
            &serde_json::to_vec(&json!({
                "invocation":self.input,"method":self.method,"principal":self.principal,
                "deployment":self.state.data.get("bundle").and_then(|bundle|bundle.get("hash")),
            }))
            .expect("watch scope is JSON"),
        )
    }
}

impl Registry {
    pub(super) fn get(&self, app: &App, scope: &str) -> Result<Arc<Hub>, ApiError> {
        let mut entries = self.0.0.lock().expect("watch registry mutex");
        if let Some(hub) = entries.get(scope).and_then(Weak::upgrade) {
            return Ok(hub);
        }
        let retained = app
            .admission
            .retain(admission::Class::User, scope.len().saturating_add(1024))?;
        let hub = Arc::new(Hub {
            scope: scope.into(),
            registry: Arc::downgrade(&self.0),
            state: tokio::sync::Mutex::new(State::default()),
            _retained: retained,
        });
        entries.insert(scope.into(), Arc::downgrade(&hub));
        Ok(hub)
    }

    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.0.0.lock().unwrap().len()
    }
}

pub(super) struct Hub {
    pub scope: String,
    registry: Weak<RegistryInner>,
    state: tokio::sync::Mutex<State>,
    _retained: admission::Input,
}

#[derive(Default)]
struct State {
    current: Option<Arc<Frame>>,
    started: Option<Instant>,
    #[cfg(test)]
    evaluations: usize,
}

impl Drop for Hub {
    fn drop(&mut self) {
        if let Some(registry) = self.registry.upgrade() {
            let mut entries = registry.0.lock().expect("watch registry mutex");
            // A replacement can have been installed between the final strong
            // reference disappearing and this destructor acquiring the lock.
            if entries
                .get(&self.scope)
                .is_some_and(|entry| entry.strong_count() == 0)
            {
                entries.remove(&self.scope);
            }
        }
    }
}

impl Hub {
    // None means another admitted subscriber advanced past this authorization
    // snapshot. The caller must reacquire and reauthorize, never borrow a newer
    // result under an older policy decision.
    pub async fn refresh(
        &self,
        app: &App,
        authorized: Authorized,
        joined: Option<Instant>,
        coalesce: bool,
    ) -> Result<Option<Arc<Frame>>, ApiError> {
        let mut state = match self.state.try_lock() {
            Ok(state) => state,
            Err(_) => {
                // Subscriber input already has a byte lease. Release its root
                // and execution slot while another producer evaluates/encodes.
                drop(authorized);
                drop(self.state.lock().await);
                return Ok(None);
            }
        };
        if let Some(current) = &state.current {
            if current.query.revision > authorized.state.revision {
                return Ok(None);
            }
            let refreshed = state.started.expect("initialized watch producer");
            let refresh = super::super::tuning::settings()
                .map_err(unavailable)?
                .watch_refresh;
            let fresh_join = joined.is_none_or(|joined| refreshed >= joined);
            if current.query.revision == authorized.state.revision
                && (current.query.cacheable || (fresh_join && refreshed.elapsed() < refresh))
            {
                return Ok(Some(current.clone()));
            }
        }
        let started = Instant::now();
        let now = app.clock.sample(&authorized.state).map_err(unavailable)?;
        // Keep one reservation through native execution, diffing and encoding;
        // cloning a Permit does not acquire a second worker or memory budget.
        let result = evaluate_query_authorized(
            app,
            authorized.state,
            &authorized.input,
            authorized.method,
            now,
            QueryAdmission {
                permit: authorized.permit,
                coalesce,
            },
            authorized.principal,
        )
        .await?;
        let QueryEvaluation::Ready(next, permit) = result else {
            return Ok(None);
        };
        let previous = state.current.clone();
        let mut frame = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            prepare_sync(previous.as_deref(), next)
        })
        .await
        .map_err(|error| failure("WORKER_FAILED", &error.to_string()))??;
        let bytes = admission::input_bytes(&frame.query.value)
            .saturating_add(frame.encoded.capacity())
            .saturating_add(frame.snapshot.len())
            .saturating_add(frame.patch.as_ref().map_or(0, Bytes::len));
        frame.retained = Some(app.admission.retain(admission::Class::User, bytes)?);
        let frame = Arc::new(frame);
        state.current = Some(frame.clone());
        state.started = Some(started);
        #[cfg(test)]
        {
            state.evaluations += 1;
        }
        Ok(Some(frame))
    }

    #[cfg(test)]
    pub async fn evaluations(&self) -> usize {
        self.state.lock().await.evaluations
    }
}

pub(super) struct Frame {
    pub retained: Option<admission::Input>,
    pub query: QueryResult,
    pub encoded: String,
    pub sequence: u64,
    pub snapshot: Bytes,
    pub patch: Option<Bytes>,
}

impl Frame {
    pub fn bytes_after(&self, previous: Option<u64>) -> Option<Bytes> {
        if previous.is_some_and(|previous| previous >= self.sequence) {
            return None;
        }
        if previous.is_some_and(|previous| previous.checked_add(1) == Some(self.sequence))
            && let Some(patch) = &self.patch
        {
            return Some(patch.clone());
        }
        // Joining an existing producer or skipping updates resets the complete
        // value. Only consecutive subscribers can consume a delta.
        Some(self.snapshot.clone())
    }
}

pub(super) fn event(name: &str, sequence: u64, data: &str) -> Bytes {
    Bytes::from(format!("event: {name}\nid: {sequence}\ndata: {data}\n\n"))
}

pub(super) fn prepare_sync(previous: Option<&Frame>, next: QueryResult) -> Result<Frame, ApiError> {
    let encoded = serde_json::to_string(&next.value)
        .map_err(|error| failure("WATCH_ENCODING_FAILED", &error.to_string()))?;
    if previous.is_some_and(|previous| next.revision < previous.query.revision) {
        return Err(failure("UNAVAILABLE", "watch revision moved backwards"));
    }
    let changed = previous.is_none_or(|previous| previous.encoded != encoded);
    let sequence = match previous {
        Some(previous) if !changed => previous.sequence,
        Some(previous) => previous
            .sequence
            .checked_add(1)
            .filter(|sequence| *sequence <= 9_007_199_254_740_991)
            .ok_or_else(|| {
                failure(
                    "WATCH_SEQUENCE_EXHAUSTED",
                    "watch sequence exhausted; reconnect for a fresh snapshot",
                )
            })?,
        None => 0,
    };
    let snapshot = format!(
        "{{\"sequence\":{sequence},\"revision\":{},\"value\":{encoded}}}",
        next.revision
    );
    let mut patch_event = None;
    if changed && let Some(previous) = previous {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Patch<'a> {
            sequence: u64,
            base_sequence: u64,
            revision: u64,
            patch: Vec<json_patch::Operation<'a>>,
        }
        if let Some(patch) = json_patch::diff(&previous.query.value, &next.value) {
            let patch = serde_json::to_string(&Patch {
                sequence,
                base_sequence: previous.sequence,
                revision: next.revision,
                patch,
            })
            .map_err(|error| failure("WATCH_ENCODING_FAILED", &error.to_string()))?;
            if patch.len() < snapshot.len() {
                patch_event = Some(event("patch", sequence, &patch));
            }
        }
    }
    Ok(Frame {
        retained: None,
        query: next,
        encoded,
        sequence,
        snapshot: event("snapshot", sequence, &snapshot),
        patch: patch_event,
    })
}
