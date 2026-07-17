import { execSync, spawn } from "node:child_process";
import { cpSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const COMPLETION_MARKER = "Exported: dist";

// The export signs every manifest variant with the OTA code-signing private
// key (scripts/generate-update-manifest.mjs). Fail loudly BEFORE the long
// `expo export` when the key material is missing, pointing at the setup script
// -- there is no unsigned mode. See docs/ota-updates.md#code-signing.
const CODE_SIGNING_KEYS = [
  join("certs", "private-key.pem"),
  join("certs", "certificate.pem"),
];
const missingKeys = CODE_SIGNING_KEYS.filter((p) => !existsSync(p));
if (missingKeys.length > 0) {
  console.error(
    `[export-web] Missing OTA code-signing keys: ${missingKeys.join(", ")}.\n`
      + "  Run `node scripts/generate-code-signing-keys.mjs` first (once per clone).\n"
      + "  There is no unsigned mode -- see docs/ota-updates.md#code-signing.",
  );
  process.exit(1);
}

function copyHtmlToClient() {
  const serverDir = join("dist", "server");
  const clientDir = join("dist", "client");
  const htmlFiles = readdirSync(serverDir).filter((f) => f.endsWith(".html"));
  for (const file of htmlFiles) {
    cpSync(join(serverDir, file), join(clientDir, file));
  }
  console.log(
    `[export-web] Copied ${htmlFiles.length} HTML file(s) to dist/client`,
  );
}

const child = spawn("npx", ["expo", "export", "-p", "web"], {
  stdio: ["inherit", "pipe", "pipe"],
  detached: true,
});

let killed = false;

function scheduleKill() {
  if (killed) return;
  killed = true;
  copyHtmlToClient();

  // Kill the web export child process
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Process already exited
  }

  // Export native bundles and generate the OTA update manifest
  try {
    console.log("[export-web] Exporting native bundles (ios + android)...");
    execSync(
      "npx expo export --platform ios --platform android --output-dir dist/native-export",
      { stdio: "inherit" },
    );

    console.log("[export-web] Generating OTA update manifest...");
    execSync("node scripts/generate-update-manifest.mjs", {
      stdio: "inherit",
    });
  } catch (err) {
    console.error("[export-web] Native export failed:", err.message);
    process.exit(1);
  }

  process.exit(0);
}

function onData(stream, chunk) {
  stream.write(chunk);
  if (chunk.toString().includes(COMPLETION_MARKER)) {
    scheduleKill();
  }
}

child.stdout.on("data", (chunk) => onData(process.stdout, chunk));
child.stderr.on("data", (chunk) => onData(process.stderr, chunk));

child.on("close", (code) => {
  if (!killed) {
    process.exit(code ?? 1);
  }
});

child.on("error", (err) => {
  console.error(`[export-web] Failed to start export: ${err.message}`);
  process.exit(1);
});
