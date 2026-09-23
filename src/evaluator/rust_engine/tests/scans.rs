use super::*;
use crate::evaluator::rust_engine::indexes::IndexSpec;

fn collection() -> Value {
    json!({"kind":"collection","name":"items","indexes":{"rank":["tenant","score"]}})
}

fn fixture() -> Fixture {
    Fixture::new([(
        "read",
        (|args, host| host("scan", json!([collection(), args]))) as Callback,
    )])
}

fn install(data: &mut Records, fixture: &Fixture) {
    let result = run_with_schema(
        data.clone(),
        json!({"requestId":"schema"}),
        "deployment",
        None,
        fixture,
        Some(Schema {
            indexes: vec![IndexSpec {
                collection: "items".into(),
                fields: vec!["tenant".into(), "score".into()],
            }],
            aggregates: BTreeMap::new(),
        }),
    )
    .unwrap();
    apply(data, result);
}

fn read(data: &Records, options: Value) -> Value {
    run(
        data.clone(),
        json!({"name":"read","args":options}),
        "query",
        None,
        &fixture(),
    )
    .unwrap()
    .value
}

fn keys(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["key"].as_str().unwrap())
        .collect()
}

#[test]
fn scans_filter_source_keys_before_reverse_offset_and_limit() {
    let data = Records::from([
        (source_id("items", "a"), Value::Null),
        (source_id("items", "b"), json!(false)),
        (source_id("items", "c"), json!([1, 2])),
        (source_id("items", "😀"), json!({"score":1})),
        (source_id("items", "\u{e000}"), json!(42)),
        (source_id("other", "b"), json!("excluded")),
    ]);
    assert_eq!(
        keys(&read(&data, json!({}))),
        ["a", "b", "c", "😀", "\u{e000}"]
    );
    assert_eq!(
        keys(&read(
            &data,
            json!({"gt":"a","lte":"😀","reverse":true,"offset":1,"limit":2})
        )),
        ["c", "b"]
    );
    assert_eq!(
        keys(&read(&data, json!({"gte":"😀","lt":"\u{e000}"}))),
        ["😀"]
    );
    assert_eq!(
        read(&data, json!({"prefix":["b"]})),
        json!([{"key":"b","value":false}])
    );
    assert!(keys(&read(&data, json!({"prefix":["missing"]}))).is_empty());
    assert!(keys(&read(&data, json!({"gt":"c","lt":"b"}))).is_empty());
    assert!(keys(&read(&data, json!({"limit":0}))).is_empty());
    assert!(keys(&read(&data, json!({"offset":5}))).is_empty());
    assert!(keys(&read(&data, json!({"offset":9_007_199_254_740_991_u64}))).is_empty());
    assert_eq!(
        read(&data, json!({"offset":0,"limit":9_007_199_254_740_991_u64})),
        read(&data, json!({}))
    );
}

#[test]
fn indexed_scans_order_scalars_and_utf16_ties_with_or_without_declared_indexes() {
    let mut data = Records::default();
    for (key, score) in [
        ("null", Value::Null),
        ("false", json!(false)),
        ("true", json!(true)),
        ("negative", json!(-100)),
        ("zero", json!(-0.0)),
        ("fraction", json!(0.125)),
        ("😀", json!(2)),
        ("\u{e000}", json!(2)),
        ("short", json!("a")),
        ("long", json!("aa")),
        ("object", json!({})),
        ("array", json!([])),
    ] {
        data.insert(source_id("items", key), json!({"tenant":"a","score":score}));
    }
    data.insert(source_id("items", "missing"), json!({"tenant":"a"}));
    data.insert(source_id("items", "primitive"), json!(12));
    data.insert(
        source_id("items", "other-tenant"),
        json!({"tenant":"b","score":1}),
    );
    let options = json!({"index":"rank","prefix":["a"]});
    let expected = [
        "null", "false", "true", "negative", "zero", "fraction", "😀", "\u{e000}", "short", "long",
    ];
    let fallback = read(&data, options.clone());
    assert_eq!(keys(&fallback), expected);
    install(&mut data, &fixture());
    assert_eq!(read(&data, options.clone()), fallback);
    let restored: Records = serde_json::from_slice(&serde_json::to_vec(&data).unwrap()).unwrap();
    assert_eq!(read(&restored, options), fallback);
    assert_eq!(
        keys(&read(
            &data,
            json!({"index":"rank","prefix":["a"],"gt":0,"lte":2,"reverse":true,"offset":1,"limit":1})
        )),
        ["😀"]
    );
}

#[test]
fn indexed_scans_apply_compound_prefixes_and_each_bound() {
    let mut data = Records::default();
    for n in 0..10 {
        data.insert(
            source_id("items", &format!("key{n}")),
            json!({"tenant":if n == 9 {"b"} else {"a"},"score":n/2}),
        );
    }
    for declared in [false, true] {
        if declared {
            install(&mut data, &fixture());
        }
        for (options, expected) in [
            (json!({"gt":1,"lt":3}), vec!["key4", "key5"]),
            (
                json!({"gte":1,"lte":3}),
                vec!["key2", "key3", "key4", "key5", "key6", "key7"],
            ),
            (json!({"gte":4,"lte":4}), vec!["key8"]),
            (json!({"gt":4,"lte":4}), vec![]),
            (json!({"gte":7,"lt":2}), vec![]),
        ] {
            let mut options = options;
            options["index"] = json!("rank");
            options["prefix"] = json!(["a"]);
            assert_eq!(keys(&read(&data, options)), expected, "declared={declared}");
        }
        assert_eq!(
            keys(&read(
                &data,
                json!({"index":"rank","prefix":["a",2],"reverse":true})
            )),
            ["key5", "key4"]
        );
        assert_eq!(
            keys(&read(&data, json!({"index":"rank","gte":"b"}))),
            ["key9"]
        );
        assert!(keys(&read(&data, json!({"index":"rank","limit":0}))).is_empty());
    }
}

#[test]
fn scans_reject_invalid_options_and_index_fields() {
    let fixture = Fixture::new([(
        "read",
        (|args, host| host("scan", args.clone())) as Callback,
    )]);
    for options in [
        Value::Null,
        json!([]),
        json!({"unknown":true}),
        json!({"index":"missing"}),
        json!({"index":""}),
        json!({"index":1}),
        json!({"index":null}),
        json!({"limit":-1}),
        json!({"limit":1.5}),
        json!({"limit":"1"}),
        json!({"limit":null}),
        json!({"limit":9_007_199_254_740_992_u64}),
        json!({"offset":-1}),
        json!({"offset":0.5}),
        json!({"offset":null}),
        json!({"offset":9_007_199_254_740_992_u64}),
        json!({"reverse":1}),
        json!({"prefix":"a"}),
        json!({"prefix":[1]}),
        json!({"prefix":["a","b"]}),
        json!({"prefix":["a"],"gte":"a"}),
        json!({"gte":1}),
        json!({"gt":"a","gte":"b"}),
        json!({"lt":"a","lte":"b"}),
        json!({"index":"rank","prefix":["a",1],"lt":2}),
        json!({"index":"rank","prefix":["a",1,2]}),
        json!({"index":"rank","prefix":[{}]}),
        json!({"index":"rank","gte":[]}),
    ] {
        let error = run(
            Records::default(),
            json!({"name":"read","args":[collection(),options]}),
            "query",
            None,
            &fixture,
        )
        .unwrap_err();
        assert_eq!(error.code, "INVALID_REFERENCE", "{options}");
    }
    for fields in [
        json!([]),
        json!("score"),
        json!([""]),
        json!([1]),
        json!(["score", "score"]),
    ] {
        let reference = json!({"kind":"collection","name":"items","indexes":{"rank":fields}});
        let error = run(
            Records::default(),
            json!({"name":"read","args":[reference,{"index":"rank"}]}),
            "query",
            None,
            &fixture,
        )
        .unwrap_err();
        assert_eq!(error.code, "INVALID_REFERENCE", "{fields}");
    }
}

#[test]
fn indexed_scans_overlay_inserts_deletes_and_moves_before_pagination() {
    let fixture = Fixture::new([(
        "work",
        (|_, host| {
            set(host, "items", "one", json!({"tenant":"a","score":5}))?;
            set(host, "items", "four", json!({"tenant":"a","score":1}))?;
            set(host, "items", "insert", json!({"tenant":"a","score":0}))?;
            host("delete", json!([collection(), "two"]))?;
            let all = host(
                "scan",
                json!([collection(),{"index":"rank","prefix":["a"]}]),
            )?;
            let page = host(
                "scan",
                json!([collection(),{"index":"rank","prefix":["a"],"reverse":true,"offset":1,"limit":2}]),
            )?;
            Ok(json!({"all":all,"page":page}))
        }) as Callback,
    )]);
    let mut data = Records::default();
    for (key, score) in [("one", 1), ("two", 2), ("three", 3), ("four", 4)] {
        data.insert(source_id("items", key), json!({"tenant":"a","score":score}));
    }
    let command = json!({"name":"work","requestId":"overlay"});
    let fallback = run(data.clone(), command.clone(), "mutation", None, &fixture).unwrap();
    install(&mut data, &fixture);
    let indexed = run(data.clone(), command, "mutation", None, &fixture).unwrap();
    assert_eq!(indexed.value, fallback.value);
    assert_eq!(
        keys(&indexed.value["all"]),
        ["insert", "four", "three", "one"]
    );
    assert_eq!(keys(&indexed.value["page"]), ["three", "four"]);
    apply(&mut data, indexed);
    assert_eq!(
        keys(&read(&data, json!({"index":"rank","prefix":["a"]}))),
        ["insert", "four", "three", "one"]
    );
}

#[test]
fn constrained_scans_invalidate_empty_results_and_paginated_derived_values() {
    let fixture = Fixture::new([
        (
            "read",
            (|args, host| host("scan", json!([collection(), args]))) as Callback,
        ),
        (
            "matches",
            (|_, host| {
                host(
                    "scan",
                    json!([collection(),{"index":"rank","prefix":["a"],"lte":5,"offset":1,"limit":1}]),
                )
            }) as Callback,
        ),
    ]);
    for declared in [false, true] {
        let mut data = Records::default();
        if declared {
            install(&mut data, &fixture);
        }
        deploy(
            &mut data,
            json!({"materialize":[{"name":"matches"}]}),
            &fixture,
        );
        let id = cell_id("matches", &Value::Null);
        assert!(keys(&data[&id]["outcome"]["value"]).is_empty());
        let result = run(
            data.clone(),
            json!({"name":"read","args":{"index":"rank","prefix":["a"],"lte":5,"offset":1,"limit":1}}),
            "query",
            None,
            &fixture,
        ).unwrap();
        let certificate = result.query_certificate.unwrap();
        let unrelated = deploy(
            &mut data,
            json!({"writes":[{"collection":"other","key":"x","value":1}]}),
            &fixture,
        );
        assert!(unrelated.evaluated.is_empty());
        assert!(certificate.valid(&data));
        let inserted = deploy(
            &mut data,
            json!({"writes":[
                {"collection":"items","key":"first","value":{"tenant":"a","score":1}},
                {"collection":"items","key":"second","value":{"tenant":"a","score":2,"label":"old"}}
            ]}),
            &fixture,
        );
        assert_eq!(inserted.evaluated, [id.clone()]);
        assert!(!certificate.valid(&data));
        assert_eq!(keys(&data[&id]["outcome"]["value"]), ["second"]);
        let updated = deploy(
            &mut data,
            json!({"writes":[{"collection":"items","key":"second","value":{"tenant":"a","score":2,"label":"new"}}]}),
            &fixture,
        );
        assert_eq!(updated.evaluated, [id.clone()]);
        assert_eq!(data[&id]["outcome"]["value"][0]["value"]["label"], "new");
        deploy(
            &mut data,
            json!({"writes":[{"collection":"items","key":"earlier","value":{"tenant":"a","score":0}}]}),
            &fixture,
        );
        assert_eq!(keys(&data[&id]["outcome"]["value"]), ["first"]);
        deploy(
            &mut data,
            json!({"writes":[{"collection":"items","key":"first","delete":true}]}),
            &fixture,
        );
        assert_eq!(keys(&data[&id]["outcome"]["value"]), ["second"]);
    }
}

#[test]
fn limited_scans_bound_retained_results_and_cannot_hide_budget_failures() {
    let mut data = Records::default();
    for n in 0..200 {
        data.insert(
            source_id("items", &format!("key{n:04}")),
            json!({"tenant":"a","score":n,"payload":"x".repeat(512)}),
        );
    }
    for declared in [false, true] {
        if declared {
            install(&mut data, &fixture());
        }
        let result = run_with_limit(
            data.clone(),
            json!({"name":"read","args":{"index":"rank","prefix":["a"],"offset":3,"limit":1}}),
            "query",
            None,
            &fixture(),
            8192,
        )
        .unwrap();
        assert_eq!(keys(&result.value), ["key0003"]);
        let catching = Fixture::new([(
            "catch",
            (|args, host| {
                let _ = host("scan", json!([collection(), args]));
                Ok(Value::Null)
            }) as Callback,
        )]);
        let error = run_with_limit(
            data.clone(),
            json!({"name":"catch","args":{"index":"rank","prefix":["a"],"limit":200}}),
            "query",
            None,
            &catching,
            8192,
        )
        .unwrap_err();
        assert_eq!(error.code, "EVALUATION_BUDGET");
    }
}

#[test]
fn declared_scan_offsets_do_not_retain_skipped_rows_with_pending_writes() {
    let fixture = Fixture::new([(
        "work",
        (|args, host| {
            set(
                host,
                "items",
                "key0000",
                json!({"tenant":"a","score":170.5,"payload":"m".repeat(512)}),
            )?;
            set(
                host,
                "items",
                "key0200",
                json!({"tenant":"a","score":50.5,"payload":"i".repeat(512)}),
            )?;
            host("delete", json!([collection(), "key0100"]))?;
            host(
                "scan",
                json!([collection(),{"index":"rank","prefix":["a"],"offset":150,"limit":2,"reverse":args["reverse"]}]),
            )
        }) as Callback,
    )]);
    let mut data = Records::default();
    for n in 0..200 {
        data.insert(
            source_id("items", &format!("key{n:04}")),
            json!({"tenant":"a","score":n,"payload":"x".repeat(512)}),
        );
    }
    install(&mut data, &fixture);
    for (reverse, expected) in [
        (false, ["key0151", "key0152"]),
        (true, ["key0050", "key0049"]),
    ] {
        let result = run_with_limit(
            data.clone(),
            json!({"name":"work","requestId":"skip","args":{"reverse":reverse}}),
            "mutation",
            None,
            &fixture,
            16 * 1024,
        )
        .unwrap();
        assert_eq!(keys(&result.value), expected);
    }
}
