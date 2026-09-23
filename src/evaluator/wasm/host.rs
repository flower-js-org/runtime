use super::{Host, check_json, error_envelope, max_json_bytes};
use anyhow::{Result, ensure};
use serde_json::Value;
use wasmtime::{Caller, Engine, Linker};

type HostCall<'a> = dyn FnMut(&str, Value) -> Result<Value> + 'a;

#[derive(Clone, Copy)]
pub(super) struct Callback {
    data: *mut (),
    call: unsafe fn(*mut (), &str, Value) -> Result<Value>,
}
impl Callback {
    /// Caller must keep the borrowed bridge alive for every synchronous guest
    /// Store that contains this token. Tokens are detached or their Store is
    /// dropped before execute() returns; a recycled Store never retains one.
    pub(super) unsafe fn scoped(bridge: &mut &mut HostCall<'_>) -> Self {
        unsafe fn dispatch(data: *mut (), method: &str, args: Value) -> Result<Value> {
            // SAFETY: execute owns the pointed-to bridge on its stack, and
            // synchronous Wasmtime callbacks cannot outlive that scope.
            let callback = unsafe { &mut *(data as *mut &mut HostCall<'static>) };
            callback(method, args)
        }
        Self {
            data: (bridge as *mut &mut HostCall<'_>).cast(),
            call: dispatch,
        }
    }
    pub(super) unsafe fn invoke(self, method: &str, args: Value) -> Result<Value> {
        // SAFETY: same scoped execution invariant as scoped().
        unsafe { (self.call)(self.data, method, args) }
    }
}

fn host_call(
    mut caller: Caller<'_, Host>,
    method_pointer: i32,
    method_length: i32,
    payload_pointer: i32,
    payload_length: i32,
) -> wasmtime::Result<i64> {
    (|| -> Result<i64> {
        caller.data().shared.check()?;
        let abi = caller
            .data()
            .abi
            .clone()
            .ok_or_else(|| anyhow::anyhow!("guest ABI not bound"))?;
        let method = abi.string(&caller, method_pointer, method_length, 64)?;
        ensure!(!method.contains('\0'), "invalid host method");
        // Only the binary crypto bridge may resolve native key envelopes.
        // Application code can call the generic host import directly, so this
        // boundary cannot rely on the SDK hiding an operation name.
        ensure!(method != "managedKey", "native-only host operation");
        let payload = abi.json(&caller, payload_pointer, payload_length)?;
        // The transport argument-list wrapper does not consume one level of
        // each business value's 128-level JSON allowance.
        if let Value::Array(args) = &payload {
            for arg in args {
                check_json(arg)?;
            }
        } else {
            check_json(&payload)?;
        }
        let callback = caller.data().callback.ok_or_else(|| {
            anyhow::anyhow!("database access is unavailable during bundle initialization")
        })?;
        // SAFETY: callbacks can only be bound by execute, which holds the borrowed
        // bridge until this Store has been dropped or completely reset. Take a copy of
        // the token, releasing the Host borrow before nested calls can execute.
        let response = match unsafe { callback.invoke(&method, payload) } {
            Ok(value) => {
                check_json(&value)?;
                Ok(value)
            }
            Err(error) => Err(error_envelope(error)),
        };
        caller.data().shared.check()?;
        let response = match response {
            Ok(value) => super::super::json_order::ordered_success(&value)?,
            Err(error) => super::super::json_order::ordered_value(&error)?,
        };
        ensure!(
            response.len() <= max_json_bytes()?,
            "host result exceeds FLOWER_RESULT_MAX_BYTES"
        );
        // C owns and frees this returned buffer after constructing a JS string.
        abi.response(&mut caller, &response)
    })()
    .map_err(wasmtime::Error::from_anyhow)
}

pub(super) fn linker(engine: &Engine) -> Result<Linker<Host>> {
    let mut linker = Linker::new(engine);
    linker.func_wrap("flower", "host_call", host_call)?;
    linker.func_wrap("flower", "crypto_call", super::crypto::call)?;
    Ok(linker)
}
