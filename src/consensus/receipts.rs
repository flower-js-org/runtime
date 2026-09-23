//! Persistent retry history. Writer snapshots retain one immutable tree root,
//! and each new receipt shares the prior history without copying its results.

use std::collections::BTreeMap;
use std::ops::Index;
use std::sync::Arc;

use im::OrdMap;
use serde::de::{MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::Receipt;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Receipts(OrdMap<String, Arc<Receipt>>);

impl Receipts {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn ptr_eq(&self, other: &Self) -> bool {
        self.0.ptr_eq(&other.0)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.0.contains_key(key)
    }

    pub fn get(&self, key: &str) -> Option<&Receipt> {
        self.get_shared(key).map(Arc::as_ref)
    }

    pub fn get_shared(&self, key: &str) -> Option<&Arc<Receipt>> {
        self.0.get(key)
    }

    pub fn get_key_value(&self, key: &str) -> Option<(&String, &Receipt)> {
        self.0
            .get_key_value(key)
            .map(|(key, value)| (key, value.as_ref()))
    }

    pub fn insert(&mut self, key: String, receipt: Receipt) -> Option<Arc<Receipt>> {
        self.insert_shared(key, Arc::new(receipt))
    }

    pub fn insert_shared(&mut self, key: String, receipt: Arc<Receipt>) -> Option<Arc<Receipt>> {
        self.0.insert(key, receipt)
    }

    pub fn remove(&mut self, key: &str) -> Option<Arc<Receipt>> {
        self.0.remove(key)
    }

    /// Start strictly after an incremental collection cursor without rescanning
    /// the retained prefix. Old immutable roots continue to own removed values.
    pub fn after(&self, cursor: Option<&str>) -> Iter<'_> {
        use std::ops::Bound;
        Iter(self.0.range::<_, str>((
            cursor.map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
        )))
    }

    pub fn iter(&self) -> Iter<'_> {
        Iter(self.0.iter())
    }
}

pub struct Iter<'a>(im::ordmap::Iter<'a, String, Arc<Receipt>>);

impl<'a> Iterator for Iter<'a> {
    type Item = (&'a String, &'a Receipt);

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

impl Index<&str> for Receipts {
    type Output = Receipt;

    fn index(&self, key: &str) -> &Self::Output {
        self.get(key).expect("missing request receipt")
    }
}

impl Index<&String> for Receipts {
    type Output = Receipt;

    fn index(&self, key: &String) -> &Self::Output {
        &self[key.as_str()]
    }
}

impl Extend<(String, Receipt)> for Receipts {
    fn extend<T: IntoIterator<Item = (String, Receipt)>>(&mut self, iter: T) {
        for (key, value) in iter {
            self.insert(key, value);
        }
    }
}

impl FromIterator<(String, Receipt)> for Receipts {
    fn from_iter<T: IntoIterator<Item = (String, Receipt)>>(iter: T) -> Self {
        let mut result = Self::new();
        result.extend(iter);
        result
    }
}

impl FromIterator<(String, Arc<Receipt>)> for Receipts {
    fn from_iter<T: IntoIterator<Item = (String, Arc<Receipt>)>>(iter: T) -> Self {
        Self(iter.into_iter().collect())
    }
}

impl From<BTreeMap<String, Receipt>> for Receipts {
    fn from(receipts: BTreeMap<String, Receipt>) -> Self {
        receipts.into_iter().collect()
    }
}

impl<const N: usize> From<[(String, Receipt); N]> for Receipts {
    fn from(receipts: [(String, Receipt); N]) -> Self {
        receipts.into_iter().collect()
    }
}

impl<'a> IntoIterator for &'a Receipts {
    type Item = (&'a String, &'a Receipt);
    type IntoIter = Iter<'a>;

    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}

impl Serialize for Receipts {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.len()))?;
        for (key, receipt) in self {
            map.serialize_entry(key, receipt)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for Receipts {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ReceiptsVisitor;

        impl<'de> Visitor<'de> for ReceiptsVisitor {
            type Value = Receipts;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("an object of request receipts")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut receipts = Receipts::new();
                while let Some((key, receipt)) = map.next_entry::<String, Receipt>()? {
                    receipts.insert(key, receipt);
                }
                Ok(receipts)
            }
        }

        deserializer.deserialize_map(ReceiptsVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn receipt(revision: u64) -> Receipt {
        Receipt {
            fingerprint: format!("fingerprint-{revision}"),
            revision,
            result: json!({"revision": revision, "large": "x".repeat(1024)}),
        }
    }

    #[test]
    fn writer_snapshots_share_history_and_keep_speculative_receipts_private() {
        let durable: Receipts = (0..1024)
            .map(|revision| (format!("request-{revision:04}"), receipt(revision)))
            .collect();
        let mut staged = durable.clone();
        assert!(durable.ptr_eq(&staged));
        staged.insert("successor".into(), receipt(1024));
        staged.insert("request-0000".into(), receipt(1025));
        assert!(!durable.ptr_eq(&staged));
        assert!(!durable.contains_key("successor"));
        assert_eq!(durable["request-0000"].revision, 0);
        assert_eq!(staged["request-0000"].revision, 1025);
        for revision in [1, 31, 512, 1023] {
            let key = format!("request-{revision:04}");
            assert!(Arc::ptr_eq(
                durable.get_shared(&key).unwrap(),
                staged.get_shared(&key).unwrap()
            ));
        }
    }

    #[test]
    fn ordered_receipts_preserve_old_snapshot_wire_format_and_result_defaults() {
        let old = BTreeMap::from([
            ("z".into(), receipt(1)),
            ("a".into(), receipt(2)),
            ("東京/🌸".into(), receipt(3)),
        ]);
        let receipts = Receipts::from(old.clone());
        let bytes = serde_json::to_vec(&receipts).unwrap();
        assert_eq!(bytes, serde_json::to_vec(&old).unwrap());
        assert_eq!(
            serde_json::from_slice::<Receipts>(&bytes).unwrap(),
            receipts
        );
        assert_eq!(
            serde_json::from_slice::<BTreeMap<String, Receipt>>(&bytes).unwrap(),
            old
        );
        let missing_result: Receipts =
            serde_json::from_str(r#"{"old":{"fingerprint":"original","revision":1}}"#).unwrap();
        assert!(missing_result["old"].result.is_null());
    }
}
