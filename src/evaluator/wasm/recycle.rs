//! Recycle resident storage, never logical interpreter state. Only synchronous
//! blocking batches enable this thread-local cache; no Store or scoped callback
//! crosses threads. Final Wasm images are checked by reset_surface first.
use super::{Abi, Callback, Host, Limits, MemoryLimit, Prepared};
use anyhow::{Context, Result, ensure};
use std::{
    cell::RefCell,
    marker::PhantomData,
    rc::Rc,
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};
use wasmtime::{Engine, Global, Module, ModuleExport, Store, Val};

pub(super) struct Image {
    globals: Vec<ModuleExport>,
    pub(super) memory_bytes: usize,
    initial: OnceLock<Snapshot>,
}

struct Snapshot {
    memory: Box<[u8]>,
    globals: Vec<Number>,
}

// Store-independent bit representations only. Wasmtime Val also supports rooted
// references; those must never become shared snapshot state.
#[derive(Clone, Copy)]
enum Number {
    I32(i32),
    I64(i64),
    F32(u32),
    F64(u64),
    V128(u128),
}

impl Number {
    fn capture(value: Val) -> Result<Self> {
        Ok(match value {
            Val::I32(value) => Self::I32(value),
            Val::I64(value) => Self::I64(value),
            Val::F32(value) => Self::F32(value),
            Val::F64(value) => Self::F64(value),
            Val::V128(value) => Self::V128(value.as_u128()),
            _ => anyhow::bail!("reset snapshot contains a reference-valued global"),
        })
    }

    fn value(self) -> Val {
        match self {
            Self::I32(value) => Val::I32(value),
            Self::I64(value) => Val::I64(value),
            Self::F32(value) => Val::F32(value),
            Self::F64(value) => Val::F64(value),
            Self::V128(value) => Val::V128(value.into()),
        }
    }
}

impl Image {
    pub(super) fn new(module: &Module, globals: &[String]) -> Result<Self> {
        let memory = module
            .get_export("memory")
            .and_then(|ty| ty.memory().cloned())
            .context("reset image memory")?;
        let memory_bytes = usize::try_from(memory.minimum())?
            .checked_mul(65536)
            .context("reset image memory size overflow")?;
        let globals = globals
            .iter()
            .map(|name| module.get_export_index(name).context("reset global export"))
            .collect::<Result<_>>()?;
        Ok(Self {
            globals,
            memory_bytes,
            initial: OnceLock::new(),
        })
    }
}

pub(super) struct Cell {
    pub(super) store: Store<Host>,
    pub(super) abi: Abi,
    image: Arc<Image>,
    globals: Vec<Global>,
    recyclable: bool,
    dirty: Option<Arc<super::dirty::Tracker>>,
    #[cfg(test)]
    reported_faults: usize,
}

impl Drop for Cell {
    fn drop(&mut self) {
        // This runs before Store's fields/destructor, including traps, native
        // panics and partially completed setup. Never return a protected mapping
        // to Wasmtime's allocator if OS cleanup fails.
        if let Some(dirty) = &self.dirty
            && dirty.unprotect().is_err()
        {
            std::process::abort();
        }
    }
}

struct Idle {
    cell: Cell,
    _reservation: Reservation,
}

#[derive(Default)]
struct Pool {
    idle: Vec<Idle>,
}

#[derive(Default)]
struct State {
    pool: Option<Pool>,
    #[cfg(test)]
    stats: Stats,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

/// Must remain on its creating thread, including when no idle Store exists yet.
pub(crate) struct Scope {
    owner: bool,
    _thread: PhantomData<Rc<()>>,
}

impl Scope {
    pub(super) fn enter() -> Self {
        let owner = STATE.with_borrow_mut(|state| {
            if state.pool.is_some() {
                false
            } else {
                state.pool = Some(Pool::default());
                #[cfg(test)]
                {
                    state.stats = Stats::default();
                }
                true
            }
        });
        Self {
            owner,
            _thread: PhantomData,
        }
    }

    pub(super) fn configured() -> Self {
        static ENABLED: OnceLock<bool> = OnceLock::new();
        if *ENABLED.get_or_init(|| {
            !std::env::var("FLOWER_WASM_RECYCLE")
                .is_ok_and(|value| value == "0" || value == "false")
        }) {
            Self::enter()
        } else {
            Self {
                owner: false,
                _thread: PhantomData,
            }
        }
    }
}

impl Drop for Scope {
    fn drop(&mut self) {
        if self.owner {
            // Release RefCell before dropping Stores or accounting reservations.
            let pool = STATE.with_borrow_mut(|state| state.pool.take());
            drop(pool);
        }
    }
}

pub(super) fn clear_idle() {
    let idle = STATE.with_borrow_mut(|state| {
        state
            .pool
            .as_mut()
            .map(|pool| std::mem::take(&mut pool.idle))
    });
    drop(idle);
}

#[derive(Default)]
struct Occupancy {
    slots: usize,
    bytes: usize,
}
static OCCUPANCY: Mutex<Occupancy> = Mutex::new(Occupancy { slots: 0, bytes: 0 });

struct Reservation {
    bytes: usize,
}
impl Reservation {
    fn acquire(bytes: usize) -> Option<Self> {
        let settings = super::super::config::settings().ok()?;
        let slots = settings.wasm_pool_slots as usize / 2;
        let mut occupied = OCCUPANCY.lock().unwrap_or_else(|error| error.into_inner());
        if occupied.slots >= slots
            || bytes > settings.wasm_recycle_bytes.saturating_sub(occupied.bytes)
        {
            return None;
        }
        occupied.slots += 1;
        occupied.bytes += bytes;
        Some(Self { bytes })
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        let mut occupied = OCCUPANCY.lock().unwrap_or_else(|error| error.into_inner());
        occupied.slots -= 1;
        occupied.bytes -= self.bytes;
    }
}

pub(super) fn checkout(
    prepared: &Prepared,
    engine: &Engine,
    shared: Arc<Limits>,
    callback: Callback,
    profile: &Option<Arc<super::super::profile::Invocation>>,
) -> Result<Cell> {
    let (enabled, idle) = STATE.with_borrow_mut(|state| {
        let Some(pool) = state.pool.as_mut() else {
            return (false, None);
        };
        let item = pool
            .idle
            .iter()
            .position(|idle| Arc::ptr_eq(&idle.cell.image, &prepared.image))
            .map(|position| pool.idle.swap_remove(position));
        (true, item)
    });
    if let Some(Idle {
        mut cell,
        _reservation,
    }) = idle
    {
        drop(_reservation);
        let memory = MemoryLimit::existing(shared.clone(), cell.image.memory_bytes)?;
        let mut host = Host::new(shared, Some(callback));
        host.memory = memory;
        host.abi = Some(cell.abi.clone());
        host.dirty = cell.dirty.clone();
        host.memory.track(cell.dirty.clone());
        *cell.store.data_mut() = host;
        cell.store.set_epoch_deadline(1);
        #[cfg(test)]
        STATE.with_borrow_mut(|state| state.stats.reused += 1);
        super::super::profile::cell_storage(profile, true, true, cell.image.memory_bytes);
        return Ok(cell);
    }

    // An idle instance from another image is never allowed to prevent a local
    // cold image or recursively entered callback from obtaining a pool slot.
    clear_idle();
    let mut store = super::store(engine, shared, Some(callback));
    let instance = prepared.pre.instantiate(&mut store).map_err(|error| error.context(
        "Wasm instance allocation failed; check FLOWER_WASM_POOL_SLOTS and FLOWER_GUEST_MEMORY_BYTES"
    ))?;
    let abi = Abi::load_cached(&mut store, instance, &prepared.exports)?;
    store.data_mut().abi = Some(abi.clone());
    let settings = super::super::config::settings()?;
    let recyclable = enabled
        && settings.wasm_pool_slots > 1
        && settings.wasm_recycle_bytes > 0
        && prepared.image.memory_bytes <= settings.wasm_recycle_bytes;
    let mut globals = Vec::new();
    if recyclable {
        for export in &prepared.image.globals {
            globals.push(
                instance
                    .get_module_export(&mut store, export)
                    .and_then(|export| export.into_global())
                    .context("reset global handle")?,
            );
        }
        ensure!(
            abi.memory.data_size(&store) == prepared.image.memory_bytes,
            "reset image initial memory size changed"
        );
        if prepared.image.initial.get().is_none() {
            let values = globals
                .iter()
                .map(|global| Number::capture(global.get(&mut store)))
                .collect::<Result<_>>()?;
            let snapshot = Snapshot {
                memory: abi.memory.data(&store).to_vec().into_boxed_slice(),
                globals: values,
            };
            // Cold requests can race; both observed an unexecuted instance of
            // the same immutable module. Retain only one complete pristine copy.
            let _ = prepared.image.initial.set(snapshot);
        }
    }
    #[cfg(test)]
    STATE.with_borrow_mut(|state| state.stats.created += 1);
    super::super::profile::cell_storage(profile, false, recyclable, abi.memory.data_size(&store));
    let mut cell = Cell {
        store,
        abi,
        image: prepared.image.clone(),
        globals,
        recyclable,
        dirty: None,
        #[cfg(test)]
        reported_faults: 0,
    };
    if recyclable && let Some(dirty) = super::dirty::install(&mut cell.store, cell.abi.memory)? {
        // Own cleanup before the first read-only protection call; mprotect may
        // fail after changing only part of a mapping.
        cell.dirty = Some(dirty.clone());
        if dirty.protect().is_ok() {
            cell.store.data_mut().dirty = Some(dirty.clone());
            cell.store.data_mut().memory.track(Some(dirty));
        } else {
            dirty.unprotect()?;
            cell.dirty = None;
        }
    }
    Ok(cell)
}

pub(super) fn finish(
    mut cell: Cell,
    shared: &Arc<Limits>,
    profile: &Option<Arc<super::super::profile::Invocation>>,
) -> Result<()> {
    let grew = cell.abi.memory.data_size(&cell.store) != cell.image.memory_bytes;
    if !cell.recyclable || grew {
        super::super::profile::cell_reset(profile, grew, 0);
        discard(cell);
        return Ok(());
    }
    let Some(reservation) = Reservation::acquire(cell.image.memory_bytes) else {
        discard(cell);
        return Ok(());
    };
    let initial = cell
        .image
        .initial
        .get()
        .context("missing pristine reset image")?;
    shared.check()?;
    // Restore every byte, including the C stack, dead allocations, invocation
    // inputs, crypto buffers and retained final CString. Guest code never runs
    // during or after reset until fresh invocation capabilities are attached.
    let memory = cell.abi.memory.data_mut(&mut cell.store);
    let copied = if let Some(dirty) = &cell.dirty {
        dirty.restore(memory, &initial.memory)?
    } else {
        memory.copy_from_slice(&initial.memory);
        memory.len()
    };
    for (global, initial) in cell.globals.iter().zip(&initial.globals) {
        global.set(&mut cell.store, initial.value())?;
    }
    super::super::profile::cell_reset(profile, false, copied);
    #[cfg(test)]
    STATE.with_borrow_mut(|state| {
        let faults = cell.dirty.as_ref().map_or(0, |dirty| dirty.faults());
        state.stats.signal_faults += faults - cell.reported_faults;
        cell.reported_faults = faults;
        state.stats.reset_bytes += copied;
        state.stats.reset_total_bytes += cell.image.memory_bytes;
    });
    shared.check()?;
    // Replacing the complete Host also drops every authorization/key cache and
    // releases the old transaction's memory charge. Idle budgets deny all work;
    // checkout must explicitly attach and charge a fresh transaction allowance.
    *cell.store.data_mut() = Host::new(Limits::new(Instant::now(), 0), None);
    let idle = Idle {
        cell,
        _reservation: reservation,
    };
    let displaced = STATE.with_borrow_mut(|state| {
        let Some(pool) = state.pool.as_mut() else {
            return Some(idle);
        };
        let old = pool
            .idle
            .iter()
            .position(|item| Arc::ptr_eq(&item.cell.image, &idle.cell.image))
            .map(|position| pool.idle.swap_remove(position));
        pool.idle.push(idle);
        #[cfg(test)]
        {
            state.stats.returned += 1;
        }
        old
    });
    drop(displaced);
    Ok(())
}

pub(super) fn discard(cell: Cell) {
    #[cfg(test)]
    STATE.with_borrow_mut(|state| state.stats.discarded += 1);
    drop(cell);
}

#[cfg(test)]
#[derive(Default, Clone, Copy, Debug)]
pub(super) struct Stats {
    pub(super) created: usize,
    pub(super) reused: usize,
    pub(super) returned: usize,
    pub(super) discarded: usize,
    pub(super) idle: usize,
    pub(super) signal_faults: usize,
    pub(super) reset_bytes: usize,
    pub(super) reset_total_bytes: usize,
}

#[cfg(test)]
pub(super) fn stats() -> Stats {
    STATE.with_borrow(|state| Stats {
        idle: state.pool.as_ref().map_or(0, |pool| pool.idle.len()),
        ..state.stats
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reset_overwrites_every_guest_byte_and_mutable_global_and_detaches_host() {
        let shared = super::super::tests::limits();
        let prepared =
            super::super::prepare(&super::super::tests::bundle("()=>42", true), shared.clone())
                .unwrap();
        let runtime = super::super::cache::runtime().unwrap();
        let _scope = Scope::enter();
        let mut host = |_: &str, _: serde_json::Value| Ok(serde_json::Value::Null);
        let mut bridge: &mut dyn FnMut(&str, serde_json::Value) -> Result<serde_json::Value> =
            &mut host;
        // The callback lives until both checked-out Stores below are detached.
        let callback = unsafe { Callback::scoped(&mut bridge) };
        let mut cell =
            checkout(&prepared, &runtime.engine, shared.clone(), callback, &None).unwrap();
        let pristine = cell.abi.memory.data(&cell.store).to_vec();
        for global in &cell.globals {
            global.set(&mut cell.store, Val::I32(-17)).unwrap();
        }
        let length = cell.abi.memory.data_size(&cell.store);
        super::super::dirty::prepare_write(&mut cell.store, 0, length).unwrap();
        cell.abi.memory.data_mut(&mut cell.store).fill(0xa5);
        cell.store.data_mut().entropy_allowed = true;
        // Directly exercise reset without executing the deliberately corrupted
        // stack/heap. The production caller also detaches this pointer first.
        cell.store.data_mut().callback = None;
        finish(cell, &shared, &None).unwrap();
        STATE.with_borrow(|state| {
            let idle = &state.pool.as_ref().unwrap().idle[0];
            let host = idle.cell.store.data();
            assert!(host.callback.is_none());
            assert!(host.abi.is_none());
            assert!(!host.entropy_allowed);
            assert!(host.managed_shared.is_empty());
            assert!(host.managed_authorizations.is_empty());
            assert!(host.shared.check().is_err(), "idle Stores cannot execute");
        });
        let mut cell = checkout(
            &prepared,
            &runtime.engine,
            super::super::tests::limits(),
            callback,
            &None,
        )
        .unwrap();
        assert_eq!(cell.abi.memory.data(&cell.store), pristine);
        for global in &cell.globals {
            assert!(matches!(global.get(&mut cell.store), Val::I32(value) if value == 1024 * 1024));
        }
        assert!(!cell.store.data().entropy_allowed);
        discard(cell);
    }
}
