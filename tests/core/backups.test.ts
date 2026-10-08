import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openLocalStore } from "../../src/local/store.ts";
import { listLocalBackups } from "../../src/local/backups.ts";
import { createDemoData } from "../../src/mock/fixtures.ts";

async function setup(t: TestContext, now?: () => number) {
  const directory = await mkdtemp(path.join(tmpdir(), "cd-player-backup-"));
  const store = await openLocalStore(directory, { now });
  t.after(async () => {
    await store.close();
    const absolute = path.resolve(directory);
    assert.equal(path.dirname(absolute), path.resolve(tmpdir()));
    assert.ok(path.basename(absolute).startsWith("cd-player-backup-"));
    await rm(absolute, { recursive: true, force: true });
  });
  return { directory, store };
}

test("automatic backup captures the previous committed version and throttles rapid writes", async (t) => {
  let clock = 1791000000000;
  const { directory, store } = await setup(t, () => clock);
  await store.transact((d) => {
    d.settings.accentColor = "#123456";
  });
  await store.transact((d) => {
    d.settings.accentColor = "#654321";
  });
  await store.transact((d) => {
    d.settings.background = "blue";
  });
  let backups = await listLocalBackups(directory);
  assert.equal(backups.valid.length, 1);
  const envelope = JSON.parse(
    await readFile(
      path.join(directory, "backups", backups.valid[0].id),
      "utf8",
    ),
  );
  assert.equal(JSON.parse(envelope.payload).settings.accentColor, "#123456");
  assert.equal(JSON.parse(envelope.payload).settings.background, "light");
  clock += 10 * 60 * 1000;
  await store.transact((d) => {
    d.settings.accentColor = "#ABCDEF";
  });
  backups = await listLocalBackups(directory);
  assert.equal(backups.valid.length, 2);
  assert.equal(backups.invalid.length, 0);
  assert.equal(store.read().settings.accentColor, "#ABCDEF");
});

test("explicit snapshot round-trips lyrics, protected metadata, archives and custom preferences", async (t) => {
  const { directory, store } = await setup(t);
  const demo = createDemoData();
  await store.transact((d) => {
    d.library = demo.library;
    d.lyricsByTrack = demo.lyricsByTrack;
    const id = Object.keys(demo.lyricsByTrack)[0];
    d.archivedLyrics[id] = structuredClone(demo.lyricsByTrack[id]);
    d.settings.ui.main = { materialTheme: "charcoal", editorView: "bilingual" };
    d.settings.accentColor = "#998877";
    d.roots = ["C:/OriginalMusic"];
  });
  const original = store.read();
  const backup = await store.backup();
  await store.transact((d) => {
    d.lyricsByTrack = {};
    d.settings.ui.main = {};
  });
  await store.close();
  const restored = await openLocalStore(directory, {
    restoreBackupId: backup.id,
  });
  try {
    assert.deepEqual(restored.read(), original);
  } finally {
    await restored.close();
  }
  assert.equal((await readdir(path.join(directory, "recovery"))).length, 1);
});

test("checksum damage is listed and rejected before replacing any current library", async (t) => {
  const { directory, store } = await setup(t);
  await store.transact((d) => {
    d.settings.accentColor = "#123456";
  });
  const backup = await store.backup();
  const filename = path.join(directory, "backups", backup.id);
  const envelope = JSON.parse(await readFile(filename, "utf8"));
  envelope.payload = envelope.payload.replace("#123456", "#654321");
  await writeFile(filename, JSON.stringify(envelope));
  await store.close();
  const before = await readFile(path.join(directory, "library.json"));
  await assert.rejects(
    openLocalStore(directory, { restoreBackupId: backup.id }),
    /备份损坏/,
  );
  assert.deepEqual(
    await readFile(path.join(directory, "library.json")),
    before,
  );
  assert.deepEqual((await listLocalBackups(directory)).invalid, [backup.id]);
  await assert.rejects(readdir(path.join(directory, "recovery")), {
    code: "ENOENT",
  });
  await assert.rejects(
    openLocalStore(directory, { restoreBackupId: "../library.json" }),
    /编号无效/,
  );
});

test("explicit recovery preserves a damaged library byte-for-byte and releases the lock", async (t) => {
  const { directory, store } = await setup(t);
  await store.transact((d) => {
    d.settings.background = "blue";
  });
  const backup = await store.backup();
  await store.close();
  const damaged = Buffer.from([0x7b, 0xff, 0xfe, 0x00]);
  await writeFile(path.join(directory, "library.json"), damaged);
  await assert.rejects(openLocalStore(directory));
  assert.deepEqual(
    await readFile(path.join(directory, "library.json")),
    damaged,
  );
  const recovered = await openLocalStore(directory, {
    restoreBackupId: backup.id,
  });
  try {
    assert.equal(recovered.read().settings.background, "blue");
  } finally {
    await recovered.close();
  }
  const archives = await readdir(path.join(directory, "recovery"));
  assert.deepEqual(
    await readFile(path.join(directory, "recovery", archives[0])),
    damaged,
  );
  assert.ok(
    (await listLocalBackups(directory)).valid.some((b) => b.id === backup.id),
  );
});

test("active writer prevents recovery and backup failure prevents publishing the proposed change", async (t) => {
  const { directory, store } = await setup(t);
  await store.transact((d) => {
    d.settings.accentColor = "#123456";
  });
  await assert.rejects(
    openLocalStore(directory, { restoreBackupId: "invalid" }),
    /另一进程/,
  );
  await writeFile(path.join(directory, "backups"), "occupied");
  await assert.rejects(
    store.transact((d) => {
      d.settings.accentColor = "#654321";
    }),
    /自动备份未成功/,
  );
  assert.equal(store.read().settings.accentColor, "#123456");
  assert.equal(
    JSON.parse(await readFile(path.join(directory, "library.json"), "utf8"))
      .settings.accentColor,
    "#123456",
  );
  assert.equal(
    (await readdir(directory)).some((f) => f.endsWith(".tmp")),
    false,
  );
});

test("cancelled draft cannot enter a backup or overwrite the committed state", async (t) => {
  const { directory, store } = await setup(t);
  await store.transact((d) => {
    d.settings.accentColor = "#123456";
  });
  let active = true;
  await assert.rejects(
    store.transact(
      (d) => {
        d.settings.accentColor = "#654321";
        active = false;
      },
      () => active,
    ),
  );
  assert.equal(store.read().settings.accentColor, "#123456");
  assert.equal((await listLocalBackups(directory)).valid.length, 0);
});

test("clock rollback still takes a backup and manual snapshots bypass the automatic interval", async (t) => {
  let clock = 1791000000000;
  const { directory, store } = await setup(t, () => clock);
  await store.transact((d) => {
    d.library.revision++;
  });
  await store.backup();
  await store.backup();
  clock -= 60000;
  await store.transact((d) => {
    d.library.revision++;
  });
  const backups = await listLocalBackups(directory);
  assert.equal(backups.valid.length, 3);
  assert.equal(new Set(backups.valid.map((b) => b.id)).size, 3);
});

test("offline backup CLI creates, lists and restores a snapshot using the real single-writer store", async (t) => {
  const { directory, store } = await setup(t);
  await store.transact((d) => {
    d.settings.accentColor = "#123456";
  });
  await store.close();
  const script = fileURLToPath(
    new URL("../../scripts/backup.mjs", import.meta.url),
  );
  const run = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [script, ...args, "--data", directory],
        { windowsHide: true },
      );
      let output = "",
        error = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        error += chunk;
      });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve(output) : reject(Error(error)),
      );
    });
  assert.match(await run(["create"]), /备份已保存/);
  const id = (await listLocalBackups(directory)).valid[0].id;
  assert.ok((await run(["list"])).includes(id));
  await writeFile(path.join(directory, "library.json"), "{broken");
  assert.match(await run(["restore", "--id", id]), /资料库已恢复/);
  assert.equal(
    JSON.parse(await readFile(path.join(directory, "library.json"), "utf8"))
      .settings.accentColor,
    "#123456",
  );
});
