# Flower's QuickJS-NG guest

Flower vendors the unmodified core of [QuickJS-NG v0.17.0](https://github.com/quickjs-ng/quickjs/releases/tag/v0.17.0),
commit `6d46d07d04041b40f4f49eaa7fdebe44c314c699`, and builds its own small
[`flower.c`](flower.c) interface. [`SOURCES.json`](SOURCES.json) records every
upstream file's SHA-256, the upstream archive digest, compiler and static-library
revisions, and the final artifact digest. The upstream CLI, `quickjs-libc`, module
loaders, and examples are neither vendored nor linked.

The checked-in `quickjs.wasm` is **1,122,196 bytes**, SHA-256
`a48ba3c7f53381bd9129c1bb5b64623ab3fa89a608df172b67acaf8993b2bbf7`.
Rust embeds it with `include_bytes!` and verifies its digest and complete ABI
before compiling. Normal Cargo builds need no guest cross-compiler or WASI SDK;
native Rust dependencies may still require a host C compiler. Server operation
needs no SDK, Node, Python, network downloads, or external Wasm file.

## No WASI capabilities

The final module imports **exactly two functions**, `flower.host_call` and
`flower.crypto_call`. It has
**zero WASI imports**, imported memories, imported tables, or imported globals.
Its only exported resources are its memory and C shadow-stack pointer, alongside
nine private ABI functions. Initialization is explicit; it has no Wasm start
section.

The build uses WASI SDK 34's LLVM compiler and statically linked libc/math code
for allocation, string handling, and number formatting. This is a build
dependency, not a runtime interface: Flower does not instantiate a WASI context
or link WASI host functions. libc's file-operation hooks trap, and its stack
protector uses a fixed private canary with a trapping failure handler rather
than entropy or stderr. Internal QuickJS string-hash initialization uses a
constant seed. The raw context omits Date and performance intrinsics, and Flower
disables `Math.random` before loading application code. No OS, timer, process,
filesystem, network, or module-loader API is exposed. Entropy is available only
through the explicit crypto capability during an authorized mutation; it is
never captured in a reusable bundle-initialization snapshot.

Other JavaScript intrinsics remain available, including BigInt, maps, sets,
regular expressions, promises, weak references, typed arrays, `atob`, and `btoa`.
Database methods still require synchronous finite JSON results. The Wasm build
disables native atomics/threads via upstream's `__wasi__` compile-time branch.

The guest uses `-O3`, full link-time optimization, and standard WebAssembly SIMD
(`-msimd128`) so the compiler can vectorize string scans and copies. It does not
enable relaxed SIMD or fast-math; Wasmtime supports standard SIMD by default.
The database interface uses length-delimited JSON; crypto passes typed-array
bytes directly. End-to-end benchmarks determine throughput.

Before capturing a reusable base or initialized bundle image, the host invokes
the private `flower_snapshot_prepare` ABI. It collects unreachable cycles and
resets the collection threshold to live allocated bytes plus 50%, matching
QuickJS's normal post-collection policy. Each new cell therefore starts with
collection headroom instead of inheriting initialization garbage or a nearly
exhausted threshold. Automatic collection, memory limits, and execution limits
remain active during application execution. The ABI returns heap diagnostics
only during image preparation; it adds no host import or JavaScript capability.

## Pristine heaps with resident storage

Every callback begins with the same pristine heap and exported numeric globals.
Normally Wasmtime creates a new instance from the copy-on-write image. Within a
synchronous writer batch, Flower can instead reuse a thread-confined Store after
restoring that exact state. Before enabling restoration, Rust validates the final
Wizer module: mutable globals must be accessible, function tables must remain
immutable, and hidden state such as dropped segments or reference-valued globals
is rejected. The pristine byte copy counts toward the bounded image cache.

On Linux and macOS, reusable Stores initially protect their linear memory as
read-only. Wasmtime's per-Store signal hook makes each first-written native page
writable and records it in a preallocated bitmap. A page stays recorded for the
Store's lifetime; resetting copies every recorded page from the pristine image.
Untouched pages are still read-only and already pristine. Rust marks host-written
input and crypto buffers explicitly, including nested calls. There are no hashes
or assumptions about which application code will write which pages. macOS uses
Wasmtime's supported Unix signal mode; every Engine in the process must agree on
that mode.

The full-copy path remains available on unsupported platforms and when protection
setup fails. `FLOWER_WASM_DIRTY_PAGES=0` selects it explicitly;
`FLOWER_WASM_RECYCLE=0` disables resident reuse altogether. Traps, failed resource
checks and memory growth discard the Store. Before disposal, all protected pages
become writable again. A reset clears invocation inputs, closures, prototypes,
typed arrays, retained results and guest crypto state. Rust also detaches the
borrowed callback, drops per-call key/authorization caches, and charges a fresh
transaction allowance before the next call. Operating-system entropy remains
fresh and mutation-only.

Idle Stores consume Wasmtime pool slots. Retention is capped at half the
configured slots and `FLOWER_WASM_RECYCLE_BYTES` (96 MiB by default), disabled with
a single slot or a zero byte budget, and cleared when a
batch finishes or a writer must wait for admission/evaluation capacity. This
reduces spare capacity for unrelated work under very small pool configurations;
workers do not transfer Stores between threads to reclaim each other's slots.
An image larger than the byte budget still runs normally in fresh COW instances;
the budget limits caching rather than application heap capacity.

## Reproduce and verify

The vendored source subset is byte-for-byte upstream, with its MIT license in
[`upstream/LICENSE`](upstream/LICENSE). No upstream patch is required.
[`engine.c`](engine.c) includes the pinned engine and Flower's
[`json-check.c`](json-check.c), [`canonical-json.c`](canonical-json.c),
[`read-json.c`](read-json.c) and
[`crypto-view.c`](crypto-view.c) extensions in
one translation unit. The JSON extension checks its optimization assumptions
without invoking application getters. The crypto helper validates Uint8Array
views and reads their current length, including length-tracking resizable
buffers: this pinned engine's public typed-array accessors return the original
length after a resize. An engine upgrade must review both private-layout uses.
[`crypto.c`](crypto.c) handles the binary host ABI without changing upstream code.

Install the matching [WASI SDK 34 release](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-34).
For the macOS arm64 toolchain used to produce this artifact:

```sh
curl -fL https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sdk-34.0-arm64-macos.tar.gz -o wasi-sdk-34.0-arm64-macos.tar.gz
echo '9c59398106b417f8f14913380fdf0097a8cc0ff4af9eb3ce0065a859e88d49e9  wasi-sdk-34.0-arm64-macos.tar.gz' | shasum -a 256 -c -
tar -xzf wasi-sdk-34.0-arm64-macos.tar.gz
python3 vendor/quickjs-ng/build.py --sdk /path/to/wasi-sdk-34.0-arm64-macos --check
```

The script checks every vendored source digest and the compiler version, builds
in a temporary directory, validates the exact import/export signatures and
1 MiB stack layout, and requires a byte-for-byte match with the checked-in Wasm.
This was verified by rebuilding from a different working directory and output
path. Other host variants of the same pinned SDK can be supplied with `--sdk`;
they must produce the same digest to pass. `FLOWER_WASI_SDK` also selects the SDK.
Without that override, the script looks under the repository's `.tools` directory.

To inspect an existing checkout without any SDK:

```sh
python3 vendor/quickjs-ng/build.py --verify-only
node vendor/quickjs-ng/check-snapshot.mjs
```

An intentional guest change uses `--write`, which replaces the Wasm and updates
the artifact digest in `SOURCES.json`. Update Rust's embedded digest separately
and run the guest ABI, isolation/budget, differential, and integration tests.
Changing upstream requires explicitly updating its release, commit, archive
digest, and individual file digests; the script never silently downloads or
changes upstream code.

### Name guest functions in native profiles

Build a C-function-name sidecar without replacing the production guest:

```sh
python3 vendor/quickjs-ng/build.py --sdk /path/to/wasi-sdk-34.0-arm64-macos --symbols /tmp/guest-symbols.json
FLOWER_PROFILE_WASM_MAP=/tmp/flower-native ./target/release/flower <server arguments>
/usr/bin/sample <server-pid> 10 1 -file /tmp/flower-sample.txt
python3 scripts/profile-wasm.py /tmp/guest-symbols.json /tmp/flower-native.<server-pid>.jsonl /tmp/flower-sample.txt --output /tmp/flower-symbolized.txt
```

The sidecar build retains linker names and verifies that **every non-custom Wasm
section is byte-identical** to the checked-in guest. No guest artifact, ABI, or
hash changes. The optional runtime map records native code ranges when an image
is compiled; normal callbacks do not record profiling events. Each process writes
its own PID-suffixed JSONL file. Use a fresh output prefix, load the workload's
bundles, then sample that same running process. The symbolizer checks artifact
hashes and refuses ambiguous reused addresses. Its top-function counts come from
`sample`'s truncated top-of-stack summary, so they are diagnostic counts rather
than complete CPU percentages. Measure throughput separately without sampling.
For instruction-level inspection, also set `FLOWER_PROFILE_WASM_CODE=1`: each
compiled image writes a native `.bin` text sidecar, named by the map record's
`code_path`. Function offsets and lengths select its disassembly ranges. This
adds compilation-time disk output only and is disabled by default.

Static-library licensing notices are in [`licenses/`](licenses/), including
musl, dlmalloc, wasi-libc, and LLVM compiler-rt. The libc source revision is
`2e6fb9d8ee0cdf9e431fbcabe8af3115de000a13`; LLVM is
`895aa2c896ada719451be2e3673c83da8ddf1141`.

## Private ABI

This ABI is internal and versioned by the embedded artifact digest. Pointers and
lengths are 32-bit, all text is UTF-8, and embedded NUL bytes are length-delimited.
A packed 64-bit result contains its pointer in bits 0–31, byte length in bits
32–62, and an exception-text flag in bit 63. Setup results from evaluation,
compilation, bytecode loading, and snapshot preparation own malloc buffers that
must be released with `flower_free`.

`flower_invoke` is the final execution before the guest heap is discarded or
restored. Its success and exception results retain QuickJS CString storage until
that reset; **never pass invocation result pointers to `flower_free`**. Rust
decodes directly from the suspended guest into owned values before replacing
the heap, avoiding an extra output allocation/copy and guest heap teardown.

| Function | Purpose |
| --- | --- |
| `_initialize()` | Explicit no-op entry point used by Wizer. |
| `flower_init() -> i32` | Create the runtime/context and trusted bootstrap helpers; zero means success. |
| `flower_alloc(length) -> pointer` | Allocate a guest buffer; allocation failure traps. |
| `flower_free(pointer)` | Release a guest buffer. |
| `flower_eval(source, length) -> packed` | Strict script evaluation; return its result as text. |
| `flower_compile(source, length) -> packed` | Compile a script into trusted QuickJS bytecode. |
| `flower_load(bytecode, length) -> packed` | Execute trusted bytecode; success is zero, failure is packed exception text. |
| `flower_invoke(name, name_length, args, args_length, kind, kind_length, bytecode, bytecode_length) -> packed` | Bind invocation strings, optionally load cached bytecode, and call the privately retained cell runner in one crossing. |
| `flower_snapshot_prepare() -> packed` | Collect initialization garbage, reset GC headroom, and return setup-only heap diagnostics. |

The database import, `flower.host_call(method, method_length, payload, payload_length)
-> packed`, synchronously invokes Rust's database machinery. The response is a
JSON envelope allocated in the same guest using `flower_alloc`. The private
parsed bridge feeds that buffer directly into QuickJS's JSON parser before
freeing it; the public compatibility bridge creates a JavaScript string instead.
Guards preserve the original JavaScript expression when application code changes
its intrinsics. Rust may recursively evaluate a different cell with its own
fresh Store and memory.

The crypto import is
`flower.crypto_call(operation, parameter, spans_pointer, span_count, result_pointer) -> i32`.
All five arguments are i32; zero return indicates a filled result descriptor.
The guest exposes a non-writable private JavaScript primitive
`__flowerCrypto(operation, parameter, ...inputs)`. Operation and parameter must
be unsigned 32-bit numbers. Inputs must be primitive strings or Uint8Array
views, except the opaque shared-handle slot of operations 201/202. Strings use QuickJS's native UTF-8 conversion; Uint8Array inputs cross as
raw bytes with their actual offset and current length, without JSON or base64.
QuickJS preserves unmatched UTF-16 surrogates in its C-string conversion; Rust
text operations must reject ill-formed UTF-8. JSON-encoded claims/options escape
unmatched surrogates before crossing, and binary inputs have no text restriction.
Proxies, other typed arrays, shared buffers, detached buffers, and out-of-bounds
views are rejected before calling Rust. No application getters or coercions run
while pointers are borrowed. Positional arguments keep their buffers alive, and
owned UTF-8 strings remain retained through the synchronous host call.

Each input span is two little-endian u32 fields `{ pointer, length }`. The result
is three u32 fields `{ kind, pointer, length_or_integer }`:

| Kind | Result |
| --- | --- |
| 0 | Uint8Array adopting the host's `flower_alloc` buffer. |
| 1 / 2 / 3 | `false` / `true` / `null`; other fields must be zero. |
| 4 | Signed i32 carried in `length_or_integer`; pointer must be zero. |
| 5 | UTF-8 error message, thrown as a JavaScript Error. |
| 6 | UTF-8 JavaScript string. |
| 7 | Opaque native SharedKey, with a private nonzero slot in `length_or_integer`; pointer must be zero. |

Rust must finish reading input memory before reentering guest allocation, and
reacquire memory views if allocation grows Wasm memory. Byte results transfer
ownership to an ArrayBuffer with a matching libc realloc/free hook: C does not
copy the result a second time. String/error buffers are freed after creating
the JS string. Empty byte or string results still carry an owned nonnull
allocation. Failed adoption frees the raw buffer; later typed-array construction
failure releases the already-owned ArrayBuffer normally. QuickJS currently
limits ArrayBuffers to `INT32_MAX` bytes, a representation constraint in addition
to operator-configured memory and crypto budgets. The bridge adds no small
argument-count or byte-length cap. Host budget failures trap outside JavaScript;
ordinary crypto failures use the error result kind.

Entropy operation zero is permitted by C only while `flower_invoke` is calling
its privately retained runner. The flag is reset on ordinary return and thrown
exceptions; trapped Stores are discarded. It remains disabled while loading a
per-invocation bundle before the runner call. The Rust host additionally checks
that the current callback is a mutation, preventing query/derived callbacks from
obtaining entropy even when evaluated inside a mutation. Pure crypto operations
remain available during initialization.

Managed-key operation 200 is also restricted to the private runner. Its four
spans contain a public JSON descriptor and three binary argument slots. Rust
resolves the declared capability against the invocation's committed catalog;
the generic JSON host import cannot resolve keys. Unwrapped bytes and prepared
contexts never enter the guest or its reusable COW image. A precomputed NaCl box
key receives an opaque, invocation-local QuickJS native object backed by a Rust context.
Its deterministic slot is C-private and exposes no entropy, token, or key bytes.
Operations 201/202 accept this class directly; numeric slots, proxies, copied
properties and copied prototypes fail before any Rust host call.

`flower_eval` and `flower_compile` require a NUL byte after the declared source
length, as required by QuickJS's parser. All other buffers use explicit lengths.
Bytecode is only generated from the current pinned guest; it is not an external
serialization format or accepted from clients.

Trusted base initialization captures the native JSON checker and parsed database
bridge in a private runner closure. `__flowerSetRunner` retains that runner in
the C image and deletes the temporary bootstrap globals before application initialization. Application code
can neither replace the runner through a global assignment nor bypass validation
with a lexical variable named `__flowerCheckJson` or `globalThis`.

The native JSON fast path accepts proven-valid ordinary trees. It checks finite
numbers, plain/null object prototypes, data descriptors, symbol/non-enumerable
properties, array holes, cycles, and the 128-level depth limit. Ordinary objects
and dense fast arrays are inspected directly through the pinned engine's shape
and value slots, without allocating own-key vectors or property descriptors.
Array length and class/layout guards prove density before inspecting elements;
other layouts retain the general property path. Invalid values,
proxies, global lexical shadows, and relevant intrinsic/prototype monkeypatches
return to the unchanged JavaScript validator. The native probe performs no
application callbacks, so restarting through JavaScript preserves proxy trap
ordering and exact error behavior. `JSON.stringify` remains unchanged, including
inherited `toJSON` behavior. Guards also cover Set methods, descriptor prototype
pollution, and array iterator `next`/`return` hooks.

After validation, the private parsed bridge uses QuickJS's exact JSON stringify
intrinsic and parses the Rust reply directly from its buffer. This avoids an
intermediate JavaScript response string and additional JavaScript builtin calls.
Raw guards first verify `JSON`, `JSON.stringify`, `JSON.parse`, and
`__flowerRead`, including global lexical shadows. Changed bindings fall back to
the original JavaScript expression before any observable work. Stringification
hooks still run in order; callees captured before those hooks remain the ones
used for the in-flight call. The public string-returning `__flowerRead` is unchanged.

The SDK also captures the immutable `__flowerCanonicalJson` capability. It
encodes finite JSON scalars and ordinary dense arrays containing only scalars
through the pinned engine's primitive JSON emitter, preserving number spelling,
negative zero, escaping and lone UTF-16 surrogates. It never stringifies the
whole array, so inherited `toJSON` remains ignored as in the SDK. Proxies, holes,
accessors, named/symbol properties, compound values and changed relevant
intrinsics return an `undefined` sentinel without user callbacks; the SDK then
runs its complete TypeScript canonicalizer, including sorting and depth checks.
This helper is a permanent read-only, nonconfigurable binding installed before
application initialization; the SDK captures its bare identifier rather than
trusting a replaceable `globalThis` property lookup.

Maintainer-only differential/routing tests and an optional microbenchmark run
directly against the guest:

```sh
node vendor/quickjs-ng/check-json.mjs
node vendor/quickjs-ng/check-canonical.mjs
node vendor/quickjs-ng/check-crypto.mjs
node vendor/quickjs-ng/check-read.mjs
node vendor/quickjs-ng/check-invoke.mjs
node vendor/quickjs-ng/check-json.mjs vendor/quickjs-ng/quickjs.wasm --bench
FLOWER_CANONICAL_BENCH=1 node vendor/quickjs-ng/check-canonical.mjs
```

The crypto ABI harness checks typed-array offsets, resizing, detachment, UTF-8,
output ownership, memory growth, error propagation, and the entropy initialization
guard. Rust tests separately validate the actual algorithms and budgets.

The microbenchmark uses Node's Wasm engine to isolate validator cost; it is not
a production Wasmtime or end-to-end throughput measurement. Production tests
also compare full Rust/Wasm evaluations with the original JavaScript coordinator
running inside the same vendored QuickJS Wasm guest.

Wasmtime enforces the shared memory/deadline budgets. The Rust adapter also
instruments every write of the exported C stack pointer, trapping before the
1 MiB stack crosses its reserved lower guard region. QuickJS's catchable native
stack/heap limits are disabled. Compiled code, base snapshots, and explicit
static-initialization bundle snapshots are reused; each cell gets fresh logical
memory with copy-on-write where supported. No mutable application heap is pooled
between invocations.
