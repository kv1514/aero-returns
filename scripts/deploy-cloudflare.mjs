// Builds AERO and deploys it to the Cloudflare account wrangler is logged in to.
// Usage: npm run deploy [-- --skip-build]. See docs/DEPLOY.md.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = JSON.parse(readFileSync(`${root}deploy/cloudflare.json`, "utf8"));
const configPath = `${root}dist/server/wrangler.json`;
const wrangler = `${root}node_modules/wrangler/bin/wrangler.js`;

function run(args, { input, capture = false } = {}) {
  const result = spawnSync(process.execPath, [wrangler, ...args, "--config", configPath], {
    cwd: root, input, encoding: "utf8", stdio: [input === undefined ? "inherit" : "pipe", capture ? "pipe" : "inherit", "inherit"],
    env: { ...process.env, CI: "true" },
  });
  if (result.status !== 0) throw new Error(`wrangler ${args.slice(0, 2).join(" ")} failed${result.error ? `: ${result.error.message}` : ""}`);
  return result.stdout;
}

if (!process.argv.includes("--skip-build")) {
  const build = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
config.name = target.worker;
// Pinned so a wrangler login with several accounts deploys to the right one without prompting.
if (target.accountId) config.account_id = target.accountId;
config.workers_dev = true;
config.preview_urls = false;
config.d1_databases = [{ binding: target.d1.binding, database_name: target.d1.name, database_id: target.d1.id, migrations_dir: "../../drizzle" }];
writeFileSync(configPath, JSON.stringify(config));

// The D1 API occasionally fails a request transiently; migrations are idempotent, so retry once.
try { run(["d1", "migrations", "apply", target.d1.binding, "--remote"]); }
catch { run(["d1", "migrations", "apply", target.d1.binding, "--remote"]); }
run(["deploy"]);

const secrets = JSON.parse(run(["secret", "list", "--format", "json"], { capture: true }) || "[]");
if (!secrets.some((s) => s.name === "DRONE_LINK_SECRET")) {
  // Generated here and never printed; per-drone keys are derived from it.
  run(["secret", "put", "DRONE_LINK_SECRET"], { input: randomBytes(32).toString("base64url") });
  console.log("Created DRONE_LINK_SECRET.");
}
