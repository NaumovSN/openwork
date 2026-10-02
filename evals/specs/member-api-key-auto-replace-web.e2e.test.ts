import { createServer } from "node:http";
import { expect } from "vitest";
import { server, spec } from "@openwork/testkit";
import { chrome, setViewport, denFetch } from "@openwork/testkit";
import { connectionResponse, inventoryResponse, tokenResponse, requireOwnedDen } from "./member-api-key-fixture";
const test = spec.world(async () => ({}), { timeout: 240_000, needs: { optIn: ["OPENWORK_EVAL_E2E_TESTS"], placement: "local" } });

test("caller auth rejection exposes Web Replace and successful replacement leaves other member unchanged", async ({ place, user, evidence }) => {
  requireOwnedDen();
  const fixture = createServer(async (req, res) => {
    const chunks: Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));
    const rpc=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):null;
    if(!rpc?.id&&rpc?.id!==0){res.writeHead(202).end();return;}
    let result;
    if(rpc.method==="initialize")result={protocolVersion:rpc.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"Auth fixture",version:"1"}};
    else if(rpc.method==="tools/list")result={tools:[{name:"identity_probe",description:"Fixture",inputSchema:{type:"object"}}]};
    else if(req.headers.authorization==="Bearer fixture-alice-old"){res.writeHead(401).end();return;}
    else result={isError:false,content:[{type:"text",text:"fixture healthy"}]};
    res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:rpc.id,result}));
  });
  await new Promise<void>(r=>fixture.listen(0,"127.0.0.1",r));
  await using owned={ [Symbol.asyncDispose]:()=>new Promise<void>((r,j)=>{fixture.closeAllConnections();fixture.close(e=>e?j(e):r());}) };
  void owned;
  const address=fixture.address();if(!address||typeof address==="string")throw Error("Fixture did not bind");
  await using den=await server({place,web:true,env:{DEN_ALLOW_PRIVATE_MCP_URLS:"1"},org:{name:"Replace UI fixture",members:{alice:{},blair:{}}}});
  const api=(member:typeof den.admin,path:string,body?:unknown,method="POST")=>denFetch(member,path,{method,headers:{authorization:`Bearer ${member.token}`},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const created=await api(den.admin,"/v1/mcp-connections",{name:"Private service",url:`http://127.0.0.1:${address.port}/mcp`,authType:"apikey",credentialMode:"per_member",access:{orgWide:true}});
  expect(created.response.status).toBe(200);const id=String(connectionResponse.parse(created.body).id);
  for(const [member,key]of [[den.members.alice,"fixture-alice-old"],[den.members.blair,"fixture-blair"]]){
    if(typeof member==="string"||typeof key!=="string")throw Error("Invalid pair");
    expect((await api(member,`/v1/mcp-connections/${id}/member-api-key`,{apiKey:key})).response.status).toBe(200);
  }
  const invoke=async(member:typeof den.admin)=>{
    const minted=await api(member,"/v1/mcp/token",{scopes:["mcp:read","mcp:write"]});expect(minted.response.status).toBe(200);
    const r=await fetch(den.ref.apiUrl+"/mcp/agent",{method:"POST",headers:{authorization:`Bearer ${tokenResponse.parse(minted.body).token}`,"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"execute_capability",arguments:{name:`mcp:${id}:identity_probe`,body:{}}}}),signal:AbortSignal.timeout(30000)});
    const raw=await r.text(),line=raw.split("\n").find(l=>l.startsWith("data:"));return JSON.parse(line?line.slice(5):raw);
  };
  expect((await invoke(den.members.alice)).result.isError).toBe(true);
  await using aliceBrowser=await chrome({name:"rejected-key-member",host:place.host(),startUrl:den.ref.webUrl,headless:true});
  await setViewport(aliceBrowser,{width:1440,height:1000,deviceScaleFactor:1});
  const alice=user.on(aliceBrowser);
  await alice.see({role:"textbox",label:/^email$/i});await alice.type({role:"textbox",label:/^email$/i},den.members.alice.email);
  await alice.click({role:"button",label:"Next"});await alice.see({role:"textbox",label:/^password$/i});
  await alice.type({role:"textbox",label:/^password$/i},den.members.alice.password,{sensitive:true});await alice.click({role:"button",label:"Sign in"});
  await alice.see({testId:"den-org-sidebar"},{timeoutMs:60000});await alice.navigate(den.ref.webUrl+"/dashboard/your-connections");
  await alice.see({role:"button",label:"Replace key"},{timeoutMs:30000});await alice.screenshot();
  await alice.click({role:"button",label:"Replace key"});
  await alice.see({role:"heading",label:"Replace key for Private service"});
  await alice.type({label:"Private service key"},"fixture-alice-new",{sensitive:true});await alice.click({role:"button",label:"Save key"});
  await alice.see({role:"heading",label:"Private service: key saved"},{timeoutMs:30000});await alice.screenshot();
  await alice.click({role:"button",label:"Done"});await alice.see({role:"button",label:"Replace key"});
  expect((await invoke(den.members.alice)).result.isError).not.toBe(true);
  expect((await invoke(den.members.blair)).result.isError).not.toBe(true);
  const rows=await api(den.members.blair,"/v1/mcp-connections?scope=usable",undefined,"GET");
  expect(inventoryResponse.parse(rows.body).connections.find((row:{id:string})=>row.id===id)).toMatchObject({needsReconnect:false,connectedForMe:true});
  evidence.recordAssertionEvidence("Actual isolated Web replacement flow after transport rejection",
    "The real Den/Chrome fixture showed the rejected caller's Replace key button, existing masked replacement dialog and Key saved acknowledgement; Alice's next tool call worked and Blair remained connected. The synthetic witness returns HTTP 401 rather than matching tool error text; no real product acceptance is claimed. Screenshots require separate visual review.",true);
});
