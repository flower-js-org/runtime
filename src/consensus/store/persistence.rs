//! Persist applied state behind its in-memory publication.
//!
//! Applied state never needs its own flush: Raft logs already make every
//! applied entry durable on a quorum, and these writes use no-sync commits
//! that the next Immediate commit persists. They therefore need not delay the
//! apply either. Readers and Raft see a new state as soon as it is published;
//! one task writes queued states in apply order, coalescing whatever queued
//! while the disk was busy, for example behind a leader's deferred log flush.
//!
//! Recovery restarts from the last persisted state and replays later entries
//! from the log. Operations that would let Raft discard those entries or that
//! replace the whole state (snapshot checkpoints, purges and installations)
//! first drain the queue, and so do shutdown and tests that inspect or reopen
//! storage. Writes are deltas, so the first failure stops every later write
//! and fails the next apply; the node then stops and replays on restart.
use super::*;
use std::collections::VecDeque;
use std::sync::Weak;

/// One apply's encoded redb projection.
pub(super) struct StateWrite {
    pub(super) data: Vec<(String, Option<Vec<u8>>)>,
    pub(super) requests: Vec<(String, Vec<u8>)>,
    pub(super) deleted_requests: Vec<String>,
    pub(super) metadata: Vec<u8>,
    pub(super) partitions: BTreeMap<String, PartitionWrite>,
}

#[derive(Default)]
struct Queue {
    writes: VecDeque<StateWrite>,
    running: bool,
}

#[derive(Default)]
pub(super) struct Persistence {
    queue: std::sync::Mutex<Queue>,
    submitted: AtomicU64,
    persisted: AtomicU64,
    failure: std::sync::Mutex<Option<String>>,
    persisted_changed: tokio::sync::Notify,
}

/// Background tasks reach the database only through a counted strong Store,
/// so closing storage can wait until none remains.
#[derive(Default)]
pub(super) struct Holders {
    count: std::sync::atomic::AtomicUsize,
    released: tokio::sync::Notify,
}

pub(super) struct Held {
    holders: Arc<Holders>,
    store: Option<Store>,
}

impl Held {
    pub(super) fn store(&self) -> &Store {
        self.store.as_ref().expect("held store")
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        // Release the database before announcing it.
        drop(self.store.take());
        self.holders.release();
    }
}

impl Holders {
    pub(super) fn hold(self: &Arc<Self>, inner: &Weak<Inner>) -> Option<Held> {
        self.count.fetch_add(1, Ordering::AcqRel);
        let held = Held {
            holders: self.clone(),
            store: inner.upgrade().map(|inner| Store {
                inner,
                raft_lifetime: None,
            }),
        };
        held.store.is_some().then_some(held)
    }

    fn release(&self) {
        self.count.fetch_sub(1, Ordering::AcqRel);
        self.released.notify_waiters();
    }

    /// Wait until no background task holds the database.
    pub(super) async fn idle(&self) {
        loop {
            let released = self.released.notified();
            tokio::pin!(released);
            released.as_mut().enable();
            if self.count.load(Ordering::Acquire) == 0 {
                return;
            }
            released.await;
        }
    }
}

impl Persistence {
    pub(super) fn check(&self) -> anyhow::Result<()> {
        match &*self.failure.lock().expect("persistence failure lock") {
            Some(error) => bail!("applied state persistence failed: {error}"),
            None => Ok(()),
        }
    }

    /// Queue one write after every earlier one. Never waits for the disk.
    pub(super) fn submit(
        self: &Arc<Self>,
        inner: Weak<Inner>,
        holders: Arc<Holders>,
        write: StateWrite,
    ) {
        self.submitted.fetch_add(1, Ordering::AcqRel);
        let mut queue = self.queue.lock().expect("persistence queue lock");
        queue.writes.push_back(write);
        if queue.running {
            return;
        }
        queue.running = true;
        drop(queue);
        let persistence = self.clone();
        tokio::spawn(async move { persistence.run(inner, holders).await });
    }

    async fn run(self: Arc<Self>, inner: Weak<Inner>, holders: Arc<Holders>) {
        loop {
            let writes: Vec<StateWrite> = {
                let mut queue = self.queue.lock().expect("persistence queue lock");
                // Writes are deltas: never write past one that failed.
                if queue.writes.is_empty() || self.check().is_err() {
                    queue.running = false;
                    return;
                }
                queue.writes.drain(..).collect()
            };
            let count = writes.len() as u64;
            let Some(held) = holders.hold(&inner) else {
                // Storage closed: unpersisted states replay from the log.
                self.fail("storage closed".into());
                self.queue.lock().expect("persistence queue lock").running = false;
                return;
            };
            let store = held.store();
            let result = store
                .disk_profiled(
                    StorageTrace::new(store.inner.id, "persist"),
                    move |db, profile| {
                        let mut transaction = db.begin_write()?;
                        transaction.set_durability(Durability::None)?;
                        profile.phase(StoragePhase::Begin);
                        for write in &writes {
                            {
                                let mut data = transaction.open_table(DATA)?;
                                for (key, value) in &write.data {
                                    match value {
                                        Some(value) => {
                                            data.insert(key.as_str(), value.as_slice())?;
                                        }
                                        None => {
                                            data.remove(key.as_str())?;
                                        }
                                    }
                                }
                                let mut requests = transaction.open_table(REQUESTS)?;
                                for key in &write.deleted_requests {
                                    requests.remove(key.as_str())?;
                                }
                                for (key, value) in &write.requests {
                                    requests.insert(key.as_str(), value.as_slice())?;
                                }
                                let mut meta = transaction.open_table(META)?;
                                meta.insert(STATE_META, write.metadata.as_slice())?;
                            }
                            write_partitions(&transaction, &write.partitions, profile)?;
                        }
                        profile.phase(StoragePhase::Write);
                        let result = transaction.commit();
                        profile.phase(StoragePhase::Flush);
                        result?;
                        Ok(())
                    },
                )
                .await;
            drop(held);
            if let Err(error) = result {
                // Record the failure before a later submit can start a writer.
                self.fail(format!("{error:#}"));
                self.queue.lock().expect("persistence queue lock").running = false;
                return;
            }
            self.persisted.fetch_add(count, Ordering::AcqRel);
            self.persisted_changed.notify_waiters();
        }
    }

    fn fail(&self, error: String) {
        self.failure
            .lock()
            .expect("persistence failure lock")
            .get_or_insert(error);
        self.persisted_changed.notify_waiters();
    }

    /// Wait until every state submitted so far has been written.
    pub(super) async fn drain(&self) -> anyhow::Result<()> {
        let target = self.submitted.load(Ordering::Acquire);
        loop {
            let changed = self.persisted_changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            self.check()?;
            if self.persisted.load(Ordering::Acquire) >= target {
                return Ok(());
            }
            changed.await;
        }
    }
}
