// Fresh completions from carapace (https://carapace.sh) for the frozen Fig specs.
//
// Figxit downloads its own carapace binary into carapaceHome() and never uses or changes a carapace
// the user installed: the binary is called by its absolute path, it reads its config and cache from
// carapaceHome(), and CARAPACE_* variables from the environment are cleared. Once a day the engine
// checks for a new carapace release, and after an update (of carapace or of Figxit) it writes every
// carapace command tree to carapaceSpecsDir() as JSON. specs.ts merges such a tree into the bundled
// Fig spec of the same name when the command is first completed.

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { version as FIGXIT_VERSION } from "../package.json";
import { carapaceHome, carapaceSpecsDir, specsDir } from "./paths";
import type { Spec } from "./specs";

const RELEASE_URL =
  process.env.FIGXIT_CARAPACE_RELEASE ?? "https://api.github.com/repos/carapace-sh/carapace-bin/releases/latest";
const CHECK_EVERY_MS = 86_400_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const SPEC_TIMEOUT_MS = 20_000;
const EXPORT_TIMEOUT_MS = 1500;
const JOBS = 8;
const MIRROR_EVERY_MS = 60_000;
/** Bump when the shape of the generated trees changes, so they are written again. */
const TREE_FORMAT = 1;
/** Stands for CARAPACE_GENERATOR in the JSON trees. */
const GENERATOR = "carapace";
const COMMAND_NAME = /^[\w@.+-]+$/;

interface State {
  version?: string;
  checkedAt?: number;
  latest?: string;
  bytes?: number;
  generated?: string;
  commands?: number;
}

export interface CarapaceStatus {
  installed: boolean;
  version: string | null;
  latest: string | null;
  bytes: number;
  size: number;
  commands: number;
}

function binary(): string {
  return join(carapaceHome(), "bin", "carapace");
}

function readState(): State {
  try {
    return JSON.parse(readFileSync(join(carapaceHome(), "state.json"), "utf8")) as State;
  } catch {
    return {};
  }
}

function writeState(change: State): State {
  const state = { ...readState(), ...change };
  mkdirSync(carapaceHome(), { recursive: true });
  writeFileSync(join(carapaceHome(), "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

function treeStamp(version: string | undefined): string {
  return [version, FIGXIT_VERSION, specsDir(), TREE_FORMAT].join("|");
}

function diskSize(path: string): number {
  let total = 0;
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory()) return stat.size;
    for (const entry of readdirSync(path)) total += diskSize(join(path, entry));
  } catch {}
  return total;
}

export function carapaceStatus(): CarapaceStatus {
  const state = readState();
  const installed = existsSync(binary());
  return {
    installed,
    version: installed ? (state.version ?? null) : null,
    latest: state.latest ?? null,
    bytes: state.bytes ?? 20_000_000,
    size: installed ? diskSize(carapaceHome()) + diskSize(carapaceSpecsDir()) : 0,
    commands: installed ? (state.commands ?? 0) : 0,
  };
}

// carapace reads its config (user specs, overlays) from $XDG_CONFIG_HOME/carapace and its cache from
// $XDG_CACHE_HOME/carapace. Pointing both at carapaceHome() keeps the user's carapace setup out of
// Figxit's results. The commands carapace runs for values (git, gh, uv) read the same variables, so
// both directories mirror the real ones with symlinks, everything except the carapace entry.
let mirroredAt = 0;

function mirror(source: string, target: string) {
  mkdirSync(join(target, "carapace"), { recursive: true });
  const wanted = new Set<string>();
  try {
    for (const name of readdirSync(source)) if (name !== "carapace") wanted.add(name);
  } catch {}
  for (const name of readdirSync(target)) {
    if (name === "carapace" || wanted.has(name)) continue;
    try {
      if (lstatSync(join(target, name)).isSymbolicLink()) unlinkSync(join(target, name));
    } catch {}
  }
  for (const name of wanted) {
    try {
      lstatSync(join(target, name));
    } catch {
      try {
        symlinkSync(join(source, name), join(target, name));
      } catch {}
    }
  }
}

export function carapaceEnv(now = Date.now()): Record<string, string> {
  const home = carapaceHome();
  const config = join(home, "config");
  const cache = join(home, "cache");
  if (now - mirroredAt > MIRROR_EVERY_MS) {
    mirroredAt = now;
    const absolute = (value: string | undefined) => (value?.startsWith("/") ? value : undefined);
    try {
      mirror(absolute(process.env.XDG_CONFIG_HOME) ?? join(homedir(), ".config"), config);
      mirror(absolute(process.env.XDG_CACHE_HOME) ?? join(homedir(), ".cache"), cache);
    } catch {}
  }
  const env: Record<string, string> = { XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache };
  for (const key of Object.keys(process.env)) if (key.startsWith("CARAPACE_")) env[key] = "";
  return env;
}

async function capture(args: string[], timeout: number): Promise<string | null> {
  try {
    const proc = Bun.spawn([binary(), ...args], {
      cwd: homedir(),
      env: { ...process.env, ...carapaceEnv() },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => proc.kill(), timeout);
    const [stdout, status] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    return status === 0 ? stdout : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// carapace spec (YAML) to a Fig spec tree

interface CaraCommand {
  name: string;
  aliases?: string[];
  description?: string;
  hidden?: boolean;
  flags?: Record<string, string | { description?: string } | null>;
  persistentflags?: Record<string, string | { description?: string } | null>;
  commands?: CaraCommand[];
}

function convertFlags(flags: CaraCommand["flags"], persistent: boolean): Spec[] {
  const options: Spec[] = [];
  for (const [key, value] of Object.entries(flags ?? {})) {
    const modifiers = /[=*?&!]*$/.exec(key)![0];
    if (modifiers.includes("&")) continue;
    const option: Spec = { name: key.slice(0, key.length - modifiers.length).split(/,\s*/) };
    const description = typeof value === "string" ? value : value?.description;
    if (description) option.description = description;
    if (modifiers.includes("*")) option.isRepeatable = true;
    if (persistent) option.isPersistent = true;
    if (modifiers.includes("?")) {
      option.requiresSeparator = true;
      option.args = { name: "value", isOptional: true, generators: GENERATOR };
    } else if (modifiers.includes("=")) {
      option.args = { name: "value", generators: GENERATOR };
    }
    options.push(option);
  }
  return options;
}

export function convertCarapace(command: CaraCommand): Spec {
  const node: Spec = { name: [command.name, ...(command.aliases ?? [])] };
  if (command.description) node.description = command.description;
  const options = [...convertFlags(command.persistentflags, true), ...convertFlags(command.flags, false)];
  if (options.length) node.options = options;
  // `help` mirrors every subcommand as a topic; listing them twice only adds noise.
  const subcommands =
    command.name === "help" ? [] : (command.commands ?? []).filter((sub) => !sub.hidden).map(convertCarapace);
  if (subcommands.length) node.subcommands = subcommands;
  else node.args = { name: "arg", isOptional: true, isVariadic: true, generators: GENERATOR };
  return node;
}

// ---------------------------------------------------------------------------------------------
// Merge into the Fig spec, and the generator that asks carapace for values

export const CARAPACE_GENERATOR: Spec = {
  trigger: "/",
  getQueryTerm: "/",
  custom: async (tokens: string[], run: (input: unknown) => Promise<{ stdout: string; status: number }>) => {
    const word = tokens[tokens.length - 1] ?? "";
    const dir = word.slice(0, word.lastIndexOf("/") + 1);
    const { stdout, status } = await run({
      command: binary(),
      args: [tokens[0], "export", ...tokens.slice(0, -1), dir],
      env: carapaceEnv(),
      timeout: EXPORT_TIMEOUT_MS,
    });
    return status === 0 ? carapaceValues(stdout, dir) : [];
  },
};

/** Turns `carapace <cmd> export` output into Fig suggestions, relative to the folder being typed. */
export function carapaceValues(stdout: string, dir: string): Spec[] {
  let reply: { nospace?: string; values?: { value: string; description?: string; tag?: string }[] };
  try {
    reply = JSON.parse(stdout);
  } catch {
    return [];
  }
  const nospace = reply.nospace ?? "";
  return (reply.values ?? []).map((value) => {
    const name = dir && value.value.startsWith(dir) ? value.value.slice(dir.length) : value.value;
    const item: Spec = { name };
    if (value.description) item.description = value.description;
    if (/^(files|directories)$/.test(value.tag ?? "")) item.type = name.endsWith("/") ? "folder" : "file";
    else if (nospace === "*" || (name !== "" && nospace.includes(name.slice(-1)))) item.insertValue = name;
    return item;
  });
}

export function parseCarapaceTree(text: string): Spec {
  return JSON.parse(text, (key, value) => (key === "generators" && value === GENERATOR ? CARAPACE_GENERATOR : value));
}

function names(node: Spec): string[] {
  return ([] as unknown[]).concat(node.name ?? []).filter((name): name is string => typeof name === "string");
}

function find(list: Spec[], node: Spec): number {
  const wanted = names(node);
  return list.findIndex((existing) => names(existing).some((name) => wanted.includes(name)));
}

// An argument slot Fig fills itself (suggestions, generators, templates) keeps that; an empty one
// asks carapace.
function fill(args: Spec | Spec[]): Spec | Spec[] {
  const filled = ([] as Spec[]).concat(args).map((arg) =>
    ([] as unknown[]).concat(arg.suggestions ?? []).length || ([] as unknown[]).concat(arg.generators ?? []).length ||
    arg.template || arg.isCommand || arg.loadSpec
      ? arg
      : { ...arg, generators: CARAPACE_GENERATOR },
  );
  return Array.isArray(args) ? filled : filled[0]!;
}

/**
 * Union of the Fig spec and the carapace tree. carapace adds the subcommands and options Fig lacks
 * and refreshes descriptions. Nothing Fig has is dropped: carapace's tree is incomplete for some
 * tools (its hx tree has no flags at all), and Fig's generators often know more.
 */
export function mergeCarapace(fig: Spec | null, cara: Spec, root = true): Spec {
  if (!fig) return cara;
  if (!cara.options && !cara.subcommands) return fig;
  const node: Spec = { ...fig, description: cara.description ?? fig.description };
  if (!root) node.name = [...new Set([...names(fig), ...names(cara)])];

  const options: Spec[] = [...(fig.options ?? [])];
  for (const option of cara.options ?? []) {
    const at = find(options, option);
    if (at < 0) {
      options.push(option);
      continue;
    }
    const mine = options[at]!;
    const merged: Spec = {
      ...mine,
      name: [...new Set([...names(mine), ...names(option)])],
      description: option.description ?? mine.description,
    };
    if (option.isRepeatable) merged.isRepeatable = mine.isRepeatable ?? true;
    if (option.isPersistent) merged.isPersistent = true;
    if (mine.args) merged.args = fill(mine.args);
    else if (option.args) merged.args = option.args;
    options[at] = merged;
  }
  if (options.length) node.options = options;

  const subcommands: Spec[] = [...(fig.subcommands ?? [])];
  for (const sub of cara.subcommands ?? []) {
    const at = find(subcommands, sub);
    if (at < 0) subcommands.push(sub);
    else subcommands[at] = mergeCarapace(subcommands[at]!, sub, false);
  }
  if (subcommands.length) node.subcommands = subcommands;
  if (fig.args) node.args = fill(fig.args);
  return node;
}

// ---------------------------------------------------------------------------------------------
// Download, update, generate

interface Release {
  version: string;
  url: string;
  sha256: string;
  bytes: number;
}

async function latestRelease(): Promise<Release> {
  const response = await fetch(RELEASE_URL, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`release check failed: HTTP ${response.status}`);
  const release = (await response.json()) as { tag_name: string; assets: { name: string; size: number; browser_download_url: string }[] };
  const version = release.tag_name.replace(/^v/, "");
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const archive = release.assets.find((asset) => asset.name === `carapace-bin_${version}_darwin_${arch}.tar.gz`);
  const sums = release.assets.find((asset) => asset.name === `carapace-bin_${version}_checksums.txt`);
  if (!archive || !sums) throw new Error(`carapace ${version} has no macOS ${arch} download`);
  const list = await (await fetch(sums.browser_download_url, { signal: AbortSignal.timeout(30_000) })).text();
  const sha256 = new RegExp(`^([0-9a-f]{64})\\s+${archive.name.replaceAll(".", "\\.")}$`, "m").exec(list)?.[1];
  if (!sha256) throw new Error(`no checksum for ${archive.name}`);
  return { version, url: archive.browser_download_url, sha256, bytes: archive.size };
}

async function installBinary(release: Release): Promise<void> {
  const response = await fetch(release.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (new Bun.CryptoHasher("sha256").update(data).digest("hex") !== release.sha256) {
    throw new Error("download failed: the file does not match its checksum");
  }
  const home = carapaceHome();
  mkdirSync(join(home, "bin"), { recursive: true });
  const work = mkdtempSync(join(home, ".download-"));
  try {
    writeFileSync(join(work, "archive.tar.gz"), data);
    const tar = Bun.spawnSync(["/usr/bin/tar", "-xzf", join(work, "archive.tar.gz"), "-C", work, "carapace"], { stderr: "pipe" });
    if (tar.exitCode !== 0 || !existsSync(join(work, "carapace"))) throw new Error("the archive could not be unpacked");
    chmodSync(join(work, "carapace"), 0o755);
    renameSync(join(work, "carapace"), binary());
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  writeState({ version: release.version, latest: release.version, bytes: release.bytes, checkedAt: Date.now() });
}

async function pool<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(JOBS, items.length) }, async () => {
      while (next < items.length) await work(items[next++]!);
    }),
  );
}

/** Writes one JSON tree per carapace command into carapaceSpecsDir(), replacing the previous set. */
export async function generateCarapace(): Promise<number> {
  const listing = await capture(["--list"], SPEC_TIMEOUT_MS);
  if (!listing) throw new Error("carapace could not list its commands");
  const commands = Object.keys(JSON.parse(listing)).filter((name) => COMMAND_NAME.test(name));
  const dumps = new Map<string, CaraCommand>();
  await pool(commands, async (name) => {
    const yaml = await capture([name, "spec"], SPEC_TIMEOUT_MS);
    if (!yaml) return;
    try {
      const parsed = Bun.YAML.parse(yaml) as CaraCommand;
      if (parsed && typeof parsed.name === "string") dumps.set(name, parsed);
    } catch {}
  });

  // Plugin subcommands (cargo clippy, cargo fmt) are found at run time and missing from `spec`;
  // carapace has them as separate commands named <command>-<sub>.
  await pool([...dumps.keys()].filter((name) => commands.some((other) => other.startsWith(`${name}-`))), async (name) => {
    const spec = dumps.get(name)!;
    const listed = await capture([name, "export", name, ""], SPEC_TIMEOUT_MS);
    let values: { value: string; description?: string }[] = [];
    try {
      values = JSON.parse(listed ?? "{}").values ?? [];
    } catch {}
    const known = new Set((spec.commands ?? []).flatMap((sub) => [sub.name, ...(sub.aliases ?? [])]));
    for (const value of values) {
      const plugin = dumps.get(`${name}-${value.value}`);
      if (!plugin || known.has(value.value)) continue;
      (spec.commands ??= []).push({ ...plugin, name: value.value, description: value.description || plugin.description });
    }
  });

  const out = carapaceSpecsDir();
  const work = `${out}.new`;
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true, mode: 0o755 });
  for (const [name, spec] of dumps) writeFileSync(join(work, `${name}.json`), JSON.stringify(convertCarapace(spec)));
  rmSync(out, { recursive: true, force: true });
  renameSync(work, out);
  return dumps.size;
}

let running: Promise<string | null> | null = null;

/** Downloads carapace and generates the trees. Returns an error message, or null. */
export function installCarapace(): Promise<string | null> {
  running ??= (async () => {
    try {
      await installBinary(await latestRelease());
      const commands = await generateCarapace();
      writeState({ generated: treeStamp(readState().version), commands });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

/**
 * Daily: installs a newer carapace release. Always: writes the trees again when carapace or Figxit
 * changed since they were written. Does nothing when carapace was never downloaded.
 */
export function updateCarapace(now = Date.now(), force = false): Promise<string | null> {
  if (!existsSync(binary())) return Promise.resolve(null);
  running ??= (async () => {
    try {
      let state = readState();
      if (force || now - (state.checkedAt ?? 0) > CHECK_EVERY_MS) {
        const release = await latestRelease();
        state = writeState({ checkedAt: now, latest: release.version, bytes: release.bytes });
        if (release.version !== state.version) {
          await installBinary(release);
          state = readState();
        }
      }
      const stamp = treeStamp(state.version);
      if (force || state.generated !== stamp || !existsSync(carapaceSpecsDir())) {
        writeState({ generated: stamp, commands: await generateCarapace() });
      }
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

export function removeCarapace(): void {
  rmSync(carapaceHome(), { recursive: true, force: true });
  rmSync(carapaceSpecsDir(), { recursive: true, force: true });
}

/** For specs.ts: the stat of a generated tree, or null. */
export function carapaceTreeFile(name: string): { file: string; stamp: string } | null {
  if (!COMMAND_NAME.test(name)) return null;
  const file = join(carapaceSpecsDir(), `${name}.json`);
  try {
    const stat = statSync(file);
    return stat.isFile() ? { file, stamp: `${stat.mtimeMs}:${stat.size}` } : null;
  } catch {
    return null;
  }
}
