pub mod config;
#[cfg(test)]
mod differential;
mod json_order;
#[cfg(test)]
mod oracle;
mod profile;
pub(crate) mod rust_engine;
pub(crate) mod staging;
pub(crate) use rust_engine::ReactiveIndex;
pub use rust_engine::{DependencyCertificate, MutationCertificate};
#[cfg(test)]
mod transactions_tests;
mod wasm;

/// Reuse resident sandbox storage only inside a synchronous blocking batch.
/// Each callback still starts from the exact pristine guest image.
pub(crate) fn wasm_recycle_scope() -> impl Drop {
    wasm::recycle_scope()
}

pub(crate) fn clear_wasm_recycle_idle() {
    wasm::clear_recycle_idle();
}

use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, Instant},
};

use crate::consensus::Records;
use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Debug, Deserialize)]
pub struct Evaluation {
    pub puts: BTreeMap<String, Value>,
    pub deletes: Vec<String>,
    pub evaluated: Vec<String>,
    #[serde(default)]
    pub value: Value,
    #[serde(default)]
    pub query_cacheable: bool,
    #[serde(skip)]
    pub query_certificate: Option<DependencyCertificate>,
    #[serde(skip)]
    pub mutation_certificate: Option<MutationCertificate>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MethodKind {
    Query,
    Mutation,
    Transaction,
}

impl MethodKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Query => "query",
            Self::Mutation => "mutation",
            Self::Transaction => "transaction",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum QueryConsistency {
    #[default]
    Linearizable,
    ReplicaLocal,
}

impl QueryConsistency {
    fn is_linearizable(&self) -> bool {
        *self == Self::Linearizable
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(try_from = "RawHttpMethod")]
pub struct HttpMethod {
    pub name: String,
    pub kind: MethodKind,
    #[serde(skip_serializing_if = "QueryConsistency::is_linearizable")]
    pub consistency: QueryConsistency,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawHttpMethod {
    name: String,
    kind: MethodKind,
    // Distinguish absence from an explicitly supplied null or default: mutations
    // must reject the property even when it would mean linearizable on a query.
    #[serde(default, deserialize_with = "present_consistency")]
    consistency: Option<QueryConsistency>,
}

fn present_consistency<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<QueryConsistency>, D::Error> {
    QueryConsistency::deserialize(deserializer).map(Some)
}

impl TryFrom<RawHttpMethod> for HttpMethod {
    type Error = &'static str;

    fn try_from(method: RawHttpMethod) -> std::result::Result<Self, Self::Error> {
        if method.kind != MethodKind::Query && method.consistency.is_some() {
            return Err("consistency is only supported on query methods");
        }
        Ok(Self {
            name: method.name,
            kind: method.kind,
            consistency: method.consistency.unwrap_or_default(),
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MaintenanceMethod {
    pub name: String,
    pub kind: MethodKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_error: Option<HttpMethod>,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    http: BTreeMap<String, HttpMethod>,
    maintenance: Option<MaintenanceMethod>,
    #[serde(default)]
    authorize: Option<AuthorizationMethod>,
    #[serde(default)]
    schema: rust_engine::Schema,
    #[serde(default)]
    keys: Vec<Value>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AuthorizationMethod {
    name: String,
}

pub fn hash(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 15) as usize] as char);
    }
    encoded
}

/// Validate the public mutation before allocating a JavaScript runtime.
pub fn validate_mutation(mutation: &Value) -> Result<()> {
    let object = mutation.as_object().context("mutation must be an object")?;
    let id = object
        .get("requestId")
        .and_then(Value::as_str)
        .context("requestId must be a string")?;
    anyhow::ensure!(!id.is_empty(), "requestId must not be empty");
    for key in object.keys() {
        anyhow::ensure!(
            [
                "requestId",
                "expectedRevision",
                "writes",
                "materialize",
                "unmaterialize",
                "bundle",
                "preparation"
            ]
            .contains(&key.as_str()),
            "unknown mutation field: {key}"
        );
    }
    if let Some(preparation) = object.get("preparation") {
        anyhow::ensure!(
            matches!(preparation.as_str(), Some("online" | "blocking")),
            "preparation must be online or blocking"
        );
    }
    if let Some(revision) = object.get("expectedRevision") {
        anyhow::ensure!(
            revision
                .as_u64()
                .is_some_and(|r| r <= 9_007_199_254_740_991),
            "expectedRevision must be a nonnegative safe integer"
        );
    }
    if let Some(bundle) = object.get("bundle") {
        let javascript = bundle
            .get("javascript")
            .and_then(Value::as_str)
            .context("bundle.javascript must be a string")?;
        anyhow::ensure!(
            javascript.len() <= config::settings()?.bundle_max_bytes,
            "bundle exceeds FLOWER_BUNDLE_MAX_BYTES"
        );
        let supplied_hash = bundle
            .get("hash")
            .and_then(Value::as_str)
            .context("bundle.hash must be a SHA-256 hash")?;
        anyhow::ensure!(
            supplied_hash == hash(javascript.as_bytes()),
            "bundle hash does not match JavaScript"
        );
    }
    Ok(())
}

/// A fresh Wasm cell prevents module globals from leaking between evaluations.
/// This runs on a blocking worker, never on the Raft event loop.
pub fn evaluate(data: impl Into<Records>, mutation: Value) -> Result<Evaluation> {
    evaluate_with_timeout(data, mutation, config::settings()?.evaluation_timeout)
}

fn evaluate_with_timeout(
    data: impl Into<Records>,
    mutation: Value,
    timeout: Duration,
) -> Result<Evaluation> {
    validate_mutation(&mutation)?;
    evaluate_inner(data.into(), mutation, "deployment", timeout, None)
}

/// Host-sampled time is separate from the public request and cannot be supplied by a client.
pub fn evaluate_at(data: impl Into<Records>, mutation: Value, now: u64) -> Result<Evaluation> {
    validate_mutation(&mutation)?;
    evaluate_inner(
        data.into(),
        mutation,
        "deployment",
        config::settings()?.evaluation_timeout,
        Some(now),
    )
}

pub fn validate_invocation(invocation: &Value, kind: &str) -> Result<()> {
    let object = invocation
        .as_object()
        .context("method invocation must be an object")?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .context("name must be a string")?;
    anyhow::ensure!(!name.is_empty(), "name must not be empty");
    anyhow::ensure!(
        matches!(kind, "query" | "mutation" | "transaction" | "call"),
        "unknown method kind"
    );
    let allowed: &[&str] = if kind == "query" {
        &["name", "args", "credentials"]
    } else {
        &[
            "name",
            "args",
            "requestId",
            "expectedRevision",
            "credentials",
        ]
    };
    for key in object.keys() {
        anyhow::ensure!(
            allowed.contains(&key.as_str()),
            "unknown method invocation field: {key}"
        );
    }
    if kind != "query" {
        let mut metadata = serde_json::Map::new();
        for key in ["requestId", "expectedRevision"] {
            if let Some(value) = object.get(key) {
                metadata.insert(key.into(), value.clone());
            }
        }
        if kind == "call" && !metadata.contains_key("requestId") {
            metadata.insert("requestId".into(), json!("validation-only"));
        }
        validate_mutation(&Value::Object(metadata))?;
    }
    Ok(())
}

pub fn invoke(data: impl Into<Records>, invocation: Value, kind: &str) -> Result<Evaluation> {
    validate_invocation(&invocation, kind)?;
    evaluate_inner(
        data.into(),
        invocation,
        kind,
        config::settings()?.evaluation_timeout,
        None,
    )
}

pub fn invoke_at(
    data: impl Into<Records>,
    invocation: Value,
    kind: &str,
    now: u64,
) -> Result<Evaluation> {
    validate_invocation(&invocation, kind)?;
    evaluate_inner(
        data.into(),
        invocation,
        kind,
        config::settings()?.evaluation_timeout,
        Some(now),
    )
}

/// Only trusted service code supplies a principal. Public validation rejects
/// this internal field, including attempts through the generic call endpoint.
pub(crate) fn invoke_as(
    data: impl Into<Records>,
    mut invocation: Value,
    kind: &str,
    now: u64,
    principal: Value,
) -> Result<Evaluation> {
    validate_invocation(&invocation, kind)?;
    invocation["$principal"] = principal;
    evaluate_inner(
        data.into(),
        invocation,
        kind,
        config::settings()?.evaluation_timeout,
        Some(now),
    )
}

/// Service-only optimistic evaluation. Its certificate must be checked again
/// against the ordered writer state before any result or patch is published.
pub(crate) fn invoke_speculative_as(
    data: Records,
    mut invocation: Value,
    now: u64,
    principal: Value,
) -> Result<Evaluation> {
    validate_invocation(&invocation, "mutation")?;
    invocation["$principal"] = principal;
    invocation["$speculate"] = Value::Bool(true);
    evaluate_inner(
        data,
        invocation,
        "mutation",
        config::settings()?.evaluation_timeout,
        Some(now),
    )
}

/// Operator-only policy update. The encrypted catalog and all affected
/// materialized values form one ordinary revision-checked Raft commit.
pub fn update_keys_at(data: impl Into<Records>, catalog: Value, now: u64) -> Result<Evaluation> {
    evaluate_inner(
        data.into(),
        json!({"catalog": catalog}),
        "keyUpdate",
        config::settings()?.evaluation_timeout,
        Some(now),
    )
}

/// Initialize the shared QuickJS/Wasmtime sandbox.
pub fn warmup() -> Result<()> {
    config::settings()?;
    anyhow::ensure!(
        std::env::var_os("FLOWER_ENGINE").is_none_or(|value| value == "quickjs"),
        "Flower only supports QuickJS in Wasm; remove FLOWER_ENGINE from the environment"
    );
    wasm::warmup()
}

fn evaluate_inner(
    data: Records,
    mutation: Value,
    mode: &str,
    timeout: Duration,
    now: Option<u64>,
) -> Result<Evaluation> {
    let data = data.graph_view(data.active_graph());
    let started = Instant::now();
    let mut evaluation = evaluate_selected(data.clone(), mutation, mode, timeout, now)?;
    if matches!(mode, "mutation" | "keyUpdate") {
        staging::maintain(
            &data,
            &mut evaluation,
            mode == "keyUpdate",
            now,
            timeout.saturating_sub(started.elapsed()),
        )?;
    }
    Ok(evaluation)
}

/// Internal callers may select an unpublished reactive generation. They never
/// execute public methods, and do not recursively maintain another generation.
fn evaluate_selected(
    data: Records,
    mut mutation: Value,
    mode: &str,
    timeout: Duration,
    now: Option<u64>,
) -> Result<Evaluation> {
    anyhow::ensure!(
        now.is_none_or(|value| value <= 9_007_199_254_740_991),
        "clock exceeds the safe integer range"
    );
    anyhow::ensure!(
        data.has_valid_depth(),
        "INPUT_INVALID: JSON nesting exceeds 128 levels"
    );
    // Compilation is process setup, not part of an application's execution budget.
    warmup()?;
    let deadline = Instant::now() + timeout;
    let limits = wasm::Limits::new(deadline, config::settings()?.guest_memory_bytes);
    let profile = profile::invocation(
        mode,
        mutation
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("deployment"),
        data.len(),
    );
    // This entire evaluator is synchronous; the guard never crosses an await.
    let span = profile::span(&profile);
    let _entered = span.enter();
    let bundle = mutation
        .get("bundle")
        .or_else(|| data.get("bundle"))
        .and_then(|bundle| bundle.get("javascript"))
        .and_then(Value::as_str)
        .unwrap_or("var __flowerBundle = { default: { definitions: {}, http: {} } };");
    let stored = mutation
        .get("bundle")
        .is_none()
        .then(|| data.get_shared("bundle"))
        .flatten()
        .filter(|stored| stored.get("javascript").is_some_and(Value::is_string));
    let prepared = {
        let _timer = profile::timer(&profile, profile::Stage::BundlePrepare);
        match stored {
            Some(stored) => wasm::prepare_shared_bundle(stored, limits.clone())?,
            None => wasm::prepare(bundle, limits.clone())?,
        }
    };
    let manifest = if mutation.get("bundle").is_some() {
        let _timer = profile::timer(&profile, profile::Stage::Manifest);
        let manifest: Manifest =
            serde_json::from_str(&wasm::manifest_prepared(&prepared, limits.clone())?)?;
        for (alias, method) in &manifest.http {
            anyhow::ensure!(!alias.is_empty(), "HTTP aliases must not be empty");
            anyhow::ensure!(!method.name.is_empty(), "method names must not be empty");
        }
        if let Some(method) = &manifest.maintenance {
            anyhow::ensure!(
                !method.name.is_empty(),
                "maintenance method names must not be empty"
            );
            if let Some(on_error) = &method.on_error {
                anyhow::ensure!(
                    !on_error.name.is_empty(),
                    "maintenance error method names must not be empty"
                );
            }
        }
        Some(manifest)
    } else {
        None
    };
    if let Some(manifest) = &manifest {
        // Install declarations before evaluating roots in the new bundle.
        // This field is internal and cannot be supplied by a public mutation.
        mutation["keyDeclarations"] = serde_json::to_value(&manifest.keys)?;
    }
    let executor = CellExecutor {
        prepared,
        limits: limits.clone(),
        profile: profile.clone(),
    };
    let mut result = {
        let _timer = profile::timer(&profile, profile::Stage::CoordinatorExecute);
        rust_engine::run_with_schema(
            data,
            mutation,
            mode,
            now,
            &executor,
            manifest.as_ref().map(|manifest| manifest.schema.clone()),
        )?
    };
    limits.check()?;
    if let Some(manifest) = manifest {
        result.puts.insert(
            "authorizationMethod".into(),
            serde_json::to_value(manifest.authorize)?,
        );
        result
            .puts
            .insert("httpMethods".into(), serde_json::to_value(manifest.http)?);
        result.puts.insert(
            "maintenanceMethod".into(),
            serde_json::to_value(manifest.maintenance)?,
        );
    }
    {
        let _timer = profile::timer(&profile, profile::Stage::ResultValidation);
        anyhow::ensure!(
            evaluation_bytes(&result)? <= config::settings()?.result_max_bytes,
            "evaluation and HTTP registry exceed FLOWER_RESULT_MAX_BYTES"
        );
        limits.check()?;
    }
    profile::success(&profile);
    Ok(result)
}

fn evaluation_bytes(evaluation: &Evaluation) -> serde_json::Result<usize> {
    #[derive(Serialize)]
    struct Output<'a> {
        puts: &'a BTreeMap<String, Value>,
        deletes: &'a [String],
        value: &'a Value,
    }
    json_byte_len(&Output {
        puts: &evaluation.puts,
        deletes: &evaluation.deletes,
        value: &evaluation.value,
    })
}

/// Preserve serde_json's exact wire accounting, including number formatting,
/// without allocating a second complete result just to discard its bytes.
fn json_byte_len(value: &impl Serialize) -> serde_json::Result<usize> {
    #[derive(Default)]
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.saturating_add(bytes.len());
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter::default();
    serde_json::to_writer(&mut counter, value)?;
    Ok(counter.0)
}

struct CellExecutor {
    prepared: Arc<wasm::Prepared>,
    limits: Arc<wasm::Limits>,
    profile: Option<Arc<profile::Invocation>>,
}

impl rust_engine::Executor for CellExecutor {
    fn check_budget(&self) -> rust_engine::EngineResult<()> {
        self.limits
            .check()
            .map_err(|error| rust_engine::EngineError::new("EVALUATION_BUDGET", error.to_string()))
    }

    fn execute(
        &self,
        kind: &str,
        name: &str,
        args: &Value,
        host: &mut dyn FnMut(&str, Value) -> rust_engine::EngineResult<Value>,
    ) -> rust_engine::EngineResult<Value> {
        let _depth = profile::enter_cell(&self.profile);
        let _wall = profile::timer(&self.profile, profile::Stage::CellWall);
        let started = self.profile.as_ref().map(|_| Instant::now());
        let mut read_nanos = 0u64;
        let result = wasm::execute_prepared_profiled(
            &self.prepared,
            name,
            args,
            kind,
            &mut |method, payload| {
                profile::read(&self.profile);
                let started = self.profile.as_ref().map(|_| Instant::now());
                let _timer = profile::timer(&self.profile, profile::Stage::CellReadWait);
                let result = host(method, payload).map_err(anyhow::Error::new);
                if let Some(started) = started {
                    read_nanos = read_nanos
                        .saturating_add(started.elapsed().as_nanos().min(u64::MAX as u128) as u64);
                }
                result
            },
            self.limits.clone(),
            &self.profile,
        );
        if let Some(started) = started {
            profile::record_nanos(
                &self.profile,
                profile::Stage::CoordinatorReceiveWait,
                (started.elapsed().as_nanos().min(u64::MAX as u128) as u64)
                    .saturating_sub(read_nanos),
            );
        }
        let mut envelope = result.map_err(|error| {
            rust_engine::EngineError::new("EVALUATION_BUDGET", error.to_string())
        })?;
        if envelope["ok"] == true {
            Ok(envelope["value"].take())
        } else {
            let mut error = rust_engine::EngineError::new(
                envelope["error"]["code"]
                    .as_str()
                    .unwrap_or("COMPUTE_ERROR"),
                envelope["error"]["message"]
                    .as_str()
                    .unwrap_or("application callback failed"),
            );
            error.details = envelope["error"].get_mut("details").map(Value::take);
            Err(error)
        }
    }
}

// serde_json::Value guarantees plain JSON without accessors, symbols, cycles,
// or non-finite numbers. Check the engine's nesting limit in Rust so its private
// invocation entry point can reuse a snapshot without cloning its whole tree.
#[cfg(test)]
fn validate_snapshot_depth(data: &BTreeMap<String, Value>) -> Result<()> {
    let mut pending: Vec<_> = data.values().map(|value| (value, 1_usize)).collect();
    while let Some((value, depth)) = pending.pop() {
        anyhow::ensure!(
            depth <= 128,
            "INPUT_INVALID: JSON nesting exceeds 128 levels"
        );
        match value {
            Value::Array(values) => {
                pending.extend(values.iter().map(|value| (value, depth + 1)));
            }
            Value::Object(values) => {
                pending.extend(values.values().map(|value| (value, depth + 1)));
            }
            _ => {}
        }
    }
    Ok(())
}

const SANDBOX: &str = r#"
(() => {
    const forbidden = () => { throw new Error('Ambient time and randomness are unavailable; use ctx.now() or explicit source records'); };
    Object.defineProperty(globalThis, 'Date', {value: undefined, writable: false, configurable: false});
    Object.defineProperty(globalThis, 'Intl', {value: undefined, writable: false, configurable: false});
    Object.defineProperty(Math, 'random', {value: forbidden, writable: false, configurable: false});
    // The host exposes no filesystem, network, process, timer, or module-loader APIs.
})()
"#;

const BUNDLE_MANIFEST: &str = r#"
(() => {
    function record(value, label) {
        if (value === null || typeof value !== 'object' || Array.isArray(value) ||
            (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
            throw new Error(label + ' must be a plain object');
        for (const key of Reflect.ownKeys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor))
                throw new Error(label + ' cannot contain symbols or accessors');
        }
        return value;
    }
    function consistency(value, query) {
        if (!Object.hasOwn(value, 'consistency')) return 'linearizable';
        if (!query || !['linearizable', 'replica-local'].includes(value.consistency))
            throw new Error('consistency requires a query method and linearizable or replica-local');
        return value.consistency;
    }
    const app = record(typeof __flowerBundle !== 'undefined' && __flowerBundle.default, 'application');
    if (Object.keys(app).some(key => !['definitions', 'http', 'maintenance', 'collections', 'keys', 'authorize'].includes(key)))
        throw new Error('Use define({definitions, http, maintenance, collections, keys, authorize}) to declare the application');
    const keys = app.keys === undefined ? [] : app.keys;
    if (!Array.isArray(keys)) throw new Error('keys must be an array');
    const keyNames = new Set();
    for (const value of keys) {
        const key = record(value, 'Key declaration');
        if (Object.keys(key).length !== 4 || Object.keys(key).some(field => !['kind', 'name', 'algorithm', 'usages'].includes(field)) ||
            key.kind !== 'key' || typeof key.name !== 'string' || !key.name || keyNames.has(key.name) ||
            !['Ed25519', 'P256', 'RSA', 'HS256', 'A256GCM', 'XSalsa20Poly1305', 'X25519'].includes(key.algorithm) ||
            !Array.isArray(key.usages) || key.usages.length === 0 || new Set(key.usages).size !== key.usages.length ||
            key.usages.some(usage => !['sign', 'verify', 'encrypt', 'decrypt', 'derive', 'publicKey'].includes(usage)))
            throw new Error('Invalid or duplicate key declaration');
        keyNames.add(key.name);
    }
    const definitions = record(app.definitions, 'definitions');
    const http = record(app.http, 'http');
    for (const name of Object.keys(definitions)) {
        const definition = record(definitions[name], 'definition');
        if (!name || definition.name !== name || typeof definition.compute !== 'function' ||
            !['derived', 'queryMethod', 'mutationMethod', 'transactionMethod'].includes(definition.kind))
            throw new Error('Invalid definition: ' + name);
        consistency(definition, definition.kind === 'queryMethod');
    }
    const registry = Object.create(null);
    for (const alias of Object.keys(http)) {
        const method = record(http[alias], 'HTTP method');
        if (!alias || Object.keys(method).some(key => !['name', 'kind', 'consistency'].includes(key)) ||
            typeof method.name !== 'string' || !Object.hasOwn(definitions, method.name) ||
            !['query', 'mutation', 'transaction'].includes(method.kind) ||
            definitions[method.name].kind !== method.kind + 'Method')
            throw new Error('Invalid HTTP method mapping: ' + alias);
        const mode = consistency(method, method.kind === 'query');
        if (mode !== consistency(definitions[method.name], method.kind === 'query'))
            throw new Error('HTTP consistency must match its query definition: ' + alias);
        registry[alias] = {name: method.name, kind: method.kind};
        if (mode === 'replica-local') registry[alias].consistency = mode;
    }
    let maintenance = null;
    if (app.maintenance !== undefined && app.maintenance !== null) {
        const method = record(app.maintenance, 'maintenance method');
        if (Object.keys(method).some(key => !['name', 'kind', 'onError'].includes(key)) ||
            method.kind !== 'mutation' || typeof method.name !== 'string' ||
            !Object.hasOwn(definitions, method.name) || definitions[method.name].kind !== 'mutationMethod')
            throw new Error('Maintenance must reference a mutation method');
        maintenance = {name: method.name, kind: 'mutation'};
        if (Object.hasOwn(method, 'onError')) {
            const handler = record(method.onError, 'maintenance error method');
            if (Object.keys(handler).some(key => key !== 'name' && key !== 'kind') ||
                handler.kind !== 'mutation' || typeof handler.name !== 'string' ||
                !Object.hasOwn(definitions, handler.name) || definitions[handler.name].kind !== 'mutationMethod')
                throw new Error('Maintenance onError must reference a mutation method');
            maintenance.onError = {name: handler.name, kind: 'mutation'};
        }
    }
    let authorize = null;
    if (app.authorize !== undefined && app.authorize !== null) {
        const method = record(app.authorize, 'authorization method');
        if (Object.keys(method).length !== 1 || typeof method.name !== 'string' ||
            !Object.hasOwn(definitions, method.name) || definitions[method.name].kind !== 'queryMethod' ||
            consistency(definitions[method.name], true) !== 'linearizable')
            throw new Error('Authorization must reference a fresh read-only query method');
        authorize = {name: method.name};
    }
    return JSON.stringify({http: registry, maintenance, authorize, ...(keys.length ? {keys} : {}),
        ...(typeof __flowerSchema === 'function' ? {schema: __flowerSchema(app)} : {})});
})()
"#;

const CELL_RUNNER: &str = r#"
((nativeCheck, nativeRead) => {
    function checkJsonFallback(value, active = new Set(), depth = 0) {
        if (depth > 128) throw new Error('JSON nesting exceeds 128');
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
        if (typeof value === 'number' && Number.isFinite(value)) return;
        if (typeof value !== 'object') throw new Error('Return a finite JSON value');
        if (active.has(value)) throw new Error('Return values cannot contain cycles');
        if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
            throw new Error('Return values must be plain JSON objects or arrays');
        active.add(value);
        for (const key of Reflect.ownKeys(value)) {
            if (Array.isArray(value) && key === 'length') continue;
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor))
                throw new Error('Return values cannot contain symbols or accessors');
            checkJsonFallback(descriptor.value, active, depth + 1);
        }
        if (Array.isArray(value)) for (let i = 0; i < value.length; ++i)
            if (!Object.hasOwn(value, i)) throw new Error('Return arrays cannot contain holes');
        active.delete(value);
    }
    function checkJson(value) {
        if (!nativeCheck(value)) checkJsonFallback(value);
    }
    function ref(value) {
        if (typeof value === 'string') return value;
        if (value && (value.kind === 'collection' || value.kind === 'derived'))
            return {kind: value.kind, name: value.name};
        return value;
    }
    function read(method, args) {
        try { checkJson(args); } catch (e) { e.code = 'INVALID_VALUE'; throw e; }
        const parsed = nativeRead(method, args);
        const result = parsed === undefined ? JSON.parse(__flowerRead(method, JSON.stringify(args))) : parsed;
        if (!result.ok) throw Object.assign(new Error(result.error.message), {code: result.error.code});
        return result.value;
    }
    const readers = {
        now: () => read('now', []),
        principal: () => read('principal', []),
        history: () => read('history', []),
        get: (target, args = null) => read('get', [ref(target), args]),
        scan: (collection, options) => {
            const target = ref(collection);
            if (options === undefined) return read('scan', [target]);
            if (target && typeof target === 'object' && target.kind === 'collection') {
                const descriptor = Object.getOwnPropertyDescriptor(collection, 'indexes');
                if (descriptor && !('value' in descriptor))
                    throw Object.assign(new Error('Collection indexes cannot be an accessor'), {code: 'INVALID_VALUE'});
                target.indexes = descriptor ? descriptor.value : {};
            }
            return read('scan', [target, options]);
        },
        query: (query) => read('query', [query]),
        range: (query) => read('range', [query])
    };
    const writers = {
        set: (collection, key, value) => read('set', [ref(collection), key, value]),
        delete: (collection, key) => read('delete', [ref(collection), key]),
        materialize: (definition, args = null) => read('materialize', [ref(definition), args]),
        unmaterialize: (definition, args = null) => read('unmaterialize', [ref(definition), args])
    };
    // Each cell gets a fresh Wasm image. Immutable context objects can therefore
    // be prepared in the trusted image; methods read invocation bindings only
    // when called and cannot retain mutations into any subsequent cell.
    const derivedContext = Object.freeze({...readers});
    const methodContext = Object.freeze({...readers, ...writers});
    return () => {
        const api = __kind === 'derived' ? derivedContext : methodContext;
        try {
            const definitions = typeof __flowerBundle !== 'undefined' && __flowerBundle.default.definitions;
            if (!definitions || !Object.hasOwn(definitions, __name) || typeof definitions[__name].compute !== 'function')
                throw Object.assign(new Error('Unknown derived definition: ' + __name), {code: 'DEFINITION_MISSING'});
            const actualKind = definitions[__name].kind;
            const expectedKind = __kind === 'derived' ? 'derived' : __kind + 'Method';
            if (actualKind !== expectedKind)
                throw Object.assign(new Error('Definition ' + __name + ' is not a ' + __kind + ' method'), {code: 'METHOD_KIND_MISMATCH'});
            const value = definitions[__name].compute(api, JSON.parse(__argsJson));
            try { checkJson(value); } catch (e) { e.code = 'INVALID_VALUE'; throw e; }
            return JSON.stringify({ok: true, value});
        } catch (e) {
            const message = String(e && e.message || e);
            const error = {
                code: e && typeof e.code === 'string' ? e.code : /out of memory|interrupted/i.test(message) ? 'EVALUATION_BUDGET' : 'COMPUTE_ERROR',
                message
            };
            try {
                if (__kind !== 'derived' && e && typeof e === 'object' && e.details !== undefined) {
                    checkJson(e.details);
                    error.details = e.details;
                }
            } catch (_) {}
            return JSON.stringify({ok: false, error});
        }
    };
})(__flowerCheckJson, __flowerReadParsed)
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_budget_counts_the_exact_json_wire_representation() {
        for value in [
            Value::Null,
            json!({"puts": {}, "deletes": [], "value": "\0\"\\\n🌸"}),
            json!({"puts": {"cell:\"": {"float": 1.0, "small": 1e-7, "large": 1e21, "zero": -0.0}}, "deletes": ["😀", "\u{e000}"], "value": [false, true, null]}),
        ] {
            let bytes = serde_json::to_vec(&value).unwrap();
            assert_eq!(json_byte_len(&value).unwrap(), bytes.len());
        }
    }

    // Keep compute fixtures compact while emitting the same explicit manifest as the SDK.
    fn fixture_bundle(javascript: &str) -> String {
        format!(
            r#"{javascript}
        (() => {{
          const definitions = Object.create(null);
          const http = Object.create(null);
          for (const [name, value] of Object.entries(__flowerBundle.default)) {{
            const definition = {{...value, name, kind: value.kind || 'derived'}};
            definitions[name] = definition;
            if (definition.kind === 'queryMethod' || definition.kind === 'mutationMethod')
              http[name] = {{name, kind: definition.kind === 'queryMethod' ? 'query' : 'mutation'}};
          }}
          __flowerBundle.default = {{definitions, http}};
        }})();"#
        )
    }

    fn mutation(javascript: &str, name: &str) -> Value {
        let javascript = fixture_bundle(javascript);
        json!({"requestId":"test", "bundle":{"hash":hash(javascript.as_bytes()),"javascript":javascript},
            "materialize":[{"name":name}], "writes":[{"collection":"input","key":"a","value":7}]})
    }

    #[test]
    fn executes_real_js_and_tracks_nested_reads() {
        let code = r#"var __flowerBundle = {default: {
          double: {compute: ctx => ctx.get({kind:'collection',name:'input'}, 'a') * 2},
          total: {compute: ctx => ctx.get({kind:'derived',name:'double'}) + 1}
        }};"#;
        let result = evaluate(BTreeMap::new(), mutation(code, "total")).unwrap();
        assert_eq!(result.puts["cell:[\"total\",null]"]["outcome"]["value"], 15);
        assert_eq!(result.evaluated.len(), 2);
    }

    #[test]
    fn isolates_module_state_between_cells_and_transactions() {
        let code = r#"let counter = 0; var __flowerBundle = {default: {
          child: {compute: () => ++counter},
          parent: {compute: ctx => ctx.get({kind:'derived',name:'child'}) + ++counter}
        }};"#;
        let result = evaluate(BTreeMap::new(), mutation(code, "parent")).unwrap();
        assert_eq!(result.puts["cell:[\"parent\",null]"]["outcome"]["value"], 2);
    }

    #[test]
    fn exceptions_are_values_and_no_ambient_io_exists() {
        let code = r#"var __flowerBundle = {default: {
          check: {compute: () => [typeof fetch, typeof process, typeof Date, typeof setTimeout]},
          random: {compute: () => Math.random()}
        }};"#;
        let result = evaluate(BTreeMap::new(), mutation(code, "check")).unwrap();
        assert_eq!(
            result.puts["cell:[\"check\",null]"]["outcome"]["value"],
            json!(["undefined", "undefined", "undefined", "undefined"])
        );
        let result = evaluate(BTreeMap::new(), mutation(code, "random")).unwrap();
        assert_eq!(
            result.puts["cell:[\"random\",null]"]["outcome"]["ok"],
            false
        );
    }

    #[test]
    fn an_infinite_loop_aborts_within_the_budget() {
        warmup().unwrap();
        let code = "var __flowerBundle = {default: {loop: {compute: () => {while (true) {}}}}};";
        let started = Instant::now();
        let error = evaluate_with_timeout(
            BTreeMap::new(),
            mutation(code, "loop"),
            Duration::from_millis(50),
        )
        .unwrap_err();
        assert!(error.to_string().contains("BUDGET") || error.to_string().contains("interrupted"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn refuses_a_bundle_with_wrong_hash() {
        let mut value = mutation("var __flowerBundle = {};", "x");
        value["bundle"]["hash"] = json!("wrong");
        assert!(
            evaluate(BTreeMap::new(), value)
                .unwrap_err()
                .to_string()
                .contains("hash")
        );
    }

    #[test]
    fn refuses_invalid_bundles_even_without_materialized_roots() {
        for code in [
            "this is invalid syntax!",
            "var __flowerBundle = {default: {oops: 1}};",
        ] {
            let mut value = mutation(code, "x");
            value.as_object_mut().unwrap().remove("materialize");
            assert!(evaluate(BTreeMap::new(), value).is_err());
        }
    }

    #[test]
    fn database_read_arguments_cannot_be_silently_coerced_to_json() {
        for args in ["NaN", "Infinity", "{x: undefined}", "[1,,3]"] {
            let code = format!(
                "var __flowerBundle = {{default: {{ parent: {{compute: ctx => ctx.get({{kind:'derived',name:'child'}}, {args})}}, child: {{compute: (_, args) => args}} }}}};"
            );
            let result = evaluate(BTreeMap::new(), mutation(&code, "parent")).unwrap();
            assert_eq!(
                result.puts["cell:[\"parent\",null]"]["outcome"]["error"]["code"],
                "INVALID_VALUE"
            );
            assert_eq!(result.evaluated.len(), 1);
        }
    }

    #[test]
    fn heap_exhaustion_cannot_be_swallowed_by_user_code() {
        let code = r#"var __flowerBundle = {default: {memory: {compute: () => {
            try { new ArrayBuffer(1024 * 1024 * 1024); } catch (_) {}
            return 'pretend success';
        }}}};"#;
        assert!(evaluate(BTreeMap::new(), mutation(code, "memory")).is_err());
    }

    fn method_data() -> BTreeMap<String, Value> {
        let code = r#"var __flowerBundle = {default: {
          double: {kind: 'derived', compute: ctx => (ctx.get({kind:'collection',name:'input'}, 'a') || 0) * 2},
          update: {kind: 'mutationMethod', compute: (ctx, args) => {
            const source = {kind:'collection',name:'input'};
            const derived = {kind:'derived',name:'double'};
            ctx.set(source, 'a', args);
            ctx.materialize(derived);
            const before = ctx.get(derived);
            ctx.set(source, 'a', args + 1);
            return {before, after: ctx.get(derived)};
          }},
          read: {kind: 'queryMethod', compute: ctx => ctx.get({kind:'derived',name:'double'})},
          fail: {kind: 'mutationMethod', compute: ctx => {
            ctx.set({kind:'collection',name:'input'}, 'a', 999);
            throw new Error('rejected by method');
          }},
          badQuery: {kind: 'queryMethod', compute: ctx => {
            try { ctx.set({kind:'collection',name:'input'}, 'a', 999); } catch (_) {}
            return 'pretend success';
          }}
        }};"#;
        let code = fixture_bundle(code);
        BTreeMap::from([(
            "bundle".into(),
            json!({"hash":hash(code.as_bytes()),"javascript":code}),
        )])
    }

    #[test]
    fn trusted_snapshot_depth_matches_the_public_json_limit() {
        let mut value = json!(0);
        for _ in 0..127 {
            value = json!({"n": value});
        }
        let mut data = BTreeMap::from([("source:[\"data\",\"x\"]".into(), value)]);
        validate_snapshot_depth(&data).unwrap();
        let previous = data.remove("source:[\"data\",\"x\"]").unwrap();
        data.insert("source:[\"data\",\"x\"]".into(), json!({"n": previous}));
        assert!(
            validate_snapshot_depth(&data)
                .unwrap_err()
                .to_string()
                .contains("INPUT_INVALID")
        );
    }

    #[test]
    fn trusted_coordinator_preserves_key_order_and_cannot_be_called_by_user_methods() {
        let code = fixture_bundle(
            r#"var __flowerBundle = {default: {
          read: {kind:'queryMethod', compute: ctx => ({
            keys: Object.keys(ctx.get({kind:'collection',name:'bundle'}, 'record')),
            hostEntry: typeof flowerInvokeTrusted,
            orderedEntry: typeof flowerInvokeOrdered
          })},
          write: {kind:'mutationMethod', compute: ctx => {
            ctx.set({kind:'collection',name:'bundle'}, 'other', 42);
            return typeof flowerInvokeTrusted;
          }}
        }};"#,
        );
        let bundle = json!({"hash":hash(code.as_bytes()),"javascript":code});
        let data = BTreeMap::from([
            ("bundle".into(), bundle.clone()),
            (
                "source:[\"bundle\",\"record\"]".into(),
                json!({"\u{e000}":1,"\u{1f600}":2,"a":3}),
            ),
        ]);
        let query = invoke(data.clone(), json!({"name":"read"}), "query").unwrap();
        assert_eq!(
            query.value,
            json!({"keys":["a","\u{1f600}","\u{e000}"],"hostEntry":"undefined","orderedEntry":"undefined"})
        );
        let mutation = invoke(
            data.clone(),
            json!({"name":"write","requestId":"write"}),
            "mutation",
        )
        .unwrap();
        assert_eq!(mutation.value, json!("undefined"));
        assert_eq!(mutation.puts["source:[\"bundle\",\"other\"]"], 42);
        assert!(!mutation.puts.contains_key("bundle"));
        assert!(!mutation.deletes.iter().any(|key| key == "bundle"));
        assert_eq!(data["bundle"], bundle);
    }

    #[test]
    fn trusted_persisted_results_obey_transport_depth_before_commit() {
        let code = fixture_bundle(
            r#"var __flowerBundle = {default: {
          nested: {compute: (_, levels) => { let value=0; for(let i=0;i<levels;i++) value={n:value}; return value; }},
          retain: {kind:'mutationMethod', compute: (ctx, levels) => { ctx.materialize({kind:'derived',name:'nested'}, levels); return null; }}
        }};"#,
        );
        let data = BTreeMap::from([(
            "bundle".into(),
            json!({"hash":hash(code.as_bytes()),"javascript":code}),
        )]);
        let valid = invoke(
            data.clone(),
            json!({"name":"retain","args":123,"requestId":"valid"}),
            "mutation",
        )
        .expect("a value within the transport nesting limit must remain valid");
        assert_eq!(valid.puts["cell:[\"nested\",123]"]["outcome"]["ok"], true);
        match invoke(
            data.clone(),
            json!({"name":"retain","args":124,"requestId":"invalid"}),
            "mutation",
        ) {
            Err(error) => assert!(error.to_string().contains("INPUT_INVALID"), "{error}"),
            Ok(result) => {
                // QuickJS can reach its own stack limit before the host's JSON
                // boundary. That is a stored compute error, never a deep value.
                assert_eq!(result.puts["cell:[\"nested\",124]"]["outcome"]["ok"], false);
                assert_eq!(
                    result.puts["cell:[\"nested\",124]"]["outcome"]["error"]["code"],
                    "INVALID_VALUE"
                );
            }
        }
        assert_eq!(data.len(), 1);
    }

    #[test]
    fn methods_read_staged_derived_values_and_commit_the_final_graph() {
        let data = method_data();
        let result = invoke(
            data,
            json!({"requestId":"method-1","name":"update","args":4}),
            "mutation",
        )
        .unwrap();
        assert_eq!(result.value, json!({"before":8,"after":10}));
        assert_eq!(result.puts["source:[\"input\",\"a\"]"], 5);
        assert_eq!(
            result.puts["cell:[\"double\",null]"]["outcome"]["value"],
            10
        );
    }

    #[test]
    fn queries_compute_ephemerally_and_cannot_call_mutations_or_derived_definitions_directly() {
        let result = invoke(method_data(), json!({"name":"read"}), "query").unwrap();
        assert_eq!(result.value, 0);
        assert!(result.puts.is_empty());
        assert!(result.deletes.is_empty());
        for name in ["update", "double"] {
            let error = invoke(method_data(), json!({"name":name}), "query").unwrap_err();
            assert!(
                error.to_string().contains("METHOD_KIND_MISMATCH"),
                "{error}"
            );
        }
    }

    #[test]
    fn method_errors_and_caught_query_writes_abort_without_a_batch() {
        let error = invoke(
            method_data(),
            json!({"requestId":"fail-1","name":"fail"}),
            "mutation",
        )
        .unwrap_err();
        assert!(error.to_string().contains("rejected by method"));
        let error = invoke(method_data(), json!({"name":"badQuery"}), "query").unwrap_err();
        assert!(
            error.to_string().contains("QUERY_WRITE_FORBIDDEN"),
            "{error}"
        );
    }

    #[test]
    fn public_method_invocations_cannot_smuggle_raw_operations() {
        assert!(
            validate_invocation(
                &json!({"requestId":"x","name":"update","writes":[]}),
                "mutation"
            )
            .is_err()
        );
        assert!(validate_invocation(&json!({"name":"read","bundle":{}}), "query").is_err());
    }

    fn deploy_manifest(manifest: &str) -> Result<Evaluation> {
        let javascript = format!("var __flowerBundle = {{default: {manifest}}};");
        evaluate(
            BTreeMap::new(),
            json!({
                "requestId":"deploy", "bundle":{"hash":hash(javascript.as_bytes()),"javascript":javascript}
            }),
        )
    }

    #[test]
    fn deployment_extracts_only_explicit_public_aliases() {
        let result = deploy_manifest(
            r#"{
            definitions: {
                internalRead: {name:'internalRead', kind:'queryMethod', compute: () => 42},
                privateReset: {name:'privateReset', kind:'mutationMethod', compute: () => null}
            },
            http: {inspect: {name:'internalRead',kind:'query'}}
        }"#,
        )
        .unwrap();
        assert_eq!(
            result.puts["httpMethods"],
            json!({"inspect":{"name":"internalRead","kind":"query"}})
        );
        assert!(result.puts.contains_key("bundle"));
        let private = deploy_manifest(
            r#"{
            definitions: {read: {name:'read',kind:'queryMethod',compute: () => 42}}, http: {}
        }"#,
        )
        .unwrap();
        assert_eq!(private.puts["httpMethods"], json!({}));
    }

    #[test]
    fn invalid_http_registries_cannot_be_deployed() {
        for manifest in [
            r#"{definitions:{},http:{bad:{name:'missing',kind:'query'}}}"#,
            r#"{definitions:{value:{name:'value',kind:'derived',compute:()=>42}},http:{bad:{name:'value',kind:'query'}}}"#,
            r#"{definitions:{write:{name:'write',kind:'mutationMethod',compute:()=>null}},http:{bad:{name:'write',kind:'query'}}}"#,
            r#"{definitions:{read:{name:'different',kind:'queryMethod',compute:()=>42}},http:{}}"#,
            r#"{definitions:{},get http(){return {}}}"#,
        ] {
            assert!(deploy_manifest(manifest).is_err(), "accepted {manifest}");
        }
    }

    #[test]
    fn query_consistency_defaults_are_backward_compatible_and_typed() {
        for kind in ["query", "mutation"] {
            let original = json!({"name":"method","kind":kind});
            let method: HttpMethod = serde_json::from_value(original.clone()).unwrap();
            assert_eq!(method.consistency, QueryConsistency::Linearizable);
            assert_eq!(serde_json::to_value(method).unwrap(), original);
        }
        let explicit: HttpMethod = serde_json::from_value(json!({
            "name":"read","kind":"query","consistency":"linearizable"
        }))
        .unwrap();
        assert_eq!(
            serde_json::to_value(explicit).unwrap(),
            json!({"name":"read","kind":"query"})
        );
        let local = json!({"name":"read","kind":"query","consistency":"replica-local"});
        let method: HttpMethod = serde_json::from_value(local.clone()).unwrap();
        assert_eq!(method.consistency, QueryConsistency::ReplicaLocal);
        assert_eq!(serde_json::to_value(method).unwrap(), local);
        for consistency in [json!("linearizable"), json!("replica-local"), Value::Null] {
            assert!(
                serde_json::from_value::<HttpMethod>(json!({
                    "name":"write","kind":"mutation","consistency":consistency
                }))
                .is_err()
            );
        }
        for consistency in [json!("stale"), json!(false), Value::Null] {
            assert!(
                serde_json::from_value::<HttpMethod>(json!({
                    "name":"read","kind":"query","consistency":consistency
                }))
                .is_err()
            );
        }
    }

    fn deploy_manifest_with_oracle(manifest: &str) -> (Result<Evaluation>, Result<Evaluation>) {
        let javascript = format!("var __flowerBundle = {{default: {manifest}}};");
        let input = json!({
            "requestId":"deploy", "bundle":{"hash":hash(javascript.as_bytes()),"javascript":javascript}
        });
        (
            evaluate(BTreeMap::new(), input.clone()),
            oracle::evaluate_inner(
                BTreeMap::new(),
                input,
                "deployment",
                config::settings().unwrap().evaluation_timeout,
                Some(0),
            ),
        )
    }

    #[test]
    fn query_consistency_is_preserved_by_wasm_and_reference_manifests() {
        let (actual, oracle) = deploy_manifest_with_oracle(
            r#"{
                definitions: {
                    local:{name:'local',kind:'queryMethod',consistency:'replica-local',compute:()=>1},
                    fresh:{name:'fresh',kind:'queryMethod',compute:()=>2},
                    explicit:{name:'explicit',kind:'queryMethod',consistency:'linearizable',compute:()=>3}
                },
                http: {
                    read:{name:'local',kind:'query',consistency:'replica-local'},
                    alias:{name:'local',kind:'query',consistency:'replica-local'},
                    fresh:{name:'fresh',kind:'query'},
                    explicit:{name:'explicit',kind:'query',consistency:'linearizable'}
                }
            }"#,
        );
        let expected = json!({
            "read":{"name":"local","kind":"query","consistency":"replica-local"},
            "alias":{"name":"local","kind":"query","consistency":"replica-local"},
            "fresh":{"name":"fresh","kind":"query"},
            "explicit":{"name":"explicit","kind":"query"}
        });
        assert_eq!(actual.unwrap().puts["httpMethods"], expected);
        assert_eq!(oracle.unwrap().puts["httpMethods"], expected);
    }

    #[test]
    fn query_consistency_rejects_mutations_mismatches_and_caller_overrides() {
        for (kind, definition_mode, mapping_mode) in [
            ("query", "", ",consistency:'replica-local'"),
            ("query", ",consistency:'replica-local'", ""),
            (
                "query",
                ",consistency:'replica-local'",
                ",consistency:'linearizable'",
            ),
            ("query", ",consistency:'unknown'", ",consistency:'unknown'"),
            ("query", ",consistency:undefined", ""),
            ("query", "", ",consistency:null"),
            (
                "query",
                ",get consistency(){return 'replica-local'}",
                ",consistency:'replica-local'",
            ),
            ("mutation", ",consistency:'replica-local'", ""),
            ("mutation", ",consistency:'linearizable'", ""),
            ("mutation", "", ",consistency:'replica-local'"),
            ("mutation", "", ",consistency:'linearizable'"),
        ] {
            let manifest = format!(
                r#"{{
                    definitions: {{
                        method: {{name:'method',kind:'{kind}Method',compute:()=>null{definition_mode}}}
                    }},
                    http: {{
                        run: {{name:'method',kind:'{kind}'{mapping_mode}}}
                    }}
                }}"#
            );
            let (actual, oracle) = deploy_manifest_with_oracle(&manifest);
            assert!(actual.is_err(), "Wasm accepted {manifest}");
            assert!(oracle.is_err(), "native oracle accepted {manifest}");
        }
        for manifest in [
            "{definitions:{value:{name:'value',kind:'derived',compute:()=>1,consistency:'replica-local'}},http:{}}",
            "{definitions:{run:{name:'run',kind:'mutationMethod',compute:()=>null}},http:{},maintenance:{name:'run',kind:'mutation',consistency:'replica-local'}}",
            "{definitions:{run:{name:'run',kind:'mutationMethod',compute:()=>null}},http:{},maintenance:{name:'run',kind:'mutation',onError:{name:'run',kind:'mutation',consistency:'linearizable'}}}",
        ] {
            let (actual, oracle) = deploy_manifest_with_oracle(manifest);
            assert!(actual.is_err(), "Wasm accepted {manifest}");
            assert!(oracle.is_err(), "native oracle accepted {manifest}");
        }
        for kind in ["query", "mutation", "call"] {
            assert!(
                validate_invocation(
                    &json!({"name":"read","requestId":"id","consistency":"replica-local"}),
                    kind
                )
                .is_err()
            );
        }
    }

    #[test]
    fn calls_allow_optional_retry_metadata_without_accepting_raw_writes() {
        validate_invocation(&json!({"name":"inspect"}), "call").unwrap();
        validate_invocation(
            &json!({"name":"update","requestId":"id","expectedRevision":1}),
            "call",
        )
        .unwrap();
        assert!(validate_invocation(&json!({"name":"update","writes":[]}), "call").is_err());
        assert!(validate_invocation(&json!({"name":"update","requestId":""}), "call").is_err());
    }

    #[test]
    fn maintenance_registration_is_private_and_requires_a_mutation() {
        let result = deploy_manifest(
            r#"{
            definitions: {sweep:{name:'sweep',kind:'mutationMethod',compute:()=>null}},
            http:{}, maintenance:{name:'sweep',kind:'mutation'}
        }"#,
        )
        .unwrap();
        assert_eq!(result.puts["httpMethods"], json!({}));
        assert_eq!(
            result.puts["maintenanceMethod"],
            json!({"name":"sweep","kind":"mutation"})
        );
        let removed = deploy_manifest("{definitions:{},http:{},maintenance:null}").unwrap();
        assert_eq!(removed.puts["maintenanceMethod"], Value::Null);
        for manifest in [
            r#"{definitions:{},http:{},maintenance:{name:'missing',kind:'mutation'}}"#,
            r#"{definitions:{read:{name:'read',kind:'queryMethod',compute:()=>null}},http:{},maintenance:{name:'read',kind:'query'}}"#,
            r#"{definitions:{read:{name:'read',kind:'queryMethod',compute:()=>null}},http:{},maintenance:{name:'read',kind:'mutation'}}"#,
            r#"{definitions:{},http:{},get maintenance(){return null}}"#,
        ] {
            assert!(deploy_manifest(manifest).is_err(), "accepted {manifest}");
        }
    }

    #[test]
    fn maintenance_error_handler_is_private_validated_and_deployed_atomically() {
        let definitions = r#"{
            run:{name:'run',kind:'mutationMethod',compute:()=>null},
            recover:{name:'recover',kind:'mutationMethod',compute:()=>null},
            read:{name:'read',kind:'queryMethod',compute:()=>null},
            derived:{name:'derived',kind:'derived',compute:()=>null}
        }"#;
        let result = deploy_manifest(&format!(
            "{{definitions:{definitions},http:{{}},maintenance:{{name:'run',kind:'mutation',onError:{{name:'recover',kind:'mutation'}}}}}}"
        ))
        .unwrap();
        assert_eq!(result.puts["httpMethods"], json!({}));
        assert_eq!(
            result.puts["maintenanceMethod"],
            json!({"name":"run","kind":"mutation","onError":{"name":"recover","kind":"mutation"}})
        );
        for handler in [
            "null",
            "undefined",
            "[]",
            "{name:'missing',kind:'mutation'}",
            "{name:'read',kind:'mutation'}",
            "{name:'read',kind:'query'}",
            "{name:'derived',kind:'mutation'}",
            "{name:'recover',kind:'mutation',onError:{name:'run',kind:'mutation'}}",
            "{get name(){return 'recover'},kind:'mutation'}",
        ] {
            let manifest = format!(
                "{{definitions:{definitions},http:{{}},maintenance:{{name:'run',kind:'mutation',onError:{handler}}}}}"
            );
            assert!(deploy_manifest(&manifest).is_err(), "accepted {handler}");
        }
        let manifest = format!(
            "{{definitions:{definitions},http:{{}},maintenance:{{name:'run',kind:'mutation',get onError(){{return {{name:'recover',kind:'mutation'}}}}}}}}"
        );
        assert!(deploy_manifest(&manifest).is_err());

        let long_name = "r".repeat(513);
        let manifest = format!(
            "{{definitions:{{run:{{name:'run',kind:'mutationMethod',compute:()=>null}},'{long_name}':{{name:'{long_name}',kind:'mutationMethod',compute:()=>null}}}},http:{{}},maintenance:{{name:'run',kind:'mutation',onError:{{name:'{long_name}',kind:'mutation'}}}}}}"
        );
        assert_eq!(
            deploy_manifest(&manifest).unwrap().puts["maintenanceMethod"]["onError"]["name"],
            json!(long_name)
        );
    }

    #[test]
    fn sampled_time_crosses_quickjs_contexts_and_queries_refresh_time_without_writes() {
        let javascript = fixture_bundle(
            r#"var __flowerBundle = {default: {
            time: {compute: (ctx) => ctx.now()},
            seed: {kind:'mutationMethod', compute: (ctx) => {
                ctx.materialize({kind:'derived',name:'time'});
                return [ctx.now(), ctx.get({kind:'derived',name:'time'}), ctx.now()];
            }},
            read: {kind:'queryMethod', compute: (ctx) => [ctx.now(), ctx.get({kind:'derived',name:'time'})]}
        }};"#,
        );
        let deployment = json!({"requestId":"deploy","bundle":{"hash":hash(javascript.as_bytes()),"javascript":javascript}});
        let deployed = evaluate_at(BTreeMap::new(), deployment, 1_000).unwrap();
        let mut data = deployed.puts;
        assert_eq!(data["clock"], 1_000);
        let seeded = invoke_at(
            data.clone(),
            json!({"name":"seed","requestId":"seed"}),
            "mutation",
            1_100,
        )
        .unwrap();
        assert_eq!(seeded.value, json!([1_100, 1_100, 1_100]));
        assert_eq!(seeded.puts["clock"], 1_100);
        data.extend(seeded.puts);
        for id in seeded.deletes {
            data.remove(&id);
        }
        let queried = invoke_at(data.clone(), json!({"name":"read"}), "query", 1_200).unwrap();
        assert_eq!(queried.value, json!([1_200, 1_200]));
        assert!(queried.puts.is_empty() && queried.deletes.is_empty());
        assert_eq!(data["clock"], 1_100);
        let backwards = invoke_at(data, json!({"name":"read"}), "query", 900).unwrap();
        assert_eq!(backwards.value, json!([1_100, 1_100]));
    }

    #[test]
    fn method_failures_keep_explicit_codes_and_json_details() {
        let javascript = fixture_bundle(
            r#"var __flowerBundle = {default: {
            checkout: {kind:'mutationMethod', compute: () => {
                throw Object.assign(new Error('The user interrupted checkout'), {code: 'CHECKOUT_ABORTED', details: {step: 2}});
            }},
            broken: {kind:'mutationMethod', compute: () => { throw new Error('interrupted by nothing in particular'); }},
            plain: {kind:'mutationMethod', compute: () => { throw Object.assign(new Error('no'), {details: () => 1}); }}
        }};"#,
        );
        let deployment = json!({"requestId":"deploy","bundle":{"hash":hash(javascript.as_bytes()),"javascript":javascript}});
        let data = evaluate_at(BTreeMap::new(), deployment, 1_000)
            .unwrap()
            .puts;
        let failure = |name: &str| {
            let error = invoke_at(
                data.clone(),
                json!({"name":name,"requestId":name}),
                "mutation",
                1_100,
            )
            .unwrap_err();
            error
                .downcast_ref::<rust_engine::EngineError>()
                .expect("engine failure")
                .failure()
        };
        assert_eq!(
            failure("checkout"),
            json!({"code":"CHECKOUT_ABORTED","message":"The user interrupted checkout","details":{"step":2}})
        );
        assert_eq!(failure("broken")["code"], "EVALUATION_BUDGET");
        assert_eq!(
            failure("plain"),
            json!({"code":"COMPUTE_ERROR","message":"no"})
        );
    }

    #[test]
    fn request_payloads_cannot_set_server_time_or_request_internal_commits() {
        for kind in ["query", "mutation", "call"] {
            for extra in ["now", "clock", "internal"] {
                let mut input = json!({"name":"method"});
                if kind != "query" {
                    input["requestId"] = json!("id");
                }
                input[extra] = json!(1);
                assert!(
                    validate_invocation(&input, kind).is_err(),
                    "accepted {kind} {extra}"
                );
            }
        }
        assert!(validate_mutation(&json!({"requestId":"id","now":123})).is_err());
    }
}
