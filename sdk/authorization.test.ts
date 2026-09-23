import assert from "node:assert/strict";
import test from "node:test";
import { define, query, mutation, FlowerClient } from "./index.ts";
import type { AuthorizationRequest, Principal } from "./index.ts";

test("authorization is private and must be a fresh query", () => {
  const authorize=query("policy", (_ctx, _request:AuthorizationRequest):Principal|null=>({subject:"alice"}));
  const app=define({authorize,http:{read:query("read",ctx=>ctx.principal())}});
  assert.deepEqual(app.authorize,{name:"policy"});
  assert.equal(app.http.policy,undefined);
  assert.throws(()=>define({authorize:mutation("bad",()=>null) as never}),/read-only/);
  assert.throws(()=>define({authorize:query("bad",()=>null,{consistency:"replica-local"})}),/read-only/);
});

test("SDK refreshes credentials independently of stable mutation identity", async () => {
  const bodies:any[]=[];
  let version=0;
  const client=new FlowerClient("http://localhost:7101",{
    credentials:()=>({token:++version}),
    fetch:async(_url,init)=>{
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({revision:1,value:null,duplicate:false}));
    },
  });
  await client.mutate("update",{x:1},{requestId:"intent"});
  await client.mutate("update",{x:1},{requestId:"intent"});
  assert.equal(bodies[0].requestId,bodies[1].requestId);
  assert.deepEqual(bodies[0].args,bodies[1].args);
  assert.deepEqual(bodies.map(x=>x.credentials),[{token:1},{token:2}]);
  await client.partition("store").query("read",null,{credentials:"override"});
  assert.equal(bodies[2].credentials,"override");
});
