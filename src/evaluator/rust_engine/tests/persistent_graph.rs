use super::*;

fn fixture() -> Fixture {
    Fixture::new([
        (
            "leaf",
            (|args, host| {
                let tenant = args.as_str().unwrap();
                let branch = get(host, "collection", "branch", args.clone())? == true;
                if get(host, "collection", "fail", args.clone())? == true {
                    return Err(EngineError::new("EXPECTED", "tenant unavailable"));
                }
                get(
                    host,
                    "collection",
                    if branch { "alternate" } else { "input" },
                    json!(tenant),
                )
            }) as Callback,
        ),
        (
            "top",
            (|args, host| get(host, "derived", "leaf", args.clone())) as Callback,
        ),
        (
            "scratch",
            (|args, host| get(host, "derived", "top", args.clone())) as Callback,
        ),
        (
            "write",
            (|args, host| {
                let tenant = args["tenant"].as_str().unwrap();
                set(host, "input", tenant, args["value"].clone())?;
                Ok(Value::Null)
            }) as Callback,
        ),
        (
            "mixed",
            (|args, host| {
                let tenant = args["tenant"].as_str().unwrap();
                match args["op"].as_u64().unwrap() {
                    0 => {
                        set(host, "input", tenant, args["value"].clone())?;
                    }
                    1 => {
                        set(host, "alternate", tenant, args["value"].clone())?;
                    }
                    2 => {
                        set(
                            host,
                            "branch",
                            tenant,
                            args["value"].as_u64().unwrap().is_multiple_of(2).into(),
                        )?;
                    }
                    3 => {
                        set(
                            host,
                            "fail",
                            tenant,
                            args["value"].as_u64().unwrap().is_multiple_of(2).into(),
                        )?;
                    }
                    4 | 5 => {
                        host(
                            if args["op"] == 4 {
                                "materialize"
                            } else {
                                "unmaterialize"
                            },
                            json!([{"kind":"derived","name":"top"}, tenant]),
                        )?;
                    }
                    6 => {
                        let first = get(host, "derived", "scratch", json!(tenant))
                            .unwrap_or_else(|error| json!(error.code));
                        set(host, "input", tenant, args["value"].clone())?;
                        return Ok(json!([
                            first,
                            get(host, "derived", "top", json!(tenant))
                                .unwrap_or_else(|error| json!(error.code))
                        ]));
                    }
                    _ => {
                        host(
                            "delete",
                            json!([{"kind":"collection","name":"input"}, tenant]),
                        )?;
                    }
                }
                Ok(get(host, "derived", "top", json!(tenant))
                    .unwrap_or_else(|error| json!(error.code)))
            }) as Callback,
        ),
        ("noop", (|_, _| Ok(Value::Null)) as Callback),
    ])
}

fn tenants(fixture: &Fixture, count: usize) -> Records {
    let mut data = Records::new();
    deploy(
        &mut data,
        json!({
            "materialize": (0..count).map(|id| json!({"name":"top","args":id.to_string()})).collect::<Vec<_>>(),
            "writes": (0..count).map(|id| json!({"collection":"input","key":id.to_string(),"value":id})).collect::<Vec<_>>()
        }),
        fixture,
    );
    data
}

fn write(data: &mut Records, fixture: &Fixture, tenant: &str, value: u64) -> Evaluation {
    let result = run(
        data.clone(),
        json!({"name":"write","args":{"tenant":tenant,"value":value}}),
        "mutation",
        None,
        fixture,
    )
    .unwrap();
    for (id, value) in &result.puts {
        data.insert(id.clone(), value.clone());
    }
    for id in &result.deletes {
        data.remove(id);
    }
    result
}

fn comparable(result: &Evaluation) -> Value {
    json!({"puts":result.puts,"deletes":result.deletes,"evaluated":result.evaluated,
        "value":result.value,"query_cacheable":result.query_cacheable})
}

#[test]
fn quiet_tenants_share_topology_and_skip_global_traversal() {
    let fixture = fixture();
    let mut data = tenants(&fixture, 256);
    // Patches and disk input rebuild derived metadata, so validate the freshly
    // installed topology once before checking its steady-state path.
    write(&mut data, &fixture, "0", 1000);
    assert!(data.reactive().validated());
    let prior = data.clone();
    let proof = data.reactive().topology.clone();
    graph::take_graph_passes();
    let result = write(&mut data, &fixture, "1", 1001);
    assert_eq!(graph::take_graph_passes(), (1, 0));
    assert_eq!(
        result.evaluated,
        [cell_id("leaf", &json!("1")), cell_id("top", &json!("1"))]
    );
    assert!(Arc::ptr_eq(&proof, &data.reactive().topology));
    assert!(Arc::ptr_eq(
        &prior.reactive().cells[&cell_id("top", &json!("200"))],
        &data.reactive().cells[&cell_id("top", &json!("200"))]
    ));
    assert_eq!(prior[&source_id("input", "1")], 1);
    assert_eq!(data[&source_id("input", "1")], 1001);
}

#[test]
fn randomized_previews_match_forced_full_traversal() {
    let fixture = fixture();
    let mut fast = tenants(&fixture, 12);
    let mut full = fast.clone();
    let mut state = 0xdad1_5115_u64;
    for step in 0..256 {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
        let invocation = json!({"name":"mixed","args":{
            "tenant":((state >> 24) % 12).to_string(), "op":(state >> 8) % 8, "value":step
        }});
        let actual = run(
            fast.clone(),
            invocation.clone(),
            "mutation",
            Some(step + 1),
            &fixture,
        );
        let expected = graph::with_full_graph(|| {
            run(
                full.clone(),
                invocation,
                "mutation",
                Some(step + 1),
                &fixture,
            )
        });
        match (actual, expected) {
            (Ok(actual), Ok(expected)) => {
                assert_eq!(comparable(&actual), comparable(&expected), "step {step}");
                apply(&mut fast, actual);
                apply(&mut full, expected);
            }
            (Err(actual), Err(expected)) => assert_eq!(actual, expected, "step {step}"),
            (actual, expected) => panic!("step {step}: fast {actual:?}, full {expected:?}"),
        }
        assert_eq!(fast, full, "step {step}");
        if step % 31 == 0 {
            fast = serde_json::from_str(&serde_json::to_string(&fast).unwrap()).unwrap();
            assert!(!fast.reactive().validated());
        }
    }
}

#[test]
fn terminal_preview_errors_match_rollback_path_at_memory_boundaries() {
    let fixture = fixture();
    let base = tenants(&fixture, 8);
    let retained = base.clone();
    let mut successes = 0;
    let mut failures = 0;
    for budget in [
        1,
        base.reactive().bytes / 2,
        base.reactive().bytes,
        32_768,
        131_072,
    ] {
        let invocation = json!({"name":"write","args":{"tenant":"0","value":"large".repeat(1024)}});
        let actual = run_with_limit(
            base.clone(),
            invocation.clone(),
            "mutation",
            Some(20),
            &fixture,
            budget,
        );
        let expected = graph::with_full_graph(|| {
            run_with_limit(
                base.clone(),
                invocation,
                "mutation",
                Some(20),
                &fixture,
                budget,
            )
        });
        match (actual, expected) {
            (Ok(actual), Ok(expected)) => {
                successes += 1;
                assert_eq!(comparable(&actual), comparable(&expected));
            }
            (Err(actual), Err(expected)) => {
                failures += 1;
                assert_eq!(actual, expected);
            }
            (actual, expected) => {
                panic!("budget {budget}: final {actual:?}, rollback {expected:?}")
            }
        }
        assert_eq!(
            base, retained,
            "failed final previews never publish the private overlay"
        );
    }
    assert!(successes > 0 && failures > 0);
}

#[test]
fn restart_revalidates_then_reuses_topology_and_accounts_its_budget() {
    let fixture = fixture();
    let mut original = tenants(&fixture, 16);
    write(&mut original, &fixture, "0", 1000);
    let mut recovered: Records =
        serde_json::from_str(&serde_json::to_string(&original).unwrap()).unwrap();
    assert_eq!(original, recovered);
    assert!(!recovered.reactive().validated());
    graph::take_graph_passes();
    graph::take_graph_visits();
    write(&mut recovered, &fixture, "0", 1001);
    assert_eq!(graph::take_graph_passes(), (1, 0));
    assert_eq!(graph::take_graph_visits(), (32, 0));
    write(&mut recovered, &fixture, "0", 1002);
    assert_eq!(graph::take_graph_passes(), (1, 0));
    assert_eq!(graph::take_graph_visits(), (0, 0));
    let error = run_with_limit(
        recovered.clone(),
        json!({"name":"noop"}),
        "mutation",
        Some(1000),
        &fixture,
        recovered.reactive().bytes - 1,
    )
    .unwrap_err();
    assert_eq!(error.code, "EVALUATION_BUDGET");
    assert!(error.message.contains("Graph index"));
}

const GENERATION: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn graph_page(data: &Records, mut command: Value, fixture: &Fixture) -> EngineResult<Evaluation> {
    command["requestId"] = json!("page");
    run(
        data.graph_view(Some(GENERATION)),
        command,
        "graph",
        None,
        fixture,
    )
}

#[test]
fn committed_append_pages_visit_only_new_nodes_with_single_and_multiple_roots() {
    let fixture = fixture();
    for count in [64, 128] {
        for page_size in [1, 8] {
            let mut data = Records::new();
            graph::take_graph_visits();
            for start in (0..count).step_by(page_size) {
                let roots: Vec<_> = (start..start + page_size)
                    .map(|id| json!({"name":"top","args":id.to_string()}))
                    .collect();
                let result = graph_page(&data, json!({"materialize":roots}), &fixture).unwrap();
                assert_eq!(result.evaluated.len(), 2 * page_size);
                assert!(result.puts.keys().all(|id| id.starts_with("graph:")));
                // This is the real commit boundary: publish only physical JSON
                // records, not the evaluator's private metadata or proof.
                apply(&mut data, result);
            }
            graph_page(&data, json!({}), &fixture).unwrap();
            let (append, full) = graph::take_graph_visits();
            assert_eq!(full, 0, "{count} roots, {page_size} roots per page");
            assert_eq!(
                append,
                4 * count,
                "each cell is certified at evaluation and commit"
            );
            assert!(data.graph_view(Some(GENERATION)).reactive().validated());
            assert!(
                data.reactive().cells.is_empty(),
                "the legacy graph stays isolated"
            );
        }
    }
}

#[test]
fn committed_shared_append_pages_and_removals_match_full_validation_after_restart() {
    let fixture = fixture();
    let mut fast = Records::new();
    let mut full = Records::new();
    for step in 0..72 {
        let tenant = (step % 12).to_string();
        let command = match step / 12 {
            0 => json!({"materialize":[{"name":"top","args":tenant}]}),
            1 => json!({"materialize":[{"name":"scratch","args":tenant}]}),
            2 => json!({"unmaterialize":[{"name":"top","args":tenant}]}),
            3 => json!({"writes":[{"collection":"input","key":tenant,"value":step}]}),
            4 => json!({"unmaterialize":[{"name":"scratch","args":tenant}]}),
            _ => {
                json!({"materialize":[{"name":"scratch","args":tenant},{"name":"top","args":tenant}]})
            }
        };
        let actual = graph_page(&fast, command.clone(), &fixture).unwrap();
        let expected = graph::with_full_graph(|| graph_page(&full, command, &fixture)).unwrap();
        assert_eq!(comparable(&actual), comparable(&expected), "step {step}");
        apply(&mut fast, actual);
        apply(&mut full, expected);
        assert_eq!(fast, full);
        if step % 17 == 0 {
            fast = serde_json::from_str(&serde_json::to_string(&fast).unwrap()).unwrap();
            assert!(!fast.graph_view(Some(GENERATION)).reactive().validated());
        }
    }
}

#[test]
fn committed_removal_rebuilds_one_baseline_then_append_pages_resume() {
    let fixture = fixture();
    let mut data = Records::new();
    let roots: Vec<_> = (0..16)
        .map(|id| json!({"name":"top","args":id.to_string()}))
        .collect();
    let result = graph_page(&data, json!({"materialize":roots}), &fixture).unwrap();
    apply(&mut data, result);
    let result = graph_page(
        &data,
        json!({"unmaterialize":[{"name":"top","args":"0"}]}),
        &fixture,
    )
    .unwrap();
    apply(&mut data, result);
    assert!(!data.graph_view(Some(GENERATION)).reactive().validated());
    graph::take_graph_visits();
    for id in 16..32 {
        let result = graph_page(
            &data,
            json!({"materialize":[{"name":"top","args":id.to_string()}]}),
            &fixture,
        )
        .unwrap();
        apply(&mut data, result);
    }
    graph_page(&data, json!({}), &fixture).unwrap();
    assert_eq!(graph::take_graph_visits(), (64, 30));
}

#[test]
fn appended_roots_honor_cached_descendant_depth() {
    let fixture = fixture();
    let mut data = Records::new();
    for index in 0..127 {
        let name = format!("chain{index}");
        let deps = if index == 126 {
            vec![]
        } else {
            vec![cell_id(&format!("chain{}", index + 1), &Value::Null)]
        };
        data.insert(cell_id(&name, &Value::Null), stored_cell(&name, deps));
    }
    data.insert(
        root_id("chain0", &Value::Null),
        json!({"name":"chain0","args":null}),
    );
    run(
        data.clone(),
        json!({"name":"noop"}),
        "mutation",
        Some(1),
        &fixture,
    )
    .unwrap();
    assert!(data.reactive().validated());
    data.insert(
        cell_id("wrapper", &Value::Null),
        stored_cell("wrapper", vec![cell_id("chain0", &Value::Null)]),
    );
    data.insert(
        root_id("wrapper", &Value::Null),
        json!({"name":"wrapper","args":null}),
    );
    graph::take_graph_visits();
    run(
        data.clone(),
        json!({"name":"noop"}),
        "mutation",
        Some(1),
        &fixture,
    )
    .unwrap();
    assert_eq!(graph::take_graph_visits(), (1, 0));
    assert!(data.reactive().validated());
    data.insert(
        cell_id("wrapper2", &Value::Null),
        stored_cell("wrapper2", vec![cell_id("wrapper", &Value::Null)]),
    );
    data.insert(
        root_id("wrapper2", &Value::Null),
        json!({"name":"wrapper2","args":null}),
    );
    let actual = run(
        data.clone(),
        json!({"name":"noop"}),
        "mutation",
        Some(1),
        &fixture,
    )
    .unwrap_err();
    let expected = graph::with_full_graph(|| {
        run(
            data.clone(),
            json!({"name":"noop"}),
            "mutation",
            Some(1),
            &fixture,
        )
    })
    .unwrap_err();
    assert_eq!(actual, expected);
    assert_eq!(actual.code, "EVALUATION_BUDGET");
    assert!(!data.reactive().validated());
}

#[test]
fn untrusted_append_deltas_reject_cycles_and_missing_cells_and_collect_orphans() {
    let fixture = fixture();
    let mut baseline = tenants(&fixture, 1);
    write(&mut baseline, &fixture, "0", 99);
    for (name, deps, expected) in [
        ("cycle", vec![cell_id("cycle", &Value::Null)], "CYCLE"),
        (
            "missing",
            vec![cell_id("absent", &Value::Null)],
            "INPUT_INVALID",
        ),
    ] {
        let mut data = baseline.clone();
        data.insert(cell_id(name, &Value::Null), stored_cell(name, deps));
        data.insert(
            root_id(name, &Value::Null),
            json!({"name":name,"args":null}),
        );
        let actual = run(
            data.clone(),
            json!({"name":"noop"}),
            "mutation",
            Some(1),
            &fixture,
        )
        .unwrap_err();
        let full = graph::with_full_graph(|| {
            run(
                data.clone(),
                json!({"name":"noop"}),
                "mutation",
                Some(1),
                &fixture,
            )
        })
        .unwrap_err();
        assert_eq!(actual, full);
        assert_eq!(actual.code, expected);
        assert!(!data.reactive().validated());
    }
    let orphan = cell_id("orphan", &Value::Null);
    baseline.insert(orphan.clone(), stored_cell("orphan", vec![]));
    let result = run(
        baseline.clone(),
        json!({"name":"noop"}),
        "mutation",
        Some(1),
        &fixture,
    )
    .unwrap();
    assert_eq!(result.deletes, vec![orphan]);
    apply(&mut baseline, result);
    assert_eq!(baseline.reactive().cells.len(), 2);
}

#[test]
fn certified_graph_still_evaluates_dirty_children_retained_by_callback_errors() {
    let fixture = Fixture::new([
        (
            "a",
            (|_, host| {
                if get(host, "collection", "input", json!("switch"))? == true {
                    return Err(EngineError::new("EXPECTED", "failed"));
                }
                get(host, "derived", "b", Value::Null)
            }) as Callback,
        ),
        (
            "b",
            (|_, host| {
                if get(host, "collection", "input", json!("switch"))? == true {
                    let _ = get(host, "derived", "a", Value::Null);
                }
                Ok(json!(1))
            }) as Callback,
        ),
    ]);
    let mut data = Records::new();
    let result = graph_page(&data, json!({"materialize":[{"name":"a"}]}), &fixture).unwrap();
    apply(&mut data, result);
    graph_page(&data, json!({}), &fixture).unwrap();
    assert!(data.graph_view(Some(GENERATION)).reactive().validated());
    let command = json!({"writes":[{"collection":"input","key":"switch","value":true}]});
    let actual = graph_page(&data, command.clone(), &fixture).unwrap_err();
    let expected = graph::with_full_graph(|| graph_page(&data, command, &fixture)).unwrap_err();
    assert_eq!(actual, expected);
    assert_eq!(actual.code, "CYCLE");
}

fn stored_cell(name: &str, deps: Vec<String>) -> Value {
    json!({"name":name,"args":null,"deps":deps,"outcome":{"ok":true,"value":1}})
}

#[test]
fn added_cycle_and_depth_are_checked_even_when_stored_cells_are_clean() {
    let fixture = fixture();
    let mut data = Records::new();
    for index in 0..128 {
        let name = format!("chain{index}");
        let deps = if index == 127 {
            vec![]
        } else {
            vec![cell_id(&format!("chain{}", index + 1), &Value::Null)]
        };
        data.insert(cell_id(&name, &Value::Null), stored_cell(&name, deps));
    }
    data.insert(
        root_id("chain0", &Value::Null),
        json!({"name":"chain0","args":null}),
    );
    run(
        data.clone(),
        json!({"name":"noop"}),
        "mutation",
        Some(1),
        &fixture,
    )
    .unwrap();
    assert!(data.reactive().validated());
    let pristine = data.clone();
    data.insert(
        cell_id("chain127", &Value::Null),
        stored_cell("chain127", vec![cell_id("chain0", &Value::Null)]),
    );
    assert!(!data.reactive().validated());
    assert!(pristine.reactive().validated());
    assert_eq!(
        run(data, json!({"name":"noop"}), "mutation", Some(2), &fixture)
            .unwrap_err()
            .code,
        "CYCLE"
    );
    let mut too_deep = pristine;
    too_deep.insert(
        cell_id("chain127", &Value::Null),
        stored_cell("chain127", vec![cell_id("chain128", &Value::Null)]),
    );
    too_deep.insert(
        cell_id("chain128", &Value::Null),
        stored_cell("chain128", vec![]),
    );
    assert_eq!(
        run(
            too_deep,
            json!({"name":"noop"}),
            "mutation",
            Some(2),
            &fixture
        )
        .unwrap_err()
        .code,
        "EVALUATION_BUDGET"
    );
}

#[test]
fn root_removal_collects_only_unreachable_shared_descendants() {
    let fixture = fixture();
    let mut data = tenants(&fixture, 1);
    deploy(
        &mut data,
        json!({"materialize":[{"name":"scratch","args":"0"}]}),
        &fixture,
    );
    write(&mut data, &fixture, "0", 1000);
    deploy(
        &mut data,
        json!({"unmaterialize":[{"name":"top","args":"0"}]}),
        &fixture,
    );
    assert!(data.contains_key(&cell_id("top", &json!("0"))));
    assert!(data.contains_key(&cell_id("leaf", &json!("0"))));
    deploy(
        &mut data,
        json!({"unmaterialize":[{"name":"scratch","args":"0"}]}),
        &fixture,
    );
    assert!(data.reactive().cells.is_empty());
    assert!(data.reactive().roots.is_empty());
    assert!(data.reactive().reverse.is_empty());
    assert_eq!(data.reactive().bytes, 0);
}

#[test]
fn cached_validation_tracks_malformed_cells_roots_and_clock_dependencies() {
    let fixture = fixture();
    let mut data = tenants(&fixture, 1);
    write(&mut data, &fixture, "0", 1000);
    assert!(data.reactive().cacheable());
    let id = cell_id("leaf", &json!("0"));
    let good = data[&id].clone();
    let mut clock = good.clone();
    clock["deps"].as_array_mut().unwrap().push(json!("clock"));
    data.insert(id.clone(), clock);
    assert!(!data.reactive().cacheable());
    data.insert(id.clone(), good.clone());
    assert!(data.reactive().cacheable());
    let mut malformed = good.clone();
    malformed["deps"] = Value::Null;
    data.insert(id.clone(), malformed);
    assert!(!data.reactive().cacheable());
    assert_eq!(
        run(
            data.clone(),
            json!({"name":"noop"}),
            "mutation",
            Some(1),
            &fixture
        )
        .unwrap_err()
        .code,
        "INPUT_INVALID"
    );
    data.insert(id, good);
    assert!(data.reactive().validate().is_ok());
    let root = root_id("top", &json!("0"));
    data.insert(root.clone(), json!({"name":"other","args":"0"}));
    assert_eq!(
        run(
            data.clone(),
            json!({"name":"noop"}),
            "mutation",
            Some(1),
            &fixture
        )
        .unwrap_err()
        .code,
        "INPUT_INVALID"
    );
    data.insert(root, json!({"name":"top","args":"0"}));
    assert!(data.reactive().validate().is_ok());
}

#[test]
fn derived_branch_switch_detaches_proof_and_collects_old_branch_in_the_same_preview() {
    let fixture = Fixture::new([
        ("left", (|_, _| Ok(json!(1))) as Callback),
        ("right", (|_, _| Ok(json!(2))) as Callback),
        (
            "choose",
            (|_, host| {
                let name = if get(host, "collection", "branch", json!("chosen"))? == true {
                    "right"
                } else {
                    "left"
                };
                get(host, "derived", name, Value::Null)
            }) as Callback,
        ),
        (
            "switch",
            (|args, host| {
                set(host, "branch", "chosen", args.clone())?;
                get(host, "derived", "choose", Value::Null)
            }) as Callback,
        ),
        ("noop", (|_, _| Ok(Value::Null)) as Callback),
    ]);
    let mut data = Records::new();
    deploy(
        &mut data,
        json!({"materialize":[{"name":"choose"}]}),
        &fixture,
    );
    for (index, switch) in [true, false, true].into_iter().enumerate() {
        run(
            data.clone(),
            json!({"name":"noop"}),
            "mutation",
            Some((index * 2 + 1) as u64),
            &fixture,
        )
        .unwrap();
        assert!(data.reactive().validated());
        let proof = data.reactive().topology.clone();
        let command = json!({"name":"switch","args":switch});
        graph::take_graph_passes();
        let actual = run(
            data.clone(),
            command.clone(),
            "mutation",
            Some((index * 2 + 2) as u64),
            &fixture,
        )
        .unwrap();
        assert_eq!(
            graph::take_graph_passes(),
            (0, 1),
            "edge change must fall back within its first preview"
        );
        let expected = graph::with_full_graph(|| {
            run(
                data.clone(),
                command,
                "mutation",
                Some((index * 2 + 2) as u64),
                &fixture,
            )
        })
        .unwrap();
        assert_eq!(comparable(&actual), comparable(&expected));
        assert_eq!(actual.value, if switch { json!(2) } else { json!(1) });
        apply(&mut data, actual);
        assert!(!Arc::ptr_eq(&proof, &data.reactive().topology));
        assert!(data.contains_key(&cell_id(
            if switch { "right" } else { "left" },
            &Value::Null
        )));
        assert!(!data.contains_key(&cell_id(
            if switch { "left" } else { "right" },
            &Value::Null
        )));
    }
}

#[test]
fn metadata_bounds_argument_depth_before_recursive_identity_work() {
    for kind in ["cell", "root"] {
        let args = (0..512).fold(Value::Null, |value, _| Value::Array(vec![value]));
        let value = json!({"name":"deep","args":args,"deps":[],"outcome":{"ok":true,"value":1}});
        let mut records = Records::new();
        records.insert(format!("{kind}:[]"), value);
        assert!(!records.has_valid_depth());
        let error = records.reactive().validate().unwrap_err();
        assert_eq!(error.code, "INPUT_INVALID");
        assert!(error.message.contains("nesting"));
    }
}
