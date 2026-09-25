//! Protection failures terminate a subprocess rather than the full test runner.
use super::super::{dirty as tracking, recycle as pool};
use super::*;

fn child(test: &str) -> bool {
    const CHILD: &str = "FLOWER_TEST_DIRTY_PAGES_CHILD";
    if std::env::var(CHILD).is_ok_and(|name| name == test) {
        return true;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("evaluator::wasm::tests::dirty::{test}"),
            "--nocapture",
        ])
        .env(CHILD, test)
        .env("FLOWER_WASM_DIRTY_PAGES", "1")
        .env("FLOWER_WASM_RECYCLE", "1")
        .env("FLOWER_WASM_POOL_SLOTS", "32")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "dirty-page child {test}: {}\n{}\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    false
}

#[test]
fn dirty_pages_restore_guest_writes_and_track_large_recursive_host_writes() {
    if !child("dirty_pages_restore_guest_writes_and_track_large_recursive_host_writes") {
        return;
    }
    // Retain spare heap capacity in the snapshot so large input/result buffers
    // exercise reset of one mapping instead of merely forcing memory growth.
    let source = format!(
        "{STATIC_INIT_MARKER}let count=0;const bytes=new Uint8Array(512*1024);bytes.fill(31);let slack=new Uint8Array(1024*1024);slack=null;{}",
        bundle(
            r#"(ctx,args)=>{
                const pristine=bytes.every(value=>value===31);
                const index=args.page*16384;
                bytes[index]=args.mark;
                const host=ctx.get(args.nested?'nested':'leaf',{text:args.text});
                const message=new Uint8Array(args.text.length);message.fill(args.mark);
                const nonce=new Uint8Array(24),key=new Uint8Array(32);
                const sealed=__flowerCrypto(1,0,message,nonce,key);
                const opened=__flowerCrypto(2,0,sealed,nonce,key);
                return{pristine,count:++count,mark:bytes[index],host,
                    crypto:opened.length===message.length&&opened.every(value=>value===args.mark)};
            }"#,
            false,
        ),
    );
    let prepared = prepare(&source, limits()).unwrap();
    // Later calls touch previously untouched pages; once a page becomes writable
    // it must remain part of every subsequent reset, even if a call skips it.
    for (index, (page, text)) in [
        (0, String::new()),
        (3, "a".repeat(16_384)),
        (17, "b".repeat(49_151)),
        (9, "c".repeat(65_537)),
        (3, "🌺\0".repeat(4096)),
        (0, String::new()),
    ]
    .into_iter()
    .enumerate()
    {
        let mark = index + 1;
        let shared = limits();
        let args = json!({"page":page,"mark":mark,"text":text,"nested":true});
        let result = execute_prepared(
            &prepared,
            "test",
            &args,
            "query",
            &mut |name, args| {
                assert_eq!(name, "get");
                assert_eq!(args, json!(["nested",{"text":text}]));
                // This child's input writes happen while its parent is inside a
                // host call. The child must mark its own protected mapping.
                let child_text = "child".repeat(8193);
                let child = execute_prepared(
                    &prepared,
                    "test",
                    &json!({"page":page,"mark":99,"text":child_text,"nested":false}),
                    "query",
                    &mut |name, args| {
                        assert_eq!(name, "get");
                        assert_eq!(args, json!(["leaf",{"text":child_text}]));
                        Ok(json!({"text":child_text}))
                    },
                    shared.clone(),
                )?;
                assert_eq!(child["ok"], true, "{child}");
                assert_eq!(child["value"]["pristine"], true, "{child}");
                assert_eq!(child["value"]["count"], 1, "{child}");
                assert_eq!(child["value"]["mark"], 99, "{child}");
                assert_eq!(child["value"]["crypto"], true, "{child}");
                assert_eq!(child["value"]["host"], json!({"text":child_text}));
                Ok(json!({"text":text}))
            },
            shared.clone(),
        )
        .unwrap();
        assert_eq!(
            result,
            json!({"ok":true,"value":{
                "pristine":true,"count":1,"mark":mark,"host":{"text":text},"crypto":true
            }}),
            "invocation {index}"
        );
        shared.check().unwrap();
    }
    assert!(
        pool::stats(&prepared).reused >= 2,
        "must exercise protected Store reuse"
    );
    let stats = pool::stats(&prepared);
    assert!(
        stats.signal_faults > 0,
        "must handle actual guest write faults"
    );
    assert!(
        stats.reset_bytes < stats.reset_total_bytes,
        "clean pages must avoid full-image copies: {stats:?}"
    );
}

#[test]
fn dirty_page_failures_release_protection_and_do_not_reuse_poisoned_guests() {
    if !child("dirty_page_failures_release_protection_and_do_not_reuse_poisoned_guests") {
        return;
    }
    let source = format!(
        "{STATIC_INIT_MARKER}let count=0;{}",
        bundle(
            r#"(ctx,args)=>{
                ++count;
                if(args==='business')throw Object.assign(Error('declined'),{code:'DECLINED'});
                if(args==='loop'){try{for(;;){}}catch(e){}}
                if(args==='grow')return new Uint8Array(16*1024*1024).length;
                if(args==='host')ctx.get('panic',null);
                return count;
            }"#,
            false,
        ),
    );
    let prepared = prepare(&source, limits()).unwrap();
    let invoke = |argument: &Value, shared: Arc<Limits>| {
        execute_prepared(
            &prepared,
            "test",
            argument,
            "query",
            &mut |_, _| panic!("intentional active host panic"),
            shared,
        )
    };
    let check_fresh = || {
        assert_eq!(
            invoke(&Value::Null, limits()).unwrap(),
            json!({"ok":true,"value":1})
        );
    };
    {
        check_fresh();
        assert_eq!(
            invoke(&json!("business"), limits()).unwrap()["error"]["code"],
            "DECLINED"
        );
        check_fresh();
        let before = pool::stats(&prepared);
        let short = Limits::new(Instant::now() + Duration::from_millis(30), MAX_MEMORY_BYTES);
        assert!(invoke(&json!("loop"), short.clone()).is_err());
        assert!(short.check().is_err());
        assert!(pool::stats(&prepared).discarded > before.discarded);
        check_fresh();
        let before = pool::stats(&prepared);
        assert_eq!(
            invoke(&json!("grow"), limits()).unwrap()["value"],
            16 * 1024 * 1024
        );
        assert!(pool::stats(&prepared).discarded > before.discarded);
        check_fresh();
        let tiny = Limits::new(Instant::now() + Duration::from_secs(30), 1);
        assert!(invoke(&Value::Null, tiny.clone()).is_err());
        assert!(tiny.check().is_err());
        check_fresh();
    }
    pool::release(&prepared);
    assert_eq!(pool::stats(&prepared).idle, 0);
    // The panicking invocation takes the only idle guest and must discard it.
    let unwind = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        check_fresh();
        invoke(&json!("host"), limits()).unwrap();
    }));
    assert!(unwind.is_err());
    assert_eq!(pool::stats(&prepared).idle, 0);
    check_fresh();
}

#[test]
fn dirty_page_faults_cover_cross_page_writes_and_leave_oob_traps_intact() {
    if !child("dirty_page_faults_cover_cross_page_writes_and_leave_oob_traps_intact") {
        return;
    }
    use wasm_encoder::{
        CodeSection, ExportKind, ExportSection, Function, FunctionSection, Instruction, MemArg,
        MemorySection, MemoryType, TypeSection, ValType,
    };
    // Creating both the production Engine and a separate test Engine in one
    // process also exercises Wasmtime's process-wide macOS signal-mode contract.
    let _runtime = super::super::cache::runtime().unwrap();
    let mut config = wasmtime::Config::new();
    config.macos_use_mach_ports(false);
    let engine = wasmtime::Engine::new(&config).unwrap();
    let mut wasm = wasm_encoder::Module::new();
    let mut types = TypeSection::new();
    types.ty().function([ValType::I32, ValType::I64], []);
    wasm.section(&types);
    let mut functions = FunctionSection::new();
    functions.function(0);
    wasm.section(&functions);
    let mut memories = MemorySection::new();
    memories.memory(MemoryType {
        minimum: 8,
        maximum: Some(8),
        memory64: false,
        shared: false,
        page_size_log2: None,
    });
    wasm.section(&memories);
    let mut exports = ExportSection::new();
    exports.export("memory", ExportKind::Memory, 0);
    exports.export("write", ExportKind::Func, 0);
    wasm.section(&exports);
    let mut write = Function::new([]);
    write.instruction(&Instruction::LocalGet(0));
    write.instruction(&Instruction::LocalGet(1));
    write.instruction(&Instruction::I64Store(MemArg {
        offset: 0,
        align: 0,
        memory_index: 0,
    }));
    write.instruction(&Instruction::End);
    let mut code = CodeSection::new();
    code.function(&write);
    wasm.section(&code);
    let module = wasmtime::Module::new(&engine, wasm.finish()).unwrap();
    let mut store = wasmtime::Store::new(&engine, Host::new(limits(), None));
    let instance = wasmtime::Instance::new(&mut store, &module, &[]).unwrap();
    let memory = instance.get_memory(&mut store, "memory").unwrap();
    let write = instance
        .get_typed_func::<(i32, i64), ()>(&mut store, "write")
        .unwrap();
    write.call(&mut store, (0, 0)).unwrap();
    memory.data_mut(&mut store).fill(0x5a);
    let pristine = memory.data(&store).to_vec();
    let tracker = tracking::install(&mut store, memory)
        .unwrap()
        .expect("supported OS page geometry");
    struct Unprotect(Arc<tracking::Tracker>);
    impl Drop for Unprotect {
        fn drop(&mut self) {
            self.0.unprotect().unwrap();
        }
    }
    // Declared after Store so protection is removed first on assertion unwind.
    let _unprotect = Unprotect(tracker.clone());
    store.data_mut().dirty = Some(tracker.clone());
    tracker.protect().unwrap();
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as usize;
    assert!(page > 0 && memory.data_size(&store) >= 8 * page);
    #[cfg(target_os = "macos")]
    let errno = unsafe { libc::__error() };
    #[cfg(target_os = "linux")]
    let errno = unsafe { libc::__errno_location() };
    unsafe {
        *errno = libc::EDOM;
    }
    write.call(&mut store, (0, 11)).unwrap();
    assert_eq!(
        unsafe { *errno },
        libc::EDOM,
        "signal handling must preserve errno"
    );
    assert_eq!(tracker.faults(), 1);
    // The first half is already writable. The fault must identify and unlock
    // the second page, allowing the original unaligned store to complete.
    write
        .call(&mut store, ((page - 4) as i32, 0x1234_5678_1357_2468))
        .unwrap();
    assert_eq!(tracker.faults(), 2);
    let last = memory.data_size(&store) - 8;
    write.call(&mut store, (last as i32, 19)).unwrap();
    assert_eq!(tracker.faults(), 3);
    assert_eq!(
        tracker
            .restore(memory.data_mut(&mut store), &pristine)
            .unwrap(),
        3 * page
    );
    assert_eq!(memory.data(&store), pristine);
    assert_eq!(
        tracker
            .restore(memory.data_mut(&mut store), &pristine)
            .unwrap(),
        3 * page,
        "ever-dirty pages remain in later resets even without another fault"
    );
    // A host payload with a terminator crosses two still-clean pages outside
    // any Wasm activation. Missing explicit marking would crash this subprocess.
    let start = 3 * page - 1;
    tracking::prepare_write(&mut store, start, 3).unwrap();
    memory.data_mut(&mut store)[start..start + 3].copy_from_slice(b"a\0\0");
    assert_eq!(
        tracker.faults(),
        3,
        "host writes need no guest fault handler"
    );
    assert_eq!(
        tracker
            .restore(memory.data_mut(&mut store), &pristine)
            .unwrap(),
        5 * page
    );
    assert_eq!(
        memory.data(&store),
        pristine,
        "restore compares every memory byte"
    );
    unsafe {
        *errno = libc::EDOM;
    }
    assert!(tracking::prepare_write(&mut store, usize::MAX, 2).is_err());
    assert_eq!(unsafe { *errno }, libc::EDOM);
    let out_of_bounds = memory.data_size(&store) as i32;
    let error = write.call(&mut store, (out_of_bounds, 23)).unwrap_err();
    assert_eq!(
        error.downcast_ref::<wasmtime::Trap>(),
        Some(&wasmtime::Trap::MemoryOutOfBounds)
    );
    assert_eq!(tracker.faults(), 3, "an OOB fault must never be swallowed");
    assert_eq!(memory.data(&store), pristine);
}
