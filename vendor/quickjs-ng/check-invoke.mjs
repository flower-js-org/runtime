// Setup results own malloc buffers; terminal invocation results retain a
// QuickJS CString until the entire instance is discarded.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const module = new WebAssembly.Module(readFileSync(new URL("./quickjs.wasm", import.meta.url)));
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
const argumentsJson = '{"text":"unicode 🌸\\u0000tail"}';

for (const [runner, expected, error, setup = ""] of [
  ['()=>__argsJson', '{"text":"unicode 🌸\\u0000tail"}', false],
  ['()=>"large 🌸\\0".repeat(16384)', "large 🌸\0".repeat(16384), false],
  ['()=>{throw Error("exception 🌸\\0tail")}', 'Error: exception 🌸\0tail', true],
  ['()=>({toString(){throw Error("conversion 🌸\\0tail")}})', 'Error: conversion 🌸\0tail', true],
  ['()=>({toString(){throw {toString(){throw null}}}})', 'unreadable QuickJS exception', true],
  ['()=>{let sum=0;outer:for(let i=0;i<5;i++){for(let j=0;j<5;j++){if(i===3)break outer;if(j===2)continue;sum+=i*10+j}}return String(sum)}', "144", false],
  ['()=>{let sum=0;for(let i=0;i<10;i++)switch(i%3){case 0:sum+=1;break;case 1:sum+=2;break;default:sum+=3}return String(sum)}', "19", false],
  ['()=>{let x=0;function f(){try{try{throw 7}catch(n){x+=n;return x}}finally{x+=2}}const result=f();return result+","+x}', "7,9", false],
  ['()=>[...function*(){try{yield 1;throw Error("caught")}catch(error){yield 2}finally{yield 3}}()].join(",")', "1,2,3", false],
  ['()=>{function factorial(n){return n<=1?1:n*factorial(n-1)}return String(factorial(10))}', "3628800", false],
  ['()=>JSON.stringify([Object.keys(globalThis).slice(-3),["__name","__argsJson","__kind"].map(k=>{const d=Object.getOwnPropertyDescriptor(globalThis,k);return [d.value,d.writable,d.enumerable,d.configurable]})])',
    JSON.stringify([["__name", "__argsJson", "__kind"], [["test", true, true, true], [argumentsJson, true, true, true], ["query", true, true, true]]]), false],
  ['()=>JSON.stringify([events,["__name","__argsJson","__kind"].map(k=>Object.hasOwn(globalThis,k))])',
    JSON.stringify([[["__name", "test", true], ["__argsJson", argumentsJson, true], ["__kind", "query", true]], [false, false, false]]), false,
    'let events=[];for(const key of ["__name","__argsJson","__kind"])Object.defineProperty(Object.prototype,key,{configurable:true,set(value){events.push([key,value,this===globalThis])}});'],
  ['()=>seen', "test", false,
    'let seen;Object.defineProperty(globalThis,"__name",{configurable:true,set(value){seen=value}});'],
  ['()=>"unreachable"', /read.only/i, true,
    'Object.defineProperty(globalThis,"__name",{value:"fixed",writable:false});'],
  ['()=>"unreachable"', /read.only/i, true,
    'Object.defineProperty(Object.prototype,"__kind",{value:"fixed",writable:false});'],
]) {
  const { exports: api } = new WebAssembly.Instance(module, { flower: {
    host_call() { throw Error("unexpected database call"); },
    crypto_call() { throw Error("unexpected crypto call"); },
  } });
  assert.equal(api.flower_init(), 0);
  const input = (text) => {
    const bytes = encoder.encode(text + "\0");
    const pointer = api.flower_alloc(bytes.length);
    new Uint8Array(api.memory.buffer, pointer, bytes.length).set(bytes);
    return [pointer, bytes.length - 1];
  };
  const output = (raw, owned) => {
    const packed = BigInt.asUintN(64, raw);
    const pointer = Number(packed & 0xffffffffn), length = Number((packed >> 32n) & 0x7fffffffn);
    const text = decoder.decode(new Uint8Array(api.memory.buffer, pointer, length));
    if (owned) api.flower_free(pointer);
    return [text, Boolean(packed >> 63n)];
  };
  // Repeated setup eval/free remains valid before entering the terminal ABI.
  for (let i = 0; i < 3; ++i) {
    const source = input('"setup 🌸"');
    assert.deepEqual(output(api.flower_eval(...source), true), ["setup 🌸", false]);
    api.flower_free(source[0]);
  }
  const source = input(`${setup}__flowerSetRunner(${runner});`);
  assert.deepEqual(output(api.flower_eval(...source), true), ["undefined", false]);
  api.flower_free(source[0]);
  const fields = [input("test"), input(argumentsJson), input("query")];
  const actual = output(api.flower_invoke(...fields.flat(), 0, 0), false);
  if (expected instanceof RegExp) {
    assert.equal(actual[1], error);
    assert.match(actual[0], expected);
  } else assert.deepEqual(actual, [expected, error]);
  // No further entry or allocator cleanup: production drops this whole Store.
}
console.log("Terminal invocation: ownership, Unicode, control flow, errors, binding setters, attributes and enumeration order passed");
