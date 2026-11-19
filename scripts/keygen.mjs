#!/usr/bin/env node
// Create an ed25519 release signing key. Prints the public key (SPKI PEM) to stdout; paste it
// into src/release-key.ts. The private key never goes in the repo.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/keygen.mjs <private-key-path>");
  process.exit(1);
}
if (existsSync(path)) {
  console.error(`keygen: ${path} already exists; refusing to overwrite it`);
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
process.stdout.write(publicKey.export({ type: "spki", format: "pem" }));
