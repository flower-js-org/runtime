//! Structurally shared indexes derived from immutable application records.
//! Updating source values does no graph work. Cell outcome changes keep reverse
//! edges and the reachability proof when dependency topology is unchanged.

use super::*;
use std::sync::OnceLock;

pub(super) type Depths = im::HashMap<String, u8>;

/// The proof is derived only by validation, never decoded from stored records.
/// Append deltas retain one persistent baseline map, not a chain of historical
/// graphs. Publishing a physical patch carries its pending frontier forward.
#[derive(Debug)]
pub(super) struct Topology {
    proof: OnceLock<Arc<Depths>>,
    extension: Option<Extension>,
}

#[derive(Clone, Debug)]
pub(super) struct Extension {
    pub baseline: Arc<Depths>,
    pub cells: im::HashSet<String>,
    pub roots: im::OrdSet<String>,
}

impl Topology {
    fn empty() -> Self {
        Self {
            proof: OnceLock::from(Arc::new(Depths::new())),
            extension: None,
        }
    }

    pub(super) fn extension(&self) -> Option<Extension> {
        if let Some(proof) = self.proof.get() {
            Some(Extension {
                baseline: proof.clone(),
                cells: im::HashSet::new(),
                roots: im::OrdSet::new(),
            })
        } else {
            self.extension.clone()
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct Cell {
    deps: Arc<[String]>,
    // Parsed `scan:` dependencies, which have no reverse edges.
    scans: Arc<[windows::Window]>,
    // The collection and fields of each `index-bucket:` dependency.
    buckets: Arc<[(String, Vec<String>)]>,
    error: Option<EngineError>,
    bytes: usize,
    clock: bool,
}

/// Scan windows by collection, then by index fields (`None` orders by key).
type ScanWindows = im::HashMap<String, im::HashMap<Option<Vec<String>>, windows::Windows>>;

#[derive(Clone, Debug)]
pub(super) struct Root {
    pub value: Arc<Value>,
}

impl Root {
    pub fn name(&self) -> &str {
        self.value["name"].as_str().expect("validated root name")
    }

    pub fn args(&self) -> &Value {
        self.value.get("args").unwrap_or(&Value::Null)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ReactiveIndex {
    pub(super) reverse: im::HashMap<String, im::HashSet<String>>,
    scans: ScanWindows,
    // Equality-queried field sets by collection, with their dependency counts.
    buckets: im::HashMap<String, im::HashMap<Vec<String>, usize>>,
    pub(super) cells: im::HashMap<String, Arc<Cell>>,
    pub(super) roots: im::OrdMap<String, Arc<Value>>,
    pub(super) root_cells: im::OrdMap<Key, Arc<Root>>,
    invalid_cells: im::OrdMap<String, EngineError>,
    invalid_roots: im::OrdMap<String, EngineError>,
    pub(super) root_bytes: usize,
    pub(super) bytes: usize,
    clock_readers: usize,
    // Complete traversals and certified append-only extensions establish this
    // proof. Other topology edits detach it from prior snapshots.
    pub(super) topology: Arc<Topology>,
    // Unlike the cycle proof, this also changes for source dependency edges.
    // Optimistic patches must discover the same set of reactive readers.
    pub(super) shape: Arc<()>,
    // Physical sources/indexes are shared by all graph generations. Their
    // marker map is updated once and retained by each graph in O(1).
    memberships: im::HashMap<String, dependencies::Generation>,
    generations: im::HashMap<String, dependencies::Generation>,
}

impl Default for ReactiveIndex {
    fn default() -> Self {
        Self {
            reverse: im::HashMap::new(),
            scans: im::HashMap::new(),
            buckets: im::HashMap::new(),
            cells: im::HashMap::new(),
            roots: im::OrdMap::new(),
            root_cells: im::OrdMap::new(),
            invalid_cells: im::OrdMap::new(),
            invalid_roots: im::OrdMap::new(),
            root_bytes: 0,
            bytes: 0,
            clock_readers: 0,
            topology: Arc::new(Topology::empty()),
            shape: Arc::new(()),
            memberships: im::HashMap::new(),
            generations: im::HashMap::new(),
        }
    }
}

impl ReactiveIndex {
    pub(crate) fn update(
        &mut self,
        id: &str,
        previous: Option<&Arc<Value>>,
        next: Option<&Arc<Value>>,
        record_depth_valid: bool,
    ) {
        if previous.is_none() && next.is_none() {
            return;
        }
        if let Some(marker) = dependencies::membership_marker(id) {
            Self::change_generation(
                &mut self.memberships,
                marker,
                previous.is_some(),
                next.is_some(),
            );
        }
        if id.starts_with("cell:") {
            if !previous
                .zip(next)
                .is_some_and(|(old, new)| equal(&old["outcome"], &new["outcome"]))
            {
                Self::change_generation(
                    &mut self.generations,
                    format!("outcome:{id}"),
                    previous.is_some(),
                    next.is_some(),
                );
            }
            self.update_cell(id, previous, next, record_depth_valid);
        } else if id.starts_with("root:") {
            self.update_root(id, previous, next, record_depth_valid);
        }
    }

    pub(crate) fn generation(&self, id: &str) -> Option<&Arc<()>> {
        let generations = if id.starts_with("outcome:") {
            &self.generations
        } else {
            &self.memberships
        };
        generations.get(id).map(|generation| &generation.token)
    }

    pub(crate) fn share_memberships(&mut self, source: &Self) {
        self.memberships = source.memberships.clone();
    }

    fn change_generation(
        generations: &mut im::HashMap<String, dependencies::Generation>,
        id: String,
        previous: bool,
        next: bool,
    ) {
        let members = generations
            .get(&id)
            .map_or(0, |value| value.members)
            .saturating_sub(usize::from(previous))
            .saturating_add(usize::from(next));
        if members == 0 {
            generations.remove(&id);
        } else {
            generations.insert(
                id,
                dependencies::Generation {
                    token: Arc::new(()),
                    members,
                },
            );
        }
    }

    /// Cells whose scan result may change when a row of `collection` changes
    /// from `previous` to `next`: a row entering, leaving or moving touches
    /// membership windows at either position; a value alone touches the
    /// windows of rows returned at its position.
    pub(super) fn scan_readers(
        &self,
        collection: &str,
        key: &str,
        previous: Option<&Value>,
        next: Option<&Value>,
        readers: &mut Vec<String>,
    ) {
        let Some(indexes) = self.scans.get(collection) else {
            return;
        };
        for (fields, windows) in indexes {
            let position = |value: Option<&Value>| {
                value.and_then(|value| ranges::position(fields.as_deref(), key, value))
            };
            match (position(previous), position(next)) {
                (Some(before), Some(after)) if before == after => {
                    windows.readers(&before, true, readers);
                }
                (before, after) => {
                    for position in [before, after].into_iter().flatten() {
                        windows.readers(&position, false, readers);
                    }
                }
            }
        }
    }

    /// Field sets that derivations query by equality in `collection`.
    pub(super) fn bucket_fields(&self, collection: &str) -> impl Iterator<Item = &Vec<String>> {
        self.buckets
            .get(collection)
            .into_iter()
            .flat_map(|fields| fields.keys())
    }

    fn change_buckets(&mut self, buckets: &[(String, Vec<String>)], insert: bool) {
        for (collection, fields) in buckets {
            let specs = self.buckets.entry(collection.clone()).or_default();
            let count = specs.get(fields).copied().unwrap_or(0);
            let count = if insert {
                count + 1
            } else {
                count.saturating_sub(1)
            };
            if count == 0 {
                specs.remove(fields);
                if specs.is_empty() {
                    self.buckets.remove(collection);
                }
            } else {
                specs.insert(fields.clone(), count);
            }
        }
    }

    fn change_scans(&mut self, scans: &[windows::Window], reader: &str, insert: bool) {
        if scans.is_empty() {
            return;
        }
        let reader: Arc<str> = reader.into();
        for window in scans {
            let indexes = self.scans.entry(window.collection.clone()).or_default();
            let windows = indexes.entry(window.fields.clone()).or_default();
            if insert {
                windows.insert(window, &reader);
            } else {
                windows.remove(window, &reader);
                if windows.is_empty() {
                    indexes.remove(&window.fields);
                    if indexes.is_empty() {
                        self.scans.remove(&window.collection);
                    }
                }
            }
        }
    }

    pub(super) fn cacheable(&self) -> bool {
        self.clock_readers == 0
    }

    pub(super) fn validate(&self) -> EngineResult<()> {
        if let Some((_, error)) = self.invalid_cells.iter().next() {
            return Err(error.clone());
        }
        if let Some((_, error)) = self.invalid_roots.iter().next() {
            return Err(error.clone());
        }
        Ok(())
    }

    pub(super) fn validated(&self) -> bool {
        self.topology.proof.get().is_some()
    }

    pub(super) fn mark_validated(&self, depths: Depths) {
        let _ = self.topology.proof.set(Arc::new(depths));
    }

    fn invalidate_topology(&mut self) {
        self.topology = Arc::new(Topology {
            proof: OnceLock::new(),
            extension: None,
        });
    }

    fn append_topology(&mut self, id: &str, root: bool) {
        let extension = self.topology.extension().map(|mut extension| {
            if root {
                extension.roots.insert(id.into());
            } else {
                extension.cells.insert(id.into());
            }
            extension
        });
        self.topology = Arc::new(Topology {
            proof: OnceLock::new(),
            extension,
        });
    }

    fn update_cell(
        &mut self,
        id: &str,
        previous: Option<&Arc<Value>>,
        next: Option<&Arc<Value>>,
        record_depth_valid: bool,
    ) {
        let old = self.cells.get(id).cloned();
        let new = next.map(|value| {
            let clock = value
                .get("deps")
                .and_then(Value::as_array)
                .is_none_or(|deps| {
                    deps.iter()
                        .any(|value| value == "clock" || value == "managedKeys")
                });
            let error = if record_depth_valid {
                Ok(())
            } else {
                // Ephemeral cell outcomes may exceed the snapshot wrapper's
                // depth. Protect recursive identity handling using only args.
                depth(&value["args"], 0, "INPUT_INVALID")
            }
            .and_then(|()| validate_cell(id, value, previous, old.as_deref()))
            .err();
            if let Some(old) = &old
                && old.error == error
                && old.clock == clock
                && value
                    .get("deps")
                    .and_then(Value::as_array)
                    .is_some_and(|deps| {
                        deps.len() == old.deps.len()
                            && deps
                                .iter()
                                .zip(old.deps.iter())
                                .all(|(value, dep)| value.as_str() == Some(dep.as_str()))
                    })
            {
                return old.clone();
            }
            let deps: Arc<[String]> = value
                .get("deps")
                .and_then(Value::as_array)
                .map(|deps| {
                    deps.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
                .into();
            // validate_cell rejected any scan dependency that does not parse.
            let scans: Arc<[windows::Window]> = deps
                .iter()
                .filter(|dep| windows::Window::is_dependency(dep))
                .filter_map(|dep| windows::Window::parse(dep))
                .collect::<Vec<_>>()
                .into();
            let buckets: Arc<[(String, Vec<String>)]> = deps
                .iter()
                .filter_map(|dep| dependencies::bucket_spec(dep))
                .collect::<Vec<_>>()
                .into();
            // Includes persistent depth certificates and pending append IDs,
            // as well as the previous reverse-edge and traversal reservations.
            let bytes = 384_usize
                .saturating_add(id.len().saturating_mul(6))
                .saturating_add(
                    deps.iter()
                        .map(|dep| 160 + id.len() + dep.len().saturating_mul(2))
                        .sum::<usize>(),
                );
            Arc::new(Cell {
                deps,
                scans,
                buckets,
                error,
                bytes,
                clock,
            })
        });
        if let (Some(old), Some(new)) = (&old, &new)
            && Arc::ptr_eq(old, new)
        {
            return;
        }
        self.shape = Arc::new(());
        let topology_changed = match (&old, &new) {
            (Some(old), Some(new)) => {
                old.error.is_some()
                    || new.error.is_some()
                    || !old
                        .deps
                        .iter()
                        .filter(|dep| dep.starts_with("cell:"))
                        .eq(new.deps.iter().filter(|dep| dep.starts_with("cell:")))
            }
            (None, None) => false,
            _ => true,
        };
        if topology_changed {
            if old.is_none() && new.as_ref().is_some_and(|cell| cell.error.is_none()) {
                self.append_topology(id, false);
            } else {
                self.invalidate_topology();
            }
        }
        if let Some(old) = old {
            self.bytes = self.bytes.saturating_sub(old.bytes);
            self.clock_readers -= usize::from(old.clock);
            self.change_scans(&old.scans, id, false);
            self.change_buckets(&old.buckets, false);
            for dep in old.deps.iter() {
                if windows::Window::is_dependency(dep) {
                    continue;
                }
                if let Some(readers) = self.reverse.get_mut(dep) {
                    readers.remove(id);
                    if readers.is_empty() {
                        self.reverse.remove(dep);
                    }
                }
            }
        }
        self.invalid_cells.remove(id);
        if let Some(new) = new {
            self.bytes = self.bytes.saturating_add(new.bytes);
            self.clock_readers += usize::from(new.clock);
            self.change_scans(&new.scans, id, true);
            self.change_buckets(&new.buckets, true);
            for dep in new
                .deps
                .iter()
                .filter(|dep| !windows::Window::is_dependency(dep))
            {
                self.reverse
                    .entry(dep.clone())
                    .or_default()
                    .insert(id.into());
            }
            if let Some(error) = &new.error {
                self.invalid_cells.insert(id.into(), error.clone());
            }
            self.cells.insert(id.into(), new);
        } else {
            self.cells.remove(id);
        }
    }

    fn update_root(
        &mut self,
        id: &str,
        previous: Option<&Arc<Value>>,
        next: Option<&Arc<Value>>,
        record_depth_valid: bool,
    ) {
        if (previous.is_none() && next.is_none())
            || previous
                .zip(next)
                .is_some_and(|(old, new)| Arc::ptr_eq(old, new))
        {
            return;
        }
        if previous.is_none() && next.is_some() {
            self.append_topology(id, true);
        } else if !previous.zip(next).is_some_and(|(old, new)| equal(old, new)) {
            self.invalidate_topology();
        }
        self.shape = Arc::new(());
        let root_bytes = 128 + id.len();
        // Root lookup/traversal storage plus a pending append-frontier entry.
        let bytes = root_bytes + 192 + id.len().saturating_mul(3);
        if self.roots.remove(id).is_some() {
            self.root_bytes = self.root_bytes.saturating_sub(root_bytes);
            self.bytes = self.bytes.saturating_sub(bytes);
        }
        self.root_cells.remove(&Key(format!("cell:{}", &id[5..])));
        self.invalid_roots.remove(id);
        if let Some(value) = next {
            self.roots.insert(id.into(), value.clone());
            self.root_bytes = self.root_bytes.saturating_add(root_bytes);
            self.bytes = self.bytes.saturating_add(bytes);
            let depth = if record_depth_valid {
                Ok(())
            } else {
                depth(&value["args"], 0, "INPUT_INVALID")
            };
            let reference = depth
                .and_then(|()| Reference::parse(value, "stored root"))
                .and_then(|reference| {
                    if reference.root_id() != id {
                        return Err(EngineError::new(
                            "INPUT_INVALID",
                            "Malformed stored root identity",
                        ));
                    }
                    Ok(reference)
                });
            match reference {
                Ok(reference) => {
                    self.root_cells.insert(
                        Key(reference.cell_id()),
                        Arc::new(Root {
                            value: value.clone(),
                        }),
                    );
                }
                Err(error) => {
                    self.invalid_roots.insert(id.into(), error);
                }
            }
        }
    }
}

fn validate_cell(
    id: &str,
    value: &Value,
    previous: Option<&Arc<Value>>,
    old: Option<&Cell>,
) -> EngineResult<()> {
    record(value, "stored cell", "INPUT_INVALID")?;
    let name = string(&value["name"], "stored cell name", "INPUT_INVALID")?;
    let same_identity = old.is_some_and(|old| old.error.is_none())
        && previous.is_some_and(|old| old["name"] == value["name"] && old["args"] == value["args"]);
    if value.get("args").is_none() || (!same_identity && cell_id(name, &value["args"]) != id) {
        return Err(EngineError::new(
            "INPUT_INVALID",
            "Malformed stored cell identity",
        ));
    }
    let outcome = &value["outcome"];
    record(outcome, "stored cell outcome", "INPUT_INVALID")?;
    if outcome["ok"] == true {
        if outcome.get("value").is_none() {
            return Err(EngineError::new(
                "INPUT_INVALID",
                "Missing stored cell value",
            ));
        }
    } else if outcome["ok"] == false {
        record(&outcome["error"], "stored cell error", "INPUT_INVALID")?;
        string(
            &outcome["error"]["code"],
            "stored error code",
            "INPUT_INVALID",
        )?;
        string(
            &outcome["error"]["message"],
            "stored error message",
            "INPUT_INVALID",
        )?;
    } else {
        return Err(EngineError::new(
            "INPUT_INVALID",
            "Malformed stored cell outcome",
        ));
    }
    if value["deps"].as_array().is_none_or(|deps| {
        deps.iter().any(|dep| {
            dep.as_str().is_none_or(|dep| {
                windows::Window::is_dependency(dep) && windows::Window::parse(dep).is_none()
            })
        })
    }) {
        return Err(EngineError::new(
            "INPUT_INVALID",
            "Malformed stored cell dependencies",
        ));
    }
    Ok(())
}
