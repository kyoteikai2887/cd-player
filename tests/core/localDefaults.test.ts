import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { openLocalStore } from "../../src/local/store.ts";
import { createDemoSettings } from "../../src/mock/fixtures/settings.ts";

const roots = new Set<string>();
after(async () => {
  for (const root of roots) {
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
    if (!relative.startsWith("cd-player-defaults-") || relative.includes(path.sep))
      throw new Error("Unsafe test cleanup target");
    await rm(root, { recursive: true, force: true });
  }
});
async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), "cd-player-defaults-"));
  roots.add(root);
  return root;
}

test("a new local collection starts in memorial charcoal and orange, and persists on reopening", async () => {
  const root = await directory(), store = await openLocalStore(root);
  try {
    const settings = store.read().settings;
    assert.equal(settings.accentColor, "#DB7A3D");
    assert.equal(settings.ui.main.materialTheme, "charcoal");
    assert.equal(settings.miniShowLyrics, false);
    assert.equal(settings.glassIntensity, 0.65);
    await store.transact(() => {});
  } finally { await store.close(); }
  const reopened = await openLocalStore(root);
  try {
    assert.equal(reopened.read().settings.accentColor, "#DB7A3D");
    assert.equal(reopened.read().settings.ui.main.materialTheme, "charcoal");
  } finally { await reopened.close(); }
});

for (const variant of ["legacy-light", "custom-blue", "custom-charcoal"] as const) {
  test(`existing ${variant} preferences are preserved without rewriting the collection`, async () => {
    const root = await directory(), store = await openLocalStore(root);
    const settings = createDemoSettings();
    if (variant !== "legacy-light") {
      settings.background = "blue";
      settings.accentColor = "#9170CF";
      settings.ui.main.materialTheme = variant === "custom-charcoal" ? "charcoal" : "standard";
    }
    settings.ui.main.privatePreference = "retained";
    settings.ui.mini.privatePreference = { value: 7 };
    try { await store.transact(data => { data.settings = settings; }); }
    finally { await store.close(); }
    const filename = path.join(root, "library.json"), before = await readFile(filename);
    const reopened = await openLocalStore(root);
    try { assert.deepEqual(reopened.read().settings, settings); }
    finally { await reopened.close(); }
    assert.deepEqual(await readFile(filename), before);
  });
}
