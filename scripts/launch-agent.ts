import { readOwnerOnlyEnvironment } from "../src/launch-env.js";

const envFile = process.argv[2];
if (!envFile) throw new Error("launch-agent: expected an environment file path");

const parsed = readOwnerOnlyEnvironment(envFile);
for (const [key, value] of Object.entries(parsed)) process.env[key] = value;
process.umask(0o077);
await import("../src/index.js");
