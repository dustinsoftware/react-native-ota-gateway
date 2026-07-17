/**
 * Generates the RSA keypair + self-signed X.509 certificate that expo-updates
 * uses to authenticate OTA manifests (the Expo Updates Protocol v1
 * `expo-signature` mechanism).
 *
 * Writes:
 *   certs/private-key.pem   Signs each manifest variant at export time
 *                           (scripts/generate-update-manifest.mjs). Must never
 *                           leave the machine that exports.
 *   certs/certificate.pem   Baked into the native hosts at prebuild (iOS
 *                           Expo.plist EXUpdatesCodeSigningCertificate, Android
 *                           manifest meta-data expo.modules.updates.CODE_SIGNING_CERTIFICATE)
 *                           and verifies signatures on-device.
 *
 * Both files are gitignored: this is a public template with no shared key, so
 * every clone generates its own pair. Run once per clone before the first
 * export or prebuild -- both fail loudly until the key material exists (there
 * is no unsigned mode). See docs/ota-updates.md#code-signing.
 *
 * The keyid is "main" and the algorithm is rsa-v1_5-sha256; those live in
 * app.json's updates.codeSigningMetadata (baked into the hosts), not in the
 * certificate itself.
 *
 * Usage:
 *   node scripts/generate-code-signing-keys.mjs           # refuses to clobber existing keys
 *   node scripts/generate-code-signing-keys.mjs --force   # regenerate (see rotation caveat below)
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  convertCertificateToCertificatePEM,
  convertKeyPairToPEM,
  generateKeyPair,
  generateSelfSignedCodeSigningCertificate,
  validateSelfSignedCertificate,
} from "@expo/code-signing-certificates";

// Anchor to the app root (the parent of scripts/), not the cwd -- this script
// is run by hand, and a stray cwd must not scatter key material around the
// repo (certs/ is only gitignored at apps/mobile/certs/).
const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CERTS_DIR = join(APP_ROOT, "certs");
const PRIVATE_KEY_PATH = join(CERTS_DIR, "private-key.pem");
const CERTIFICATE_PATH = join(CERTS_DIR, "certificate.pem");
// The on-device certificate is baked into the binary and cannot be rotated
// over the air, so a short validity would silently expire installed hosts.
// Ten years matches the freeze-not-break polarity: rotation is an app-store
// release concern (docs/version-skew.md), never an OTA one.
const VALIDITY_YEARS = 10;

const force = process.argv.includes("--force");

const existing = [PRIVATE_KEY_PATH, CERTIFICATE_PATH].filter((p) => existsSync(p));
if (existing.length > 0 && !force) {
  console.error(
    "[generate-code-signing-keys] Refusing to overwrite existing key material:",
  );
  for (const p of existing) {
    console.error(`    ${p}`);
  }
  console.error(
    "  Pass --force to regenerate. NOTE: hosts already in the field verify\n"
      + "  against the certificate they shipped with and will REJECT (and freeze\n"
      + "  on their current bundle) any manifest signed by a new key. Rotate only\n"
      + "  alongside a runtimeVersion bump / app-store release -- see docs/version-skew.md.",
  );
  process.exit(1);
}

console.log("[generate-code-signing-keys] Generating RSA-2048 keypair...");
const keyPair = generateKeyPair();

const validityNotBefore = new Date();
const validityNotAfter = new Date(validityNotBefore);
validityNotAfter.setFullYear(validityNotAfter.getFullYear() + VALIDITY_YEARS);

console.log("[generate-code-signing-keys] Generating self-signed code-signing certificate...");
const certificate = generateSelfSignedCodeSigningCertificate({
  keyPair,
  validityNotBefore,
  validityNotAfter,
  commonName: "ota-gateway-app",
});
// Fail before writing anything if the generated pair is not usable for
// expo-updates code signing (wrong key usage / EKU) -- there is no point
// shipping a certificate the client will reject.
validateSelfSignedCertificate(certificate, keyPair);

const { privateKeyPEM } = convertKeyPairToPEM(keyPair);
const certificatePEM = convertCertificateToCertificatePEM(certificate);

mkdirSync(CERTS_DIR, { recursive: true });
writeFileSync(PRIVATE_KEY_PATH, privateKeyPEM, { mode: 0o600 });
writeFileSync(CERTIFICATE_PATH, certificatePEM);

console.log("[generate-code-signing-keys] Wrote:");
console.log(`    ${PRIVATE_KEY_PATH}   (signs manifests at export time -- keep private)`);
console.log(`    ${CERTIFICATE_PATH}   (baked into the hosts at prebuild)`);
console.log(
  `  keyid: main   alg: rsa-v1_5-sha256   validity: ${VALIDITY_YEARS}y`,
);
console.log(
  "  Both files are gitignored. Run `pnpm --filter @ota-gateway/mobile export`\n"
    + "  to sign an update, and prebuild to bake the certificate into the hosts.",
);
