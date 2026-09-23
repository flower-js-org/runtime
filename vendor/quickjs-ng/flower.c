/* Flower's private QuickJS-NG Wasm ABI. SPDX-License-Identifier: MIT */
#include "quickjs.h"
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <sys/types.h>

#define EXPORT(name) __attribute__((export_name(name)))
#define ERROR_BIT (UINT64_C(1) << 63)

/* The JSON database capability. Both arguments and results are UTF-8 strings.
 * The host allocates its response with flower_alloc in this same guest. */
__attribute__((import_module("flower"), import_name("host_call")))
extern uint64_t flower_host_call(const char *, uint32_t, const char *, uint32_t);

static JSRuntime *runtime;
static JSContext *context;
static JSValue cell_runner = JS_UNDEFINED;
/* Owned atoms live exactly as long as this single-runtime guest. Reusing their
 * IDs avoids interning/refcount pairs without precreating global properties. */
enum { BIND_NAME, BIND_ARGS, BIND_KIND, BIND_COUNT };
static JSAtom invocation_bindings[BIND_COUNT];
extern int flower_json_init(JSContext *ctx);
extern int flower_canonical_init(JSContext *ctx);
extern int flower_read_init(JSContext *ctx);
extern int flower_crypto_init(JSContext *ctx);
extern int flower_crypto_callback_active;

/* QuickJS seeds its internal string hash in JS_NewContextRaw. Deterministic
 * zero is deliberate: no ambient clock/randomness is available to this guest.
 * Date and performance intrinsics are never installed. */
int gettimeofday(struct timeval *restrict tv, void *restrict timezone) {
    (void)timezone;
    tv->tv_sec = 0;
    tv->tv_usec = 0;
    return 0;
}

/* No process or I/O capability, including on internal engine assertion paths. */
_Noreturn void abort(void) { __builtin_trap(); }
/* The statically linked libc has stack-protected helpers. Its default failure
 * handler imports random_get and stderr; this guest uses a fixed canary
 * and an uncatchable trap. Wasmtime also guards the C shadow stack explicitly. */
uintptr_t __stack_chk_guard = UINT32_C(0x9e3779b9);
_Noreturn void __stack_chk_fail(void) { __builtin_trap(); }
int printf(const char *restrict format, ...) {
    (void)format;
    __builtin_trap();
}
/* musl's formatting core is also used by snprintf. Its unreachable file-backed
 * branches still take addresses of these hooks; supply traps instead of linking
 * descriptor operations. In-memory snprintf keeps its own buffer-write hook. */
int __stdio_close(FILE *file) { (void)file; __builtin_trap(); }
size_t __stdio_write(FILE *file, const unsigned char *bytes, size_t length) {
    (void)file; (void)bytes; (void)length; __builtin_trap();
}
off_t __stdio_seek(FILE *file, off_t offset, int origin) {
    (void)file; (void)offset; (void)origin; __builtin_trap();
}

static uint64_t pack(const void *pointer, size_t length, int error) {
    if (length > INT32_MAX) __builtin_trap();
    return (uint32_t)(uintptr_t)pointer | ((uint64_t)length << 32)
        | (error ? ERROR_BIT : 0);
}

EXPORT("flower_alloc") void *flower_alloc(size_t size) {
    void *pointer = malloc(size ? size : 1);
    if (!pointer) __builtin_trap();
    return pointer;
}

EXPORT("flower_free") void flower_free(void *pointer) { free(pointer); }

static uint64_t copy_result(const void *source, size_t length, int error) {
    void *pointer = flower_alloc(length + 1);
    memcpy(pointer, source, length);
    ((char *)pointer)[length] = 0;
    return pack(pointer, length, error);
}

static uint64_t exception_result(void) {
    JSValue error = JS_GetException(context);
    size_t length = 0;
    const char *text = JS_ToCStringLen(context, &length, error);
    uint64_t result = text
        ? copy_result(text, length, 1)
        : copy_result("unreadable QuickJS exception", 27, 1);
    if (text) JS_FreeCString(context, text);
    JS_FreeValue(context, error);
    return result;
}

/* Setup calls consume value and copy into a flower_free-owned malloc buffer.
 * These calls may continue running the same guest while building an image. */
static uint64_t value_result(JSValue value) {
    if (JS_IsException(value)) return exception_result();
    size_t length = 0;
    const char *text = JS_ToCStringLen(context, &length, value);
    if (!text) {
        JS_FreeValue(context, value);
        return exception_result();
    }
    uint64_t result = copy_result(text, length, 0);
    JS_FreeCString(context, text);
    JS_FreeValue(context, value);
    return result;
}

/* Invocation is the final execution before Store disposal or pristine reset.
 * Keep QuickJS's CString reference until that full reset instead of allocating
 * and copying another buffer, then tearing down a heap about to be replaced.
 * These pointers must never be passed to flower_free: QuickJS's string arena
 * has different bookkeeping. Both successful and exceptional returns follow
 * this ownership rule; eval/compile/load keep their independent owned buffers. */
static uint64_t invocation_exception(void) {
    JSValue error = JS_GetException(context);
    size_t length = 0;
    const char *text = JS_ToCStringLen(context, &length, error);
    static const char unreadable[] = "unreadable QuickJS exception";
    return text ? pack(text, length, 1)
                : pack(unreadable, sizeof(unreadable) - 1, 1);
}

static uint64_t invocation_result(JSValue value) {
    if (JS_IsException(value)) return invocation_exception();
    size_t length = 0;
    const char *text = JS_ToCStringLen(context, &length, value);
    return text ? pack(text, length, 0) : invocation_exception();
}

static JSValue read_host_internal(JSContext *ctx, int argc,
                                  JSValueConst *argv, int parsed) {
    if (argc != 2) return JS_ThrowTypeError(ctx, "expected method and JSON arguments");
    size_t method_length, payload_length;
    const char *method = JS_ToCStringLen(ctx, &method_length, argv[0]);
    if (!method) return JS_EXCEPTION;
    /* ToString may reenter the host bridge; hold each owned C string until its
     * matching conversion has completed, then use explicit lengths throughout. */
    const char *payload = JS_ToCStringLen(ctx, &payload_length, argv[1]);
    if (!payload) {
        JS_FreeCString(ctx, method);
        return JS_EXCEPTION;
    }
    uint64_t response = flower_host_call(method, method_length, payload, payload_length);
    JS_FreeCString(ctx, payload);
    JS_FreeCString(ctx, method);
    char *pointer = (char *)(uintptr_t)(uint32_t)response;
    size_t length = (response >> 32) & INT32_MAX;
    JSValue value = parsed && !(response & ERROR_BIT)
        ? JS_ParseJSON(ctx, pointer, length, "<input>")
        : JS_NewStringLen(ctx, pointer, length);
    flower_free(pointer);
    return (response & ERROR_BIT) && !JS_IsException(value) ? JS_Throw(ctx, value) : value;
}

static JSValue read_host(JSContext *ctx, JSValueConst this_value,
                         int argc, JSValueConst *argv) {
    (void)this_value;
    return read_host_internal(ctx, argc, argv, 0);
}

JSValue flower_read_parsed_host(JSContext *ctx, JSValueConst method,
                                JSValueConst payload) {
    JSValueConst arguments[] = {method, payload};
    return read_host_internal(ctx, 2, arguments, 1);
}

/* Called only by trusted bootstrap before any application code. Keep the runner
 * in the C image, inaccessible through JS globals, and erase the bootstrap API.
 * The runner's private closure holds the native validator, so application global
 * or lexical names cannot replace validation or the execution entry point. */
static JSValue set_runner(JSContext *ctx, JSValueConst this_value,
                          int argc, JSValueConst *argv) {
    (void)this_value;
    if (argc != 1 || !JS_IsFunction(ctx, argv[0]) || !JS_IsUndefined(cell_runner))
        return JS_ThrowTypeError(ctx, "invalid Flower runner initialization");
    cell_runner = JS_DupValue(ctx, argv[0]);
    JSValue global = JS_GetGlobalObject(ctx);
    const char *names[] = {"__flowerCheckJson", "__flowerReadParsed", "__flowerSetRunner"};
    for (unsigned i = 0; i < sizeof(names) / sizeof(names[0]); ++i) {
        JSAtom atom = JS_NewAtom(ctx, names[i]);
        if (atom == JS_ATOM_NULL) {
            JS_FreeValue(ctx, global);
            return JS_EXCEPTION;
        }
        int result = JS_DeleteProperty(ctx, global, atom, JS_PROP_THROW);
        JS_FreeAtom(ctx, atom);
        if (result < 0) {
            JS_FreeValue(ctx, global);
            return JS_EXCEPTION;
        }
    }
    JS_FreeValue(ctx, global);
    return JS_UNDEFINED;
}

EXPORT("_initialize") void flower_initialize(void) {}

EXPORT("flower_init") int flower_init(void) {
    if (runtime) return -1;
    runtime = JS_NewRuntime();
    if (!runtime) return -1;
    JS_SetMemoryLimit(runtime, 0);
    JS_SetMaxStackSize(runtime, 0);
    context = JS_NewContextRaw(runtime);
    if (!context) return -1;
    if (JS_AddIntrinsicBaseObjects(context) || JS_AddIntrinsicEval(context)
        || JS_AddIntrinsicRegExp(context) || JS_AddIntrinsicJSON(context)
        || JS_AddIntrinsicProxy(context) || JS_AddIntrinsicMapSet(context)
        || JS_AddIntrinsicTypedArrays(context) || JS_AddIntrinsicPromise(context)
        || JS_AddIntrinsicWeakRef(context) || JS_AddIntrinsicAToB(context)
        || flower_json_init(context) || flower_canonical_init(context)
        || flower_crypto_init(context) < 0) return -1;
    JSValue global = JS_GetGlobalObject(context);
    JSValue callback = JS_NewCFunction(context, read_host, "__flowerRead", 2);
    int status = JS_SetPropertyStr(context, global, "__flowerRead", callback);
    if (status >= 0) status = flower_read_init(context);
    if (status >= 0) status = JS_DefinePropertyValueStr(context, global, "__flowerSetRunner",
        JS_NewCFunction(context, set_runner, "__flowerSetRunner", 1), JS_PROP_CONFIGURABLE);
    JS_FreeValue(context, global);
    if (status < 0) return -1;
    const char *names[BIND_COUNT] = {"__name", "__argsJson", "__kind"};
    for (unsigned i = 0; i < BIND_COUNT; ++i) {
        invocation_bindings[i] = JS_NewAtom(context, names[i]);
        if (invocation_bindings[i] == JS_ATOM_NULL) return -1;
    }
    return 0;
}

EXPORT("flower_eval") uint64_t flower_eval(const char *source, size_t length) {
    return value_result(JS_Eval(context, source, length, "<flower>", JS_EVAL_FLAG_STRICT));
}

EXPORT("flower_compile") uint64_t flower_compile(const char *source, size_t length) {
    JSValue value = JS_Eval(context, source, length, "<flower>",
        JS_EVAL_FLAG_STRICT | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(value)) return exception_result();
    size_t byte_length = 0;
    uint8_t *bytecode = JS_WriteObject(context, &byte_length, value, JS_WRITE_OBJ_BYTECODE);
    JS_FreeValue(context, value);
    if (!bytecode) return exception_result();
    uint64_t result = copy_result(bytecode, byte_length, 0);
    js_free(context, bytecode);
    return result;
}

static int load_bytecode(const uint8_t *bytecode, size_t length) {
    JSValue value = JS_ReadObject(context, bytecode, length, JS_READ_OBJ_BYTECODE);
    if (JS_IsException(value)) return -1;
    value = JS_EvalFunction(context, value);
    if (JS_IsException(value)) return -1;
    JS_FreeValue(context, value);
    return 0;
}

EXPORT("flower_load") uint64_t flower_load(const uint8_t *bytecode, size_t length) {
    return load_bytecode(bytecode, length) < 0 ? exception_result() : 0;
}

/* Trusted host-only image preparation. Snapshotting an arbitrary point in the
 * allocator's cycle can put every fresh instance just below the next full-heap
 * cycle collection. Collect initialization garbage once, then give each clone
 * the same 50% allocation headroom that QuickJS itself grants after auto-GC.
 * Automatic collection during execution and the host memory limiter remain on.
 * JS_RunGC does not reset its threshold; that must be done explicitly here. */
EXPORT("flower_snapshot_prepare") uint64_t flower_snapshot_prepare(void) {
    if (!runtime || !context || flower_crypto_callback_active) __builtin_trap();
    JSMemoryUsage before, after;
    size_t previous_threshold = JS_GetGCThreshold(runtime);
    JS_ComputeMemoryUsage(runtime, &before);
    JS_RunGC(runtime);
    JS_ComputeMemoryUsage(runtime, &after);
    size_t live = (size_t)after.malloc_size;
    size_t threshold = live > SIZE_MAX - (live >> 1) ? SIZE_MAX : live + (live >> 1);
    JS_SetGCThreshold(runtime, threshold);
    char diagnostics[384];
    int length = snprintf(diagnostics, sizeof(diagnostics),
        "{\"bytesBefore\":%lld,\"bytesAfter\":%lld,\"objectsBefore\":%lld,"
        "\"objectsAfter\":%lld,\"thresholdBefore\":%zu,\"thresholdAfter\":%zu}",
        (long long)before.malloc_size, (long long)after.malloc_size,
        (long long)before.obj_count, (long long)after.obj_count,
        previous_threshold, threshold);
    if (length < 0 || (size_t)length >= sizeof(diagnostics)) __builtin_trap();
    return copy_result(diagnostics, (size_t)length, 0);
}

static int bind_string(JSValueConst global, JSAtom key, const char *value, size_t length) {
    JSValue string = JS_NewStringLen(context, value, length);
    if (JS_IsException(string)) return -1;
    /* JS_SetPropertyStr calls this same throwing setter after interning its
     * name. Keep inherited/own setters, readonly checks and insertion order. */
    return JS_SetProperty(context, global, key, string);
}

EXPORT("flower_invoke") uint64_t flower_invoke(
    const char *name, size_t name_length, const char *args, size_t args_length,
    const char *kind, size_t kind_length, const uint8_t *bytecode, size_t bytecode_length) {
    JSValue global = JS_GetGlobalObject(context);
    if (bind_string(global, invocation_bindings[BIND_NAME], name, name_length) < 0
        || bind_string(global, invocation_bindings[BIND_ARGS], args, args_length) < 0
        || bind_string(global, invocation_bindings[BIND_KIND], kind, kind_length) < 0
        || (bytecode && load_bytecode(bytecode, bytecode_length) < 0)) {
        JS_FreeValue(context, global);
        return invocation_exception();
    }
    flower_crypto_callback_active = 1;
    JSValue result = JS_Call(context, cell_runner, global, 0, NULL);
    flower_crypto_callback_active = 0;
    JS_FreeValue(context, global);
    return invocation_result(result);
}
