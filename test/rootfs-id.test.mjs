// The id a VM filesystem is published under. It decides whether an installed hive downloads the
// image again, so it must move when the image changes and stay put when it does not.
import test from "node:test";
import assert from "node:assert/strict";
import { rootfsId } from "../scripts/rootfs-id.mjs";

const tree = "1111111111111111111111111111111111111111";
const packages = ["chromium-145.0-1.fc45.x86_64", "git-core-2.51.0-1.fc45.x86_64", "nodejs-24.22.3-1.fc45.x86_64"];

test("the id is 12 lowercase hex characters", () => {
  const id = rootfsId({ imageTree: tree, packages });
  assert.match(id, /^[0-9a-f]{12}$/);
});

test("the same image gets the same id every build, whatever order rpm prints", () => {
  const forward = rootfsId({ imageTree: tree, packages });
  const reversed = rootfsId({ imageTree: tree, packages: [...packages].reverse() });
  assert.equal(forward, reversed);
  assert.equal(forward, rootfsId({ imageTree: tree, packages: [...packages, "", "  "] }));
});

test("a new or updated package moves the id", () => {
  const base = rootfsId({ imageTree: tree, packages });
  const updated = rootfsId({
    imageTree: tree,
    packages: packages.map((p) => (p.startsWith("chromium-") ? "chromium-146.0-1.fc45.x86_64" : p)),
  });
  assert.notEqual(base, updated, "a Chromium security update must reach installs");
  const extra = rootfsId({ imageTree: tree, packages: [...packages, "jq-1.7.1-1.fc45.x86_64"] });
  assert.notEqual(base, extra);
});

test("a change to image/ moves the id", () => {
  const base = rootfsId({ imageTree: tree, packages });
  assert.notEqual(base, rootfsId({ imageTree: "2".repeat(40), packages }));
});

test("a missing image tree is not silently treated as an unchanged one", () => {
  const base = rootfsId({ imageTree: tree, packages });
  assert.notEqual(base, rootfsId({ imageTree: "", packages }));
});
