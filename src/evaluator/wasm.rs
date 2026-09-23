//! QuickJS cells in logically fresh heaps backed by reusable COW images.
//!
//! Rust owns coordination and database state. The shared engine, trusted compiled
//! code, linked imports and pristine guest snapshots survive calls; mutable guest
//! heaps and invocation host callbacks never do. Synchronous writer batches may
//! reuse resident storage after restoring every byte and mutable global.
mod abi;
mod cache;
mod code_cache;
mod crypto;
#[cfg(test)]
mod crypto_tests;
mod dirty;
mod host;
mod limits;
mod native_profile;
mod recycle;
mod reset_surface;
mod shadow_stack;
mod surface;
#[cfg(test)]
mod tests;

use abi::Abi;
use anyhow::{Result, ensure};
pub(super) use cache::Prepared;
use host::Callback;
pub use limits::Limits;
use limits::MemoryLimit;
use serde_json::{Value, json};
use std::sync::Arc;
use wasmtime::{Engine, Store, UpdateDeadline};

#[cfg(test)]
const MAX_MEMORY_BYTES: usize = 128 * 1024 * 1024;
fn max_json_bytes() -> Result<usize> {
    Ok(super::config::settings()?.result_max_bytes)
}
pub const STATIC_INIT_MARKER: &str = "/* flower:static-init */";

struct Host {
    abi: Option<Abi>,
    callback: Option<Callback>,
    entropy_allowed: bool,
    managed_shared: std::collections::HashMap<String, crypto::SharedKey>,
    managed_shared_bytes: usize,
    managed_authorizations: std::collections::HashMap<String, crypto::CachedAuthorization>,
    managed_authorization_bytes: usize,
    shared: Arc<Limits>,
    memory: MemoryLimit,
    dirty: Option<Arc<dirty::Tracker>>,
}

impl Host {
    fn new(shared: Arc<Limits>, callback: Option<Callback>) -> Self {
        Self {
            abi: None,
            callback,
            entropy_allowed: false,
            managed_shared: std::collections::HashMap::new(),
            managed_shared_bytes: 0,
            managed_authorizations: std::collections::HashMap::new(),
            managed_authorization_bytes: 0,
            memory: MemoryLimit::new(shared.clone()),
            shared,
            dirty: None,
        }
    }
}

fn store(engine: &Engine, shared: Arc<Limits>, callback: Option<Callback>) -> Store<Host> {
    let mut store = Store::new(engine, Host::new(shared, callback));
    store.limiter(|host| &mut host.memory);
    store.set_epoch_deadline(1);
    store.epoch_deadline_callback(|context| {
        context
            .data()
            .shared
            .check()
            .map_err(wasmtime::Error::from_anyhow)?;
        Ok(UpdateDeadline::Continue(1))
    });
    store
}

pub(crate) fn recycle_scope() -> impl Drop {
    recycle::Scope::configured()
}

pub(crate) fn clear_recycle_idle() {
    recycle::clear_idle();
}

/// Compile and initialize the shared sandbox before accepting timed requests.
pub fn warmup() -> Result<()> {
    cache::runtime().map(|_| ())
}

pub(super) fn prepare(bundle: &str, shared: Arc<Limits>) -> Result<Arc<Prepared>> {
    cache::runtime()?.prepare(bundle, shared)
}

pub(super) fn prepare_shared_bundle(
    bundle: &Arc<Value>,
    shared: Arc<Limits>,
) -> Result<Arc<Prepared>> {
    cache::runtime()?.prepare_shared_bundle(bundle, shared)
}

#[cfg(test)]
fn execute(
    bundle: &str,
    name: &str,
    args: &Value,
    kind: &str,
    host: &mut dyn FnMut(&str, Value) -> Result<Value>,
    shared: Arc<Limits>,
) -> Result<Value> {
    let prepared = prepare(bundle, shared.clone())?;
    execute_prepared(&prepared, name, args, kind, host, shared)
}

/// Run one isolated callback from an image acquired once per transaction.
/// Business errors are returned in {ok:false,error:{code,message}} envelopes;
/// resource failures remain Err and poison the shared transaction allowance.
#[cfg(test)]
pub(super) fn execute_prepared(
    prepared: &Prepared,
    name: &str,
    args: &Value,
    kind: &str,
    host: &mut dyn FnMut(&str, Value) -> Result<Value>,
    shared: Arc<Limits>,
) -> Result<Value> {
    execute_prepared_profiled(prepared, name, args, kind, host, shared, &None)
}

pub(super) fn execute_prepared_profiled(
    prepared: &Prepared,
    name: &str,
    args: &Value,
    kind: &str,
    host: &mut dyn FnMut(&str, Value) -> Result<Value>,
    shared: Arc<Limits>,
    profile: &Option<Arc<super::profile::Invocation>>,
) -> Result<Value> {
    let _depth = shared.enter()?;
    check_json(args)?;
    let args = super::json_order::ordered_value(args)?;
    ensure!(
        args.len() <= max_json_bytes()?,
        "INPUT_INVALID: arguments exceed FLOWER_RESULT_MAX_BYTES"
    );
    let runtime = cache::runtime()?;
    shared.check()?;
    // SAFETY: the bridge is borrowed only while this function is active; every
    // Store using its pointer is dropped or detached below before the bridge or
    // caller's callback can go away. Host callbacks are synchronous
    // and confined to this thread, including recursively entered child Stores.
    let mut bridge = host;
    let callback = unsafe { Callback::scoped(&mut bridge) };
    let setup_timer = super::profile::timer(profile, super::profile::Stage::CellRuntime);
    let mut cell = recycle::checkout(prepared, &runtime.engine, shared.clone(), callback, profile)?;
    cell.store.data_mut().entropy_allowed = kind == "mutation";
    let result = (|| {
        let store = &mut cell.store;
        let abi = &cell.abi;
        drop(setup_timer);
        let load_timer = super::profile::timer(profile, super::profile::Stage::CellLoad);
        let invocation = abi.invocation(
            store,
            name,
            &args,
            kind,
            prepared.bytecode.as_deref(),
            prepared.input_buffer,
        )?;
        drop(load_timer);
        let run_timer = super::profile::timer(profile, super::profile::Stage::CellExecute);
        let encoded = abi.run_once(store, invocation)?;
        drop(run_timer);
        let value = abi.callback_result(store, encoded)?;
        if value.get("ok").and_then(Value::as_bool) == Some(true) {
            check_json(&value["value"])?;
        }
        Ok(value)
    })();
    // Never let the borrowed callback escape, including a failed evaluation.
    cell.store.data_mut().callback = None;
    if result.as_ref().err().is_some_and(is_guest_trap) {
        shared.fail();
    }
    if let Err(error) = shared.check() {
        recycle::discard(cell);
        return Err(error);
    }
    if result.is_ok() {
        let _reset_timer = super::profile::timer(profile, super::profile::Stage::CellReset);
        recycle::finish(cell, &shared, profile)?;
    } else {
        recycle::discard(cell);
    }
    result
}

fn is_guest_trap(error: &anyhow::Error) -> bool {
    error.downcast_ref::<wasmtime::Trap>().is_some()
}

#[cfg(test)]
fn manifest(bundle: &str, shared: Arc<Limits>) -> Result<String> {
    let prepared = prepare(bundle, shared.clone())?;
    manifest_prepared(&prepared, shared)
}

/// Validate the manifest in a fresh isolated guest without invocation bindings.
pub(super) fn manifest_prepared(prepared: &Prepared, shared: Arc<Limits>) -> Result<String> {
    let _depth = shared.enter()?;
    let runtime = cache::runtime()?;
    let mut store = store(&runtime.engine, shared.clone(), None);
    let result = (|| {
        let instance = prepared.pre.instantiate(&mut store).map_err(|error| error.context("Wasm instance allocation failed; check FLOWER_WASM_POOL_SLOTS and FLOWER_GUEST_MEMORY_BYTES"))?;
        let abi = Abi::load_cached(&mut store, instance, &prepared.exports)?;
        store.data_mut().abi = Some(abi.clone());
        if let Some(bytecode) = &prepared.bytecode {
            abi.bytecode(&mut store, bytecode)?;
        }
        abi.eval_string(
            &mut store,
            &format!(
                "((__flowerSchema)=>{})({})",
                super::BUNDLE_MANIFEST,
                include_str!("schema-manifest.js")
            ),
        )
    })();
    drop(store);
    if result.as_ref().err().is_some_and(is_guest_trap) {
        shared.fail();
    }
    shared.check()?;
    result
}

pub(super) fn check_json(value: &Value) -> Result<()> {
    fn walk(value: &Value, depth: usize) -> Result<()> {
        ensure!(
            depth <= 128,
            "INVALID_VALUE: JSON nesting exceeds 128 levels"
        );
        match value {
            Value::Array(values) => {
                for value in values {
                    walk(value, depth + 1)?;
                }
            }
            Value::Object(values) => {
                for value in values.values() {
                    walk(value, depth + 1)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    walk(value, 1)
}

pub(super) fn error_envelope(error: anyhow::Error) -> Value {
    if let Some(error) = error.downcast_ref::<super::rust_engine::EngineError>() {
        return json!({"ok": false, "error": {"code": error.code, "message": error.message}});
    }
    let message = error.to_string();
    // Rust coordinator errors have a stable CODE: message display. Arbitrary
    // callback errors get COMPUTE_ERROR; never reinterpret punctuation as a code.
    let (code, message) = message
        .split_once(": ")
        .filter(|(code, _)| {
            !code.is_empty() && code.bytes().all(|b| b.is_ascii_uppercase() || b == b'_')
        })
        .unwrap_or(("COMPUTE_ERROR", &message));
    json!({"ok": false, "error": {"code": code, "message": message}})
}

// Bound wire nesting before disabling serde's smaller default recursion limit:
// business JSON permits 128 levels, plus the host call / envelope wrappers.
pub(super) fn parse_json(encoded: &str) -> Result<Value> {
    use serde::Deserialize;
    ensure!(
        encoded.len() <= max_json_bytes()?,
        "JSON exceeds FLOWER_RESULT_MAX_BYTES"
    );
    let (mut quoted, mut escaped, mut depth) = (false, false, 0usize);
    for byte in encoded.bytes() {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
        } else {
            match byte {
                b'"' => quoted = true,
                b'{' | b'[' => {
                    depth += 1;
                    ensure!(depth <= 136, "INVALID_VALUE: JSON nesting exceeds limit");
                }
                b'}' | b']' => depth = depth.saturating_sub(1),
                _ => {}
            }
        }
    }
    let mut decoder = serde_json::Deserializer::from_str(encoded);
    decoder.disable_recursion_limit();
    let result = Value::deserialize(&mut decoder)?;
    decoder.end()?;
    Ok(result)
}

/// Test-only access to the same bounded guest, used by independent JavaScript
/// reference algorithms without linking a second native interpreter.
#[cfg(test)]
pub(super) fn reference_script(code: &str, shared: Arc<Limits>) -> Result<String> {
    let prepared = prepare("", shared.clone())?;
    let _depth = shared.enter()?;
    let runtime = cache::runtime()?;
    let mut store = store(&runtime.engine, shared.clone(), None);
    let result = (|| {
        let instance = prepared.pre.instantiate(&mut store)?;
        let abi = Abi::load_cached(&mut store, instance, &prepared.exports)?;
        store.data_mut().abi = Some(abi.clone());
        abi.eval_string(&mut store, code)
    })();
    drop(store);
    shared.check()?;
    result
}
