process.env.FIGXIT_SPECS = "off";
process.env.FIGXIT_USER_SPECS = "/nonexistent/figxit-user-specs";

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Spec } from "../src/specs";

const root = mkdtempSync(join(tmpdir(), "figxit-carapace-"));
const home = join(root, "home");
const realConfig = join(root, "real-config");
const realCache = join(root, "real-cache");
const specs = join(root, "specs");
process.env.FIGXIT_CARAPACE_HOME = home;
process.env.FIGXIT_CARAPACE_SPECS = specs;
process.env.XDG_CONFIG_HOME = realConfig;
process.env.XDG_CACHE_HOME = realCache;
afterAll(() => rmSync(root, { recursive: true, force: true }));

const { CARAPACE_GENERATOR, carapaceEnv, carapaceValues, convertCarapace, mergeCarapace } = await import("../src/carapace");
const { suggest } = await import("../src/suggest");
const { History } = await import("../src/history");
const { registerSpec } = await import("../src/specs");

describe("carapace spec to Fig spec", () => {
  const tree = convertCarapace({
    name: "tool",
    description: "A tool",
    persistentflags: { "-v, --verbose*": "More output" },
    commands: [
      {
        name: "build",
        aliases: ["b"],
        flags: {
          "-F, --features=*": "Features",
          "--color?": "When to color",
          "--internal&": "Hidden",
          "--format=": { description: "Format" },
        },
      },
      { name: "help", commands: [{ name: "build" }] },
      { name: "secret", hidden: true },
    ],
  });

  test("flags keep their names, value, repeat and persistence", () => {
    const build = tree.subcommands[0];
    expect(build.name).toEqual(["build", "b"]);
    expect(build.options.map((o: Spec) => o.name)).toEqual([["-F", "--features"], ["--color"], ["--format"]]);
    expect(build.options[0]).toMatchObject({ isRepeatable: true, args: { name: "value", generators: "carapace" } });
    expect(build.options[1]).toMatchObject({ requiresSeparator: true, args: { isOptional: true } });
    expect(build.options[2].description).toBe("Format");
    expect(tree.options[0]).toMatchObject({ name: ["-v", "--verbose"], isPersistent: true, isRepeatable: true });
  });

  test("hidden commands and the help topics are left out, and a leaf asks carapace for its arguments", () => {
    expect(tree.subcommands.map((s: Spec) => s.name[0])).toEqual(["build", "help"]);
    expect(tree.subcommands[1].subcommands).toBeUndefined();
    expect(tree.subcommands[0].args).toMatchObject({ isOptional: true, isVariadic: true, generators: "carapace" });
  });
});

describe("merging into the Fig spec", () => {
  const figGenerator = { script: ["cargo", "metadata"] };
  const fig = {
    name: "cargo",
    subcommands: [
      {
        name: ["test", "t"],
        description: "Old",
        options: [
          { name: ["-p", "--package"], args: { name: "package", generators: figGenerator } },
          { name: "--target", args: { name: "triple" } },
          { name: "--out-dir", args: { name: "dir" } },
        ],
      },
      { name: "legacy" },
    ],
  };
  const cara = {
    name: ["cargo"],
    subcommands: [
      {
        name: ["test", "t"],
        description: "New",
        options: [
          { name: ["-p", "--package"], args: { name: "value", generators: CARAPACE_GENERATOR } },
          { name: ["--target"], args: { name: "value", generators: CARAPACE_GENERATOR } },
          { name: ["-F", "--features"], description: "Features", args: { name: "value", generators: CARAPACE_GENERATOR } },
        ],
      },
      { name: ["clippy"], args: { name: "arg", generators: CARAPACE_GENERATOR } },
    ],
  };
  const merged = mergeCarapace(fig, cara);
  const test_ = merged.subcommands[0];

  test("Fig's own generator wins, an empty slot asks carapace", () => {
    expect(test_.options[0].args.generators).toBe(figGenerator);
    expect(test_.options[1].args.generators).toBe(CARAPACE_GENERATOR);
  });

  test("carapace adds what Fig lacks and nothing of Fig's is dropped", () => {
    expect(test_.options.map((o: Spec) => [].concat(o.name)[0])).toEqual(["-p", "--target", "--out-dir", "-F"]);
    expect(merged.subcommands.map((s: Spec) => [].concat(s.name)[0])).toEqual(["test", "legacy", "clippy"]);
    expect(test_.description).toBe("New");
    expect(merged.name).toBe("cargo");
    expect(fig.subcommands[0]!.description).toBe("Old");
  });

  test("a tree with no flags or commands leaves the Fig spec as it is", () => {
    expect(mergeCarapace(fig, { name: ["cargo"] })).toBe(fig);
  });
});

describe("carapace export values", () => {
  test("paths become files and folders relative to the folder being typed", () => {
    const out = JSON.stringify({
      nospace: "/",
      values: [
        { value: "src/main.rs", tag: "files" },
        { value: "src/bin/", tag: "files" },
      ],
    });
    expect(carapaceValues(out, "src/")).toEqual([
      { name: "main.rs", type: "file" },
      { name: "bin/", type: "folder" },
    ]);
  });

  test("a value whose last character is in nospace is inserted without a space", () => {
    const out = JSON.stringify({ nospace: ",", values: [{ value: "name,", description: "column" }, { value: "uuid" }] });
    expect(carapaceValues(out, "")).toEqual([
      { name: "name,", description: "column", insertValue: "name," },
      { name: "uuid" },
    ]);
  });

  test("output that is not JSON gives no rows", () => {
    expect(carapaceValues("panic: oops", "")).toEqual([]);
  });
});

describe("isolation from the user's carapace", () => {
  test("Figxit's carapace gets its own config and cache, mirroring everything except carapace", () => {
    mkdirSync(join(realConfig, "gh"), { recursive: true });
    mkdirSync(join(realConfig, "carapace", "overlays"), { recursive: true });
    mkdirSync(join(realCache, "uv"), { recursive: true });
    process.env.CARAPACE_BRIDGES = "zsh,fish";
    const env = carapaceEnv(Date.now() + 120_000);
    delete process.env.CARAPACE_BRIDGES;
    expect(env.XDG_CONFIG_HOME).toBe(join(home, "config"));
    expect(env.XDG_CACHE_HOME).toBe(join(home, "cache"));
    expect(env.CARAPACE_BRIDGES).toBe("");
    expect(lstatSync(join(home, "config", "gh")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(home, "cache", "uv")).isSymbolicLink()).toBe(true);
    const own = lstatSync(join(home, "config", "carapace"));
    expect(own.isSymbolicLink()).toBe(false);
    expect(own.isDirectory()).toBe(true);
  });

  test("completion runs Figxit's own binary by path with the isolated environment", async () => {
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    const log = join(root, "call.log");
    writeFileSync(
      join(bin, "carapace"),
      `#!/bin/sh\nprintf '%s\\n' "$*" "$XDG_CONFIG_HOME" "$CARAPACE_BRIDGES" > '${log}'\n` +
        `printf '%s' '{"values":[{"value":"syscall_wrapper","description":"member"}]}'\n`,
    );
    chmodSync(join(bin, "carapace"), 0o755);
    registerSpec("crate-tool", {
      name: "crate-tool",
      subcommands: [{ name: "test", options: [{ name: "-p", args: { name: "package", generators: CARAPACE_GENERATOR } }] }],
    });
    process.env.CARAPACE_BRIDGES = "zsh";
    const buffer = "crate-tool test -p sys";
    const result = await suggest(buffer, buffer.length, root, new History("/nonexistent"), Date.now());
    delete process.env.CARAPACE_BRIDGES;
    const list = result.more ? await result.more : result.now;
    expect(list?.items.map((i) => i.label)).toEqual(["syscall_wrapper"]);
    const [args, config, bridges] = readFileSync(log, "utf8").split("\n");
    expect(args).toBe("crate-tool export crate-tool test -p ");
    expect(config).toBe(join(home, "config"));
    expect(bridges).toBe("");
  });
});
