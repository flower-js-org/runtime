//! Persistent application records. A snapshot clone only retains a tree root;
//! changing a key copies its tree path and shares every unchanged JSON value.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::ops::{Index, RangeBounds};
use std::sync::Arc;

use im::{OrdMap, OrdSet};
use serde::de::{MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use serde_json::value::RawValue;

#[derive(Clone, Debug, Default)]
pub struct Records(
    OrdMap<String, Arc<Value>>,
    OrdSet<String>,
    OrdSet<String>,
    // Original unprefixed graph and its source-membership markers.
    crate::evaluator::ReactiveIndex,
    // Graph generations, reconstructed from their physical record prefixes.
    OrdMap<String, GraphIndex>,
    // None follows the durable pointer; Some(None) forces the original graph.
    Option<Option<String>>,
    // Persistent source-only seed for creating an empty graph without a scan.
    crate::evaluator::ReactiveIndex,
);

#[derive(Clone, Debug)]
struct GraphIndex {
    reactive: crate::evaluator::ReactiveIndex,
    records: usize,
}

// Metadata is derived from records. Its shared validation proof is deliberately
// absent from equality and serialization, just like a process-local cache.
impl PartialEq for Records {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}

impl Eq for Records {}

impl Records {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Snapshot input validation is O(1). Only newly inserted records are
    /// traversed; the persistent set remembers invalid transient wrapper keys.
    /// Such wrappers can occur during an ephemeral graph preview, so insertion
    /// records validity without rejecting them prematurely.
    pub fn has_valid_depth(&self) -> bool {
        self.1.is_empty()
    }

    /// Source-key syntax depends only on the key, so each insertion validates it
    /// once. Values and snapshot clones retain this result without a global lock.
    pub(crate) fn has_valid_source_ids(&self) -> bool {
        self.2.is_empty()
    }

    pub(crate) fn reactive(&self) -> &crate::evaluator::ReactiveIndex {
        match self.graph_generation() {
            None => &self.3,
            Some(generation) => self
                .4
                .get(generation)
                .map_or(&self.6, |index| &index.reactive),
        }
    }

    /// The committed graph pointer. Absence identifies the original unprefixed
    /// graph; explicit views do not change this durable pointer.
    pub fn active_graph(&self) -> Option<&str> {
        self.0
            .get("reactive:active")
            .and_then(|value| value.as_str())
            .filter(|generation| valid_graph_generation(generation))
    }

    pub(crate) fn has_valid_graph_pointer(&self) -> bool {
        self.0
            .get("reactive:active")
            .is_none_or(|value| value.as_str().is_some_and(valid_graph_generation))
    }

    pub(crate) fn valid_graph_generation(generation: &str) -> bool {
        valid_graph_generation(generation)
    }

    /// All retained graph clocks, including the original graph. New writes
    /// must use a common time no earlier than any graph's last evaluation.
    pub(crate) fn graph_clocks(&self) -> impl Iterator<Item = &Value> {
        self.0
            .get("clock")
            .into_iter()
            .chain(
                self.4
                    .keys()
                    .filter_map(|generation| self.0.get(&format!("graph:{generation}:clock"))),
            )
            .map(Arc::as_ref)
    }

    /// The graph selected for logical reads and evaluator metadata.
    pub fn graph_generation(&self) -> Option<&str> {
        self.5
            .as_ref()
            .map_or_else(|| self.active_graph(), |view| view.as_deref())
    }

    /// Select a graph for evaluation, including its writes. Storage snapshots
    /// themselves always mutate raw keys, so cleanup can remove an old graph
    /// without accidentally deleting the currently active graph.
    pub fn graph_view(&self, generation: Option<&str>) -> Self {
        assert!(generation.is_none_or(valid_graph_generation));
        let mut view = self.clone();
        view.5 = Some(generation.map(str::to_owned));
        view
    }

    /// Translate a logical evaluator patch key to its durable storage key.
    pub fn graph_key(&self, logical: &str) -> String {
        self.read_key(logical).into_owned()
    }

    fn read_key<'a>(&self, key: &'a str) -> Cow<'a, str> {
        if is_graph_record(key)
            && let Some(generation) = self.graph_generation()
        {
            return Cow::Owned(format!("graph:{generation}:{key}"));
        }
        Cow::Borrowed(key)
    }

    /// Enumerate selected roots by logical identity, without scanning sources
    /// or any of the other graph generations retained in this snapshot.
    pub fn graph_roots(&self) -> impl DoubleEndedIterator<Item = (&str, &Value)> {
        let prefix = self
            .graph_generation()
            .map_or_else(String::new, |generation| format!("graph:{generation}:"));
        let offset = prefix.len();
        self.0
            .range(format!("{prefix}root:")..format!("{prefix}root;"))
            .map(move |(key, value)| (&key[offset..], value.as_ref()))
    }

    /// O(1) identity check useful for revision/cache comparisons.
    pub fn ptr_eq(&self, other: &Self) -> bool {
        self.0.ptr_eq(&other.0)
            && (self.5 == other.5 || self.graph_generation() == other.graph_generation())
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.get_shared(key).is_some()
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.get_shared(key).map(Arc::as_ref)
    }

    pub fn get_shared(&self, key: &str) -> Option<&Arc<Value>> {
        self.get_raw_shared(self.read_key(key).as_ref())
    }

    /// Bypass active-graph resolution when applying or inspecting storage keys.
    pub fn get_raw_shared(&self, key: &str) -> Option<&Arc<Value>> {
        self.0.get(key)
    }

    pub fn get_key_value(&self, key: &str) -> Option<(&String, &Value)> {
        self.0
            .get_key_value(self.read_key(key).as_ref())
            .map(|(key, value)| (key, value.as_ref()))
    }

    /// Return the old allocation without deep-copying it even when another
    /// application revision still owns that record.
    pub fn insert(&mut self, key: String, value: Value) -> Option<Arc<Value>> {
        self.insert_shared(key, Arc::new(value))
    }

    pub fn insert_shared(&mut self, key: String, value: Arc<Value>) -> Option<Arc<Value>> {
        let key = if self.5.is_some() {
            self.graph_key(&key)
        } else {
            key
        };
        let previous = self.0.get(&key).cloned();
        if previous
            .as_ref()
            .is_some_and(|previous| Arc::ptr_eq(previous, &value))
        {
            return Some(value);
        }
        let depth_valid = valid_depth(&value);
        self.update_reactive(&key, previous.as_ref(), Some(&value), depth_valid);
        if previous.is_none() && !valid_source_id(&key) {
            self.2.insert(key.clone());
        }
        if depth_valid {
            self.1.remove(&key);
        } else {
            self.1.insert(key.clone());
        }
        self.0.insert(key, value)
    }

    pub fn remove(&mut self, key: &str) -> Option<Arc<Value>> {
        self.remove_shared(key)
    }

    pub fn remove_shared(&mut self, key: &str) -> Option<Arc<Value>> {
        let key = if self.5.is_some() {
            self.read_key(key)
        } else {
            Cow::Borrowed(key)
        };
        let key = key.as_ref();
        let previous = self.0.get(key).cloned();
        self.update_reactive(key, previous.as_ref(), None, true);
        self.1.remove(key);
        self.2.remove(key);
        self.0.remove(key)
    }

    fn update_reactive(
        &mut self,
        key: &str,
        previous: Option<&Arc<Value>>,
        next: Option<&Arc<Value>>,
        depth_valid: bool,
    ) {
        if previous.is_none() && next.is_none() {
            return;
        }
        if let Some((generation, logical)) = split_graph_key(key) {
            let index = self
                .4
                .entry(generation.to_owned())
                .or_insert_with(|| GraphIndex {
                    reactive: self.6.clone(),
                    records: 0,
                });
            index.reactive.update(logical, previous, next, depth_valid);
            index.records = index
                .records
                .saturating_sub(usize::from(previous.is_some()))
                .saturating_add(usize::from(next.is_some()));
            if index.records == 0 {
                self.4.remove(generation);
            }
        } else {
            if key.starts_with("source:")
                || key.starts_with("index-entry:")
                || key.starts_with("ordered-entry:")
            {
                // New generations inherit a persistent source-membership index
                // in O(1), independent of the size of the source collection.
                self.6.update(key, previous, next, depth_valid);
                self.3.share_memberships(&self.6);
                let generations: Vec<_> = self.4.keys().cloned().collect();
                for generation in generations {
                    self.4
                        .get_mut(&generation)
                        .expect("existing graph index")
                        .reactive
                        .share_memberships(&self.6);
                }
            } else {
                self.3.update(key, previous, next, depth_valid);
            }
        }
    }

    pub fn iter(&self) -> Iter<'_> {
        Iter(self.0.iter())
    }

    pub fn iter_shared(&self) -> im::ordmap::Iter<'_, String, Arc<Value>> {
        self.0.iter()
    }

    pub fn range<R: RangeBounds<str>>(&self, range: R) -> Iter<'_> {
        Iter(self.0.range(range))
    }

    pub fn range_shared<R: RangeBounds<str>>(
        &self,
        range: R,
    ) -> im::ordmap::Iter<'_, String, Arc<Value>> {
        self.0.range(range)
    }

    pub fn keys(&self) -> impl DoubleEndedIterator<Item = &String> {
        self.0.keys()
    }

    pub fn values(&self) -> impl DoubleEndedIterator<Item = &Value> {
        self.0.values().map(Arc::as_ref)
    }
}

pub struct Iter<'a>(im::ordmap::Iter<'a, String, Arc<Value>>);

impl<'a> Iterator for Iter<'a> {
    type Item = (&'a String, &'a Value);

    fn next(&mut self) -> Option<Self::Item> {
        self.0.next().map(|(key, value)| (key, value.as_ref()))
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        self.0.size_hint()
    }
}

impl DoubleEndedIterator for Iter<'_> {
    fn next_back(&mut self) -> Option<Self::Item> {
        self.0.next_back().map(|(key, value)| (key, value.as_ref()))
    }
}

impl Index<&str> for Records {
    type Output = Value;

    fn index(&self, key: &str) -> &Self::Output {
        self.get(key).expect("missing application record")
    }
}

impl Index<&String> for Records {
    type Output = Value;

    fn index(&self, key: &String) -> &Self::Output {
        &self[key.as_str()]
    }
}

impl Extend<(String, Value)> for Records {
    fn extend<T: IntoIterator<Item = (String, Value)>>(&mut self, iter: T) {
        for (key, value) in iter {
            self.insert(key, value);
        }
    }
}

fn valid_graph_generation(generation: &str) -> bool {
    generation.len() == 64
        && generation
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_graph_record(key: &str) -> bool {
    key == "clock" || key.starts_with("cell:") || key.starts_with("root:")
}

fn split_graph_key(key: &str) -> Option<(&str, &str)> {
    let (generation, logical) = key.strip_prefix("graph:")?.split_once(':')?;
    (valid_graph_generation(generation) && is_graph_record(logical))
        .then_some((generation, logical))
}

fn valid_source_id(id: &str) -> bool {
    let Some(encoded) = id.strip_prefix("source:") else {
        return true;
    };
    let Ok(pair) = serde_json::from_str::<(String, String)>(encoded) else {
        return false;
    };
    serde_json::to_string(&pair).is_ok_and(|canonical| canonical == encoded)
}

fn valid_depth(value: &Value) -> bool {
    // Each frame holds only a borrowed value, remaining depth and collection
    // iterator. The 128-level guard bounds recursion to 129 frames including
    // rejection, without allocating a traversal stack per record.
    // A record starts at depth one inside its snapshot.
    fn visit(value: &Value, remaining: u8) -> bool {
        if remaining == 0 {
            return false;
        }
        match value {
            Value::Array(values) => values.iter().all(|value| visit(value, remaining - 1)),
            Value::Object(values) => values.values().all(|value| visit(value, remaining - 1)),
            _ => true,
        }
    }
    visit(value, 128)
}

impl FromIterator<(String, Value)> for Records {
    fn from_iter<T: IntoIterator<Item = (String, Value)>>(iter: T) -> Self {
        let mut result = Self::new();
        result.extend(iter);
        result
    }
}

impl From<BTreeMap<String, Value>> for Records {
    fn from(data: BTreeMap<String, Value>) -> Self {
        data.into_iter().collect()
    }
}

impl<const N: usize> From<[(String, Value); N]> for Records {
    fn from(data: [(String, Value); N]) -> Self {
        data.into_iter().collect()
    }
}

impl<'a> IntoIterator for &'a Records {
    type Item = (&'a String, &'a Value);
    type IntoIter = Iter<'a>;

    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}

impl IntoIterator for Records {
    type Item = (String, Value);
    type IntoIter = std::iter::Map<
        <OrdMap<String, Arc<Value>> as IntoIterator>::IntoIter,
        fn((String, Arc<Value>)) -> (String, Value),
    >;

    fn into_iter(self) -> Self::IntoIter {
        // Owned iteration explicitly requests owned JSON trees. Query and
        // graph paths use borrowed iteration/shared handles instead.
        self.0
            .into_iter()
            .map(|(key, value)| (key, Arc::unwrap_or_clone(value)))
    }
}

impl Serialize for Records {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.len()))?;
        for (key, value) in self {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for Records {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct RecordsVisitor;

        impl<'de> Visitor<'de> for RecordsVisitor {
            type Value = Records;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("an object of application records")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut records = Records::new();
                while let Some((key, raw)) = map.next_entry::<String, Box<RawValue>>()? {
                    // Reset parser depth for each user value, just as the old
                    // BTreeMap decoder did. Raft wrappers spend no user budget.
                    let value =
                        serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
                    records.insert(key, value);
                }
                Ok(records)
            }
        }

        deserializer.deserialize_map(RecordsVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const GRAPH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const GRAPH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const CELL: &str = r#"cell:["leaf",null]"#;
    const ROOT: &str = r#"root:["leaf",null]"#;

    fn graph_cell(value: u64) -> Value {
        json!({
            "name": "leaf", "args": null,
            "outcome": {"ok": true, "value": value},
            "deps": [r#"source:["items","first"]"#]
        })
    }

    fn graph_records() -> Records {
        let mut records = Records::from([
            (CELL.into(), graph_cell(1)),
            (ROOT.into(), json!({"name": "leaf", "args": null})),
            ("clock".into(), json!(10)),
            (r#"source:["items","first"]"#.into(), json!(1)),
        ]);
        for (generation, value, clock) in [(GRAPH_A, 2, 20), (GRAPH_B, 3, 30)] {
            records.insert(format!("graph:{generation}:{CELL}"), graph_cell(value));
            records.insert(
                format!("graph:{generation}:{ROOT}"),
                json!({"name": "leaf", "args": null}),
            );
            records.insert(format!("graph:{generation}:clock"), json!(clock));
        }
        records
    }

    #[test]
    fn graph_pointer_switches_logical_reads_and_metadata_in_one_snapshot() {
        let mut records = graph_records();
        let legacy = records.clone();
        let outcome = format!("outcome:{CELL}");
        let legacy_outcome = legacy.reactive().generation(&outcome).unwrap();
        let candidate = records.graph_view(Some(GRAPH_A));
        let candidate_outcome = candidate.reactive().generation(&outcome).unwrap();
        assert!(!Arc::ptr_eq(legacy_outcome, candidate_outcome));
        assert_eq!(records[CELL]["outcome"]["value"], 1);
        assert_eq!(records["clock"], 10);
        records.insert("reactive:active".into(), json!(GRAPH_A));
        assert_eq!(records.active_graph(), Some(GRAPH_A));
        assert_eq!(records.graph_generation(), Some(GRAPH_A));
        assert_eq!(records[CELL]["outcome"]["value"], 2);
        assert_eq!(records["clock"], 20);
        assert!(records.contains_key(CELL));
        assert_eq!(
            records.get_key_value(CELL).unwrap().0,
            &format!("graph:{GRAPH_A}:{CELL}")
        );
        assert!(Arc::ptr_eq(
            records.get_shared(CELL).unwrap(),
            candidate.get_shared(CELL).unwrap()
        ));
        assert!(Arc::ptr_eq(
            records.reactive().generation(&outcome).unwrap(),
            candidate_outcome
        ));
        assert_eq!(legacy[CELL]["outcome"]["value"], 1);
        assert_eq!(legacy["clock"], 10);
        assert_eq!(legacy.active_graph(), None);

        let active = records.clone();
        records.insert("reactive:active".into(), json!(GRAPH_B));
        assert_eq!(records[CELL]["outcome"]["value"], 3);
        assert_eq!(records["clock"], 30);
        assert_eq!(active[CELL]["outcome"]["value"], 2);
        assert_eq!(candidate[CELL]["outcome"]["value"], 2);
        assert_eq!(
            records.graph_roots().collect::<Vec<_>>(),
            [(ROOT, &json!({"name":"leaf","args":null}))]
        );
    }

    #[test]
    fn graph_views_route_writes_but_storage_cleanup_keeps_raw_key_semantics() {
        let mut records = graph_records();
        records.insert("reactive:active".into(), json!(GRAPH_A));
        let mut candidate = records.graph_view(Some(GRAPH_B));
        assert_eq!(candidate.active_graph(), Some(GRAPH_A));
        assert_eq!(candidate.graph_generation(), Some(GRAPH_B));
        assert!(!records.ptr_eq(&candidate));
        assert!(records.ptr_eq(&records.graph_view(Some(GRAPH_A))));
        assert_eq!(candidate, records);
        assert_eq!(
            serde_json::to_string(&candidate).unwrap(),
            serde_json::to_string(&records).unwrap()
        );
        let loaded: Records =
            serde_json::from_str(&serde_json::to_string(&candidate).unwrap()).unwrap();
        assert_eq!(loaded.graph_generation(), Some(GRAPH_A));
        candidate.insert(CELL.into(), graph_cell(42));
        candidate.insert("clock".into(), json!(40));
        candidate.insert(r#"source:["items","second"]"#.into(), json!(2));
        candidate.remove(ROOT);
        assert_eq!(candidate[CELL]["outcome"]["value"], 42);
        assert_eq!(candidate["clock"], 40);
        assert_eq!(records[CELL]["outcome"]["value"], 2);
        assert_eq!(
            records.graph_view(Some(GRAPH_B))[CELL]["outcome"]["value"],
            3
        );
        assert!(!candidate.contains_key(ROOT));
        assert!(candidate.graph_roots().next().is_none());
        assert!(candidate.get_raw_shared(ROOT).is_some());
        assert_eq!(
            candidate
                .keys()
                .filter(|key| key.starts_with("source:"))
                .count(),
            2
        );
        assert_eq!(candidate.graph_key(CELL), format!("graph:{GRAPH_B}:{CELL}"));
        assert_eq!(
            candidate.graph_key("clock"),
            format!("graph:{GRAPH_B}:clock")
        );
        assert_eq!(candidate.graph_key("bundle"), "bundle");
        assert_eq!(candidate.graph_view(None).graph_key(CELL), CELL);
        assert_eq!(candidate.graph_view(None)[CELL]["outcome"]["value"], 1);

        records.remove(CELL);
        records.remove(ROOT);
        records.remove("clock");
        assert!(records.get_raw_shared(CELL).is_none());
        assert_eq!(records[CELL]["outcome"]["value"], 2);
        assert_eq!(records["clock"], 20);
        assert_eq!(records.graph_view(None).graph_roots().count(), 0);
        assert_eq!(records.graph_roots().count(), 1);
        for logical in [CELL, ROOT, "clock"] {
            records.remove(&format!("graph:{GRAPH_B}:{logical}"));
        }
        assert!(
            !records.4.contains_key(GRAPH_B),
            "cleanup also releases derived metadata"
        );
        assert_eq!(records.graph_view(Some(GRAPH_B)).graph_roots().count(), 0);
    }

    #[test]
    fn graph_membership_indexes_cover_source_and_index_updates_in_every_generation() {
        let first = r#"source:["items","first"]"#;
        let second = r#"source:["items","second"]"#;
        let bucket = r#"index-bucket:["items",["group"]]:"a""#;
        let range = r#"index-range:["items",["group"]]"#;
        let index_entry = r#"index-entry:["items",["group"]]:"a":"first""#;
        let ordered_entry = r#"ordered-entry:["items",["group"]]:"a":"first""#;
        let mut records = Records::from([(first.into(), json!(1))]);
        let empty = records.graph_view(Some(GRAPH_A));
        let empty_membership = empty
            .reactive()
            .generation(r#"collection:"items""#)
            .unwrap();
        records.insert(format!("graph:{GRAPH_A}:{CELL}"), graph_cell(1));
        let candidate = records.graph_view(Some(GRAPH_A));
        assert!(Arc::ptr_eq(
            empty_membership,
            candidate
                .reactive()
                .generation(r#"collection:"items""#)
                .unwrap()
        ));
        records.insert(second.into(), json!(2));
        records.insert(index_entry.into(), json!(true));
        records.insert(ordered_entry.into(), json!(true));
        // B is still empty: its view must already see current source metadata.
        for generation in [None, Some(GRAPH_A), Some(GRAPH_B)] {
            let view = records.graph_view(generation);
            assert!(view.reactive().generation(bucket).is_some());
            assert!(view.reactive().generation(range).is_some());
            assert!(!Arc::ptr_eq(
                empty_membership,
                view.reactive().generation(r#"collection:"items""#).unwrap()
            ));
        }
        records.insert(format!("graph:{GRAPH_B}:{CELL}"), graph_cell(2));
        records.remove(first);
        for generation in [None, Some(GRAPH_A), Some(GRAPH_B)] {
            assert!(
                records
                    .graph_view(generation)
                    .reactive()
                    .generation(r#"collection:"items""#)
                    .is_some()
            );
        }
        records.remove(second);
        records.remove(index_entry);
        records.remove(ordered_entry);
        for generation in [None, Some(GRAPH_A), Some(GRAPH_B)] {
            let view = records.graph_view(generation);
            for marker in [r#"collection:"items""#, bucket, range] {
                assert!(
                    view.reactive().generation(marker).is_none(),
                    "{generation:?}: {marker}"
                );
            }
        }
        assert!(
            empty
                .reactive()
                .generation(r#"collection:"items""#)
                .is_some()
        );
    }

    #[test]
    fn graph_metadata_reconstructs_independently_of_physical_record_order() {
        let mut records = graph_records();
        records.insert("reactive:active".into(), json!(GRAPH_B));
        let loaded: Records =
            serde_json::from_str(&serde_json::to_string(&records).unwrap()).unwrap();
        let reverse: Records = records
            .iter()
            .rev()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        for restored in [loaded, reverse] {
            assert_eq!(restored, records);
            assert_eq!(restored[CELL]["outcome"]["value"], 3);
            for generation in [None, Some(GRAPH_A), Some(GRAPH_B)] {
                let view = restored.graph_view(generation);
                assert_eq!(view.graph_roots().count(), 1);
                assert!(
                    view.reactive()
                        .generation(&format!("outcome:{CELL}"))
                        .is_some()
                );
                assert!(
                    view.reactive()
                        .generation(r#"collection:"items""#)
                        .is_some()
                );
                let mut removed = view.clone();
                removed.remove(r#"source:["items","first"]"#);
                assert!(
                    removed
                        .reactive()
                        .generation(r#"collection:"items""#)
                        .is_none()
                );
            }
        }
        for malformed in ["", "abc", "A".repeat(64).as_str(), "g".repeat(64).as_str()] {
            assert!(!valid_graph_generation(malformed));
        }
        assert_eq!(
            split_graph_key(&format!("graph:{GRAPH_A}:{CELL}")),
            Some((GRAPH_A, CELL))
        );
        assert!(split_graph_key(&format!("graph:{GRAPH_A}:source:[]")).is_none());
    }

    #[test]
    fn graph_pointer_validation_and_retained_clocks_ignore_the_selected_view() {
        let mut records = graph_records();
        let legacy = records.clone();
        assert!(records.has_valid_graph_pointer());
        records.insert("reactive:active".into(), json!(GRAPH_A));
        assert!(records.has_valid_graph_pointer());
        for generation in [None, Some(GRAPH_A), Some(GRAPH_B)] {
            assert_eq!(
                records
                    .graph_view(generation)
                    .graph_clocks()
                    .collect::<Vec<_>>(),
                [&json!(10), &json!(20), &json!(30)]
            );
        }
        records.remove(&format!("graph:{GRAPH_B}:clock"));
        assert_eq!(
            records.graph_clocks().collect::<Vec<_>>(),
            [&json!(10), &json!(20)]
        );
        for invalid in [
            Value::Null,
            json!(42),
            json!(""),
            json!("A".repeat(64)),
            json!("g".repeat(64)),
        ] {
            records.insert("reactive:active".into(), invalid);
            assert!(!records.has_valid_graph_pointer());
            assert!(!records.graph_view(Some(GRAPH_A)).has_valid_graph_pointer());
            let restored: Records =
                serde_json::from_str(&serde_json::to_string(&records).unwrap()).unwrap();
            assert!(!restored.has_valid_graph_pointer());
        }
        assert!(legacy.has_valid_graph_pointer());
        records.remove("reactive:active");
        assert!(records.has_valid_graph_pointer());
    }

    #[test]
    fn graph_generations_share_source_markers_but_keep_separate_outcomes() {
        let mut records = graph_records();
        let before = records.clone();
        let collection = r#"collection:"items""#;
        let outcome = format!("outcome:{CELL}");
        let old_marker = before.reactive().generation(collection).unwrap();
        for generation in [None, Some(GRAPH_A), Some(GRAPH_B)] {
            assert!(Arc::ptr_eq(
                old_marker,
                before
                    .graph_view(generation)
                    .reactive()
                    .generation(collection)
                    .unwrap()
            ));
        }
        records.insert(r#"source:["items","second"]"#.into(), json!(2));
        let new_marker = records.reactive().generation(collection).unwrap();
        assert!(!Arc::ptr_eq(old_marker, new_marker));
        for generation in [None, Some(GRAPH_A), Some(GRAPH_B)] {
            let previous = before.graph_view(generation);
            let current = records.graph_view(generation);
            assert!(Arc::ptr_eq(
                new_marker,
                current.reactive().generation(collection).unwrap()
            ));
            assert!(Arc::ptr_eq(
                previous.reactive().generation(&outcome).unwrap(),
                current.reactive().generation(&outcome).unwrap()
            ));
        }
        let a = records.graph_view(Some(GRAPH_A));
        let b = records.graph_view(Some(GRAPH_B));
        assert!(!Arc::ptr_eq(
            a.reactive().generation(&outcome).unwrap(),
            b.reactive().generation(&outcome).unwrap()
        ));
        records.insert(format!("graph:{GRAPH_A}:{CELL}"), graph_cell(42));
        assert!(Arc::ptr_eq(
            old_marker,
            before.reactive().generation(collection).unwrap()
        ));
        assert!(Arc::ptr_eq(
            b.reactive().generation(&outcome).unwrap(),
            records
                .graph_view(Some(GRAPH_B))
                .reactive()
                .generation(&outcome)
                .unwrap()
        ));
    }

    fn iterative_depth_reference(value: &Value) -> bool {
        let mut pending = vec![(value, 1)];
        while let Some((value, depth)) = pending.pop() {
            if depth > 128 {
                return false;
            }
            match value {
                Value::Array(values) => {
                    pending.extend(values.iter().map(|value| (value, depth + 1)))
                }
                Value::Object(values) => {
                    pending.extend(values.values().map(|value| (value, depth + 1)))
                }
                _ => {}
            }
        }
        true
    }

    #[test]
    fn allocation_free_depth_matches_iterative_validation_at_every_boundary() {
        for leaf in [
            Value::Null,
            json!([]),
            json!({}),
            json!({"first": [], "last": [1, true]}),
        ] {
            for levels in 0..=132 {
                let value = (0..levels).fold(leaf.clone(), |value, level| {
                    if level % 2 == 0 {
                        json!([null, value, []])
                    } else {
                        json!({"first": {}, "last": value})
                    }
                });
                assert_eq!(
                    valid_depth(&value),
                    iterative_depth_reference(&value),
                    "{levels} levels"
                );
            }
        }
        for leaf in [Value::Null, json!([]), json!({})] {
            let edge = (0..127).fold(leaf, |value, _| json!([value]));
            assert!(
                valid_depth(&edge),
                "snapshot wrapper plus127 containers is permitted"
            );
            assert!(
                !valid_depth(&json!([edge])),
                "snapshot wrapper plus128 containers is rejected"
            );
        }
        let wide = Value::Object(
            (0..2048)
                .map(|index| (index.to_string(), json!([null, {"a": true}])))
                .collect(),
        );
        assert_eq!(valid_depth(&wide), iterative_depth_reference(&wide));
    }

    #[test]
    fn depth_guard_fits_a_small_stack_even_for_excessively_nested_values() {
        let edge = (0..127).fold(Value::Null, |value, _| json!({"next": value}));
        let excessive = (0..512).fold(Value::Null, |value, _| json!([value]));
        // Ordinary workers have much larger stacks. Return the values so their
        // recursive JSON destructors run on the test thread, outside this check.
        let values = std::thread::Builder::new()
            .stack_size(256 * 1024)
            .spawn(move || {
                assert!(valid_depth(&edge));
                assert!(!valid_depth(&excessive));
                (edge, excessive)
            })
            .unwrap()
            .join()
            .unwrap();
        drop(values);
    }

    #[test]
    fn source_identity_validity_is_persistent_and_rebuilt_from_disk() {
        let key = r#"source:["memo/🌺","quoted\"\n"]"#;
        let mut records = Records::from([(key.into(), json!(1))]);
        assert!(records.has_valid_source_ids());
        let pristine = records.clone();
        for malformed in [
            r#"source: ["memo/🌺","quoted\"\n"]"#,
            r#"source:["memo/🌺", "quoted\"\n"]"#,
            r#"source:["memo/🌺","quoted\"\u000a"]"#,
            r#"source:["memo/🌺",null]"#,
            "source:[",
            "source:[]",
        ] {
            records.insert(malformed.into(), json!(2));
            assert!(!records.has_valid_source_ids());
            records.insert(malformed.into(), json!(3));
            assert!(!records.has_valid_source_ids());
            assert!(pristine.has_valid_source_ids());
            let loaded: Records =
                serde_json::from_str(&serde_json::to_string(&records).unwrap()).unwrap();
            assert_eq!(loaded, records);
            assert!(!loaded.has_valid_source_ids());
            records.remove(malformed);
            assert!(records.has_valid_source_ids());
        }
        records.insert(key.into(), json!(42));
        assert!(records.has_valid_source_ids());
        assert_eq!(pristine[key], 1);
        let long = format!(
            "source:{}",
            serde_json::to_string(&["long", &"🌺".repeat(10_000)]).unwrap()
        );
        records.insert(long, json!(null));
        assert!(records.has_valid_source_ids());
    }

    #[test]
    fn snapshots_share_roots_and_unchanged_values_without_mutating_prior_revisions() {
        let records: Records = (0..1024)
            .map(|id| {
                (
                    format!("key-{id:04}"),
                    json!({"large": "x".repeat(1024), "id": id}),
                )
            })
            .collect();
        let mut next = records.clone();
        assert!(records.ptr_eq(&next));
        next.insert("key-0000".into(), json!("changed"));
        next.remove("key-0512");
        assert!(!records.ptr_eq(&next));
        assert_eq!(records["key-0000"]["id"], 0);
        assert_eq!(records["key-0512"]["id"], 512);
        assert_eq!(next["key-0000"], "changed");
        assert!(!next.contains_key("key-0512"));
        for id in [1, 2, 511, 513, 1023] {
            let key = format!("key-{id:04}");
            assert!(Arc::ptr_eq(
                records.get_shared(&key).unwrap(),
                next.get_shared(&key).unwrap()
            ));
        }
    }

    #[test]
    fn records_preserve_ordered_wire_shape_and_payload_depth_limits() {
        let old = BTreeMap::from([
            ("z".into(), json!({"a": [1, null, true]})),
            ("東京/🌸".into(), json!("value")),
            ("a".into(), json!(42)),
        ]);
        let records = Records::from(old.clone());
        let encoded = serde_json::to_string(&records).unwrap();
        assert_eq!(encoded, serde_json::to_string(&old).unwrap());
        assert_eq!(serde_json::from_str::<Records>(&encoded).unwrap(), records);
        assert_eq!(records.into_iter().collect::<BTreeMap<_, _>>(), old);

        let acceptable = format!(r#"{{"deep": {}0{}}}"#, "[".repeat(127), "]".repeat(127));
        assert!(serde_json::from_str::<Records>(&acceptable).is_ok());
        let excessive = format!(r#"{{"deep": {}0{}}}"#, "[".repeat(128), "]".repeat(128));
        assert!(serde_json::from_str::<Records>(&excessive).is_err());
    }

    #[test]
    fn cached_depth_validity_tracks_replacements_removals_and_shared_versions() {
        let deep = |levels| (0..levels).fold(Value::Null, |value, _| json!([value]));
        let mut records = Records::from([("edge".into(), deep(127))]);
        assert!(records.has_valid_depth());
        let pristine = records.clone();
        records.insert("first".into(), deep(128));
        records.insert_shared("second".into(), Arc::new(deep(129)));
        assert!(!records.has_valid_depth());
        assert!(pristine.has_valid_depth());
        let retained = records.clone();
        records.insert("first".into(), json!(42));
        assert!(!records.has_valid_depth());
        records.remove("second");
        assert!(records.has_valid_depth());
        assert!(!retained.has_valid_depth());
        records.extend([("first".into(), deep(129)), ("first".into(), deep(127))]);
        assert!(records.has_valid_depth());
        let reconstructed: Records =
            serde_json::from_str(&serde_json::to_string(&records).unwrap()).unwrap();
        assert!(reconstructed.has_valid_depth());
        assert_eq!(reconstructed, records);
    }
}
