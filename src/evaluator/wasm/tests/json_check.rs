use super::*;

#[test]
fn direct_json_slots_preserve_validation_and_observable_fallback_order() {
    // These shapes exercise the native slot walk and its guarded fallback in
    // production Wasmtime, compared with the untouched JavaScript validator.
    for compute in [
        "()=>{const x={first:1,gone:2,last:3};delete x.gone;x.again={ok:true};return x}",
        "()=>{const x={9:'nine',2:'two',text:1};delete x[2];x[2]='again';return x}",
        "()=>Object.freeze({x:1,nested:Object.freeze([1,2])})",
        "()=>Object.seal([1,{x:2}])",
        "()=>{const x=[1,{x:2}];Object.setPrototypeOf(x,null);return x}",
        "()=>{const x=[1,2,3];x.length=1;return x}",
        "()=>{const x=[1,2];x.length=4;return x}",
        "()=>{const x=[1,2,3];delete x[1];return x}",
        "()=>{const x=[1,2,3];delete x[1];x[1]=4;return x}",
        "()=>[1,undefined,3]",
        "()=>{const x=[1];x[Symbol('extra')]=2;return x}",
        "ctx=>{const x=[1];Object.defineProperty(x,'extra',{enumerable:true,get(){ctx.now();return 2}});return x}",
        "()=>{const x=[1];x.push(x);return x}",
        "()=>{const x=new Number(3);Object.setPrototypeOf(x,Object.prototype);return x}",
        // Own-key order differs from insertion/shape order for integer keys.
        // Probes must never run either trap before restarting the JS validator.
        "ctx=>{const x={};x[9]=new Proxy({x:9},{ownKeys(t){ctx.get('trace','nine');return Reflect.ownKeys(t)}});x[2]=new Proxy({x:2},{ownKeys(t){ctx.get('trace','two');return Reflect.ownKeys(t)}});return x}",
        "()=>{const shared={nested:[1,2]};return [shared,{shared},shared]}",
        "()=>{let x=null;for(let i=0;i<120;i++)x=[x];return x}",
        "()=>{let x=null;for(let i=0;i<129;i++)x=[x];return x}",
        // Arguments entering the database bridge use the same validator.
        "ctx=>ctx.get('items',Object.assign([1],{extra:{valid:true}}))",
        "ctx=>{const key=[1];key.length=3;try{return ctx.get('items',key)}catch(e){return {code:e.code,message:e.message}}}",
    ] {
        let code = bundle(compute, false);
        let expected = original_runner(&code);
        let mut calls = Vec::new();
        let actual = execute(
            &code,
            "test",
            &Value::Null,
            "query",
            &mut |method, args| {
                calls.push((method.to_owned(), args));
                Ok(Value::Null)
            },
            limits(),
        )
        .unwrap();
        assert_eq!((actual, calls), expected, "{compute}");
    }
}
