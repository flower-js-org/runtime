//! One redb database for every replica a process hosts, with group commit.
//!
//! Log appends and applied-state writes queue here and commit together: each
//! batch is one transaction, flushed once when any write in it must be
//! durable. Replicas that share a disk therefore share its fsyncs instead of
//! contending for them, and a durable commit also persists every earlier
//! no-sync commit of every replica. Rare writes (votes, truncation, purges,
//! snapshots) still run their own transactions; redb orders them between
//! batches.
//!
//! A staged write that fails aborts its batch; the others are staged again in a
//! fresh transaction, so one replica's failure never lands a partial write or
//! an error in another's. Staging may therefore run more than once, and must
//! only write the transaction. A failed commit fails the whole batch.
use super::*;
use std::path::Path;

type Stage = Box<dyn FnMut(&WriteTransaction, &mut StorageTrace) -> anyhow::Result<()> + Send>;

struct Job {
    durable: bool,
    stage: Stage,
    profile: StorageTrace,
    done: tokio::sync::oneshot::Sender<Result<(), Arc<anyhow::Error>>>,
    // Held until the batch completes, so Raft's storage drain waits for it
    // even when the awaiting future was cancelled.
    _lifetime: Option<Arc<RaftLifetime>>,
}

#[derive(Default)]
struct Queue {
    jobs: Vec<Job>,
    running: bool,
}

pub struct SharedDatabase {
    db: Database,
    queue: std::sync::Mutex<Queue>,
    batches: AtomicU64,
    durable_batches: AtomicU64,
    staged: AtomicU64,
    // Microseconds from beginning each batch's transaction through its commit,
    // and the part of that spent committing.
    busy_micros: AtomicU64,
    commit_micros: AtomicU64,
}

impl SharedDatabase {
    /// Open or create the database file. Blocking.
    pub fn open(path: &Path) -> anyhow::Result<Arc<Self>> {
        let db = Database::create(path).map_err(|error| match error {
            redb::DatabaseError::UpgradeRequired(version) => anyhow::anyhow!(
                "Raft database uses unsupported legacy redb format v{version}; this release requires a current-format data directory"
            ),
            error => anyhow::Error::new(error).context("open Raft database"),
        })?;
        Ok(Self::with_database(db))
    }

    pub(super) fn with_database(db: Database) -> Arc<Self> {
        Arc::new(Self {
            db,
            queue: std::sync::Mutex::default(),
            batches: AtomicU64::new(0),
            durable_batches: AtomicU64::new(0),
            staged: AtomicU64::new(0),
            busy_micros: AtomicU64::new(0),
            commit_micros: AtomicU64::new(0),
        })
    }

    pub(super) fn database(&self) -> &Database {
        &self.db
    }

    /// Counters shared by every replica in this database.
    pub(super) fn metrics(&self) -> serde_json::Value {
        let (batches, durable, staged) = self.batches();
        serde_json::json!({
            "batches": batches, "durableBatches": durable, "stagedWrites": staged,
            "busyMicros": self.busy_micros.load(Ordering::Acquire),
            "commitMicros": self.commit_micros.load(Ordering::Acquire),
        })
    }

    /// Batches committed so far, how many of them flushed, and writes staged.
    pub(super) fn batches(&self) -> (u64, u64, u64) {
        (
            self.batches.load(Ordering::Acquire),
            self.durable_batches.load(Ordering::Acquire),
            self.staged.load(Ordering::Acquire),
        )
    }

    /// Queue `write` for the next batch, durable when `durable`. Batches
    /// commit in submission order, so a caller may release its own ordering
    /// as soon as this returns.
    pub(super) fn submit(
        self: &Arc<Self>,
        durable: bool,
        profile: StorageTrace,
        lifetime: Option<Arc<RaftLifetime>>,
        write: impl FnMut(&WriteTransaction, &mut StorageTrace) -> anyhow::Result<()> + Send + 'static,
    ) -> Submitted {
        let (done, completed) = tokio::sync::oneshot::channel();
        let job = Job {
            durable,
            stage: Box::new(write),
            profile,
            done,
            _lifetime: lifetime,
        };
        let start = {
            let mut queue = self.queue.lock().expect("shared database queue lock");
            queue.jobs.push(job);
            !std::mem::replace(&mut queue.running, true)
        };
        if start {
            self.spawn();
        }
        Submitted(completed)
    }

    fn spawn(self: &Arc<Self>) {
        let shared = self.clone();
        tokio::task::spawn_blocking(move || shared.run());
    }

    fn run(self: Arc<Self>) {
        // A panicking write must not leave the queue marked running forever.
        struct Restart(std::sync::Weak<SharedDatabase>);
        impl Drop for Restart {
            fn drop(&mut self) {
                let Some(shared) = self.0.upgrade().filter(|_| std::thread::panicking()) else {
                    return;
                };
                let mut queue = shared.queue.lock().expect("shared database queue lock");
                queue.running = !queue.jobs.is_empty();
                if queue.running {
                    drop(queue);
                    shared.spawn();
                }
            }
        }
        let _restart = Restart(Arc::downgrade(&self));
        let mut shared = Some(self);
        while let Some(this) = &shared {
            let jobs = {
                let mut queue = this.queue.lock().expect("shared database queue lock");
                if queue.jobs.is_empty() {
                    queue.running = false;
                    return;
                }
                std::mem::take(&mut queue.jobs)
            };
            let (jobs, result) = this.commit(jobs);
            {
                let mut queue = this.queue.lock().expect("shared database queue lock");
                if queue.jobs.is_empty() {
                    queue.running = false;
                    // Release the database before waking anyone: a waiter may
                    // close its replica and reopen this file at once.
                    drop(queue);
                    shared = None;
                }
            }
            complete(jobs, result);
        }
    }

    /// Commit a batch; returns the jobs to complete with its outcome. A job
    /// whose staging fails completes at once and the others restage.
    fn commit(&self, mut jobs: Vec<Job>) -> (Vec<Job>, Result<(), Arc<anyhow::Error>>) {
        for job in &mut jobs {
            job.profile.phase(StoragePhase::BlockingQueue);
        }
        loop {
            if jobs.is_empty() {
                return (jobs, Ok(()));
            }
            let durable = jobs.iter().any(|job| job.durable);
            let began = Instant::now();
            let transaction =
                self.db
                    .begin_write()
                    .map_err(anyhow::Error::new)
                    .and_then(|mut transaction| {
                        transaction.set_durability(if durable {
                            Durability::Immediate
                        } else {
                            Durability::None
                        })?;
                        Ok(transaction)
                    });
            let transaction = match transaction {
                Ok(transaction) => transaction,
                Err(error) => return (jobs, Err(Arc::new(error))),
            };
            let mut failed = None;
            for (index, job) in jobs.iter_mut().enumerate() {
                job.profile.phase(StoragePhase::Begin);
                if let Err(error) = (job.stage)(&transaction, &mut job.profile) {
                    failed = Some((index, error));
                    break;
                }
                job.profile.phase(StoragePhase::Write);
            }
            if let Some((index, error)) = failed {
                // Dropping the transaction aborts it; the rest restage.
                drop(transaction);
                complete(vec![jobs.remove(index)], Err(Arc::new(error)));
                continue;
            }
            let committing = Instant::now();
            let result = transaction
                .commit()
                .map_err(|error| Arc::new(anyhow::Error::new(error)));
            let micros = |since: Instant| since.elapsed().as_micros().min(u64::MAX as u128) as u64;
            self.busy_micros.fetch_add(micros(began), Ordering::AcqRel);
            self.commit_micros.fetch_add(micros(committing), Ordering::AcqRel);
            self.batches.fetch_add(1, Ordering::AcqRel);
            self.durable_batches
                .fetch_add(durable as u64, Ordering::AcqRel);
            self.staged.fetch_add(jobs.len() as u64, Ordering::AcqRel);
            return (jobs, result);
        }
    }
}

/// A queued write.
pub(super) struct Submitted(tokio::sync::oneshot::Receiver<Result<(), Arc<anyhow::Error>>>);

impl Submitted {
    /// Wait until the write's batch has committed.
    pub(super) async fn committed(self) -> anyhow::Result<()> {
        match self.0.await {
            Ok(result) => result.map_err(|error| anyhow::anyhow!("{error:#}")),
            Err(_) => bail!("shared database committer stopped"),
        }
    }
}

fn complete(jobs: Vec<Job>, result: Result<(), Arc<anyhow::Error>>) {
    for mut job in jobs {
        job.profile.phase(StoragePhase::Flush);
        job.profile.report(result.is_ok());
        let _ = job.done.send(result.clone());
    }
}
