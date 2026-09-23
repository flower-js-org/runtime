use super::*;

#[test]
fn parsed_host_bridge_preserves_nested_calls_from_stringification() {
    for static_init in [false, true] {
        let code = bundle(
            r#"ctx=>{
            let first=true;
            Array.prototype.toJSON=function(){
                if(first){first=false;ctx.get('trace','nested');}
                return this;
            };
            const value=ctx.get('items','outer');
            delete Array.prototype.toJSON;
            return value;
        }"#,
            static_init,
        );
        let mut calls = Vec::new();
        let result = execute(
            &code,
            "test",
            &Value::Null,
            "query",
            &mut |method, args| {
                calls.push((method.to_owned(), args));
                Ok(json!({"text":"reply\0é🌸","size":calls.len()}))
            },
            limits(),
        )
        .unwrap();
        assert_eq!(
            calls,
            vec![
                ("get".into(), json!(["trace", "nested"])),
                ("get".into(), json!(["items", "outer"]))
            ]
        );
        assert_eq!(
            result,
            json!({"ok":true,"value":{"text":"reply\0é🌸","size":2}})
        );
    }
}

#[test]
fn parsed_host_bridge_captures_callees_before_hooks_and_falls_back_on_the_next_call() {
    for static_init in [false, true] {
        let code = bundle(
            r#"ctx=>{
            const parse=JSON.parse, stringify=JSON.stringify;
            let parses=0;
            Array.prototype.toJSON=function(){
                delete Array.prototype.toJSON;
                JSON.parse=(text)=>{++parses;return parse(text)};
                __flowerRead=()=>stringify({ok:true,value:'replacement'});
                return this;
            };
            const first=ctx.get('items','first');
            const second=ctx.get('items','second');
            return {first,second,parses};
        }"#,
            static_init,
        );
        let mut calls = 0;
        let result = execute(
            &code,
            "test",
            &Value::Null,
            "query",
            &mut |method, args| {
                assert_eq!(method, "get");
                assert_eq!(args, json!(["items", "first"]));
                calls += 1;
                Ok(json!("original"))
            },
            limits(),
        )
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(
            result,
            json!({"ok":true,"value":{"first":"original","second":"replacement","parses":1}})
        );
    }
}

#[test]
fn application_shadowing_cannot_replace_private_parsed_bridge() {
    let code = format!(
        "let __flowerReadParsed=()=>({{ok:true,value:'spoofed'}});{}",
        bundle("ctx=>ctx.now()", false)
    );
    let result = execute(
        &code,
        "test",
        &Value::Null,
        "query",
        &mut |method, args| {
            assert_eq!(method, "now");
            assert_eq!(args, json!([]));
            Ok(json!(42))
        },
        limits(),
    )
    .unwrap();
    assert_eq!(result, json!({"ok":true,"value":42}));
}
