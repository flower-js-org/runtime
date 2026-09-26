//! OpenRaft transport over cleartext HTTP/2, retaining its typed remote errors.

use std::io::{self, Write};
use std::sync::Arc;
#[cfg(test)]
use std::time::Duration;

use openraft::BasicNode;
use openraft::error::{
    InstallSnapshotError, NetworkError, PayloadTooLarge, RPCError, RaftError, RemoteError,
    Unreachable,
};
use openraft::network::{RPCOption, RaftNetwork, RaftNetworkFactory};
use openraft::raft::{
    AppendEntriesRequest, AppendEntriesResponse, InstallSnapshotRequest, InstallSnapshotResponse,
    VoteRequest, VoteResponse,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tracing::Instrument;

use super::{Limits, RPC_NODE_HEADER, RPC_TARGET_HEADER, TypeConfig, membership};

type RpcError<E = openraft::error::Infallible> = RPCError<u64, BasicNode, RaftError<u64, E>>;

/// A snapshot segment on the wire. Its bytes travel as base64, a third
/// larger than they are, where JSON would write them as an array of
/// numbers several times as large and slow to parse.
#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct SnapshotSegment {
    vote: openraft::Vote<u64>,
    meta: openraft::SnapshotMeta<u64, BasicNode>,
    offset: u64,
    #[serde(with = "base64_bytes")]
    data: Vec<u8>,
    done: bool,
}

impl From<InstallSnapshotRequest<TypeConfig>> for SnapshotSegment {
    fn from(request: InstallSnapshotRequest<TypeConfig>) -> Self {
        Self {
            vote: request.vote,
            meta: request.meta,
            offset: request.offset,
            data: request.data,
            done: request.done,
        }
    }
}

impl From<SnapshotSegment> for InstallSnapshotRequest<TypeConfig> {
    fn from(segment: SnapshotSegment) -> Self {
        Self {
            vote: segment.vote,
            meta: segment.meta,
            offset: segment.offset,
            data: segment.data,
            done: segment.done,
        }
    }
}

mod base64_bytes {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use serde::{Deserialize, Deserializer, Serializer, de::Error};

    pub(super) fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&STANDARD.encode(bytes))
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(deserializer)?;
        STANDARD.decode(text).map_err(D::Error::custom)
    }
}

#[derive(Clone)]
pub struct Network {
    client: reqwest::Client,
    limits: Arc<Limits>,
}

impl Network {
    #[cfg(test)]
    pub fn new(token: &str) -> anyhow::Result<Self> {
        Self::with_limits(token, Arc::new(Limits::default()))
    }

    pub fn with_limits(token: &str, limits: Arc<Limits>) -> anyhow::Result<Self> {
        let mut authorization = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))?;
        authorization.set_sensitive(true);
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::AUTHORIZATION, authorization);
        headers.insert(
            membership::COMPATIBILITY_HEADER,
            membership::contract_header().clone(),
        );
        Ok(Self {
            client: crate::transport::client_builder()?
                .default_headers(headers)
                .connect_timeout(limits.peer_connect_timeout)
                .pool_idle_timeout(limits.peer_idle_timeout)
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .build()?,
            limits,
        })
    }

    pub(super) async fn peer_info(
        &self,
        target: u64,
        address: &str,
    ) -> anyhow::Result<membership::PeerInfo> {
        let response = self
            .client
            .get(crate::transport::peer_url(address, "/raft/version"))
            .header(RPC_TARGET_HEADER, target.to_string())
            .timeout(self.limits.read_timeout)
            .send()
            .await?
            .error_for_status()?;
        validate_peer_response(response.headers(), target)?;
        Ok(response.json().await?)
    }

    pub(super) async fn read_fence(
        &self,
        target: u64,
        node: BasicNode,
    ) -> anyhow::Result<super::read::ReadFence> {
        let connection = Connection {
            client: self.client.clone(),
            target,
            node,
            pending_append: None,
            limits: self.limits.clone(),
        };
        connection
            .send::<_, super::read::ReadFence, super::read::ReadFenceError>(
                "read-fence",
                (),
                RPCOption::new(self.limits.read_timeout),
            )
            .await
            .map_err(anyhow::Error::new)
    }
}

pub struct Connection {
    client: reqwest::Client,
    target: u64,
    node: BasicNode,
    pending_append: Option<PendingAppend>,
    limits: Arc<Limits>,
}

// OpenRaft 0.9 uses the heartbeat interval as an outer timeout even for large
// durable appends. Retain exactly one data RPC across those canceled awaits so
// serialization, transfer and fsync can finish instead of restarting forever.
// Control probes keep their short deadline; the transport allowance is bounded.
struct PendingAppend {
    request: Arc<AppendEntriesRequest<TypeConfig>>,
    latest_commit: Option<openraft::LogId<u64>>,
    task: tokio::task::JoinHandle<Result<AppendEntriesResponse<u64>, RpcError>>,
}

impl PendingAppend {
    fn matches(&self, request: &AppendEntriesRequest<TypeConfig>) -> bool {
        // OpenRaft 0.9.25's AppendEntriesResponse::Success proves replicated
        // logs, not that the follower committed/applied leader_commit. See
        // raft/message/append_entries.rs and replication/mod.rs::send_log_entries:
        // Success advances matching to the sent range's last log, while
        // PartialSuccess advances it to its explicit matching log. Receiver
        // core/raft_core.rs::handle_append_entries_request handles commit
        // propagation separately after append validation.
        //
        // A healthy quorum can advance commit while this follower catches up.
        // Restarting its identical data transfer for each new commit recreates
        // the timeout starvation. Keep the same log proof when commit advances;
        // its response makes no claim about delivery of the newer commit. The
        // next fresh heartbeat/data RPC propagates that value. A regressed
        // commit, changed vote, previous log, or entry must start a new RPC.
        self.request.vote == request.vote
            && self.request.prev_log_id == request.prev_log_id
            && self.latest_commit <= request.leader_commit
            && self.request.entries == request.entries
    }
}

impl Drop for PendingAppend {
    fn drop(&mut self) {
        // A changed request or removed replication stream must not retain a
        // detached transport task. Already accepted remote writes remain under
        // ordinary Raft vote/log checks, exactly as for any canceled RPC.
        self.task.abort();
    }
}

impl Connection {
    // OpenRaft's network trait requires this concrete error type.
    #[allow(clippy::result_large_err)]
    async fn send<Req, Resp, Err>(
        &self,
        path: &str,
        request: Req,
        option: RPCOption,
    ) -> Result<Resp, RPCError<u64, BasicNode, Err>>
    where
        Req: Serialize,
        Resp: DeserializeOwned,
        Err: std::error::Error + DeserializeOwned,
    {
        crate::telemetry::raft_rpc(path, self.target, self.send_inner(path, request, option)).await
    }

    #[allow(clippy::result_large_err)] // OpenRaft's transport contract uses this concrete type.
    async fn send_inner<Req, Resp, Err>(
        &self,
        path: &str,
        request: Req,
        option: RPCOption,
    ) -> Result<Resp, RPCError<u64, BasicNode, Err>>
    where
        Req: Serialize,
        Resp: DeserializeOwned,
        Err: std::error::Error + DeserializeOwned,
    {
        // Encode once, with the same byte ceiling enforced by the receiver.
        // An oversized multi-entry append stops allocating/serializing early
        // and asks OpenRaft to retry a single entry, which admission guarantees
        // fits including its envelope.
        let mut body = RpcBody::new(self.limits.rpc_max_bytes);
        if let Err(error) = serde_json::to_writer(&mut body, &request) {
            if body.exceeded && path == "append" {
                return Err(RPCError::PayloadTooLarge(
                    PayloadTooLarge::new_entries_hint(1),
                ));
            }
            return Err(RPCError::Network(NetworkError::new(&error)));
        }
        let request = self
            .client
            .post(crate::transport::peer_url(
                &self.node.addr,
                &format!("/raft/{path}"),
            ))
            .header(RPC_TARGET_HEADER, self.target.to_string())
            .timeout(option.hard_ttl())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.bytes);
        let response = crate::telemetry::inject(request)
            .send()
            .await
            .map_err(|error| {
                if error.is_connect() {
                    RPCError::Unreachable(Unreachable::new(&error))
                } else {
                    RPCError::Network(NetworkError::new(&error))
                }
            })?;
        if path == "append" && response.status() == reqwest::StatusCode::PAYLOAD_TOO_LARGE {
            return Err(RPCError::PayloadTooLarge(
                PayloadTooLarge::new_entries_hint(1),
            ));
        }
        let response = response
            .error_for_status()
            .map_err(|error| RPCError::Network(NetworkError::new(&error)))?;
        validate_peer_response(response.headers(), self.target)
            .map_err(|error| RPCError::Network(NetworkError::new(&error)))?;
        let result: Result<Resp, Err> = response
            .json()
            .await
            .map_err(|error| RPCError::Network(NetworkError::new(&error)))?;
        result.map_err(|error| RPCError::RemoteError(RemoteError::new(self.target, error)))
    }
}

fn validate_peer_response(headers: &reqwest::header::HeaderMap, target: u64) -> io::Result<()> {
    let responder = headers
        .get(RPC_NODE_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if responder != Some(target) {
        return Err(io::Error::other(format!(
            "Raft peer identity mismatch: expected node {target}, received {responder:?}"
        )));
    }
    if headers
        .get(membership::COMPATIBILITY_HEADER)
        .and_then(|value| value.to_str().ok())
        != Some(membership::contract())
    {
        return Err(io::Error::other(
            "Raft peer compatibility mismatch: wire, state, snapshot, value and QuickJS contracts must match",
        ));
    }
    Ok(())
}

struct RpcBody {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}

impl RpcBody {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(limit.min(128)),
            limit,
            exceeded: false,
        }
    }
}

impl Write for RpcBody {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            self.exceeded = true;
            return Err(io::Error::other(format!(
                "Raft RPC exceeds FLOWER_RPC_MAX_BYTES ({}) including metadata",
                self.limit
            )));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl RaftNetworkFactory<TypeConfig> for Network {
    type Network = Connection;

    async fn new_client(&mut self, target: u64, node: &BasicNode) -> Self::Network {
        Connection {
            client: self.client.clone(),
            target,
            node: node.clone(),
            pending_append: None,
            limits: self.limits.clone(),
        }
    }
}

impl RaftNetwork<TypeConfig> for Connection {
    async fn append_entries(
        &mut self,
        request: AppendEntriesRequest<TypeConfig>,
        option: RPCOption,
    ) -> Result<AppendEntriesResponse<u64>, RpcError> {
        if request.entries.is_empty() {
            // Replication may interleave a heartbeat between a canceled data
            // await and its retry. A same-vote probe must not restart that data
            // transfer. Read confirmation uses a fresh connection, and all empty
            // probes still perform their own short RPC rather than reuse an ack.
            if self
                .pending_append
                .as_ref()
                .is_some_and(|pending| pending.request.vote != request.vote)
            {
                self.pending_append = None;
            }
            return self.send("append", request, option).await;
        }
        if self
            .pending_append
            .as_ref()
            .is_none_or(|pending| !pending.matches(&request))
        {
            self.pending_append = None;
            let request = Arc::new(request);
            let transport_request = request.clone();
            let connection = Connection {
                client: self.client.clone(),
                target: self.target,
                node: self.node.clone(),
                pending_append: None,
                limits: self.limits.clone(),
            };
            let ttl = self.limits.append_timeout.max(option.hard_ttl());
            let task = tokio::spawn(
                async move {
                    // The outer transport allowance also counts serialization. It
                    // is created once, never renewed by OpenRaft's short polls.
                    tokio::time::timeout(
                        ttl,
                        connection.send("append", transport_request.as_ref(), RPCOption::new(ttl)),
                    )
                    .await
                    .map_err(|error| RPCError::Network(NetworkError::new(&error)))?
                }
                .in_current_span(),
            );
            self.pending_append = Some(PendingAppend {
                latest_commit: request.leader_commit,
                request,
                task,
            });
        } else {
            // Track the highest commit observed by callers separately from the
            // immutable wire request so any later regression still restarts.
            self.pending_append
                .as_mut()
                .expect("pending append")
                .latest_commit = request.leader_commit;
        }
        // Await by mutable reference. Dropping this future leaves the task in
        // Connection, and an append of the same logs resumes it rather than
        // issuing another durable write. The retained response acknowledges the
        // logs only; a newly advanced leader_commit still needs a fresh RPC.
        let response = (&mut self.pending_append.as_mut().expect("pending append").task).await;
        self.pending_append = None;
        response.map_err(|error| RPCError::Network(NetworkError::new(&error)))?
    }

    async fn vote(
        &mut self,
        request: VoteRequest<u64>,
        option: RPCOption,
    ) -> Result<VoteResponse<u64>, RpcError> {
        self.send("vote", request, option).await
    }

    async fn install_snapshot(
        &mut self,
        request: InstallSnapshotRequest<TypeConfig>,
        option: RPCOption,
    ) -> Result<InstallSnapshotResponse<u64>, RpcError<InstallSnapshotError>> {
        self.send("snapshot", SnapshotSegment::from(request), option).await
    }
}

#[cfg(test)]
mod tests;
