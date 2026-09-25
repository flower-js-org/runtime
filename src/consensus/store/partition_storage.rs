use super::*;
use crate::consensus::{PartitionCommand, PartitionPhase};
use std::collections::BTreeSet;
use std::ops::Bound;

const PARTITION_BASE_DATA: TableDefinition<(&str, &str), &[u8]> =
    TableDefinition::new("partition_copy_base_data_v1");
const PARTITION_BASE_REQUESTS: TableDefinition<(&str, &str), &[u8]> =
    TableDefinition::new("partition_copy_base_requests_v1");

const PARTITION_CHUNKS: TableDefinition<(&str, &str), &[u8]> =
    TableDefinition::new("partition_difference_chunks_v1");

#[derive(Serialize, Deserialize)]
struct Metadata {
    #[serde(flatten)]
    info: PartitionInfo,
    #[serde(default)]
    base_revision: Option<u64>,
    #[serde(default)]
    last_import: Option<partitions::copy::ImportManifest>,
}
impl From<&PartitionState> for Metadata {
    fn from(state: &PartitionState) -> Self {
        Self {
            info: state.info.clone(),
            base_revision: state.base.as_ref().map(|base| base.revision),
            last_import: state.last_import.clone(),
        }
    }
}

#[derive(Clone)]
pub(super) struct PartitionWrite {
    pub(super) state: PartitionState,
    replace: bool,
    replace_base: bool,
    data: BTreeSet<String>,
    requests: BTreeSet<String>,
    chunks: BTreeSet<String>,
    replace_chunks: bool,
}

pub(super) fn load_partitions(transaction: &WriteTransaction) -> anyhow::Result<Partitions> {
    let tables = transaction
        .list_tables()?
        .map(|table| table.name().to_owned())
        .collect::<BTreeSet<_>>();
    if tables.contains(PARTITION_META.name()) {
        anyhow::ensure!(
            tables.contains(PARTITION_DATA.name()) && tables.contains(PARTITION_REQUESTS.name()),
            "incomplete partition storage tables"
        );
    }
    let mut states = BTreeMap::new();
    for item in transaction.open_table(PARTITION_META)?.iter()? {
        let (id, bytes) = item?;
        let metadata: Metadata = serde_json::from_slice(bytes.value())?;
        let info = metadata.info;
        if metadata.base_revision.is_some() {
            anyhow::ensure!(
                tables.contains(PARTITION_BASE_DATA.name())
                    && tables.contains(PARTITION_BASE_REQUESTS.name()),
                "incomplete partition copy base storage tables"
            );
        }
        anyhow::ensure!(
            id.value() == info.partition,
            "partition metadata key mismatch"
        );
        let revision = if info.phase == PartitionPhase::Importing {
            if metadata
                .last_import
                .as_ref()
                .is_some_and(|manifest| manifest.kind == partitions::ExportKind::Delta)
            {
                anyhow::ensure!(
                    tables.contains(PARTITION_CHUNKS.name()),
                    "missing partition difference staging table"
                );
                metadata
                    .last_import
                    .as_ref()
                    .and_then(|manifest| manifest.base_revision)
                    .context("difference import missing base revision")?
            } else {
                0
            }
        } else {
            info.revision
        };
        states.insert(
            info.partition.clone(),
            PartitionState {
                info,
                snapshot: Snapshot {
                    revision,
                    ..Snapshot::default()
                },
                base: metadata.base_revision.map(|revision| Snapshot {
                    revision,
                    ..Snapshot::default()
                }),
                last_import: metadata.last_import,
                chunks: Records::default(),
            },
        );
    }
    for item in transaction.open_table(PARTITION_DATA)?.iter()? {
        let (key, bytes) = item?;
        let (partition, key) = key.value();
        states
            .get_mut(partition)
            .context("partition data without metadata")?
            .snapshot
            .data
            .insert(key.into(), serde_json::from_slice(bytes.value())?);
    }
    for item in transaction.open_table(PARTITION_REQUESTS)?.iter()? {
        let (key, bytes) = item?;
        let (partition, key) = key.value();
        states
            .get_mut(partition)
            .context("partition receipt without metadata")?
            .snapshot
            .requests
            .insert(key.into(), serde_json::from_slice(bytes.value())?);
    }
    for item in transaction.open_table(PARTITION_BASE_DATA)?.iter()? {
        let (key, bytes) = item?;
        let (partition, key) = key.value();
        states
            .get_mut(partition)
            .and_then(|state| state.base.as_mut())
            .context("copy base data without metadata")?
            .data
            .insert(key.into(), serde_json::from_slice(bytes.value())?);
    }
    for item in transaction.open_table(PARTITION_BASE_REQUESTS)?.iter()? {
        let (key, bytes) = item?;
        let (partition, key) = key.value();
        states
            .get_mut(partition)
            .and_then(|state| state.base.as_mut())
            .context("copy base receipt without metadata")?
            .requests
            .insert(key.into(), serde_json::from_slice(bytes.value())?);
    }
    for item in transaction.open_table(PARTITION_CHUNKS)?.iter()? {
        let (key, bytes) = item?;
        let (partition, key) = key.value();
        states
            .get_mut(partition)
            .context("difference chunks without partition metadata")?
            .chunks
            .insert(key.into(), serde_json::from_slice(bytes.value())?);
    }
    let mut partitions = Partitions::default();
    for (_, state) in states {
        partitions::validate_state(&state)?;
        partitions.insert(state);
    }
    Ok(partitions)
}

pub(super) fn replace_partitions(
    transaction: &WriteTransaction,
    partitions: &Partitions,
    profile: &mut StorageTrace,
) -> anyhow::Result<()> {
    transaction.delete_table(PARTITION_META)?;
    transaction.delete_table(PARTITION_DATA)?;
    transaction.delete_table(PARTITION_REQUESTS)?;
    transaction.delete_table(PARTITION_BASE_DATA)?;
    transaction.delete_table(PARTITION_BASE_REQUESTS)?;
    transaction.delete_table(PARTITION_CHUNKS)?;
    let mut metadata = transaction.open_table(PARTITION_META)?;
    let mut data = transaction.open_table(PARTITION_DATA)?;
    let mut requests = transaction.open_table(PARTITION_REQUESTS)?;
    transaction.open_table(PARTITION_BASE_DATA)?;
    transaction.open_table(PARTITION_BASE_REQUESTS)?;
    transaction.open_table(PARTITION_CHUNKS)?;
    for (id, state) in partitions.iter() {
        partitions::validate_state(state)?;
        metadata.insert(
            id.as_str(),
            profile.encode(&Metadata::from(state))?.as_slice(),
        )?;
        for (key, value) in &state.snapshot.data {
            data.insert(
                (id.as_str(), key.as_str()),
                profile.encode(value)?.as_slice(),
            )?;
        }
        for (key, value) in &state.snapshot.requests {
            requests.insert(
                (id.as_str(), key.as_str()),
                profile.encode(value)?.as_slice(),
            )?;
        }
        write_base(transaction, id, state.base.as_ref(), profile)?;
        write_chunks(
            transaction,
            id,
            &state.chunks,
            true,
            &BTreeSet::new(),
            profile,
        )?;
    }
    Ok(())
}

fn write_base(
    transaction: &WriteTransaction,
    id: &str,
    base: Option<&Snapshot>,
    profile: &mut StorageTrace,
) -> anyhow::Result<()> {
    for definition in [PARTITION_BASE_DATA, PARTITION_BASE_REQUESTS] {
        let mut table = transaction.open_table(definition)?;
        let upper = format!("{id}\0");
        let range = (
            Bound::Included((id, "")),
            Bound::Excluded((upper.as_str(), "")),
        );
        let keys = table
            .range(range)?
            .map(|entry| entry.map(|(key, _)| key.value().1.to_owned()))
            .collect::<Result<Vec<_>, _>>()?;
        for key in keys {
            table.remove((id, key.as_str()))?;
        }
    }
    if let Some(base) = base {
        let mut data = transaction.open_table(PARTITION_BASE_DATA)?;
        let mut receipts = transaction.open_table(PARTITION_BASE_REQUESTS)?;
        for (key, value) in &base.data {
            data.insert((id, key.as_str()), profile.encode(value)?.as_slice())?;
        }
        for (key, value) in &base.requests {
            receipts.insert((id, key.as_str()), profile.encode(value)?.as_slice())?;
        }
    }
    Ok(())
}

fn write_chunks(
    transaction: &WriteTransaction,
    id: &str,
    chunks: &Records,
    replace: bool,
    keys: &BTreeSet<String>,
    profile: &mut StorageTrace,
) -> anyhow::Result<()> {
    if !replace && keys.is_empty() {
        return Ok(());
    }
    let mut table = transaction.open_table(PARTITION_CHUNKS)?;
    if replace {
        let upper = format!("{id}\0");
        let range = (
            Bound::Included((id, "")),
            Bound::Excluded((upper.as_str(), "")),
        );
        let stale = table
            .range(range)?
            .map(|entry| entry.map(|(key, _)| key.value().1.to_owned()))
            .collect::<Result<Vec<_>, _>>()?;
        for key in stale {
            table.remove((id, key.as_str()))?;
        }
        for (key, value) in chunks {
            table.insert((id, key.as_str()), profile.encode(value)?.as_slice())?;
        }
    } else {
        for key in keys {
            if let Some(value) = chunks.get(key) {
                table.insert((id, key.as_str()), profile.encode(value)?.as_slice())?;
            } else {
                table.remove((id, key.as_str()))?;
            }
        }
    }
    Ok(())
}

pub(super) fn write_partitions(
    transaction: &WriteTransaction,
    writes: &BTreeMap<String, PartitionWrite>,
    profile: &mut StorageTrace,
) -> anyhow::Result<()> {
    if writes.is_empty() {
        return Ok(());
    }
    let mut metadata = transaction.open_table(PARTITION_META)?;
    let mut data = transaction.open_table(PARTITION_DATA)?;
    let mut requests = transaction.open_table(PARTITION_REQUESTS)?;
    for (id, write) in writes {
        let state = &write.state;
        if write.replace {
            // The first tuple member isolates the range regardless of arbitrary
            // Unicode/NUL bytes in the partition or application key.
            let upper = format!("{id}\0");
            let range = (
                Bound::Included((id.as_str(), "")),
                Bound::Excluded((upper.as_str(), "")),
            );
            let data_keys = data
                .range(range)?
                .map(|entry| entry.map(|(key, _)| key.value().1.to_owned()))
                .collect::<Result<Vec<_>, _>>()?;
            for key in data_keys {
                data.remove((id.as_str(), key.as_str()))?;
            }
            let request_keys = requests
                .range(range)?
                .map(|entry| entry.map(|(key, _)| key.value().1.to_owned()))
                .collect::<Result<Vec<_>, _>>()?;
            for key in request_keys {
                requests.remove((id.as_str(), key.as_str()))?;
            }
            for (key, value) in &state.snapshot.data {
                data.insert(
                    (id.as_str(), key.as_str()),
                    profile.encode(value)?.as_slice(),
                )?;
            }
            for (key, value) in &state.snapshot.requests {
                requests.insert(
                    (id.as_str(), key.as_str()),
                    profile.encode(value)?.as_slice(),
                )?;
            }
        } else {
            for key in &write.data {
                match state.snapshot.data.get_raw_shared(key).map(Arc::as_ref) {
                    Some(value) => {
                        data.insert(
                            (id.as_str(), key.as_str()),
                            profile.encode(value)?.as_slice(),
                        )?;
                    }
                    None => {
                        data.remove((id.as_str(), key.as_str()))?;
                    }
                }
            }
            for key in &write.requests {
                if let Some(value) = state.snapshot.requests.get(key) {
                    requests.insert(
                        (id.as_str(), key.as_str()),
                        profile.encode(value)?.as_slice(),
                    )?;
                } else {
                    requests.remove((id.as_str(), key.as_str()))?;
                }
            }
        }
        if write.replace_base {
            write_base(transaction, id, state.base.as_ref(), profile)?;
        }
        write_chunks(
            transaction,
            id,
            &state.chunks,
            write.replace_chunks,
            &write.chunks,
            profile,
        )?;
        metadata.insert(
            id.as_str(),
            profile.encode(&Metadata::from(state))?.as_slice(),
        )?;
    }
    Ok(())
}

pub(super) fn apply_scoped(
    partitions: &Partitions,
    writes: &mut BTreeMap<String, PartitionWrite>,
    binding: PartitionBinding,
    command: RaftCommand,
    leader: openraft::CommittedLeaderId<u64>,
) -> ApplyResult {
    let current = writes
        .get(&binding.partition)
        .map(|write| &write.state)
        .or_else(|| partitions.get(&binding.partition));
    if let Err(error) = partitions::validate_binding(&binding)
        .and_then(|_| partitions::active(current, &binding).map(|_| ()))
    {
        return ApplyResult::Rejected(error.to_string());
    }
    let current = current.expect("validated partition exists").clone();
    let mut delta = ApplicationDelta::new(current.snapshot.revision);
    let result = match command {
        RaftCommand::Single(commit) => apply_commit(&current.snapshot, &mut delta, commit),
        RaftCommand::Batch { batch } => apply_batch(&current.snapshot, &mut delta, batch),
        RaftCommand::Retention { retention } => {
            apply_retention(&current.snapshot, &mut delta, retention)
        }
        RaftCommand::Fenced { leader_id, commit } if leader_id == leader => {
            apply_commit(&current.snapshot, &mut delta, commit)
        }
        RaftCommand::Fenced { .. } => ApplyResult::Rejected(
            "partition preparation was authorized under another leader".into(),
        ),
        _ => ApplyResult::Rejected(
            "nested partition scopes and partition controls are invalid application commands"
                .into(),
        ),
    };
    if delta.revision > 9_007_199_254_740_991 {
        return ApplyResult::Rejected("partition application revision exhausted".into());
    }
    let mut write = writes
        .remove(&binding.partition)
        .unwrap_or_else(|| PartitionWrite {
            state: current,
            replace: false,
            replace_base: false,
            data: BTreeSet::new(),
            requests: BTreeSet::new(),
            chunks: BTreeSet::new(),
            replace_chunks: false,
        });
    write.data.extend(delta.data.keys().cloned());
    write.requests.extend(delta.requests.keys().cloned());
    write
        .requests
        .extend(delta.deleted_requests.iter().cloned());
    delta.publish(&mut write.state.snapshot);
    write.state.info.revision = write.state.snapshot.revision;
    writes.insert(binding.partition, write);
    result
}

pub(super) fn apply_partition_control(
    partitions: &Partitions,
    writes: &mut BTreeMap<String, PartitionWrite>,
    command: PartitionCommand,
) -> ApplyResult {
    let id = command.partition().to_owned();
    let current = writes
        .get(&id)
        .map(|write| &write.state)
        .or_else(|| partitions.get(&id));
    match partitions::transition(current, command) {
        Err(error) => ApplyResult::Rejected(error.to_string()),
        Ok(change) => {
            let mut write = writes.remove(&id).unwrap_or_else(|| PartitionWrite {
                state: change.state.clone(),
                replace: false,
                replace_base: false,
                data: BTreeSet::new(),
                requests: BTreeSet::new(),
                chunks: BTreeSet::new(),
                replace_chunks: false,
            });
            write.replace |= change.replace;
            write.replace_base |= change.replace_base;
            write.data.extend(change.data_keys);
            write.requests.extend(change.request_keys);
            write.chunks.extend(change.chunk_keys);
            write.replace_chunks |= change.replace_chunks;
            write.state = change.state;
            let info = write.state.info.clone();
            writes.insert(id, write);
            ApplyResult::Partition(info)
        }
    }
}
