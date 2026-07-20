import { describe, expect, it } from "vitest";
import { escapeXmlText, renderLaunchdTemplate } from "./launchd-template.js";

describe("launchd template rendering", () => {
  it("escapes every XML-sensitive path character", () => {
    expect(escapeXmlText(`/Users/Dan & Co/<bridge>/"node"/'env'`))
      .toBe("/Users/Dan &amp; Co/&lt;bridge&gt;/&quot;node&quot;/&apos;env&apos;");
  });

  it("renders all placeholders without exposing raw path text", () => {
    const rendered = renderLaunchdTemplate(
      "__NODE_BIN__|__REPO_DIR__|__ENV_FILE__|__HOME__",
      {
        nodeBin: "/opt/Node & Tools/node",
        repoDir: "/Users/Dan/<bridge>",
        envFile: "/Users/Dan/Config & Secrets/copilot.env",
        home: "/Users/Dan",
      },
    );
    expect(rendered).toBe(
      "/opt/Node &amp; Tools/node|/Users/Dan/&lt;bridge&gt;|"
      + "/Users/Dan/Config &amp; Secrets/copilot.env|/Users/Dan",
    );
    expect(rendered).not.toMatch(/__[A-Z_]+__/);
  });

  it("rejects unknown unresolved placeholders", () => {
    expect(() => renderLaunchdTemplate("__UNKNOWN_PATH__", {
      nodeBin: "/node",
      repoDir: "/repo",
      envFile: "/env",
      home: "/home",
    })).toThrow(/unresolved placeholder/);
  });
});
