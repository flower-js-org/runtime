//! Durable redb application checkpoints and backward-compatible snapshot reads.
//! New checkpoints store metadata only. Full transfer images are transient and
//! encoded lazily; older full-image formats remain readable for migration.
use super::*;
use sha2::{Digest, Sha256};
use std::fs::File;
#[cfg(test)]
use std::io::Read;
use std::io::{BufReader, BufWriter, Seek, SeekFrom, Write};
use std::path::Path;

pub(super) const STREAM_SNAPSHOT_MAGIC: &[u8] = b"FLOWERSNAP3\0";
pub(super) const CHECKPOINT_KEY: &str = "snapshot_checkpoint_v1";
#[cfg(test)]
const SNAPSHOT_CHUNKS: TableDefinition<u64, &[u8]> =
    TableDefinition::new("raft_snapshot_chunks_v1");
// This is an I/O buffer size, not a limit on snapshot or application size.
const CHUNK_BYTES: usize = 256 * 1024;

pub(super) struct DiskSnapshot {
    pub meta: SnapshotMeta<u64, BasicNode>,
    pub data: File,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChunkManifest {
    meta: SnapshotMeta<u64, BasicNode>,
    data_bytes: u64,
    chunks: u64,
    sha256: [u8; 32],
    // Missing in existing FLOWERSNAP3 images. Older readers deny unknown
    // manifest fields and therefore reject compressed storage on startup.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    encoding: Option<ChunkEncoding>,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ChunkEncoding {
    Lz4,
}

#[cfg(test)]
fn encode_chunk(input: &[u8], output: &mut Vec<u8>) {
    output.clear();
    output.resize(1 + lz4_flex::block::get_maximum_output_size(input.len()), 0);
    let length = lz4_flex::block::compress_into(input, &mut output[1..])
        .expect("LZ4 maximum output reservation");
    if length < input.len() {
        output[0] = 1;
        output.truncate(1 + length);
    } else {
        // Incompressible input stays bounded to one extra tag byte.
        output[0] = 0;
        output.truncate(1);
        output.extend_from_slice(input);
    }
}

fn decode_chunk<'a>(
    input: &'a [u8],
    expected: usize,
    output: &'a mut [u8],
) -> anyhow::Result<&'a [u8]> {
    anyhow::ensure!(
        expected <= CHUNK_BYTES && output.len() >= expected,
        "snapshot chunk exceeds decode buffer"
    );
    let (&tag, bytes) = input.split_first().context("missing snapshot chunk tag")?;
    match tag {
        0 => {
            anyhow::ensure!(
                bytes.len() == expected,
                "raw snapshot chunk length mismatch"
            );
            Ok(bytes)
        }
        1 => {
            anyhow::ensure!(
                bytes.len() < expected,
                "compressed snapshot chunk length mismatch"
            );
            let length = lz4_flex::block::decompress_into(bytes, &mut output[..expected])
                .context("invalid compressed snapshot chunk")?;
            anyhow::ensure!(length == expected, "decoded snapshot chunk length mismatch");
            Ok(&output[..expected])
        }
        _ => anyhow::bail!("unknown snapshot chunk tag"),
    }
}

pub(super) fn allocate_snapshot_meta(
    transaction: &WriteTransaction,
    tables: Tables,
    node: u64,
    state: &StoredState,
) -> anyhow::Result<SnapshotMeta<u64, BasicNode>> {
    let mut table = transaction.open_table(tables.meta)?;
    let sequence = table
        .get("snapshot_sequence")?
        .map(|v| serde_json::from_slice::<u64>(v.value()))
        .transpose()?
        .unwrap_or(0)
        .checked_add(1)
        .context("snapshot sequence exhausted")?;
    table.insert(
        "snapshot_sequence",
        serde_json::to_vec(&sequence)?.as_slice(),
    )?;
    Ok(SnapshotMeta {
        last_log_id: state.last_applied,
        last_membership: state.membership.clone(),
        snapshot_id: format!(
            "{node}-{}-{sequence}",
            state
                .last_applied
                .map(|id| id.to_string())
                .unwrap_or_else(|| "empty".into())
        ),
    })
}

pub(super) fn write_checkpoint(
    transaction: &WriteTransaction,
    tables: Tables,
    meta: &SnapshotMeta<u64, BasicNode>,
    profile: &mut StorageTrace,
) -> anyhow::Result<()> {
    // Publication and retirement share one immediate-durability transaction.
    // The existing application tables are the recovery source, not this marker.
    transaction.delete_table(tables.snapshot_chunks)?;
    let mut table = transaction.open_table(tables.meta)?;
    table.remove("snapshot")?;
    table.insert(CHECKPOINT_KEY, profile.encode(meta)?.as_slice())?;
    Ok(())
}

pub(super) fn recover_checkpoint(
    transaction: &WriteTransaction,
    tables: Tables,
    node: u64,
    state: &StoredState,
) -> anyhow::Result<Option<SnapshotImage>> {
    let (checkpoint, purged) = {
        let table = transaction.open_table(tables.meta)?;
        let checkpoint = table
            .get(CHECKPOINT_KEY)?
            .map(|v| serde_json::from_slice::<SnapshotMeta<u64, BasicNode>>(v.value()))
            .transpose()?;
        let purged = table
            .get("last_purged")?
            .map(|v| serde_json::from_slice::<LogId<u64>>(v.value()))
            .transpose()?;
        (checkpoint, purged)
    };
    let Some(mut meta) = checkpoint else {
        return Ok(None);
    };
    for floor in [meta.last_log_id, purged] {
        let covered = match (state.last_applied, floor) {
            (_, None) => true,
            (Some(applied), Some(floor)) => applied.index > floor.index || applied == floor,
            (None, Some(_)) => false,
        };
        anyhow::ensure!(
            covered,
            "durable application state is behind its checkpoint or purged Raft logs"
        );
    }
    if state.last_applied == meta.last_log_id {
        anyhow::ensure!(
            state.membership == meta.last_membership,
            "checkpoint membership disagrees with durable state"
        );
    } else {
        // Later durable applies can survive a restart. Advertise exactly that
        // recovered state, never old metadata paired with a newer payload.
        meta = allocate_snapshot_meta(transaction, tables, node, state)?;
        transaction
            .open_table(tables.meta)?
            .insert(CHECKPOINT_KEY, serde_json::to_vec(&meta)?.as_slice())?;
    }
    Ok(Some(SnapshotImage {
        meta,
        state: Arc::new(state.clone()),
    }))
}

pub(super) fn temporary(directory: &Path) -> anyhow::Result<File> {
    tempfile::tempfile_in(directory).context("create temporary snapshot in database directory")
}

pub(super) fn encode_state(
    directory: &Path,
    state: &StoredState,
    profile: &mut StorageTrace,
) -> anyhow::Result<File> {
    let started = Instant::now();
    let file = temporary(directory)?;
    let mut writer = BufWriter::with_capacity(CHUNK_BYTES, file);
    serde_json::to_writer(&mut writer, state).context("encode snapshot state")?;
    writer.flush()?;
    let mut file = writer.into_inner()?;
    if let Some(timing) = &mut profile.0 {
        timing.encode_ns += started.elapsed().as_nanos() as u64;
        timing.encoded_bytes += usize::try_from(file.metadata()?.len()).unwrap_or(usize::MAX);
    }
    file.rewind()?;
    Ok(file)
}

pub(super) fn decode_state(file: &mut File) -> anyhow::Result<StoredState> {
    file.rewind()?;
    let state = serde_json::from_reader(BufReader::with_capacity(CHUNK_BYTES, &mut *file))
        .context("decode received snapshot")?;
    file.rewind()?;
    Ok(state)
}

#[cfg(test)]
pub(super) fn write_snapshot(
    transaction: &WriteTransaction,
    tables: Tables,
    snapshot: &mut DiskSnapshot,
    profile: &mut StorageTrace,
) -> anyhow::Result<()> {
    // Dropping the previous table and replacing it in this transaction keeps
    // committed readers on the old MVCC image until the new manifest is durable.
    transaction.delete_table(tables.snapshot_chunks)?;
    let data_bytes = snapshot.data.metadata()?.len();
    anyhow::ensure!(data_bytes != 0, "empty snapshot data");
    snapshot.data.rewind()?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; CHUNK_BYTES];
    let mut encoded = Vec::new();
    let mut remaining = data_bytes;
    let mut count = 0_u64;
    {
        let mut chunks = transaction.open_table(tables.snapshot_chunks)?;
        while remaining != 0 {
            let length = remaining.min(CHUNK_BYTES as u64) as usize;
            snapshot.data.read_exact(&mut buffer[..length])?;
            encode_chunk(&buffer[..length], &mut encoded);
            chunks.insert(count, encoded.as_slice())?;
            hash.update(&buffer[..length]);
            remaining -= length as u64;
            count += 1;
        }
    }
    let manifest = ChunkManifest {
        meta: snapshot.meta.clone(),
        data_bytes,
        chunks: count,
        sha256: hash.finalize().into(),
        encoding: Some(ChunkEncoding::Lz4),
    };
    let mut bytes = STREAM_SNAPSHOT_MAGIC.to_vec();
    bytes.extend_from_slice(&profile.encode(&manifest)?);
    transaction
        .open_table(tables.meta)?
        .insert("snapshot", bytes.as_slice())?;
    snapshot.data.rewind()?;
    Ok(())
}

pub(super) fn read_snapshot(
    db: &Database,
    tables: Tables,
    directory: &Path,
) -> anyhow::Result<Option<DiskSnapshot>> {
    let transaction = db.begin_read()?;
    let table = transaction.open_table(tables.meta)?;
    let Some(value) = table.get("snapshot")? else {
        return Ok(None);
    };
    let bytes = value.value();
    let mut file = temporary(directory)?;
    let meta = if let Some(header) = bytes.strip_prefix(STREAM_SNAPSHOT_MAGIC) {
        let header: ChunkManifest =
            serde_json::from_slice(header).context("decode snapshot manifest")?;
        anyhow::ensure!(
            header.data_bytes != 0
                && header.chunks == header.data_bytes.div_ceil(CHUNK_BYTES as u64),
            "invalid snapshot chunk manifest"
        );
        let chunks = transaction.open_table(tables.snapshot_chunks)?;
        let mut hash = Sha256::new();
        let mut remaining = header.data_bytes;
        let mut count = 0;
        let mut decoded = vec![0; CHUNK_BYTES];
        for item in chunks.iter()? {
            let (index, data) = item?;
            let data = data.value();
            anyhow::ensure!(
                remaining != 0 && index.value() == count,
                "snapshot chunk sequence mismatch"
            );
            let expected = remaining.min(CHUNK_BYTES as u64) as usize;
            let data = match header.encoding {
                Some(ChunkEncoding::Lz4) => decode_chunk(data, expected, &mut decoded)?,
                None => {
                    anyhow::ensure!(data.len() == expected, "snapshot chunk length mismatch");
                    data
                }
            };
            file.write_all(data)?;
            hash.update(data);
            remaining -= data.len() as u64;
            count += 1;
        }
        anyhow::ensure!(
            remaining == 0 && count == header.chunks,
            "truncated snapshot chunks"
        );
        let actual: [u8; 32] = hash.finalize().into();
        anyhow::ensure!(actual == header.sha256, "snapshot checksum mismatch");
        header.meta
    } else if let Some(container) = bytes.strip_prefix(SNAPSHOT_MAGIC) {
        let (header, data) = binary_snapshot(container)?;
        // The old binary format already has a borrowed byte slice; stream it
        // directly to disk rather than making another full-image allocation.
        file.write_all(data)?;
        header.meta
    } else {
        // Only the retired JSON-array envelope requires an image allocation.
        let legacy: StoredSnapshot =
            serde_json::from_slice(bytes).context("decode legacy snapshot envelope")?;
        file.write_all(&legacy.data)?;
        legacy.meta
    };
    file.seek(SeekFrom::Start(0))?;
    Ok(Some(DiskSnapshot { meta, data: file }))
}

pub(super) fn read_snapshot_metadata(
    db: &Database,
    tables: Tables,
) -> anyhow::Result<Option<SnapshotMeta<u64, BasicNode>>> {
    let transaction = db.begin_read()?;
    let table = transaction.open_table(tables.meta)?;
    if let Some(value) = table.get(CHECKPOINT_KEY)? {
        return Ok(Some(
            serde_json::from_slice(value.value())
                .context("decode application checkpoint metadata")?,
        ));
    }
    let Some(value) = table.get("snapshot")? else {
        return Ok(None);
    };
    let bytes = value.value();
    let meta = if let Some(header) = bytes.strip_prefix(STREAM_SNAPSHOT_MAGIC) {
        serde_json::from_slice::<ChunkManifest>(header)?.meta
    } else if let Some(container) = bytes.strip_prefix(SNAPSHOT_MAGIC) {
        binary_snapshot(container)?.0.meta
    } else {
        serde_json::from_slice::<StoredSnapshot>(bytes)?.meta
    };
    Ok(Some(meta))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct StoredSnapshot {
    pub meta: SnapshotMeta<u64, BasicNode>,
    pub data: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SnapshotHeader<M> {
    pub meta: M,
    pub data_bytes: u64,
}

type LegacyHeader = SnapshotHeader<SnapshotMeta<u64, BasicNode>>;
fn binary_snapshot(container: &[u8]) -> anyhow::Result<(LegacyHeader, &[u8])> {
    let length = container
        .get(..4)
        .context("truncated snapshot length header")?;
    let metadata_len = u32::from_le_bytes(length.try_into()?) as usize;
    let data_offset = 4_usize
        .checked_add(metadata_len)
        .context("snapshot metadata length overflow")?;
    let metadata = container
        .get(4..data_offset)
        .context("truncated snapshot metadata")?;
    let header: LegacyHeader =
        serde_json::from_slice(metadata).context("decode snapshot metadata")?;
    let data = container
        .get(data_offset..)
        .context("truncated snapshot data")?;
    anyhow::ensure!(!data.is_empty(), "empty snapshot data");
    anyhow::ensure!(
        u64::try_from(data.len()).ok() == Some(header.data_bytes),
        "snapshot data length mismatch: expected {}, found {}",
        header.data_bytes,
        data.len()
    );
    Ok((header, data))
}

#[cfg(test)]
pub(super) fn decode_snapshot(bytes: &[u8]) -> anyhow::Result<StoredSnapshot> {
    match bytes.strip_prefix(SNAPSHOT_MAGIC) {
        None => Ok(serde_json::from_slice(bytes)?),
        Some(container) => {
            let (header, data) = binary_snapshot(container)?;
            Ok(StoredSnapshot {
                meta: header.meta,
                data: data.to_vec(),
            })
        }
    }
}

#[cfg(test)]
pub(super) fn encode_snapshot(
    snapshot: &StoredSnapshot,
    profile: &mut StorageTrace,
) -> anyhow::Result<Vec<u8>> {
    let metadata = profile.encode(&SnapshotHeader {
        meta: &snapshot.meta,
        data_bytes: snapshot.data.len() as u64,
    })?;
    let mut encoded = SNAPSHOT_MAGIC.to_vec();
    encoded.extend_from_slice(&u32::try_from(metadata.len())?.to_le_bytes());
    encoded.extend_from_slice(&metadata);
    encoded.extend_from_slice(&snapshot.data);
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

    // Frozen legacy writer for compatibility/corruption fixtures only.
    fn legacy_chunked_snapshot(
        store: &Store,
        capture: SnapshotCapture,
    ) -> RaftSnapshot<TypeConfig> {
        let mut profile = StorageTrace::default();
        let data = encode_state(
            &store.inner.snapshot_directory,
            &capture.state,
            &mut profile,
        )
        .unwrap();
        let transaction = store.inner.shared.database().begin_write().unwrap();
        let meta = allocate_snapshot_meta(
            &transaction,
            Tables::new(""),
            store.inner.id,
            &capture.state,
        )
        .unwrap();
        let mut snapshot = DiskSnapshot { meta, data };
        write_snapshot(&transaction, Tables::new(""), &mut snapshot, &mut profile).unwrap();
        transaction.commit().unwrap();
        RaftSnapshot {
            meta: snapshot.meta,
            snapshot: Box::new(SnapshotData::from_std(snapshot.data)),
        }
    }

    #[test]
    fn snapshot_codec_bounds_output_and_preserves_incompressible_chunks() {
        let mut random = 0x7f4a7c15u32;
        let noise: Vec<u8> = (0..CHUNK_BYTES)
            .map(|_| {
                random ^= random << 13;
                random ^= random >> 17;
                random ^= random << 5;
                random as u8
            })
            .collect();
        let mut encoded = Vec::new();
        let mut decoded = vec![0; CHUNK_BYTES];
        for bytes in [b"a".as_slice(), noise.as_slice(), &vec![b'x'; CHUNK_BYTES]] {
            encode_chunk(bytes, &mut encoded);
            assert!(encoded.len() <= bytes.len() + 1);
            assert_eq!(
                decode_chunk(&encoded, bytes.len(), &mut decoded).unwrap(),
                bytes
            );
        }
        encode_chunk(&noise, &mut encoded);
        assert_eq!(encoded[0], 0, "incompressible bytes use raw storage");
        encode_chunk(&vec![b'x'; CHUNK_BYTES], &mut encoded);
        assert_eq!(encoded[0], 1);
        assert!(encoded.len() < CHUNK_BYTES / 10);
        assert!(
            decode_chunk(&encoded, 100, &mut decoded).is_err(),
            "expansion cannot escape the declared output bound"
        );
        assert!(decode_chunk(&encoded, CHUNK_BYTES + 1, &mut decoded).is_err());
        assert!(decode_chunk(&[], 1, &mut decoded).is_err());
        assert!(decode_chunk(&[9, 1], 1, &mut decoded).is_err());
        assert!(decode_chunk(&[0, 1], 2, &mut decoded).is_err());
    }

    #[tokio::test]
    async fn stored_compression_preserves_the_wire_and_reads_prior_raw_chunks() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(1, directory.path().into()).await.unwrap();
        let mut capture = store.capture_snapshot().await;
        capture.state.application.data.insert(
            "compressible".into(),
            Value::String("flower".repeat(CHUNK_BYTES)),
        );
        let mut built = legacy_chunked_snapshot(&store, capture);
        let mut wire = Vec::new();
        built.snapshot.read_to_end(&mut wire).await.unwrap();
        assert!(
            serde_json::from_slice::<StoredState>(&wire).is_ok(),
            "Raft still transfers the original JSON stream"
        );
        let mut manifest = {
            let transaction = store.inner.shared.database().begin_read().unwrap();
            let meta = transaction.open_table(META).unwrap();
            let value = meta.get("snapshot").unwrap().unwrap();
            let header = &value.value()[STREAM_SNAPSHOT_MAGIC.len()..];
            let manifest: ChunkManifest = serde_json::from_slice(header).unwrap();
            assert!(matches!(manifest.encoding, Some(ChunkEncoding::Lz4)));
            let stored: usize = transaction
                .open_table(SNAPSHOT_CHUNKS)
                .unwrap()
                .iter()
                .unwrap()
                .map(|entry| entry.unwrap().1.value().len())
                .sum();
            assert!(stored < wire.len() / 10);
            manifest
        };
        // Recreate the exact prior FLOWERSNAP3 representation: no encoding
        // field, and raw fixed-size chunks. It must remain readable on upgrade.
        manifest.encoding = None;
        let transaction = store.inner.shared.database().begin_write().unwrap();
        transaction.delete_table(SNAPSHOT_CHUNKS).unwrap();
        {
            let mut chunks = transaction.open_table(SNAPSHOT_CHUNKS).unwrap();
            for (index, bytes) in wire.chunks(CHUNK_BYTES).enumerate() {
                chunks.insert(index as u64, bytes).unwrap();
            }
        }
        let mut header = STREAM_SNAPSHOT_MAGIC.to_vec();
        header.extend(serde_json::to_vec(&manifest).unwrap());
        assert!(!String::from_utf8_lossy(&header).contains("encoding"));
        transaction
            .open_table(META)
            .unwrap()
            .insert("snapshot", header.as_slice())
            .unwrap();
        transaction.commit().unwrap();
        drop(store);
        let mut reopened = Store::open(1, directory.path().into()).await.unwrap();
        let mut snapshot = reopened.get_current_snapshot().await.unwrap().unwrap();
        let mut restored = Vec::new();
        snapshot.snapshot.read_to_end(&mut restored).await.unwrap();
        assert_eq!(wire, restored);
    }

    #[tokio::test]
    async fn chunked_snapshot_stream_roundtrip_recovery_and_atomic_abort() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(1, directory.path().into()).await.unwrap();
        let mut capture = store.capture_snapshot().await;
        capture
            .state
            .application
            .data
            .insert("large".into(), Value::String("🌸".repeat(CHUNK_BYTES)));
        let expected = capture.state.application.clone();
        let mut built = legacy_chunked_snapshot(&store, capture);
        assert!(built.snapshot.seek(SeekFrom::End(0)).await.unwrap() > (CHUNK_BYTES * 3) as u64);
        built.snapshot.rewind().await.unwrap();
        let mut wire = Vec::new();
        built.snapshot.read_to_end(&mut wire).await.unwrap();
        let meta = built.meta.clone();
        let follower_dir = tempfile::tempdir().unwrap();
        let mut follower = Store::open(2, follower_dir.path().into()).await.unwrap();
        let mut receiving = follower.begin_receiving_snapshot().await.unwrap();
        // Exercise the same seek/write/read transport contract OpenRaft uses.
        for chunk in wire.chunks(17_113) {
            receiving.write_all(chunk).await.unwrap();
        }
        receiving.flush().await.unwrap();
        follower.install_snapshot(&meta, receiving).await.unwrap();
        assert_eq!(follower.snapshot().await, expected);
        {
            let transaction = follower.inner.shared.database().begin_write().unwrap();
            transaction
                .open_table(SNAPSHOT_CHUNKS)
                .unwrap()
                .remove(0)
                .unwrap();
            transaction
                .open_table(META)
                .unwrap()
                .insert(CHECKPOINT_KEY, b"partial replacement".as_slice())
                .unwrap();
            transaction.abort().unwrap();
        }
        drop(follower);
        let mut follower = Store::open(2, follower_dir.path().into()).await.unwrap();
        let mut restored = follower.get_current_snapshot().await.unwrap().unwrap();
        let mut restored_bytes = Vec::new();
        restored
            .snapshot
            .read_to_end(&mut restored_bytes)
            .await
            .unwrap();
        assert_eq!(restored_bytes, wire);
        assert_eq!(restored.meta, meta);
        assert_eq!(follower.snapshot().await, expected);
        // The manifest contains metadata only, regardless of image size.
        let transaction = follower.inner.shared.database().begin_read().unwrap();
        let table = transaction.open_table(META).unwrap();
        assert!(table.get(CHECKPOINT_KEY).unwrap().unwrap().value().len() < 1024);
        assert!(table.get("snapshot").unwrap().is_none());
        // A trailing or truncated incoming JSON stream cannot replace either
        // durable state or the authoritative previous image.
        for invalid in [
            &wire[..wire.len() - 1],
            &[wire.as_slice(), b"junk"].concat(),
        ] {
            let mut receiving = follower.begin_receiving_snapshot().await.unwrap();
            receiving.write_all(invalid).await.unwrap();
            receiving.flush().await.unwrap();
            assert!(follower.install_snapshot(&meta, receiving).await.is_err());
            assert_eq!(follower.snapshot().await, expected);
        }
        // Independent current-snapshot streams never share file cursor state.
        built.snapshot.rewind().await.unwrap();
        let mut second = store.get_current_snapshot().await.unwrap().unwrap();
        let mut prefix = [0; 10];
        second.snapshot.read_exact(&mut prefix).await.unwrap();
        assert_eq!(&prefix, &wire[..10]);
    }

    #[tokio::test]
    async fn chunk_corruption_missing_extra_and_manifest_mismatch_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(1, directory.path().into()).await.unwrap();
        let mut capture = store.capture_snapshot().await;
        capture
            .state
            .application
            .data
            .insert("large".into(), Value::String("x".repeat(CHUNK_BYTES + 100)));
        legacy_chunked_snapshot(&store, capture);
        let (manifest, original) = {
            let transaction = store.inner.shared.database().begin_read().unwrap();
            let meta = transaction.open_table(META).unwrap();
            let chunks = transaction.open_table(SNAPSHOT_CHUNKS).unwrap();
            (
                meta.get("snapshot").unwrap().unwrap().value().to_vec(),
                chunks.get(0).unwrap().unwrap().value().to_vec(),
            )
        };
        for mode in 0..5 {
            let transaction = store.inner.shared.database().begin_write().unwrap();
            {
                let mut chunks = transaction.open_table(SNAPSHOT_CHUNKS).unwrap();
                match mode {
                    0 => {
                        let mut corrupt = original.clone();
                        corrupt[50] ^= 1;
                        chunks.insert(0, corrupt.as_slice()).unwrap();
                    }
                    1 => {
                        chunks.remove(0).unwrap();
                    }
                    2 => {
                        chunks.insert(999, b"extra".as_slice()).unwrap();
                    }
                    3 => {
                        chunks.insert(0, &original[..original.len() - 1]).unwrap();
                    }
                    _ => {
                        let mut changed: ChunkManifest =
                            serde_json::from_slice(&manifest[STREAM_SNAPSHOT_MAGIC.len()..])
                                .unwrap();
                        changed.data_bytes += CHUNK_BYTES as u64;
                        let mut bytes = STREAM_SNAPSHOT_MAGIC.to_vec();
                        bytes.extend_from_slice(&serde_json::to_vec(&changed).unwrap());
                        transaction
                            .open_table(META)
                            .unwrap()
                            .insert("snapshot", bytes.as_slice())
                            .unwrap();
                    }
                }
            }
            transaction.commit().unwrap();
            assert!(
                store.get_current_snapshot().await.is_err(),
                "corruption mode {mode} was accepted"
            );
            let transaction = store.inner.shared.database().begin_write().unwrap();
            {
                let mut chunks = transaction.open_table(SNAPSHOT_CHUNKS).unwrap();
                chunks.insert(0, original.as_slice()).unwrap();
                chunks.remove(999).unwrap();
            }
            transaction
                .open_table(META)
                .unwrap()
                .insert("snapshot", manifest.as_slice())
                .unwrap();
            transaction.commit().unwrap();
            assert!(store.get_current_snapshot().await.unwrap().is_some());
        }
    }
}
