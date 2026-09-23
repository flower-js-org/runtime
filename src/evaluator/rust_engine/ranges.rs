//! Ordered scalar index ranges. Cursors continue against the current snapshot;
//! they do not pin historical data. Index-wide dependencies cover phantoms.
use super::*;
use indexes::IndexSpec;
use std::ops::Bound;

pub(super) fn prefix(collection: &str, fields: &[String]) -> String {
    format!(
        "ordered-entry:{}:",
        canonical_json(&json!([collection, fields]))
    )
}
pub(super) fn dependency(collection: &str, fields: &[String]) -> String {
    format!(
        "index-range:{}",
        canonical_json(&json!([collection, fields]))
    )
}
fn text_key(text: &str) -> String {
    let mut out = String::new();
    for unit in text.encode_utf16() {
        use std::fmt::Write;
        write!(out, "{unit:04x}").expect("String writes");
    }
    out.push('!');
    out
}
fn scalar(value: &Value) -> EngineResult<String> {
    Ok(match value {
        Value::Null => "0".into(),
        Value::Bool(false) => "10".into(),
        Value::Bool(true) => "11".into(),
        Value::Number(number) => {
            let number = number.as_f64().filter(|n| n.is_finite()).ok_or_else(|| {
                EngineError::new("INVALID_REFERENCE", "Range numbers must be finite")
            })?;
            let bits = (if number == 0.0 { 0.0 } else { number }).to_bits();
            let ordered = if bits >> 63 == 1 {
                !bits
            } else {
                bits ^ (1 << 63)
            };
            format!("2{ordered:016x}")
        }
        Value::String(value) => format!("3{}", text_key(value)),
        _ => {
            return Err(EngineError::new(
                "INVALID_REFERENCE",
                "Ordered index components must be null, boolean, finite number or string",
            ));
        }
    })
}
pub(super) fn entry(spec: &IndexSpec, key: &str, value: &Value) -> Option<String> {
    let object = value.as_object()?;
    let mut encoded = prefix(&spec.collection, &spec.fields);
    for field in &spec.fields {
        encoded.push_str(&scalar(object.get(field)?).ok()?);
    }
    encoded.push(':');
    encoded.push_str(&text_key(key));
    Some(encoded)
}

pub(super) struct RangeQuery {
    collection: String,
    fields: Vec<String>,
    lower: String,
    upper: String,
    after: Option<String>,
    reverse: bool,
    limit: usize,
    scope: String,
    offset: usize,
    scan: bool,
    source_keys: bool,
}
impl RangeQuery {
    pub(super) fn parse_scan(reference: &Value, options: &Value) -> EngineResult<Self> {
        let collection = reference_name(reference, "collection")?;
        let options = record(options, "scan options", "INVALID_REFERENCE")?;
        if options.keys().any(|key| {
            ![
                "index", "prefix", "gt", "gte", "lt", "lte", "limit", "offset", "reverse",
            ]
            .contains(&key.as_str())
        }) {
            return Err(EngineError::new("INVALID_REFERENCE", "Unknown scan option"));
        }
        let integer = |name: &str, default: usize| -> EngineResult<usize> {
            match options.get(name) {
                None => Ok(default),
                Some(value) => value
                    .as_f64()
                    .filter(|n| {
                        n.is_finite()
                            && *n >= 0.0
                            && *n <= 9_007_199_254_740_991.0
                            && n.fract() == 0.0
                    })
                    .and_then(|n| usize::try_from(n as u64).ok())
                    .ok_or_else(|| {
                        EngineError::new(
                            "INVALID_REFERENCE",
                            format!("Scan {name} must be a nonnegative safe integer"),
                        )
                    }),
            }
        };
        let limit = integer("limit", usize::MAX)?;
        let offset = integer("offset", 0)?;
        let source_keys = !options.contains_key("index");
        let fields = match options.get("index") {
            Some(index) => {
                let index = string(index, "scan index", "INVALID_REFERENCE")?;
                reference
                    .get("indexes")
                    .and_then(Value::as_object)
                    .and_then(|indexes| indexes.get(index))
                    .cloned()
                    .ok_or_else(|| EngineError::new("INVALID_REFERENCE", "Unknown scan index"))?
            }
            // A key scan uses the same scalar encoder as an implicit single-field
            // index, but never selects a persisted application index.
            None => json!(["$key"]),
        };
        if source_keys {
            let prefix = options.get("prefix").and_then(Value::as_array);
            if prefix.is_some_and(|parts| parts.iter().any(|part| !part.is_string()))
                || ["gt", "gte", "lt", "lte"]
                    .iter()
                    .any(|key| options.get(*key).is_some_and(|value| !value.is_string()))
            {
                return Err(EngineError::new(
                    "INVALID_REFERENCE",
                    "Source key constraints must be strings",
                ));
            }
        }
        let mut bounds = options.clone();
        bounds.remove("index");
        bounds.remove("offset");
        // Reuse the range validator, including its compound prefix rules. Scan's
        // optional/zero limit is restored after validating the range constraints.
        bounds.insert("limit".into(), json!(1));
        let mut query = Self::parse(&json!({
            "kind":"range", "collection":collection, "fields":fields, "options":bounds,
        }))?;
        query.limit = limit;
        query.offset = offset;
        query.scan = true;
        query.source_keys = source_keys;
        Ok(query)
    }

    pub(super) fn parse(value: &Value) -> EngineResult<Self> {
        record(value, "range reference", "INVALID_REFERENCE")?;
        if value["kind"] != "range"
            || value
                .as_object()
                .unwrap()
                .keys()
                .any(|k| !["kind", "collection", "fields", "options"].contains(&k.as_str()))
        {
            return Err(EngineError::new(
                "INVALID_REFERENCE",
                "Invalid range reference",
            ));
        }
        let collection = string(
            &value["collection"],
            "range collection",
            "INVALID_REFERENCE",
        )?
        .to_owned();
        let fields = value["fields"]
            .as_array()
            .and_then(|v| {
                v.iter()
                    .map(|v| v.as_str().filter(|v| !v.is_empty()).map(str::to_owned))
                    .collect::<Option<Vec<_>>>()
            })
            .filter(|v| !v.is_empty() && v.iter().collect::<HashSet<_>>().len() == v.len())
            .ok_or_else(|| {
                EngineError::new(
                    "INVALID_REFERENCE",
                    "Range fields must be distinct nonempty strings",
                )
            })?;
        let options = record(&value["options"], "range options", "INVALID_REFERENCE")?;
        if options.keys().any(|k| {
            ![
                "prefix", "gt", "gte", "lt", "lte", "limit", "after", "reverse",
            ]
            .contains(&k.as_str())
        }) {
            return Err(EngineError::new(
                "INVALID_REFERENCE",
                "Unknown range option",
            ));
        }
        let limit = options
            .get("limit")
            .and_then(Value::as_u64)
            .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| {
                EngineError::new(
                    "INVALID_REFERENCE",
                    "Range limit must be a positive safe integer",
                )
            })?;
        let parts = match options.get("prefix") {
            None => &[][..],
            Some(Value::Array(v)) => v.as_slice(),
            _ => {
                return Err(EngineError::new(
                    "INVALID_REFERENCE",
                    "Range prefix must be an array",
                ));
            }
        };
        if parts.len() > fields.len()
            || (parts.len() == fields.len()
                && ["gt", "gte", "lt", "lte"]
                    .iter()
                    .any(|key| options.contains_key(*key)))
            || (options.contains_key("gt") && options.contains_key("gte"))
            || (options.contains_key("lt") && options.contains_key("lte"))
        {
            return Err(EngineError::new(
                "INVALID_REFERENCE",
                "Invalid range prefix or overlapping bounds",
            ));
        }
        let mut base = prefix(&collection, &fields);
        for part in parts {
            base.push_str(&scalar(part)?);
        }
        let mut lower = base.clone();
        let mut upper = format!("{base}~");
        if let Some(value) = options.get("gte") {
            lower.push_str(&scalar(value)?);
        }
        if let Some(value) = options.get("gt") {
            lower.push_str(&scalar(value)?);
            lower.push('~');
        }
        if let Some(value) = options.get("lt") {
            upper = format!("{base}{}", scalar(value)?);
        }
        if let Some(value) = options.get("lte") {
            upper = format!("{base}{}~", scalar(value)?);
        }
        let reverse = match options.get("reverse") {
            None => false,
            Some(Value::Bool(v)) => *v,
            _ => {
                return Err(EngineError::new(
                    "INVALID_REFERENCE",
                    "reverse must be boolean",
                ));
            }
        };
        let scope = canonical_json(&json!([collection, fields, lower, upper, reverse]));
        let after = match options.get("after") {
            None => None,
            Some(Value::String(encoded)) => {
                let cursor: Value = serde_json::from_str(encoded)
                    .map_err(|_| EngineError::new("INVALID_REFERENCE", "Invalid range cursor"))?;
                if cursor["version"] != 1
                    || cursor["scope"] != scope
                    || cursor.as_object().is_none_or(|v| v.len() != 3)
                {
                    return Err(EngineError::new(
                        "INVALID_REFERENCE",
                        "Cursor belongs to another range",
                    ));
                }
                let last =
                    string(&cursor["last"], "cursor position", "INVALID_REFERENCE")?.to_owned();
                if last < lower || last >= upper {
                    return Err(EngineError::new(
                        "INVALID_REFERENCE",
                        "Cursor is outside the range",
                    ));
                }
                Some(last)
            }
            _ => {
                return Err(EngineError::new(
                    "INVALID_REFERENCE",
                    "Range cursor must be a string",
                ));
            }
        };
        Ok(Self {
            collection,
            fields,
            lower,
            upper,
            after,
            reverse,
            limit,
            scope,
            offset: 0,
            scan: false,
            source_keys: false,
        })
    }
    fn entry(&self, spec: &IndexSpec, key: &str, value: &Value) -> Option<String> {
        if self.source_keys {
            Some(format!(
                "{}3{}:{}",
                prefix(&self.collection, &self.fields),
                text_key(key),
                text_key(key)
            ))
        } else {
            entry(spec, key, value)
        }
    }
    fn includes(&self, id: &str) -> bool {
        id >= self.lower.as_str()
            && id < self.upper.as_str()
            && self.after.as_ref().is_none_or(|after| {
                if self.reverse {
                    id < after.as_str()
                } else {
                    id > after.as_str()
                }
            })
    }
    pub(super) fn dependency(&self, engine: &Engine<'_>) -> String {
        if self.indexed(engine) {
            dependency(&self.collection, &self.fields)
        } else {
            collection_id(&self.collection)
        }
    }
    fn indexed(&self, engine: &Engine<'_>) -> bool {
        !self.source_keys
            && engine
                .schema
                .indexes
                .iter()
                .any(|i| i.collection == self.collection && i.fields == self.fields)
    }
}

impl Engine<'_> {
    pub(super) fn range_rows(&mut self, query: &RangeQuery) -> EngineResult<Value> {
        self.marker_read(query.dependency(self));
        if query.lower >= query.upper || query.limit == 0 {
            return Ok(if query.scan {
                json!([])
            } else {
                json!({"rows":[],"cursor":null})
            });
        }
        let spec = IndexSpec {
            collection: query.collection.clone(),
            fields: query.fields.clone(),
        };
        let keep = query
            .offset
            .saturating_add(query.limit)
            .saturating_add(usize::from(!query.scan));
        let mut found = BTreeMap::<String, (String, Arc<Value>)>::new();
        let mut bytes = 0usize;
        let retain = |found: &mut BTreeMap<String, (String, Arc<Value>)>,
                      bytes: &mut usize,
                      id: String,
                      key: String,
                      value: Arc<Value>| {
            if let Some((old_key, _)) = found.insert(id.clone(), (key.clone(), value)) {
                *bytes = bytes.saturating_sub(192 + id.len() + old_key.len());
            }
            *bytes = bytes.saturating_add(192 + id.len() + key.len());
            if found.len() > keep {
                let removed = if query.reverse {
                    found.pop_first()
                } else {
                    found.pop_last()
                };
                if let Some((id, (key, _))) = removed {
                    *bytes = bytes.saturating_sub(192 + id.len() + key.len());
                }
            }
        };
        // Overlay mutations before walking the durable index. Skipped old entries
        // and inserted positions preserve read-your-writes without a full preview.
        let source_prefix = format!(
            "source:[{},",
            serde_json::to_string(&query.collection).unwrap()
        );
        for (position, (id, value)) in self.writes.range(source_prefix.clone()..).enumerate() {
            if !id.starts_with(&source_prefix) {
                break;
            }
            if position % 64 == 0 {
                self.check_fatal()?;
            }
            if let Some(value) = value {
                let (_, key) = source_pair(id)?;
                if let Some(id) = query
                    .entry(&spec, &key, value)
                    .filter(|id| query.includes(id))
                {
                    retain(&mut found, &mut bytes, id, key, value.clone());
                }
            }
            if self.total_retained_bytes().saturating_add(bytes) > self.retained_limit {
                return self.abort(
                    "EVALUATION_BUDGET",
                    "Range result exceeds Rust memory budget",
                );
            }
        }
        let indexed = query.indexed(self);
        if indexed {
            let snapshot = self.staged.clone();
            let lower = if !query.reverse {
                query
                    .after
                    .as_deref()
                    .map_or(Bound::Included(query.lower.as_str()), Bound::Excluded)
            } else {
                Bound::Included(query.lower.as_str())
            };
            let upper = if query.reverse {
                Bound::Excluded(query.after.as_deref().unwrap_or(&query.upper))
            } else {
                Bound::Excluded(query.upper.as_str())
            };
            let range = snapshot.range_shared((lower, upper));
            let iterator: Box<dyn Iterator<Item = (&String, &Arc<Value>)>> = if query.reverse {
                Box::new(range.rev())
            } else {
                Box::new(range)
            };
            // Merge the sorted overlay with the durable walk before applying
            // offset. Skipped durable rows never occupy the result buffer.
            let pending = std::mem::take(&mut found);
            let pending: Box<dyn Iterator<Item = (String, (String, Arc<Value>))>> = if query.reverse
            {
                Box::new(pending.into_iter().rev())
            } else {
                Box::new(pending.into_iter())
            };
            let mut pending = pending.peekable();
            let mut stored = iterator.peekable();
            let mut skip = query.offset;
            let selected_limit = query.limit.saturating_add(usize::from(!query.scan));
            let mut position = 0usize;
            loop {
                if position % 64 == 0 {
                    self.check_fatal()?;
                }
                position += 1;
                let take_pending = match (pending.peek(), stored.peek()) {
                    (Some((pending, _)), Some((stored, _))) => {
                        if query.reverse {
                            pending.as_str() >= stored.as_str()
                        } else {
                            pending.as_str() <= stored.as_str()
                        }
                    }
                    (Some(_), None) => true,
                    (None, Some(_)) => false,
                    (None, None) => break,
                };
                let (id, key, value) = if take_pending {
                    let (id, (key, value)) = pending.next().expect("pending entry");
                    bytes = bytes.saturating_sub(192 + id.len() + key.len());
                    (id, key, value)
                } else {
                    let (id, stored) = stored.next().expect("stored entry");
                    let key = stored.as_str().ok_or_else(|| {
                        EngineError::new("INPUT_INVALID", "Malformed ordered index entry")
                    })?;
                    let source = source_id(&query.collection, key);
                    if self.writes.contains_key(&source) {
                        continue;
                    }
                    let value = snapshot
                        .get_shared(&source)
                        .filter(|value| entry(&spec, key, value).as_ref() == Some(id))
                        .ok_or_else(|| {
                            EngineError::new(
                                "INPUT_INVALID",
                                "Ordered index entry does not match source",
                            )
                        })?;
                    (id.clone(), key.to_owned(), value.clone())
                };
                if skip > 0 {
                    skip -= 1;
                    continue;
                }
                bytes = bytes.saturating_add(192 + id.len() + key.len());
                found.insert(id, (key, value));
                if self.total_retained_bytes().saturating_add(bytes) > self.retained_limit {
                    return self.abort(
                        "EVALUATION_BUDGET",
                        "Range result exceeds Rust memory budget",
                    );
                }
                if found.len() == selected_limit {
                    break;
                }
            }
        } else {
            // Undeclared/dynamic helper collections stay correct. This fallback
            // scans native records, retaining only offset+limit (plus a cursor
            // lookahead for range pages); declare the index for seeks.
            let snapshot = self.staged.clone();
            for (position, (id, value)) in snapshot
                .range_shared((Bound::Included(source_prefix.as_str()), Bound::Unbounded))
                .enumerate()
            {
                if !id.starts_with(&source_prefix) {
                    break;
                }
                if position % 64 == 0 {
                    self.check_fatal()?;
                }
                if self.writes.contains_key(id) {
                    continue;
                }
                let (_, key) = source_pair(id)?;
                if let Some(id) = query
                    .entry(&spec, &key, value)
                    .filter(|id| query.includes(id))
                {
                    retain(&mut found, &mut bytes, id, key, value.clone());
                }
                if self.total_retained_bytes().saturating_add(bytes) > self.retained_limit {
                    return self.abort(
                        "EVALUATION_BUDGET",
                        "Range result exceeds Rust memory budget",
                    );
                }
            }
        }
        if !indexed {
            for _ in 0..query.offset.min(found.len()) {
                if query.reverse {
                    found.pop_last();
                } else {
                    found.pop_first();
                }
            }
        }
        let more = !query.scan && found.len() > query.limit;
        if more {
            if query.reverse {
                found.pop_first();
            } else {
                found.pop_last();
            }
        }
        let last = if query.reverse {
            found.first_key_value()
        } else {
            found.last_key_value()
        }
        .map(|(id, _)| id.clone());
        let cursor = if more {
            last.map(|last| canonical_json(&json!({"version":1,"scope":query.scope,"last":last})))
        } else {
            None
        };
        for (key, _) in found.values() {
            self.record_read(source_id(&query.collection, key));
        }
        let rows = if query.reverse {
            found.into_values().rev().collect()
        } else {
            found.into_values().collect()
        };
        let rows = self.rows_for_host(rows)?;
        if query.scan {
            return Ok(rows);
        }
        let page = json!({"rows":rows,"cursor":cursor});
        self.copy_for_host(&page)
    }
}
