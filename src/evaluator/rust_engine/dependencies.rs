//! Query certificates refer to immutable allocation identities, never old payloads.
//! Weak references prevent address reuse without retaining obsolete JSON trees.
use super::*;
use std::sync::Weak;

#[derive(Clone, Debug)]
enum Stamp {
    Record(Option<Weak<Value>>),
    Marker(Option<Weak<()>>),
}
#[derive(Clone, Debug, Default)]
pub struct DependencyCertificate {
    checks: BTreeMap<String, Stamp>,
    bytes: usize,
}
impl DependencyCertificate {
    /// Validate only observed identities against this request's chosen snapshot.
    pub fn valid(&self, data: &Records) -> bool {
        data.reactive().cacheable() && self.valid_records(data)
    }
    fn valid_records(&self, data: &Records) -> bool {
        data.has_valid_depth()
            && data.has_valid_source_ids()
            && data.has_valid_graph_pointer()
            && data.reactive().validate().is_ok()
            && data
                .get("clock")
                .is_none_or(|value| safe_time(value, "Stored clock").is_ok())
            && self.checks.iter().all(|(id, stamp)| match stamp {
                Stamp::Record(expected) => match (expected, data.get_shared(id)) {
                    (None, None) => true,
                    (Some(expected), Some(actual)) => {
                        std::ptr::eq(expected.as_ptr(), Arc::as_ptr(actual))
                    }
                    _ => false,
                },
                Stamp::Marker(expected) => match (expected, data.reactive().generation(id)) {
                    (None, None) => true,
                    (Some(expected), Some(actual)) => {
                        std::ptr::eq(expected.as_ptr(), Arc::as_ptr(actual))
                    }
                    _ => false,
                },
            })
    }
    pub fn allocation_cost(&self) -> usize {
        self.bytes
    }
}

/// An optimistic mutation is reusable only against the same observed values,
/// write bases, graph dependency shape and code/policy, at its fixed clock.
#[derive(Clone, Debug)]
pub struct MutationCertificate {
    reads: DependencyCertificate,
    graph: Weak<()>,
    now: u64,
}
impl MutationCertificate {
    pub(super) fn new(reads: DependencyCertificate, data: &Records, now: u64) -> Self {
        Self {
            reads,
            graph: Arc::downgrade(&data.reactive().shape),
            now,
        }
    }
    pub fn valid(&self, data: &Records) -> bool {
        self.reads.valid_records(data)
            && std::ptr::eq(self.graph.as_ptr(), Arc::as_ptr(&data.reactive().shape))
            && data
                .get("clock")
                .map_or(Ok(0), |clock| safe_time(clock, "Stored clock"))
                .is_ok_and(|clock| clock <= self.now)
    }
    pub fn allocation_cost(&self) -> usize {
        self.reads.allocation_cost().saturating_add(64)
    }
}
impl Engine<'_> {
    fn certificate_stamp(&mut self, id: &str, marker: bool) {
        if !self.query_cacheable && !self.speculative {
            return;
        }
        let Some(certificate) = self.certificate.as_ref() else {
            return;
        };
        if certificate.checks.contains_key(id) {
            return;
        }
        let cost = 160usize.saturating_add(id.len());
        if self.total_retained_bytes().saturating_add(cost) > self.retained_limit {
            // Stop tracking when the certificate itself would exceed budget.
            self.disable_certificate();
            return;
        }
        let stamp = if marker {
            Stamp::Marker(self.base.reactive().generation(id).map(Arc::downgrade))
        } else {
            Stamp::Record(self.base.get_shared(id).map(Arc::downgrade))
        };
        self.retained_bytes = self.retained_bytes.saturating_add(cost);
        let certificate = self.certificate.as_mut().expect("checked certificate");
        certificate.bytes = certificate.bytes.saturating_add(cost);
        certificate.checks.insert(id.to_owned(), stamp);
    }
    fn disable_certificate(&mut self) {
        if let Some(previous) = self.certificate.take() {
            self.retained_bytes = self.retained_bytes.saturating_sub(previous.bytes);
        }
    }
    pub(super) fn record_read(&mut self, id: impl AsRef<str>) {
        self.certificate_stamp(id.as_ref(), false);
    }
    pub(super) fn marker_read(&mut self, id: impl AsRef<str>) {
        self.certificate_stamp(id.as_ref(), true);
    }
    pub(super) fn derived_read(&mut self, id: String) {
        // A stored cell may read the clock without this query noticing: only
        // a graph without clock readers proves the read is time-independent.
        if !self.base.reactive().cacheable() {
            self.clock_polled = true;
        }
        if self.speculative {
            self.record_read(id);
            return;
        }
        if !self.query_cacheable || self.certificate.is_none() {
            return;
        }
        let mut walk_bytes = 160usize.saturating_add(id.len());
        let mut pending = vec![id];
        let mut seen = HashSet::new();
        while let Some(id) = pending.pop() {
            if self.certificate.is_none() {
                return;
            }
            if self.total_retained_bytes().saturating_add(walk_bytes) > self.retained_limit {
                self.disable_certificate();
                return;
            }
            if seen.len().is_multiple_of(64) && self.check_fatal().is_err() {
                self.disable_certificate();
                return;
            }
            if !seen.insert(id.clone()) {
                continue;
            }
            if id == "clock" || id == "managedKeys" {
                self.query_cacheable = false;
                self.clock_polled = true;
                return;
            }
            if id.starts_with("source:") {
                self.record_read(id);
            } else if let Some(window) = windows::Window::parse(&id) {
                // Snapshot validation cannot see which rows moved.
                self.marker_read(window.marker(&self.schema));
            } else if let Some((collection, fields)) = bucket_spec(&id)
                && !self.maintained_index(&collection, &fields)
            {
                // Only maintained indexes have bucket markers.
                self.marker_read(collection_id(&collection));
            } else if id.starts_with("collection:")
                || id.starts_with("index-bucket:")
                || id.starts_with("index-range:")
            {
                self.marker_read(id);
            } else if id.starts_with("cell:") {
                if self.base.get(&id).is_some() {
                    self.marker_read(format!("outcome:{id}"));
                } else if let Some(cell) = self.staged.get(&id) {
                    let Some(deps) = cell["deps"].as_array() else {
                        self.query_cacheable = false;
                        return;
                    };
                    for dep in deps {
                        let Some(dep) = dep.as_str() else {
                            self.query_cacheable = false;
                            return;
                        };
                        walk_bytes = walk_bytes.saturating_add(160).saturating_add(dep.len());
                        if self.total_retained_bytes().saturating_add(walk_bytes)
                            > self.retained_limit
                        {
                            self.disable_certificate();
                            return;
                        }
                        pending.push(dep.to_owned());
                    }
                } else {
                    self.query_cacheable = false;
                    return;
                }
            } else {
                self.query_cacheable = false;
                return;
            }
        }
    }

    pub(super) fn speculative_read(&mut self, id: &str) {
        // range_rows already stamped a scan's marker and returned rows, and
        // query_rows the collection of an undeclared bucket.
        if !self.speculative
            || id == "clock"
            || windows::Window::is_dependency(id)
            || bucket_spec(id)
                .is_some_and(|(collection, fields)| !self.maintained_index(&collection, &fields))
        {
            return;
        }
        if id.starts_with("collection:")
            || id.starts_with("index-bucket:")
            || id.starts_with("index-range:")
        {
            self.marker_read(id);
        } else {
            self.record_read(id);
        }
    }
}

/// Persistent marker identities are proportional to live members, not history.
#[derive(Clone, Debug)]
pub(super) struct Generation {
    pub token: Arc<()>,
    pub members: usize,
}

/// Split the first complete JSON component without interpreting user strings.
/// IDs are trusted generated keys; malformed IDs conservatively have no marker.
fn component(value: &str) -> Option<(&str, &str)> {
    let mut quoted = false;
    let mut escaped = false;
    let mut nesting = 0usize;
    for (index, byte) in value.bytes().enumerate() {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
            continue;
        }
        match byte {
            b'"' => quoted = true,
            b'[' | b'{' => nesting = nesting.checked_add(1)?,
            b']' | b'}' => nesting = nesting.checked_sub(1)?,
            b':' if nesting == 0 => return Some((&value[..index], &value[index + 1..])),
            _ => {}
        }
    }
    None
}
/// The collection and fields of an `index-bucket:` dependency.
pub(super) fn bucket_spec(id: &str) -> Option<(String, Vec<String>)> {
    let (spec, _) = component(id.strip_prefix("index-bucket:")?)?;
    serde_json::from_str(spec).ok()
}

pub(super) fn membership_marker(id: &str) -> Option<String> {
    if let Some(source) = id.strip_prefix("source:[") {
        // The first member is always a JSON string; use the same escape-safe
        // component scanner after replacing its delimiting comma virtually.
        let mut escaped = false;
        let bytes = source.as_bytes();
        if bytes.first() != Some(&b'"') {
            return None;
        }
        for index in 1..bytes.len() {
            if escaped {
                escaped = false;
            } else if bytes[index] == b'\\' {
                escaped = true;
            } else if bytes[index] == b'"' {
                return (bytes.get(index + 1) == Some(&b','))
                    .then(|| format!("collection:{}", &source[..=index]));
            }
        }
        None
    } else if let Some(encoded) = id.strip_prefix("index-entry:") {
        let (spec, tail) = component(encoded)?;
        let (bucket, _) = component(tail)?;
        Some(format!("index-bucket:{spec}:{bucket}"))
    } else if let Some(encoded) = id.strip_prefix("ordered-entry:") {
        let (spec, _) = component(encoded)?;
        Some(format!("index-range:{spec}"))
    } else {
        None
    }
}
