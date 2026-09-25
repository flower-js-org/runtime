use super::*;
use crate::evaluator::DependencyCertificate;

fn query(
    data: &Records,
    name: &str,
    args: Value,
    fixture: &Fixture,
) -> (Value, DependencyCertificate) {
    let result = run(
        data.clone(),
        json!({"name":name,"args":args}),
        "query",
        None,
        fixture,
    )
    .unwrap();
    assert!(result.query_cacheable);
    (result.value, result.query_certificate.unwrap())
}
fn fixture() -> Fixture {
    Fixture::new([
        (
            "point",
            (|args, host| get(host, "collection", "items", args.clone())) as Callback,
        ),
        (
            "scan",
            (|_, host| host("scan", json!([{"kind":"collection","name":"items"}]))) as Callback,
        ),
        (
            "indexed",
            (|args, host| {
                host(
                    "query",
                    json!([{"kind":"query","collection":"items","fields":["group"],"value":args}]),
                )
            }) as Callback,
        ),
        (
            "range",
            (|_, host| {
                host(
                    "range",
                    json!([{"kind":"range","collection":"items","fields":["group"],"options":{"prefix":["a"],"limit":1}}]),
                )
            }) as Callback,
        ),
        (
            "leaf",
            (|_, host| get(host, "collection", "items", json!("first"))) as Callback,
        ),
        (
            "derived",
            (|_, host| get(host, "derived", "leaf", Value::Null)) as Callback,
        ),
        ("clock", (|_, host| host("now", json!([]))) as Callback),
    ])
}
#[test]
fn certificates_cover_points_absence_code_and_schema_without_retaining_payloads() {
    let fixture = fixture();
    let mut data = Records::from([(source_id("items", "first"), json!(42))]);
    let (_, point) = query(&data, "point", json!("first"), &fixture);
    let (_, missing) = query(&data, "point", json!("missing"), &fixture);
    let original = data.clone();
    data.insert(source_id("unrelated", "x"), json!(1));
    assert!(point.valid(&data));
    assert!(missing.valid(&data));
    data.insert(source_id("items", "missing"), json!(7));
    assert!(point.valid(&data));
    assert!(!missing.valid(&data));
    data.insert(source_id("items", "first"), json!(43));
    assert!(!point.valid(&data));
    assert!(point.valid(&original));
    for field in [
        "bundle",
        "schema",
        "keyDeclarations",
        "managedKeys",
        "authorizationMethod",
    ] {
        let mut changed = original.clone();
        changed.insert(field.into(), json!({}));
        assert!(!point.valid(&changed), "{field}");
    }
    let mut removed = original.clone();
    removed.remove(&source_id("items", "first"));
    assert!(!point.valid(&removed));
    let record = original.get_shared(&source_id("items", "first")).unwrap();
    assert_eq!(
        Arc::strong_count(record),
        1,
        "certificate must retain only Weak<Value>"
    );
}

#[test]
fn warm_queries_skip_build_progress_but_follow_physical_graph_pointer_cutover_and_source() {
    let mut fixture = fixture();
    fixture.callbacks.insert("write", |args, host| {
        set(host, "items", "first", args.clone())
    });
    let mut data = Records::from([(source_id("items", "first"), json!(7))]);
    deploy(
        &mut data,
        json!({"materialize":[{"name":"leaf"}]}),
        &fixture,
    );
    let (_, point) = query(&data, "point", json!("first"), &fixture);
    let (_, derived) = query(&data, "derived", Value::Null, &fixture);
    let mutation = optimistic(&data, "point", json!("first"), &fixture)
        .mutation_certificate
        .unwrap();
    let original = data.clone();
    let generation = "a".repeat(64);
    for phase in [
        "backfill",
        "rebuilding",
        "ready",
        "failed",
        "canceled",
        "collected",
    ] {
        data.insert(
            crate::evaluator::staging::JOB.into(),
            json!({
                "generation":generation,"phase":phase,"graphCursor":"root:[\"leaf\",null]",
                "rebuiltRoots":1,"scannedRows":12
            }),
        );
        data.insert(
            crate::evaluator::staging::INDEXES.into(),
            json!({
                "indexes":[{"collection":"items","fields":["future"]}],"aggregates":{}
            }),
        );
        // Backfilled cells and root pages belong to an unpublished graph.
        for (key, value) in original
            .iter()
            .filter(|(key, _)| key.starts_with("root:") || key.starts_with("cell:"))
        {
            data.insert(format!("graph:{generation}:{key}"), value.clone());
        }
        assert!(point.valid(&data), "point query invalidated by {phase}");
        assert!(
            derived.valid(&data),
            "materialized query invalidated by {phase}"
        );
        assert!(
            !mutation.valid(&data),
            "mutation must observe deployment lifecycle"
        );
    }
    for field in [
        crate::evaluator::staging::JOB,
        crate::evaluator::staging::INDEXES,
    ] {
        let mut changed = original.clone();
        changed.insert(field.into(), json!({}));
        assert!(!mutation.valid(&changed), "mutation must track {field}");
    }
    let mut cutover = data.clone();
    cutover.insert("reactive:active".into(), json!(generation));
    assert!(!point.valid(&cutover));
    assert!(!derived.valid(&cutover));
    let write = run(
        data.clone(),
        json!({"name":"write","args":8}),
        "mutation",
        None,
        &fixture,
    )
    .unwrap();
    apply(&mut data, write);
    assert!(!point.valid(&data));
    assert!(!derived.valid(&data));
}
#[test]
fn certificates_track_collection_and_index_phantoms_but_skip_unrelated_buckets() {
    let fixture = fixture();
    let mut data = Records::new();
    let schema = Schema {
        indexes: vec![indexes::IndexSpec {
            collection: "items".into(),
            fields: vec!["group".into()],
        }],
        aggregates: BTreeMap::new(),
    };
    let result = run_with_schema(
        data.clone(),
        json!({"requestId":"schema"}),
        "deployment",
        None,
        &fixture,
        Some(schema),
    )
    .unwrap();
    apply(&mut data, result);
    let (_, scan) = query(&data, "scan", Value::Null, &fixture);
    let (_, empty) = query(&data, "indexed", json!("a"), &fixture);
    let (_, range) = query(&data, "range", Value::Null, &fixture);
    deploy(
        &mut data,
        json!({"writes":[{"collection":"items","key":"other","value":{"group":"b"}}]}),
        &fixture,
    );
    assert!(!scan.valid(&data));
    assert!(empty.valid(&data));
    // The empty page depends on its whole prefix, and only on it.
    assert!(range.valid(&data));
    deploy(
        &mut data,
        json!({"writes":[{"collection":"items","key":"first","value":{"group":"a","value":1}}]}),
        &fixture,
    );
    assert!(!empty.valid(&data));
    assert!(!range.valid(&data));
    let (_, present) = query(&data, "indexed", json!("a"), &fixture);
    let (_, range) = query(&data, "range", Value::Null, &fixture);
    deploy(
        &mut data,
        json!({"writes":[{"collection":"items","key":"other","value":{"group":"b","value":2}}]}),
        &fixture,
    );
    assert!(present.valid(&data));
    assert!(range.valid(&data));
    deploy(
        &mut data,
        json!({"writes":[{"collection":"items","key":"first","value":{"group":"a","value":2}}]}),
        &fixture,
    );
    assert!(!present.valid(&data));
    assert!(!range.valid(&data));
    let (_, present) = query(&data, "indexed", json!("a"), &fixture);
    deploy(
        &mut data,
        json!({"writes":[{"collection":"items","key":"first","delete":true}]}),
        &fixture,
    );
    assert!(!present.valid(&data));
    assert!(
        data.reactive()
            .generation(&indexes::bucket_id("items", &["group".into()], &json!("a")))
            .is_none(),
        "empty buckets retain no generation tombstone"
    );
}
#[test]
fn certificates_flatten_ephemeral_derives_and_guard_materialized_outcomes() {
    let fixture = fixture();
    let mut data = Records::from([(source_id("items", "first"), json!(7))]);
    let (_, ephemeral) = query(&data, "derived", Value::Null, &fixture);
    data.insert(source_id("items", "second"), json!(5));
    assert!(ephemeral.valid(&data));
    data.insert(source_id("items", "first"), json!(8));
    assert!(!ephemeral.valid(&data));
    deploy(
        &mut data,
        json!({"materialize":[{"name":"leaf"}]}),
        &fixture,
    );
    let (_, materialized) = query(&data, "derived", Value::Null, &fixture);
    deploy(
        &mut data,
        json!({"writes":[{"collection":"items","key":"second","value":6}]}),
        &fixture,
    );
    assert!(materialized.valid(&data));
    deploy(
        &mut data,
        json!({"writes":[{"collection":"items","key":"first","value":9}]}),
        &fixture,
    );
    assert!(!materialized.valid(&data));
    let clock = run(data, json!({"name":"clock"}), "query", None, &fixture).unwrap();
    assert!(!clock.query_cacheable);
    assert!(clock.query_certificate.is_none());
}
#[test]
fn markers_handle_delimiters_and_quoted_unicode_without_cross_bucket_collisions() {
    let collection = "colon:quote\"🌺";
    let fields = vec!["x:[]".into()];
    let spec = indexes::IndexSpec {
        collection: collection.into(),
        fields: fields.clone(),
    };
    let prefix = format!(
        "index-entry:{}:",
        canonical_json(&json!([collection, fields]))
    );
    let mut data = Records::new();
    for value in [
        json!(null),
        json!(false),
        json!(12),
        json!(":quote\""),
        json!([":",{"a:":1}]),
    ] {
        let id = format!("{prefix}{}:\"row\"", canonical_json(&value));
        let marker = indexes::bucket_id(collection, &fields, &value);
        data.insert(id.clone(), json!("row"));
        assert!(data.reactive().generation(&marker).is_some(), "{id}");
        data.remove(&id);
        assert!(data.reactive().generation(&marker).is_none());
    }
    let ordered = super::super::ranges::entry(&spec, "row", &json!({"x:[]":1})).unwrap();
    data.insert(ordered.clone(), json!("row"));
    assert!(data
        .reactive()
        .generation(&super::super::ranges::dependency(collection, &fields))
        .is_some());
    data.insert(source_id(collection, "row"), json!(1));
    assert!(data
        .reactive()
        .generation(&collection_id(collection))
        .is_some());
}

fn optimistic(data: &Records, name: &str, args: Value, fixture: &Fixture) -> Evaluation {
    run(
        data.clone(),
        json!({"name":name,"args":args,"$speculate":true}),
        "mutation",
        Some(2000),
        fixture,
    )
    .unwrap()
}
#[test]
fn mutation_certificates_cover_write_conflicts_negative_reads_phantoms_and_time() {
    let fixture = Fixture::new([
        (
            "blind",
            (|args, host| {
                set(
                    host,
                    "items",
                    args["key"].as_str().unwrap(),
                    args["value"].clone(),
                )
            }) as Callback,
        ),
        (
            "negative",
            (|_, host| {
                let value = get(host, "collection", "items", json!("missing"))?;
                set(host, "out", "value", value)
            }) as Callback,
        ),
        (
            "scan",
            (|_, host| {
                let rows = host("scan", json!([{"kind":"collection","name":"items"}]))?;
                set(host, "out", "value", rows)
            }) as Callback,
        ),
        (
            "range",
            (|_, host| {
                let page = host(
                    "range",
                    json!([{"kind":"range","collection":"items","fields":["score"],"options":{"gte":0,"limit":1}}]),
                )?;
                set(host, "out", "value", page)
            }) as Callback,
        ),
    ]);
    let base = Records::from([
        ("clock".into(), json!(1000)),
        (source_id("items", "a"), json!(1)),
    ]);
    let write = optimistic(&base, "blind", json!({"key":"a","value":2}), &fixture);
    let certificate = write.mutation_certificate.unwrap();
    let mut next = base.clone();
    next.insert(source_id("items", "b"), json!(7));
    next.insert("clock".into(), json!(2000));
    assert!(certificate.valid(&next));
    next.insert(source_id("items", "a"), json!(9));
    assert!(!certificate.valid(&next));
    let missing = optimistic(&base, "negative", Value::Null, &fixture)
        .mutation_certificate
        .unwrap();
    let scan = optimistic(&base, "scan", Value::Null, &fixture)
        .mutation_certificate
        .unwrap();
    let range = optimistic(&base, "range", Value::Null, &fixture)
        .mutation_certificate
        .unwrap();
    let mut next = base.clone();
    next.insert(source_id("items", "missing"), json!({"score":1}));
    assert!(!missing.valid(&next));
    assert!(!scan.valid(&next));
    assert!(!range.valid(&next));
    for field in [
        "bundle",
        "schema",
        "managedKeys",
        "keyDeclarations",
        "authorizationMethod",
    ] {
        let mut next = base.clone();
        next.insert(field.into(), Value::Null);
        assert!(!certificate.valid(&next), "{field}");
    }
    let mut next = base.clone();
    next.insert("clock".into(), json!(2001));
    assert!(!certificate.valid(&next));
}

#[test]
fn optimistic_mutations_match_serial_across_independent_hot_and_dynamic_graphs() {
    let fixture = Fixture::new([
        (
            "update",
            (|args, host| {
                let key = args["key"].as_str().unwrap();
                let old = get(host, "collection", "items", json!(key))?
                    .as_i64()
                    .unwrap_or(0);
                set(host, "items", key, json!(old + 1))?;
                Ok(json!(old + 1))
            }) as Callback,
        ),
        (
            "leaf",
            (|args, host| get(host, "collection", "items", args.clone())) as Callback,
        ),
        (
            "branch",
            (|_, host| {
                let key = get(host, "collection", "control", json!("key"))?;
                get(host, "collection", "items", key)
            }) as Callback,
        ),
    ]);
    let mut initial = Records::new();
    deploy(
        &mut initial,
        json!({"writes":[{"collection":"control","key":"key","value":"a"},{"collection":"items","key":"a","value":0},{"collection":"items","key":"b","value":0}],"materialize":[{"name":"leaf","args":"a"},{"name":"leaf","args":"b"},{"name":"branch"}]}),
        &fixture,
    );
    let candidate = optimistic(&initial, "update", json!({"key":"a"}), &fixture);
    let mut branch = initial.clone();
    deploy(
        &mut branch,
        json!({"writes":[{"collection":"control","key":"key","value":"b"}]}),
        &fixture,
    );
    assert!(
        !candidate
            .mutation_certificate
            .as_ref()
            .unwrap()
            .valid(&branch),
        "source-only edge changes must invalidate the graph shape"
    );
    let mut actual = initial.clone();
    let mut serial = initial;
    let mut accepted = 0;
    let mut conflicts = 0;
    let mut random = 0x12345678u64;
    for _ in 0..24 {
        let mut wave = Vec::new();
        for _ in 0..5 {
            random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
            let key = if random.is_multiple_of(4) {
                "a"
            } else if random % 4 == 1 {
                "b"
            } else {
                "c"
            };
            let args = json!({"key":key});
            wave.push((args.clone(), optimistic(&actual, "update", args, &fixture)));
        }
        for (args, candidate) in wave {
            let expected = run(
                serial.clone(),
                json!({"name":"update","args":args}),
                "mutation",
                Some(2000),
                &fixture,
            )
            .unwrap();
            let mut selected = if candidate
                .mutation_certificate
                .as_ref()
                .unwrap()
                .valid(&actual)
            {
                accepted += 1;
                candidate
            } else {
                conflicts += 1;
                optimistic(&actual, "update", args, &fixture)
            };
            // The ordered writer omits a redundant fixed wave-clock put.
            if selected
                .puts
                .get("clock")
                .is_some_and(|clock| actual.get("clock") == Some(clock))
            {
                selected.puts.remove("clock");
            }
            assert_eq!(selected.value, expected.value);
            assert_eq!(selected.puts, expected.puts);
            assert_eq!(selected.deletes, expected.deletes);
            apply(&mut actual, selected);
            apply(&mut serial, expected);
            assert_eq!(actual, serial);
        }
    }
    assert!(
        accepted > 24 && conflicts > 0,
        "must exercise both disjoint reuse and hot conflicts"
    );
}
