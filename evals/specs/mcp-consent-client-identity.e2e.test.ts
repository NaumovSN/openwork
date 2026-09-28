import { spec } from "@openwork/testkit";
import { mcpConsentClientIdentity } from "../worlds/mcp-consent-client-identity.ts";

const test = spec.world(mcpConsentClientIdentity, {
  timeout: 300_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den"] },
});

test("a member sees which app is asking and where it returns before authorizing MCP access", async ({ world, user, step, evidence }) => {
  const person = user.on(world.web);

  await step("given a member who signs in from the app's authorization link", async () => {
    await person.navigate(world.loopback.url);
    await person.see({ role: "textbox", label: /^email$/i }, { timeoutMs: 90_000 });
    await person.type({ role: "textbox", label: /^email$/i }, world.admin.email);
    await person.click({ role: "button", label: "Next" });
    await person.type({ role: "textbox", label: /^password$/i }, world.admin.password);
    await person.click({ role: "button", label: "Sign in" });
    evidence.recordAssertionEvidence("The member signs in through the normal sign-in page", world.admin.email, true);
  });

  await step("after: an app that returns to this computer is named, with its return address and a warning", async () => {
    await person.see({ testId: "mcp-client-name", text: world.loopback.name }, { timeoutMs: 90_000 });
    await person.see({ testId: "mcp-redirect-host", text: world.loopback.redirectHost });
    await person.see({ testId: "mcp-loopback-warning" });
    evidence.recordAssertionEvidence(
      "The consent card names the app and its loopback return address, and warns",
      `App "${world.loopback.name}"; returns to ${world.loopback.redirectHost}; loopback warning shown`,
      true,
    );
    await person.screenshot();
  });

  await step("an app that returns to a public website is named without the loopback warning", async () => {
    await person.navigate(world.hosted.url);
    await person.see({ testId: "mcp-client-name", text: world.hosted.name }, { timeoutMs: 60_000 });
    await person.see({ testId: "mcp-redirect-host", text: world.hosted.redirectHost });
    await person.notSee({ testId: "mcp-loopback-warning" });
    evidence.recordAssertionEvidence(
      "A public return address carries no loopback warning",
      `App "${world.hosted.name}"; returns to ${world.hosted.redirectHost}; no warning`,
      true,
    );
    await person.screenshot();
  });

  await step("the card shows the app's registered name, never its raw client identifier", async () => {
    await person.see({ testId: "mcp-client-name", text: world.hosted.name });
    await person.notSee({ text: world.hosted.clientId });
    await person.see({ text: "Use your connected tools, including actions that create, change, or delete data" });
    evidence.recordAssertionEvidence("No opaque client id on the card", `client id ${world.hosted.clientId.slice(0, 6)}… absent; name "${world.hosted.name}" shown; mcp:write listed as "Use your connected tools, including actions…"`, true);
  });

  await step("an app that shared no name is called that, with the host to check", async () => {
    await person.navigate(world.unnamed.url);
    await person.see({ testId: "mcp-client-name", text: "An app without a name" }, { timeoutMs: 60_000 });
    await person.see({ testId: "mcp-redirect-host", text: world.unnamed.redirectHost });
    await person.see({ testId: "mcp-unnamed-app-line" });
    await person.see({ text: `This app did not share its name. Only continue if you know ${world.unnamed.redirectHost} and started this sign-in.` });
    await person.see({ role: "button", label: "Authorize this app" });
    evidence.recordAssertionEvidence("An unnamed app names the host to check", `returns to ${world.unnamed.redirectHost}; guidance line shown`, true);
    await person.screenshot();
  });

  await step("the consent step names the app, the workspace and the return address, with Deny as a quiet action", async () => {
    await person.navigate(await world.consentUrl(world.loopback.authorizePath));
    await person.see({ text: `Allow ${world.loopback.name} to use` }, { timeoutMs: 60_000 });
    await person.see({ testId: "mcp-redirect-host", text: world.loopback.redirectHost });
    await person.see({ testId: "mcp-loopback-warning" });
    await person.see({ role: "button", label: `Authorize ${world.loopback.name}` });
    await person.see({ role: "button", label: "Deny" });
    await person.notSee({ text: /OpenWork MCP|Authorize MCP access/ });
    await person.screenshot();
  });

  await step("an unnamed app's consent step names the host to check", async () => {
    await person.navigate(await world.consentUrl(world.unnamed.authorizePath));
    await person.see({ text: "Allow this app to use" }, { timeoutMs: 60_000 });
    await person.see({ testId: "mcp-unnamed-app-line" });
    await person.screenshot();
  });
});
