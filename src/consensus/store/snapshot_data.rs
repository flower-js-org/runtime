//! Raft transfer files are materialized only when a peer reads or seeks them.
//! Capturing an image only retains immutable state roots; it does no encoding.
use super::{StoragePhase, StorageTrace, StoredState, snapshots::encode_state};
use std::future::Future;
use std::io::{self, SeekFrom};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll, ready};
use tokio::io::{AsyncRead, AsyncSeek, AsyncWrite, ReadBuf};

pub(super) struct DeferredImage {
    pub state: Arc<StoredState>,
    pub directory: PathBuf,
    pub node: u64,
}

enum Data {
    Deferred(Option<DeferredImage>),
    Preparing(tokio::task::JoinHandle<io::Result<std::fs::File>>),
    File(tokio::fs::File),
    Failed(io::ErrorKind, String),
}

/// File-backed Raft snapshot transport with lazy encoding of immutable state.
/// Received snapshots are ordinary writable temporary files.
pub struct SnapshotData {
    data: Data,
    seek: Option<SeekFrom>,
    read_only: bool,
}

impl std::fmt::Debug for SnapshotData {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never include application state or errors in consensus debug output.
        f.debug_struct("SnapshotData")
            .field("materialized", &matches!(self.data, Data::File(_)))
            .finish()
    }
}

impl SnapshotData {
    pub(super) fn deferred(image: DeferredImage) -> Self {
        Self {
            data: Data::Deferred(Some(image)),
            seek: None,
            read_only: true,
        }
    }

    pub(super) fn from_std(file: std::fs::File) -> Self {
        Self {
            data: Data::File(tokio::fs::File::from_std(file)),
            seek: None,
            read_only: false,
        }
    }

    fn poll_file(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<&mut tokio::fs::File>> {
        loop {
            match &mut self.data {
                Data::Deferred(image) => {
                    let image = image.take().expect("deferred snapshot image");
                    self.data = Data::Preparing(tokio::task::spawn_blocking(move || {
                        let mut profile = StorageTrace::new(image.node, "snapshot_transfer");
                        let span = profile.span();
                        let _entered = span.enter();
                        profile.phase(StoragePhase::BlockingQueue);
                        let result = encode_state(&image.directory, &image.state, &mut profile);
                        profile.phase(StoragePhase::Prepare);
                        profile.report(result.is_ok());
                        result.map_err(io::Error::other)
                    }));
                }
                Data::Preparing(task) => {
                    let result = ready!(Pin::new(task).poll(cx))
                        .map_err(io::Error::other)
                        .and_then(|v| v);
                    self.data = match result {
                        Ok(file) => Data::File(tokio::fs::File::from_std(file)),
                        Err(error) => Data::Failed(error.kind(), error.to_string()),
                    };
                }
                Data::Failed(kind, message) => {
                    return Poll::Ready(Err(io::Error::new(*kind, message.clone())));
                }
                Data::File(_) => break,
            }
        }
        let Data::File(file) = &mut self.data else {
            unreachable!()
        };
        Poll::Ready(Ok(file))
    }

    fn poll_position(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        let position = self.seek;
        let file = ready!(self.poll_file(cx))?;
        if let Some(position) = position {
            Pin::new(file).start_seek(position)?;
            self.seek = None;
        }
        let file = ready!(self.poll_file(cx))?;
        Pin::new(file).poll_complete(cx)
    }

    pub(super) async fn into_std(mut self) -> io::Result<std::fs::File> {
        std::future::poll_fn(|cx| self.poll_position(cx)).await?;
        let Data::File(file) = self.data else {
            unreachable!()
        };
        Ok(file.into_std().await)
    }
}

impl AsyncRead for SnapshotData {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.seek.is_some() {
            ready!(self.poll_position(cx))?;
        }
        let file = ready!(self.poll_file(cx))?;
        Pin::new(file).poll_read(cx, buf)
    }
}

impl AsyncSeek for SnapshotData {
    fn start_seek(mut self: Pin<&mut Self>, position: SeekFrom) -> io::Result<()> {
        if self.seek.is_some() {
            return Err(io::Error::other("snapshot seek already in progress"));
        }
        self.seek = Some(position);
        Ok(())
    }
    fn poll_complete(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        self.poll_position(cx)
    }
}

impl AsyncWrite for SnapshotData {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.read_only {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "immutable snapshot image",
            )));
        }
        if self.seek.is_some() {
            ready!(self.poll_position(cx))?;
        }
        let file = ready!(self.poll_file(cx))?;
        Pin::new(file).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let file = ready!(self.poll_file(cx))?;
        Pin::new(file).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let file = ready!(self.poll_file(cx))?;
        Pin::new(file).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

    #[tokio::test]
    async fn deferred_stream_encodes_only_on_io_and_preserves_seek_and_independent_cursors() {
        let directory = tempfile::tempdir().unwrap();
        let mut state = StoredState::default();
        state
            .application
            .data
            .insert("value".into(), serde_json::json!("flower".repeat(100_000)));
        let bytes = serde_json::to_vec(&state).unwrap();
        let state = Arc::new(state);
        let make = || {
            SnapshotData::deferred(DeferredImage {
                state: state.clone(),
                directory: directory.path().into(),
                node: 1,
            })
        };
        let mut first = make();
        let mut second = make();
        assert!(matches!(first.data, Data::Deferred(_)));
        assert_eq!(
            first.write(b"no").await.unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        assert!(matches!(first.data, Data::Deferred(_)));
        assert_eq!(
            first.seek(SeekFrom::End(0)).await.unwrap(),
            bytes.len() as u64
        );
        first.seek(SeekFrom::Start(7)).await.unwrap();
        let mut tail = Vec::new();
        first.read_to_end(&mut tail).await.unwrap();
        assert_eq!(tail, bytes[7..]);
        assert!(matches!(second.data, Data::Deferred(_)));
        let mut all = Vec::new();
        second.read_to_end(&mut all).await.unwrap();
        assert_eq!(all, bytes);
        first.rewind().await.unwrap();
        let mut prefix = [0; 7];
        first.read_exact(&mut prefix).await.unwrap();
        assert_eq!(prefix, bytes[..7]);
    }

    #[tokio::test]
    async fn failed_encoding_stays_an_error_and_debug_never_prints_state() {
        let directory = tempfile::tempdir().unwrap();
        let mut state = StoredState::default();
        state
            .application
            .data
            .insert("private-value".into(), serde_json::json!("secret-payload"));
        let mut data = SnapshotData::deferred(DeferredImage {
            state: Arc::new(state),
            directory: directory.path().join("missing"),
            node: 1,
        });
        assert!(!format!("{data:?}").contains("secret"));
        assert!(data.seek(SeekFrom::End(0)).await.is_err());
        assert!(data.read_u8().await.is_err());
        assert!(!format!("{data:?}").contains("secret"));
    }
}
