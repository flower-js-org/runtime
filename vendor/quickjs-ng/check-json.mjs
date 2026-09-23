// Standalone guest differential checks and an optional validator microbenchmark.
// Node is a maintainer tool here; production executes the guest with Wasmtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

const filename = process.argv[2] ?? new URL('./quickjs.wasm', import.meta.url);
const module = new WebAssembly.Module(fs.readFileSync(filename));
const frozen = fs.readFileSync(new URL('../../src/evaluator/reference-cell-runner.js', import.meta.url), 'utf8');
const validator = frozen.slice(frozen.indexOf('    function checkJson('), frozen.indexOf('    function ref('));
assert(validator.includes('function checkJson('));
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function guest() {
  const { exports: api } = new WebAssembly.Instance(module, {
    flower: { host_call() { throw new Error('validator must not call the database'); }, crypto_call() { throw new Error('validator must not call crypto'); } },
  });
  assert.equal(api.flower_init(), 0);
  const execute = (source) => {
    const bytes = encoder.encode(`${source}\0`);
    const pointer = api.flower_alloc(bytes.length);
    new Uint8Array(api.memory.buffer, pointer, bytes.length).set(bytes);
    const packed = BigInt.asUintN(64, api.flower_eval(pointer, bytes.length - 1));
    api.flower_free(pointer);
    const output = Number(packed & 0xffffffffn);
    const length = Number((packed >> 32n) & 0x7fffffffn);
    const value = decoder.decode(new Uint8Array(api.memory.buffer, output, length));
    api.flower_free(output);
    if (packed >> 63n) throw new Error(value);
    return value;
  };
  execute(`Object.defineProperty(globalThis,'__testNativeCheck',{value:__flowerCheckJson});
    __flowerSetRunner(()=>'{"ok":true,"value":null}');
    if(Object.hasOwn(globalThis,'__flowerCheckJson')||Object.hasOwn(globalThis,'__flowerSetRunner'))
      throw Error('bootstrap capabilities escaped');`);
  return execute;
}

const cases = [
  ['null', '', 'null', true],
  ['primitive', '', '4.25', true],
  ['ordinary', '', '({name:"flower", nested:[true,null,{ok:1}], unicode:"🌸\\u0000🌻"})', true],
  ['null prototype', '', 'Object.assign(Object.create(null),{value:[1,2]})', true],
  ['shared references', 'const shared={a:1};', '({a:shared,b:shared})', true],
  ['extra array property', 'const extra=[1];extra.note={x:true};', 'extra', true],
  ['deleted shape slots', 'const slots={first:1,gone:2,last:3};delete slots.gone;slots.again={ok:true};', 'slots', true],
  ['reinserted numeric keys', 'const slots={9:"nine",2:"two",x:1};delete slots[2];slots[2]="again";', 'slots', true],
  ['frozen object', '', 'Object.freeze({x:1,nested:Object.freeze([1,2])})', true],
  ['sealed array', '', 'Object.seal([1,{x:2}])', true],
  ['null array prototype', 'const values=[1,{x:2}];Object.setPrototypeOf(values,null);', 'values', true],
  ['truncated dense array', 'const values=[1,2,3];values.length=1;', 'values', true],
  ['extended array holes', 'const values=[1,2];values.length=4;', 'values', false],
  ['deleted array element', 'const values=[1,2,3];delete values[1];', 'values', false],
  ['refilled array hole', 'const values=[1,2,3];delete values[1];values[1]=4;', 'values', true],
  ['explicit undefined element', '', '[1,undefined,3]', false],
  ['array symbol key', 'const values=[1];values[Symbol("extra")]=2;', 'values', false],
  ['array accessor key', 'const values=[1];Object.defineProperty(values,"extra",{enumerable:true,get(){trace.push("getter");return 2}});', 'values', false],
  ['array self reference', 'const values=[1];values.push(values);', 'values', false],
  ['boxed number plain prototype', 'const boxed=new Number(3);Object.setPrototypeOf(boxed,Object.prototype);', 'boxed', true],
  ['reverse numeric proxy slots', 'const slots={};slots[9]=new Proxy({x:9},{ownKeys(t){trace.push("nine");return Reflect.ownKeys(t)}});slots[2]=new Proxy({x:2},{ownKeys(t){trace.push("two");return Reflect.ownKeys(t)}});', 'slots', false],
  ['NaN', '', 'NaN', false],
  ['infinity', '', 'Infinity', false],
  ['undefined', '', 'undefined', false],
  ['bigint', '', '1n', false],
  ['function', '', '()=>0', false],
  ['function plain prototype', 'const fn=()=>0;Object.setPrototypeOf(fn,Object.prototype);', 'fn', false],
  ['symbol', '', 'Symbol("x")', false],
  ['symbol key', '', '({[Symbol("x")]:1})', false],
  ['nonenumerable', '', 'Object.defineProperty({x:1},"hidden",{value:2})', false],
  ['accessor', '', '({get value(){trace.push("get");return 1}})', false],
  ['sparse', '', '[1,,3]', false],
  ['custom prototype', '', 'Object.create({})', false],
  ['cycles', 'const cycle={};cycle.self=cycle;', 'cycle', false],
  ['129 deep', 'let deep=null;for(let i=0;i<129;i++)deep={deep};', 'deep', false],
  ['128 deep', 'let deep=null;for(let i=0;i<128;i++)deep={deep};', 'deep', true],
  ['129 deep arrays', 'let deep=null;for(let i=0;i<129;i++)deep=[deep];', 'deep', false],
  ['128 deep arrays', 'let deep=null;for(let i=0;i<128;i++)deep=[deep];', 'deep', true],
  ['proxy', '', 'new Proxy({a:1},{ownKeys(t){trace.push("keys");return Reflect.ownKeys(t)},getOwnPropertyDescriptor(t,k){trace.push(k);return Object.getOwnPropertyDescriptor(t,k)}})', false],
  ['nested proxy', '', '({a:{ok:1},b:new Proxy({c:2},{ownKeys(t){trace.push("keys");return Reflect.ownKeys(t)}})})', false],
  ['revoked proxy', 'const rev=Proxy.revocable({},{});rev.revoke();', 'rev.proxy', false],
  ['finite monkeypatch', 'Number.isFinite=()=>true;', 'NaN', false],
  ['lexical Number', 'let Number={isFinite:()=>true};', 'NaN', false],
  ['lexical Set', 'const RealSet=globalThis.Set;let Set=class extends RealSet{constructor(){super();trace.push("new Set")}};', '({x:1})', false],
  ['prototype monkeypatch', 'Object.getPrototypeOf=()=>null;', 'new Map()', false],
  ['array monkeypatch', 'Array.isArray=()=>true;', '({length:1,0:1})', false],
  ['ownKeys monkeypatch', 'Reflect.ownKeys=()=>[];', '({get x(){return 1}})', false],
  ['global accessor', 'const RealSet=Set;Object.defineProperty(globalThis,"Set",{get(){trace.push("Set getter");return RealSet}});', '({x:1})', false],
  ['inherited descriptor value', 'Object.prototype.value=3;', '({get x(){return 1}})', false],
  ['iterator hook', 'const proto=Object.getPrototypeOf([][Symbol.iterator]());const next=proto.next;proto.next=function(){trace.push("next");return next.call(this)};', '({x:1})', false],
  ['iterator return hook', 'Object.getPrototypeOf([][Symbol.iterator]()).return=function(){trace.push("return");return {done:true}};', '({x:undefined})', false],
  ['Object iterator return hook', 'Object.prototype.return=function(){trace.push("return");return {done:true}};', '({x:undefined})', false],
  ['Set monkeypatch', 'const has=Set.prototype.has;Set.prototype.has=function(v){trace.push("has");return has.call(this,v)};', '({x:1})', false],
  ['lexical validator shadow', 'let __flowerCheckJson=()=>true;', 'undefined', false],
  ['global validator shadow', 'globalThis.__flowerCheckJson=()=>true;', 'Infinity', false],
  ['lexical globalThis shadow', 'let globalThis={__flowerCheckJson:()=>true};', '()=>0', false],
];

for (const [name, setup, expression, fast] of cases) {
  const source = (optimized, probe) => `${validator}\nconst trace=[];${setup}\nconst value=${expression};
    ${probe ? 'JSON.stringify({fast:__testNativeCheck(value),trace})' : `
    let outcome;try{${optimized ? 'if(!__testNativeCheck(value))' : ''}checkJson(value);outcome="ok"}
    catch(error){outcome={name:error.name,message:error.message}}JSON.stringify({outcome,trace})`}`;
  assert.deepEqual(JSON.parse(guest()(source(true, false))), JSON.parse(guest()(source(false, false))), name);
  const probed = JSON.parse(guest()(source(true, true)));
  assert.equal(probed.fast, fast, `${name}: native routing`);
  assert.deepEqual(probed.trace, [], `${name}: native probing must have no side effects`);
}
console.log(`${cases.length} native-validator differential/routing cases passed.`);

if (process.argv.includes('--bench')) {
  const samples = [];
  const shapes = [
    ['three-field arguments', '[{kind:"collection",name:"tips"},"shop-1",{shopId:"shop-1",amount:1,worker:"goblin"}]', 20000],
    ['six-shop leaderboard', 'Array.from({length:6},(_,i)=>({id:String(i),name:"Goblin Pizza",open:5,waiting:4,baking:3,delivering:2,done:100,failed:0,pizzas:125,revenue:1200,tips:42,workers:3,rank:i+1}))', 2000],
  ];
  for (const [name, shape, iterations] of shapes) {
    const execute = guest();
    execute(`${validator}\nvar sample=${shape};if(!__testNativeCheck(sample))throw Error("unexpected fallback");`);
    for (let round = 0; round < 7; round++) {
      for (const native of round % 2 ? [true, false] : [false, true]) {
        const started = performance.now();
        execute(`for(let i=0;i<${iterations};i++){${native ? 'if(!__testNativeCheck(sample))' : ''}checkJson(sample)};"ok"`);
        const elapsed = performance.now() - started;
        if (round) samples.push({name, native, us: elapsed * 1000 / iterations});
      }
    }
  }
  for (const [name] of shapes) {
    const median = (native) => samples.filter(x => x.name === name && x.native === native).map(x => x.us).sort((a,b)=>a-b)[3];
    const interpreted = median(false), optimized = median(true);
    console.log(JSON.stringify({name, engine:'Node WebAssembly maintainer microbenchmark; not production Wasmtime throughput', interpretedUs:interpreted, nativeWithGuardUs:optimized, speedup:interpreted/optimized}));
  }
}
