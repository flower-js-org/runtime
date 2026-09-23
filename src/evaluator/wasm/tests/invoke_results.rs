use super::*;

#[test]
fn retained_invocation_text_survives_guest_drop_with_large_unicode_results() {
    for static_init in [false, true] {
        let code = bundle("(_,args)=>args", static_init);
        let prepared = prepare(&code, limits()).unwrap();
        for value in [
            Value::Null,
            json!({"text":"quote\"\\\n\0é🌸","nested":[true,false,1e21]}),
            json!("large\0é🌸".repeat(16384)),
        ] {
            let result = execute_prepared(
                &prepared,
                "test",
                &value,
                "query",
                &mut |_, _| Ok(Value::Null),
                limits(),
            )
            .unwrap();
            assert_eq!(result, json!({"ok":true,"value":value}));
        }
    }
}

#[test]
fn retained_invocation_exceptions_keep_conversion_and_unreadable_error_semantics() {
    for (prefix, expected) in [
        (
            "JSON.stringify=()=>({toString(){throw Error('conversion 🌸\\0tail')}});",
            "conversion 🌸\0tail",
        ),
        (
            "JSON.stringify=()=>({toString(){throw {toString(){throw null}}}});",
            "unreadable QuickJS exception",
        ),
        (
            "throw Error('initialization 🌸\\0tail');",
            "initialization 🌸\0tail",
        ),
    ] {
        let code = format!("{prefix}{}", bundle("()=>1", false));
        let error = run(&code, Value::Null).unwrap_err();
        assert!(error.to_string().contains(expected), "{error:#}");
    }
    let result = run(
        &bundle("()=>{throw Error('business 🌸\\0tail')}", true),
        Value::Null,
    )
    .unwrap();
    assert_eq!(
        result,
        json!({"ok":false,"error":{"code":"COMPUTE_ERROR","message":"business 🌸\0tail"}})
    );
}
