//! Invocation costs of the benchmark application through the production
//! evaluator. Build its bundle, then:
//! FLOWER_GOBLIN_BUNDLE=path cargo test --release --lib goblin -- --ignored --nocapture
use super::*;
use crate::consensus::Records;

fn timed(label: &str, calls: usize, mut call: impl FnMut(usize)) {
    if std::env::var("FLOWER_GOBLIN_ONLY").is_ok_and(|only| only != label) {
        return;
    }
    for index in 0..calls / 10 {
        call(usize::MAX - index);
    }
    let started = Instant::now();
    for index in 0..calls {
        call(index);
    }
    let micros = started.elapsed().as_secs_f64() * 1e6 / calls as f64;
    println!("{label:>12}: {micros:8.1} µs/call");
}

#[test]
#[ignore]
fn goblin_invocation_costs() {
    let path = std::env::var("FLOWER_GOBLIN_BUNDLE").expect("FLOWER_GOBLIN_BUNDLE");
    let javascript = std::fs::read_to_string(path).unwrap();
    let bundle = json!({"hash": hash(javascript.as_bytes()), "javascript": javascript});
    let mut data = evaluate(BTreeMap::new(), json!({"requestId":"deploy","bundle":bundle}))
        .unwrap()
        .puts;
    let setup = invoke(
        data.clone(),
        json!({"name":"internal.pizza.setup","requestId":"setup","args":{
            "tenants":["t0"],"storesPerTenant":4,"stockPerShop":1_000_000,"bakeMs":10,"leaseMs":1000
        }}),
        "mutation",
    )
    .unwrap();
    data.extend(setup.puts);
    let records: Records = data.into();
    let calls = std::env::var("FLOWER_GOBLIN_CALLS").map_or(2000, |calls| calls.parse().unwrap());
    timed("order", calls, |index| {
        invoke(records.clone(), json!({"name":"internal.pizza.order","requestId":format!("o{index}"),
            "args":{"id":format!("o{index}"),"shop":["t0","store-0"],"quantity":1}}), "mutation").unwrap();
    });
    timed("tip", calls, |index| {
        invoke(records.clone(), json!({"name":"internal.pizza.tip","requestId":format!("t{index}"),
            "args":{"shop":["t0","store-1"],"amount":1}}), "mutation").unwrap();
    });
    timed("shop", calls, |_| {
        invoke(records.clone(), json!({"name":"internal.pizza.shop","args":["t0","store-2"]}), "query").unwrap();
    });
}
