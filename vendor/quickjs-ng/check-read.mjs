// Compare the private parsed bridge with its original JS expression, including
// hooks that change those globals during argument serialization.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const module = new WebAssembly.Module(readFileSync(new URL("./quickjs.wasm", import.meta.url)));
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });

function evaluate(setup, expression, native, reply, hostError = false) {
  const calls = [];
  let api;
  ({ exports: api } = new WebAssembly.Instance(module, { flower: {
    host_call(method, methodLength, payload, payloadLength) {
      calls.push([
        decoder.decode(new Uint8Array(api.memory.buffer, method, methodLength)),
        decoder.decode(new Uint8Array(api.memory.buffer, payload, payloadLength)),
      ]);
      if (reply === "TRAP") throw new WebAssembly.RuntimeError("host budget trap");
      const bytes = encoder.encode(reply);
      const pointer = api.flower_alloc(bytes.length + 1);
      new Uint8Array(api.memory.buffer, pointer, bytes.length).set(bytes);
      new Uint8Array(api.memory.buffer)[pointer + bytes.length] = 0;
      return BigInt.asIntN(64, BigInt(pointer) | (BigInt(bytes.length) << 32n) | (hostError ? 1n << 63n : 0n));
    },
    crypto_call() { throw Error("unexpected crypto call"); },
  } }));
  assert.equal(api.flower_init(), 0);
  const run = (code) => {
    const bytes = encoder.encode(code + "\0"), pointer = api.flower_alloc(bytes.length);
    new Uint8Array(api.memory.buffer, pointer, bytes.length).set(bytes);
    const packed = BigInt.asUintN(64, api.flower_eval(pointer, bytes.length - 1));
    api.flower_free(pointer);
    const output = Number(packed & 0xffffffffn), length = Number((packed >> 32n) & 0x7fffffffn);
    const text = decoder.decode(new Uint8Array(api.memory.buffer, output, length));
    api.flower_free(output);
    if (packed >> 63n) throw Error(text);
    return text;
  };
  run(`const stringify=JSON.stringify, originalRead=__flowerRead, nativeRead=__flowerReadParsed;
    function fast(method,args){const parsed=nativeRead(method,args);return parsed===undefined?JSON.parse(__flowerRead(method,JSON.stringify(args))):parsed}
    function reference(method,args){return JSON.parse(__flowerRead(method,JSON.stringify(args)))}
    __flowerSetRunner(()=>"null");
    if(Object.hasOwn(globalThis,'__flowerReadParsed'))throw Error('private helper leaked');`);
  try {
    const output = run(`let trace="";${setup}
      let result;try{result={ok:true,value:${native ? "fast" : "reference"}("get",${expression})}}catch(error){result={ok:false,text:String(error)}}
      stringify({result,trace});`);
    return { output: JSON.parse(output), calls };
  } catch (error) {
    return { error: String(error), calls };
  }
}

const cases = [
  ["plain", "", '["tenant",{"text":"🌸\\u0000tail"}]'],
  ["proxy stringify order", "", 'new Proxy({a:1,b:2},{get(t,k,r){trace+="get:"+String(k)+";";return Reflect.get(t,k,r)},ownKeys(t){trace+="keys;";return Reflect.ownKeys(t)},getOwnPropertyDescriptor(t,k){trace+="descriptor:"+k+";";return Reflect.getOwnPropertyDescriptor(t,k)}})'],
  ["toJSON", "", '({toJSON(){trace+="toJSON;";return [1,2]}})'],
  ["toJSON changes callees", "", '({toJSON(){trace+="toJSON;";JSON.parse=()=>{throw Error("new parse")};__flowerRead=()=>{throw Error("new read")};return [1,2]}})'],
  ["toJSON installs successful read", "", '({toJSON(){trace+="toJSON;";__flowerRead=()=>\'{"ok":true,"value":"replacement"}\';return [1,2]}})'],
  ["nested host call", "", '({toJSON(){trace+="toJSON;";originalRead("nested","[]");return [1,2]}})'],
  ["toJSON undefined", "", '({toJSON(){trace+="toJSON;";return undefined}})'],
  ["toJSON throws", "", '({toJSON(){trace+="toJSON;";throw Error("stringify 🌸")}})'],
  ["stringify wrapper", 'JSON.stringify=(v)=>{trace+="stringify;";return stringify(v)};', '[1,2]'],
  ["parse wrapper", 'const parse=JSON.parse;JSON.parse=(v)=>{trace+="parse;";return parse(v)};', '[1,2]'],
  ["read wrapper", '__flowerRead=(...args)=>{trace+="read;";return originalRead(...args)};', '[1,2]'],
  ["parse accessor", 'const parse=JSON.parse;Object.defineProperty(JSON,"parse",{get(){trace+="parse getter;";return parse}});', '[1,2]'],
  ["read accessor", 'Object.defineProperty(globalThis,"__flowerRead",{get(){trace+="read getter;";return originalRead}});', '[1,2]'],
  ["lexical JSON", 'let JSON={parse(v){trace+="parse lexical;";return {ok:true,value:v}},stringify(v){trace+="stringify lexical;";return "[]"}};', '[1,2]'],
  ["lexical read", 'let __flowerRead=()=>{trace+="read lexical;";return \'{"ok":true,"value":"lexical"}\'};', '[1,2]'],
  ["private helper shadow", 'let __flowerReadParsed=()=>{throw Error("spoofed")};', '[1,2]'],
];
const reply = JSON.stringify({ ok: true, value: { text: "reply 🌸\0é", keys: ["😀", "\ue000"], number: 1e21 } });
for (const [name, setup, expression] of cases) {
  assert.deepEqual(evaluate(setup, expression, true, reply), evaluate(setup, expression, false, reply), name);
}
for (const [name, response, error] of [
  ["business error", '{"ok":false,"error":{"code":"FAIL","message":"business 🌸"}}', false],
  ["invalid response", "invalid JSON", false],
  ["error flag", "host error 🌸\0tail", true],
  ["budget trap", "TRAP", false],
]) {
  assert.deepEqual(evaluate("", "[]", true, response, error), evaluate("", "[]", false, response, error), name);
}
console.log(`Parsed host bridge: ${cases.length + 4} differential ordering, fallback, UTF-8, error and trap vectors passed`);
