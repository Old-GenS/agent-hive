#!/usr/bin/env node
// Sign a release file with the ed25519 release key. Writes <file>.sig (base64 signature).
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [keyPath, file] = process.argv.slice(2);
if (!keyPath || !file) {
  console.error("usage: node scripts/sign.mjs <private-key-path> <file>");
  process.exit(1);
}

const privateKey = createPrivateKey(readFileSync(keyPath));
const signature = sign(null, readFileSync(file), privateKey);
writeFileSync(`${file}.sig`, signature.toString("base64") + "\n");
