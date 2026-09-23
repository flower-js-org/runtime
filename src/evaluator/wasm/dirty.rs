//! Track pages ever written in a recyclable Store. Clean pages stay read-only;
//! a first write makes one OS page writable for the rest of that Store's life.
//! Reset copies only those pages, with no hashes or guessed dirty ranges.
use super::Host;
use anyhow::{Result, ensure};
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use wasmtime::{AsContextMut, Memory, Store};

pub(super) struct Tracker {
    base: usize,
    length: usize,
    page_size: usize,
    pages: Box<[AtomicBool]>,
    active: AtomicBool,
    faults: AtomicUsize,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    errno: usize,
}

pub(super) fn install(store: &mut Store<Host>, memory: Memory) -> Result<Option<Arc<Tracker>>> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        static ENABLED: OnceLock<bool> = OnceLock::new();
        if *ENABLED.get_or_init(|| {
            !std::env::var("FLOWER_WASM_DIRTY_PAGES")
                .is_ok_and(|value| value == "0" || value == "false")
        }) {
            return native::install(store, memory);
        }
    }
    let _ = (store, memory);
    Ok(None)
}

/// Host writes may happen between Wasm activations (or under a different parent
/// Store's activation). Mark/unprotect them explicitly before touching bytes.
pub(super) fn prepare_write<S: AsContextMut<Data = Host>>(
    store: &mut S,
    offset: usize,
    length: usize,
) -> Result<()> {
    let context = store.as_context_mut();
    if let Some(tracker) = &context.data().dirty {
        tracker.prepare_write(offset, length)?;
    }
    Ok(())
}

impl Tracker {
    /// The caller must already own this tracker in a cleanup guard alongside
    /// the still-live Store, even if mprotect fails partway through its range.
    pub(super) fn protect(&self) -> Result<()> {
        self.active.store(true, Ordering::Relaxed);
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        native::readonly(self.base, self.length)?;
        Ok(())
    }

    fn prepare_write(&self, offset: usize, length: usize) -> Result<()> {
        let end = offset
            .checked_add(length)
            .ok_or_else(|| anyhow::anyhow!("guest write overflow"))?
            .min(self.length);
        if offset >= end || !self.active.load(Ordering::Relaxed) {
            return Ok(());
        }
        let mut page = offset / self.page_size;
        let last = (end - 1) / self.page_size + 1;
        while page < last {
            if self.pages[page].load(Ordering::Relaxed) {
                page += 1;
                continue;
            }
            let first = page;
            while page < last && !self.pages[page].load(Ordering::Relaxed) {
                page += 1;
            }
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            native::writable(
                self.base + first * self.page_size,
                (page - first) * self.page_size,
            )?;
            for dirty in &self.pages[first..page] {
                dirty.store(true, Ordering::Relaxed);
            }
        }
        Ok(())
    }

    /// End protection before memory growth or Store destruction. This must
    /// succeed before the pooled mapping can be handed back to Wasmtime.
    pub(super) fn unprotect(&self) -> Result<()> {
        if self.active.load(Ordering::Relaxed) {
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            native::writable(self.base, self.length)?;
            self.active.store(false, Ordering::Relaxed);
        }
        Ok(())
    }

    pub(super) fn restore(&self, memory: &mut [u8], pristine: &[u8]) -> Result<usize> {
        ensure!(
            memory.as_ptr() as usize == self.base
                && memory.len() == self.length
                && pristine.len() == self.length,
            "tracked guest mapping changed"
        );
        if !self.active.load(Ordering::Relaxed) {
            memory.copy_from_slice(pristine);
            return Ok(memory.len());
        }
        let mut copied = 0;
        let mut page = 0;
        while page < self.pages.len() {
            if !self.pages[page].load(Ordering::Relaxed) {
                page += 1;
                continue;
            }
            let first = page;
            while page < self.pages.len() && self.pages[page].load(Ordering::Relaxed) {
                page += 1;
            }
            let range = first * self.page_size..page * self.page_size;
            memory[range.clone()].copy_from_slice(&pristine[range.clone()]);
            copied += range.len();
        }
        Ok(copied)
    }

    #[cfg(test)]
    pub(super) fn faults(&self) -> usize {
        self.faults.load(Ordering::Relaxed)
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod native {
    use super::*;
    use wasmtime::unix::StoreExt;

    pub(super) fn install(store: &mut Store<Host>, memory: Memory) -> Result<Option<Arc<Tracker>>> {
        // Query page geometry outside signal context. Wasm pages are 64 KiB,
        // divisible by Linux and macOS native pages; otherwise use full copies.
        let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        if page_size <= 0 {
            return Ok(None);
        }
        let page_size = page_size as usize;
        let base = memory.data_ptr(&*store) as usize;
        let length = memory.data_size(&*store);
        if !page_size.is_power_of_two()
            || base % page_size != 0
            || length % page_size != 0
            || base.checked_add(length).is_none()
            || length == 0
        {
            return Ok(None);
        }
        // Resolve the mprotect dynamic symbol before any signal can need it.
        // Failure leaves the normal unprotected copy path available.
        if writable(base, length).is_err() {
            return Ok(None);
        }
        // Stores are thread-confined by Host's scoped non-Send callback token.
        // Resolve this thread's errno slot now, never through TLS/dynamic binding
        // inside the signal handler.
        #[cfg(target_os = "macos")]
        let errno = unsafe { libc::__error() };
        #[cfg(target_os = "linux")]
        let errno = unsafe { libc::__errno_location() };
        let tracker = Arc::new(Tracker {
            base,
            length,
            page_size,
            pages: (0..length / page_size)
                .map(|_| AtomicBool::new(false))
                .collect(),
            active: AtomicBool::new(false),
            faults: AtomicUsize::new(0),
            errno: errno as usize,
        });
        let handler = tracker.clone();
        // SAFETY: this closure uses only immutable geometry, preallocated
        // lock-free atomics, and mprotect. It neither accesses Host/TLS nor
        // allocates, locks, logs, formats, unwinds, or enters Wasm. It handles
        // only first-write faults in this exact Store's initial memory range.
        unsafe {
            store.set_signal_handler(move |signal, info, _| handler.handle(signal, info));
        }
        // The caller installs its RAII cleanup owner before protect(). Until
        // then this handler is inert and memory is still normally writable.
        Ok(Some(tracker))
    }

    pub(super) fn readonly(base: usize, length: usize) -> Result<()> {
        // SAFETY: this private, idle Wasm mapping has page-aligned geometry; no
        // other thread executes or accesses this Store. Cleanup is already owned.
        if unsafe { libc::mprotect(base as *mut libc::c_void, length, libc::PROT_READ) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }

    pub(super) fn writable(base: usize, length: usize) -> Result<()> {
        // SAFETY: all callers use checked page-aligned portions of the live
        // Store's private initial mapping; no Wasm executes concurrently.
        if unsafe {
            libc::mprotect(
                base as *mut libc::c_void,
                length,
                libc::PROT_READ | libc::PROT_WRITE,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }

    impl Tracker {
        fn handle(&self, signal: libc::c_int, info: *const libc::siginfo_t) -> bool {
            if (signal != libc::SIGSEGV && signal != libc::SIGBUS)
                || info.is_null()
                || !self.active.load(Ordering::Relaxed)
            {
                return false;
            }
            // SAFETY: Wasmtime provides the OS siginfo for this synchronous
            // memory fault. Bounds below exclude guard pages and other Stores.
            let address = unsafe { (*info).si_addr() as usize };
            let offset = address.wrapping_sub(self.base);
            if offset >= self.length {
                return false;
            }
            let page = offset / self.page_size;
            let Some(dirty) = self.pages.get(page) else {
                return false;
            };
            // A fault on an already-writable page is not ours. In particular do
            // not loop on execute faults or hide unrelated memory corruption.
            if dirty.load(Ordering::Relaxed) {
                return false;
            }
            // The mprotect system-call wrapper can change errno; guest/native
            // code observes exactly the prior value when the instruction retries.
            let errno = self.errno as *mut libc::c_int;
            // SAFETY: errno is this thread's native integer slot. Geometry is
            // checked at installation and the atomic page index is in bounds.
            let success = unsafe {
                let saved = *errno;
                let result = libc::mprotect(
                    (self.base + page * self.page_size) as *mut libc::c_void,
                    self.page_size,
                    libc::PROT_READ | libc::PROT_WRITE,
                );
                *errno = saved;
                result == 0
            };
            if success {
                dirty.store(true, Ordering::Relaxed);
                self.faults.fetch_add(1, Ordering::Relaxed);
            }
            success
        }
    }
}
