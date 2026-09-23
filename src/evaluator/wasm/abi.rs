use super::Host;
use anyhow::{Context, Result, bail, ensure};
use wasmtime::{AsContextMut, Instance, Memory, Module, ModuleExport, Store, TypedFunc};

type InvokeParameters = (i32, i32, i32, i32, i32, i32, i32, i32);

/// The guest exposes owned byte buffers, never interpreter values or pointers to
/// its runtime. One invocation binds inputs and runs the callback inside C.
#[derive(Clone)]
pub(super) struct Abi {
    pub(super) memory: Memory,
    instance: Instance,
    alloc: TypedFunc<i32, i32>,
    free: TypedFunc<i32, ()>,
    invoke: TypedFunc<InvokeParameters, i64>,
}

/// Export identities belong to a compiled module, while all actual handles
/// below still belong to the current Store. Cache only these immutable indices.
pub(super) struct Exports {
    memory: ModuleExport,
    alloc: ModuleExport,
    free: ModuleExport,
    invoke: ModuleExport,
}

impl Exports {
    pub(super) fn new(module: &Module) -> Result<Self> {
        let export = |name| {
            module
                .get_export_index(name)
                .with_context(|| format!("missing {name}"))
        };
        Ok(Self {
            memory: export("memory")?,
            alloc: export("flower_alloc")?,
            free: export("flower_free")?,
            invoke: export("flower_invoke")?,
        })
    }
}

pub(super) struct Invocation {
    parameters: InvokeParameters,
}

/// A malloc allocation retained in one immutable image. Each invocation
/// owns logically pristine bytes at this address, either through COW or a full
/// image reset. Larger invocations still allocate inside their isolated heap.
#[derive(Clone, Copy)]
pub(super) struct InputBuffer {
    pointer: i32,
}

impl InputBuffer {
    const CAPACITY: usize = 4096;
}

pub(super) struct CallbackResult(i64);

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SnapshotPreparation {
    pub bytes_before: u64,
    pub bytes_after: u64,
    pub objects_before: u64,
    pub objects_after: u64,
    pub threshold_before: u64,
    pub threshold_after: u64,
}

impl Abi {
    /// Resolve this setup-only export here, never on the per-cell ABI path.
    pub(super) fn prepare_snapshot(
        &self,
        store: &mut Store<Host>,
        instance: Instance,
        phase: &str,
    ) -> Result<SnapshotPreparation> {
        let prepare = instance.get_typed_func::<(), i64>(&mut *store, "flower_snapshot_prepare")?;
        let packed = prepare.call(&mut *store, ())?;
        // The trusted C export formats into a fixed 384-byte diagnostics buffer.
        let bytes = self.result(store, packed, 384)?;
        let stats: SnapshotPreparation = serde_json::from_slice(&bytes)?;
        tracing::debug!(target: "flower::evaluator_profile", phase,
            gc_live_before_bytes = stats.bytes_before,
            gc_live_after_bytes = stats.bytes_after,
            gc_objects_before = stats.objects_before,
            gc_objects_after = stats.objects_after,
            gc_threshold_before_bytes = stats.threshold_before,
            gc_threshold_after_bytes = stats.threshold_after,
            "QuickJS snapshot heap preparation");
        Ok(stats)
    }

    pub(super) fn load(store: &mut Store<Host>, instance: Instance) -> Result<Self> {
        macro_rules! f {
            ($name:literal) => {
                instance.get_typed_func(&mut *store, $name)?
            };
        }
        Ok(Self {
            instance,
            memory: instance
                .get_memory(&mut *store, "memory")
                .context("memory")?,
            alloc: f!("flower_alloc"),
            free: f!("flower_free"),
            invoke: f!("flower_invoke"),
        })
    }

    pub(super) fn load_cached(
        store: &mut Store<Host>,
        instance: Instance,
        exports: &Exports,
    ) -> Result<Self> {
        macro_rules! f {
            ($export:ident) => {
                instance
                    .get_module_export(&mut *store, &exports.$export)
                    .and_then(|export| export.into_func())
                    .context(concat!("cached guest function ", stringify!($export)))?
                    .typed(&*store)?
            };
        }
        Ok(Self {
            instance,
            memory: instance
                .get_module_export(&mut *store, &exports.memory)
                .and_then(|export| export.into_memory())
                .context("cached guest memory")?,
            alloc: f!(alloc),
            free: f!(free),
            invoke: f!(invoke),
        })
    }

    pub(super) fn bytes<S: AsContextMut<Data = Host>>(&self, s: &mut S, b: &[u8]) -> Result<i32> {
        let size = b.len().checked_add(1).context("input overflow")?;
        let p = self.alloc.call(&mut *s, i32::try_from(size)?)?;
        ensure!(p != 0, "guest allocation failed");
        let start = p as u32 as usize;
        // Rust writes can occur outside a Wasm activation, or while a parent
        // Store is active. They cannot rely on this Store's signal handler.
        super::dirty::prepare_write(s, start, size)?;
        self.memory.write(&mut *s, start, b)?;
        self.memory.write(&mut *s, start + b.len(), &[0])?;
        Ok(p)
    }

    /// Copy before calling guest code again: both reentrant host callbacks and
    /// allocator growth may move or mutate linear memory.
    pub(super) fn string<S: AsContextMut<Data = Host>>(
        &self,
        s: &S,
        pointer: i32,
        length: i32,
        maximum: usize,
    ) -> Result<String> {
        let size = length as u32 as usize;
        ensure!(size <= maximum, "guest string exceeds limit");
        let start = pointer as u32 as usize;
        let bytes = self
            .memory
            .data(s)
            .get(start..start.checked_add(size).context("string overflow")?)
            .context("guest string bounds")?;
        Ok(std::str::from_utf8(bytes)?.to_owned())
    }

    /// Decode while the guest is suspended, finishing the memory borrow before
    /// a host callback can recursively enter another guest or allocate a reply.
    /// The returned JSON owns its strings and never borrows guest memory.
    pub(super) fn json<S: AsContextMut<Data = Host>>(
        &self,
        s: &S,
        pointer: i32,
        length: i32,
    ) -> Result<serde_json::Value> {
        let size = length as u32 as usize;
        ensure!(
            size <= super::max_json_bytes()?,
            "guest string exceeds limit"
        );
        let start = pointer as u32 as usize;
        let bytes = self
            .memory
            .data(s)
            .get(start..start.checked_add(size).context("string overflow")?)
            .context("guest string bounds")?;
        super::parse_json(std::str::from_utf8(bytes)?)
    }

    /// Packed results own a malloc buffer. Bit 63 marks a guest exception; the
    /// other high bits give its length. Copy and release on success and errors.
    fn result<S: AsContextMut<Data = Host>>(
        &self,
        s: &mut S,
        packed: i64,
        maximum: usize,
    ) -> Result<Vec<u8>> {
        let bits = packed as u64;
        let pointer = bits as u32 as i32;
        let length = ((bits >> 32) & 0x7fff_ffff) as usize;
        let copied = (|| {
            ensure!(length <= maximum, "guest result exceeds limit");
            ensure!(pointer != 0 || length == 0, "null guest result");
            let start = pointer as u32 as usize;
            let bytes = self
                .memory
                .data(&*s)
                .get(start..start.checked_add(length).context("result overflow")?)
                .context("guest result bounds")?;
            Ok(bytes.to_vec())
        })();
        if pointer != 0 {
            self.free.call(&mut *s, pointer)?;
        }
        let bytes = copied?;
        if bits >> 63 != 0 {
            bail!("guest: {}", String::from_utf8_lossy(&bytes));
        }
        Ok(bytes)
    }

    fn call_bytes<S: AsContextMut<Data = Host>>(
        &self,
        s: &mut S,
        function: &TypedFunc<(i32, i32), i64>,
        bytes: &[u8],
        maximum: usize,
    ) -> Result<Vec<u8>> {
        let pointer = self.bytes(s, bytes)?;
        // After a trap discard the entire Store; do not reenter potentially
        // interrupted guest allocator state merely to release this allocation.
        let packed = function.call(&mut *s, (pointer, i32::try_from(bytes.len())?))?;
        self.free.call(&mut *s, pointer)?;
        self.result(s, packed, maximum)
    }

    pub(super) fn discard(&self, s: &mut Store<Host>, code: &str) -> Result<()> {
        self.eval_string(s, code).map(|_| ())
    }
    pub(super) fn eval_string(&self, s: &mut Store<Host>, code: &str) -> Result<String> {
        let function = self.instance.get_typed_func(&mut *s, "flower_eval")?;
        String::from_utf8(self.call_bytes(
            s,
            &function,
            code.as_bytes(),
            super::max_json_bytes()?,
        )?)
        .context("guest result is not UTF-8")
    }
    pub(super) fn compile(&self, s: &mut Store<Host>, code: &str) -> Result<Vec<u8>> {
        let function = self.instance.get_typed_func(&mut *s, "flower_compile")?;
        self.call_bytes(
            s,
            &function,
            code.as_bytes(),
            super::super::config::settings()?.bytecode_max_bytes(),
        )
    }
    pub(super) fn bytecode(&self, s: &mut Store<Host>, bytes: &[u8]) -> Result<()> {
        let function = self.instance.get_typed_func(&mut *s, "flower_load")?;
        self.call_bytes(s, &function, bytes, super::max_json_bytes()?)
            .map(|_| ())
    }

    /// Reserve only while constructing an image, after initialization/GC. The
    /// allocation remains part of every pristine heap until its Store drops.
    pub(super) fn reserve_input(&self, s: &mut Store<Host>) -> Result<InputBuffer> {
        let pointer = self.alloc.call(&mut *s, InputBuffer::CAPACITY as i32)?;
        ensure!(pointer != 0, "guest allocation failed");
        let start = pointer as u32 as usize;
        super::dirty::prepare_write(s, start, InputBuffer::CAPACITY)?;
        self.memory
            .data_mut(s)
            .get_mut(
                start
                    ..start
                        .checked_add(InputBuffer::CAPACITY)
                        .context("input overflow")?,
            )
            .context("guest input bounds")?
            .fill(0);
        Ok(InputBuffer { pointer })
    }

    pub(super) fn invocation(
        &self,
        s: &mut Store<Host>,
        name: &str,
        args: &str,
        kind: &str,
        bytecode: Option<&[u8]>,
        input_buffer: InputBuffer,
    ) -> Result<Invocation> {
        let inputs = [
            name.as_bytes(),
            args.as_bytes(),
            kind.as_bytes(),
            bytecode.unwrap_or_default(),
        ];
        let size = inputs
            .iter()
            .try_fold(0usize, |total, input| total.checked_add(input.len() + 1))
            .context("invocation input overflow")?;
        let pointer = if size <= InputBuffer::CAPACITY {
            input_buffer.pointer
        } else {
            self.alloc.call(&mut *s, i32::try_from(size)?)?
        };
        ensure!(pointer != 0, "guest allocation failed");
        let start = pointer as u32 as usize;
        super::dirty::prepare_write(s, start, size)?;
        let memory = self
            .memory
            .data_mut(&mut *s)
            .get_mut(start..start.checked_add(size).context("input overflow")?)
            .context("guest input bounds")?;
        let mut fields = [0i32; 8];
        let mut offset = 0;
        for (index, input) in inputs.into_iter().enumerate() {
            fields[index * 2] = (start + offset) as u32 as i32;
            fields[index * 2 + 1] = i32::try_from(input.len())?;
            memory[offset..offset + input.len()].copy_from_slice(input);
            memory[offset + input.len()] = 0;
            offset += input.len() + 1;
        }
        if bytecode.is_none() {
            fields[6] = 0;
        }
        Ok(Invocation {
            parameters: (
                fields[0], fields[1], fields[2], fields[3], fields[4], fields[5], fields[6],
                fields[7],
            ),
        })
    }
    /// This callback is the last guest execution before its Store is discarded
    /// or fully restored. Its input and retained QuickJS CString disappear with
    /// that heap. Unlike
    /// setup results, invocation result pointers must never enter flower_free.
    pub(super) fn run_once(
        &self,
        s: &mut Store<Host>,
        invocation: Invocation,
    ) -> Result<CallbackResult> {
        Ok(CallbackResult(self.invoke.call(s, invocation.parameters)?))
    }

    /// Parse the suspended callback's result directly into owned Rust values.
    /// No guest entry or allocator call may occur before decoding completes.
    /// Setup eval/compile/load keep their separate copy-and-free result path.
    pub(super) fn callback_result(
        &self,
        s: &Store<Host>,
        result: CallbackResult,
    ) -> Result<serde_json::Value> {
        let bits = result.0 as u64;
        let pointer = bits as u32 as usize;
        let length = ((bits >> 32) & 0x7fff_ffff) as usize;
        ensure!(
            length <= super::max_json_bytes()?,
            "guest result exceeds limit"
        );
        ensure!(pointer != 0 || length == 0, "null guest result");
        let bytes = self
            .memory
            .data(s)
            .get(pointer..pointer.checked_add(length).context("result overflow")?)
            .context("guest result bounds")?;
        if bits >> 63 != 0 {
            bail!("guest: {}", String::from_utf8_lossy(bytes));
        }
        let encoded = std::str::from_utf8(bytes).context("guest result is not UTF-8")?;
        super::parse_json(encoded).context("invalid guest result JSON")
    }

    pub(super) fn response<S: AsContextMut<Data = Host>>(
        &self,
        s: &mut S,
        response: &str,
    ) -> Result<i64> {
        let pointer = self.bytes(s, response.as_bytes())?;
        Ok(((response.len() as u64) << 32 | pointer as u32 as u64) as i64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn invocation_buffer_has_exact_boundary_and_instance_private_bytes() {
        let runtime = super::super::cache::runtime().unwrap();
        let prepared = super::super::prepare("", super::super::tests::limits()).unwrap();
        let prefix = "test".len() + "query".len() + 4;
        for length in [
            0,
            InputBuffer::CAPACITY - prefix,
            InputBuffer::CAPACITY - prefix + 1,
            16384,
        ] {
            let mut store =
                super::super::store(&runtime.engine, super::super::tests::limits(), None);
            let instance = prepared.pre.instantiate(&mut store).unwrap();
            let abi = Abi::load_cached(&mut store, instance, &prepared.exports).unwrap();
            let args = "x".repeat(length);
            let invocation = abi
                .invocation(
                    &mut store,
                    "test",
                    &args,
                    "query",
                    None,
                    prepared.input_buffer,
                )
                .unwrap();
            let (
                name,
                name_length,
                arguments,
                argument_length,
                kind,
                kind_length,
                bytecode,
                bytecode_length,
            ) = invocation.parameters;
            assert_eq!(
                name == prepared.input_buffer.pointer,
                length + prefix <= InputBuffer::CAPACITY
            );
            assert_eq!(abi.string(&store, name, name_length, 64).unwrap(), "test");
            assert_eq!(
                abi.string(&store, arguments, argument_length, 16384)
                    .unwrap(),
                args
            );
            assert_eq!(abi.string(&store, kind, kind_length, 64).unwrap(), "query");
            assert_eq!((bytecode, bytecode_length), (0, 0));
            assert_eq!(abi.memory.data(&store)[arguments as usize + length], 0);

            // Allocator activity must not reclaim the reserved buffer. A second
            // live clone must still expose the pristine bytes, not this input.
            abi.bytes(&mut store, &[0xff; 8192]).unwrap();
            assert_eq!(
                abi.string(&store, arguments, argument_length, 16384)
                    .unwrap(),
                args
            );
            let mut pristine =
                super::super::store(&runtime.engine, super::super::tests::limits(), None);
            let instance = prepared.pre.instantiate(&mut pristine).unwrap();
            let fresh = Abi::load_cached(&mut pristine, instance, &prepared.exports).unwrap();
            let start = prepared.input_buffer.pointer as u32 as usize;
            assert!(
                fresh.memory.data(&pristine)[start..start + InputBuffer::CAPACITY]
                    .iter()
                    .all(|byte| *byte == 0)
            );
        }
    }

    #[test]
    fn reserved_input_is_charged_to_the_normal_instance_memory_budget() {
        let runtime = super::super::cache::runtime().unwrap();
        let prepared = super::super::prepare("", super::super::tests::limits()).unwrap();
        let minimum = prepared
            .pre
            .module()
            .get_export("memory")
            .unwrap()
            .memory()
            .unwrap()
            .minimum() as usize
            * 65536;
        let shared = super::super::Limits::new(
            std::time::Instant::now() + std::time::Duration::from_secs(30),
            minimum - 1,
        );
        let mut store = super::super::store(&runtime.engine, shared.clone(), None);
        assert!(prepared.pre.instantiate(&mut store).is_err());
        assert!(
            shared.check().is_err(),
            "snapshot memory, including scratch, keeps the sticky budget"
        );
    }

    #[test]
    fn disposable_callback_results_keep_errors_bounds_and_owned_values() {
        let shared = super::super::tests::limits();
        let runtime = super::super::cache::runtime().unwrap();
        let prepared = super::super::prepare("", shared.clone()).unwrap();
        let mut store = super::super::store(&runtime.engine, shared, None);
        let instance = prepared.pre.instantiate(&mut store).unwrap();
        let abi = Abi::load_cached(&mut store, instance, &prepared.exports).unwrap();
        let packed = |pointer: i32, length: usize, error: bool| {
            CallbackResult(
                (pointer as u32 as u64 | ((length as u64) << 32) | ((error as u64) << 63)) as i64,
            )
        };

        let input = r#"{"ok":true,"value":{"text":"a\u0000b🌸","nested":[true,null]}}"#;
        let pointer = abi.bytes(&mut store, input.as_bytes()).unwrap();
        let value = abi
            .callback_result(&store, packed(pointer, input.len(), false))
            .unwrap();

        let error = b"engine exception";
        let error_pointer = abi.bytes(&mut store, error).unwrap();
        assert_eq!(
            abi.callback_result(&store, packed(error_pointer, error.len(), true))
                .unwrap_err()
                .to_string(),
            "guest: engine exception"
        );
        let malformed = abi.bytes(&mut store, &[0xff]).unwrap();
        assert!(
            abi.callback_result(&store, packed(malformed, 1, false))
                .unwrap_err()
                .to_string()
                .contains("UTF-8")
        );
        assert!(
            abi.callback_result(&store, packed(0, 1, false))
                .unwrap_err()
                .to_string()
                .contains("null guest result")
        );
        assert!(
            abi.callback_result(&store, packed(i32::MAX, 1, false))
                .unwrap_err()
                .to_string()
                .contains("bounds")
        );
        assert!(
            abi.callback_result(
                &store,
                packed(pointer, super::super::max_json_bytes().unwrap() + 1, false)
            )
            .unwrap_err()
            .to_string()
            .contains("exceeds limit")
        );
        let trailing = abi.bytes(&mut store, b"{}[]").unwrap();
        assert!(
            abi.callback_result(&store, packed(trailing, 4, false))
                .unwrap_err()
                .to_string()
                .contains("invalid guest result JSON")
        );

        // All invocation buffers are discarded together; decoded strings must
        // remain valid after the Store and its entire linear memory disappear.
        drop(store);
        assert_eq!(
            value,
            json!({"ok":true,"value":{"text":"a\0b🌸","nested":[true,null]}})
        );
    }

    #[test]
    fn borrowed_guest_json_is_owned_before_memory_is_reused_and_rejects_bad_spans() {
        let shared = super::super::tests::limits();
        let runtime = super::super::cache::runtime().unwrap();
        let prepared = super::super::prepare("", shared.clone()).unwrap();
        let mut store = super::super::store(&runtime.engine, shared, None);
        let instance = prepared.pre.instantiate(&mut store).unwrap();
        let abi = Abi::load_cached(&mut store, instance, &prepared.exports).unwrap();
        let input = r#"["a\u0000b",{"😀":"é","nested":[true,null,1]}]"#;
        let pointer = abi.bytes(&mut store, input.as_bytes()).unwrap();
        let value = abi.json(&store, pointer, input.len() as i32).unwrap();
        super::super::dirty::prepare_write(&mut store, pointer as usize, 1).unwrap();
        abi.memory
            .write(&mut store, pointer as usize, &[0xff])
            .unwrap();
        assert_eq!(value, json!(["a\0b", {"😀":"é", "nested":[true,null,1]}]));
        assert!(
            abi.json(&store, pointer, input.len() as i32).is_err(),
            "malformed UTF-8"
        );
        assert!(
            abi.json(&store, i32::MAX, 1).is_err(),
            "out-of-bounds pointer"
        );
        assert!(
            abi.json(&store, pointer, -1).is_err(),
            "unsigned oversized span"
        );
        abi.free.call(&mut store, pointer).unwrap();
        let pointer = abi.bytes(&mut store, b"{}[]").unwrap();
        assert!(abi.json(&store, pointer, 4).is_err(), "trailing JSON input");
        abi.free.call(&mut store, pointer).unwrap();
    }
}
