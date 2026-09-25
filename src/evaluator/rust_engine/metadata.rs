//! Structurally shared indexes derived from immutable application records.
//! Updating source values does no graph work. The graph's structure itself is
//! durable: `reader:` records hold reverse edges and `height:` records the
//! longest derived path below each cell, both maintained by the engine.

use super::*;

/// Heights found by a full traversal, the reference for the stored ones.
pub(super) type Depths = im::HashMap<String, u8>;

/// The selected graph's whole accounted size: what building it from nothing
/// costs.
#[cfg(test)]
pub(super) fn graph_bytes(data: &Records) -> usize {
    let empty = Records::new();
    data.graph_cells()
        .map(|(id, _)| id)
        .chain(data.graph_roots().map(|(id, _)| id))
        .map(|id| ReactiveIndex::unshared_bytes(data, &empty, id))
        .sum()
}

/// What the index derives from one stored cell record. It is parsed again
/// from the record whenever the record is replaced, not retained per cell.
struct Cell {
    // Parsed `scan:` dependencies, which have no reader records.
    scans: Vec<windows::Window>,
    // The collection and fields of each `index-bucket:` dependency.
    buckets: Vec<(String, Vec<String>)>,
    bytes: usize,
    clock: bool,
}

impl Cell {
    fn parse(id: &str, value: &Value) -> Self {
        let listed = value.get("deps").and_then(Value::as_array);
        let clock = listed.is_none_or(|deps| {
            deps.iter()
                .any(|value| value == "clock" || value == "managedKeys")
        });
        let deps: Vec<&str> = listed
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        // validate_cell rejected any scan dependency that does not parse.
        let scans = deps
            .iter()
            .filter(|dep| windows::Window::is_dependency(dep))
            .filter_map(|dep| windows::Window::parse(dep))
            .collect();
        let buckets = deps
            .iter()
            .filter_map(|dep| dependencies::bucket_spec(dep))
            .collect();
        // Includes persistent depth certificates and pending append IDs, as
        // well as traversal reservations and the cell's reader records.
        let bytes = 384_usize
            .saturating_add(id.len().saturating_mul(6))
            .saturating_add(
                deps.iter()
                    .map(|dep| 160 + id.len() + dep.len().saturating_mul(2))
                    .sum::<usize>(),
            );
        Self {
            scans,
            buckets,
            bytes,
            clock,
        }
    }
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
    scans: ScanWindows,
    // Equality-queried field sets by collection, with their dependency counts.
    buckets: im::HashMap<String, im::HashMap<Vec<String>, usize>>,
    cell_count: usize,
    invalid_cells: im::OrdMap<String, EngineError>,
    invalid_roots: im::OrdMap<String, EngineError>,
    clock_readers: usize,
    // Unlike the cycle proof, this also changes for source dependency edges.
    // Optimistic patches must discover the same set of reactive readers.
    pub(super) shape: Arc<()>,
    // Physical sources/indexes are shared by all graph generations. Their
    // marker map is updated once and retained by each graph in O(1).
    memberships: im::HashMap<String, dependencies::Generation>,
}

impl Default for ReactiveIndex {
    fn default() -> Self {
        Self {
            scans: im::HashMap::new(),
            buckets: im::HashMap::new(),
            cell_count: 0,
            invalid_cells: im::OrdMap::new(),
            invalid_roots: im::OrdMap::new(),
            clock_readers: 0,
            shape: Arc::new(()),
            memberships: im::HashMap::new(),
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
            if previous.is_some() != next.is_some()
                && let Some(keys) = dependencies::keys_marker(&marker)
            {
                Self::change_generation(
                    &mut self.memberships,
                    keys,
                    previous.is_some(),
                    next.is_some(),
                );
            }
            Self::change_generation(
                &mut self.memberships,
                marker,
                previous.is_some(),
                next.is_some(),
            );
        }
        if id.starts_with("cell:") {
            self.update_cell(id, previous, next, record_depth_valid);
        } else if id.starts_with("root:") {
            self.update_root(id, previous, next, record_depth_valid);
        }
    }

    /// A source collection, index bucket or index range's membership token.
    /// Cell outcomes need none: a stored cell keeps its allocation until its
    /// outcome or dependencies change.
    pub(crate) fn generation(&self, id: &str) -> Option<&Arc<()>> {
        self.memberships.get(id).map(|generation| &generation.token)
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

    /// Stored cells of this graph, including invalid ones.
    #[cfg(test)]
    pub(crate) fn cell_count(&self) -> usize {
        self.cell_count
    }

    /// Accounted bytes of the graph entry for cell or root `id` that `base`
    /// does not share, i.e. what a transaction adds or replaces. Stored
    /// records are the graph's entries: one kept from the snapshot, a cell
    /// whose outcome alone changed, and a removed entry cost nothing.
    pub(super) fn unshared_bytes(staged: &Records, base: &Records, id: &str) -> usize {
        let Some(record) = staged.get_shared(id) else {
            return 0;
        };
        let old = base.get_shared(id);
        if old.is_some_and(|old| Arc::ptr_eq(old, record)) {
            return 0;
        }
        if id.starts_with("cell:") {
            let same_edges = old.is_some_and(|old| old.get("deps") == record.get("deps"))
                && staged.reactive().invalid_cells.get(id) == base.reactive().invalid_cells.get(id);
            if same_edges {
                0
            } else {
                Cell::parse(id, record).bytes
            }
        } else if id.starts_with("root:") {
            // Root lookup/traversal storage plus a pending append-frontier entry.
            320 + id.len().saturating_mul(4)
        } else {
            0
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

    fn update_cell(
        &mut self,
        id: &str,
        previous: Option<&Arc<Value>>,
        next: Option<&Arc<Value>>,
        record_depth_valid: bool,
    ) {
        let old_error = self.invalid_cells.get(id).cloned();
        let new_error = next.map(|value| {
            if record_depth_valid {
                Ok(())
            } else {
                // Ephemeral cell outcomes may exceed the snapshot wrapper's
                // depth. Protect recursive identity handling using only args.
                depth(&value["args"], 0, "INPUT_INVALID")
            }
            .and_then(|()| {
                validate_cell(
                    id,
                    value,
                    previous,
                    previous.is_some() && old_error.is_none(),
                )
            })
            .err()
        });
        // An outcome change alone leaves every derived structure unchanged,
        // so compare dependencies before parsing either record.
        if let (Some(previous), Some(next), Some(error)) = (previous, next, &new_error)
            && old_error == *error
            && previous.get("deps") == next.get("deps")
        {
            return;
        }
        let old = previous.map(|value| Cell::parse(id, value));
        let new = next
            .zip(new_error)
            .map(|(value, error)| (Cell::parse(id, value), error));
        self.shape = Arc::new(());
        if let Some(old) = old {
            self.clock_readers -= usize::from(old.clock);
            self.change_scans(&old.scans, id, false);
            self.change_buckets(&old.buckets, false);
            self.cell_count -= 1;
        }
        self.invalid_cells.remove(id);
        if let Some((new, error)) = new {
            self.clock_readers += usize::from(new.clock);
            self.change_scans(&new.scans, id, true);
            self.change_buckets(&new.buckets, true);
            if let Some(error) = error {
                self.invalid_cells.insert(id.into(), error);
            }
            self.cell_count += 1;
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
        self.shape = Arc::new(());
        self.invalid_roots.remove(id);
        if let Some(value) = next {
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
            if let Err(error) = reference {
                self.invalid_roots.insert(id.into(), error);
            }
        }
    }
}

fn validate_cell(
    id: &str,
    value: &Value,
    previous: Option<&Arc<Value>>,
    previous_valid: bool,
) -> EngineResult<()> {
    record(value, "stored cell", "INPUT_INVALID")?;
    let name = string(&value["name"], "stored cell name", "INPUT_INVALID")?;
    let same_identity = previous_valid
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
