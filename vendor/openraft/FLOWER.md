# Flower's OpenRaft 0.9.25

This is the published `openraft` 0.9.25 crate with one change: the current
leader's own log append no longer blocks replication.

Upstream 0.9 awaits the leader's log flush inside `RaftCore` before it runs the
`Replicate` commands that follow, so every commit pays for the leader's fsync
and a follower's fsync one after the other. Raft allows a leader to write its
log in parallel with replication (Ongaro's thesis, section 10.2.1), provided it
counts itself toward the commit quorum only once its entries are durable.

- `src/core/raft_core.rs`: `AppendInputEntries` for the current leader calls
  `submit_leader_append`, which returns once storage has made the entries
  readable. A spawned task waits for the flush callback and sends
  `Notify::LocalLogFlushed`; only then does the leader's own matching log
  advance. A notification from an older leadership is ignored. Follower appends
  are unchanged, so their AppendEntries responses still imply durability.
- `src/core/notify.rs`: the `LocalLogFlushed` notification.
- `src/storage/callback.rs`: `LogFlushed::is_leader_append()` tells storage that
  it may make this append durable later than a follower append would be.

Flower's store (`src/consensus/store/lazy_flush.rs`) uses that flag to commit
the leader's appends without an fsync while followers alone form a majority.

To update, replace this directory with a newer published crate and reapply the
changes marked `Flower:`.
