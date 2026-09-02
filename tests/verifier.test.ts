import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFilter, normalizePath } from "vite";
import { createInjectionRegistry } from "../src/compiler";
import { formatVerificationResult, verifyProject } from "../src/verifier";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(files: Record<string, string>) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ts-source-reflection-verify-"),
  );
  temporaryDirectories.push(root);
  for (const [name, code] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, code);
  }
  return root;
}

async function localResolver(source: string, importer: string) {
  if (!source.startsWith(".")) return null;
  const base = path.resolve(path.dirname(importer), source);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
  ]) {
    try {
      if ((await fs.stat(candidate)).isFile()) return normalizePath(candidate);
    } catch {
      // Try the next supported source extension.
    }
  }
  return null;
}

async function verify(root: string, exclude: string[] = []) {
  const filter = createFilter(
    ["**/*.ts", "**/*.tsx"],
    ["**/node_modules/**", "**/dist/**", "**/*.d.ts", ...exclude],
    { resolve: root },
  );
  return verifyProject({
    root,
    registry: createInjectionRegistry({
      injectFileName: false,
      injectSourceLine: true,
      injectUniqueId: false,
    }),
    explicitProperty: "preserve",
    isIncluded: filter,
    resolve: localResolver,
  });
}

describe("whole-project verifier", () => {
  it("accepts transformable calls outside the build entry graph", async () => {
    const root = await fixture({
      "Provider.ts": `import type { InjectSourceLine } from "ts-source-reflection"; export function run(props: InjectSourceLine<{}>) {}`,
      "UnusedConsumer.ts": `import { run } from "./Provider"; run({});`,
    });
    const result = await verify(root);
    expect(result.ok).toBe(true);
    expect(result.callSites).toBe(1);
    expect(result.injectionAwareExports).toBe(1);
    expect(formatVerificationResult(result)).toContain(
      "All injection-aware usages are transformable",
    );
  });

  it("aggregates unsupported usages across files", async () => {
    const root = await fixture({
      "Provider.ts": `import type { InjectSourceLine } from "ts-source-reflection"; export function run(props: InjectSourceLine<{}>) {}`,
      "First.ts": `import { run } from "./Provider"; const callback = run;`,
      "Second.ts": `import { run } from "./Provider"; const props = {}; run(props);`,
    });
    const result = await verify(root);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      "unsupported-reference",
    );
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      "invalid-call-site",
    );
  });

  it("rejects barrel exports and same-module calls", async () => {
    const root = await fixture({
      "Provider.ts": `import type { InjectSourceLine } from "ts-source-reflection"; export function run(props: InjectSourceLine<{}>) {} run({});`,
      "index.ts": `export { run } from "./Provider";`,
    });
    const result = await verify(root);
    expect(result.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "unsupported-re-export",
        "unsupported-same-module-reference",
      ]),
    );
  });

  it("rejects declarations and imports in excluded project files", async () => {
    const root = await fixture({
      "Provider.ts": `import type { InjectSourceLine } from "ts-source-reflection"; export function run(props: InjectSourceLine<{}>) {}`,
      "excluded/Declaration.ts": `import type { InjectSourceLine } from "ts-source-reflection"; export function hidden(props: InjectSourceLine<{}>) {}`,
      "excluded/Consumer.ts": `import { run } from "../Provider";`,
      "excluded/Unrelated.ts": `import { other } from "../Provider"; void other;`,
    });
    const result = await verify(root, ["**/excluded/**"]);
    expect(result.auditedFiles).toBe(3);
    expect(result.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "excluded-injection-declaration",
        "excluded-injection-import",
      ]),
    );
    expect(
      result.diagnostics.filter(
        ({ code }) => code === "excluded-injection-import",
      ),
    ).toHaveLength(1);
  });

  it("serializes diagnostics without the internal manifest", async () => {
    const root = await fixture({
      "Provider.ts": `import type { InjectSourceLine } from "ts-source-reflection"; export function run(props: InjectSourceLine<{}>) {}`,
      "Consumer.ts": `import { run } from "./Provider"; const callback = run;`,
    });
    const result = await verify(root);
    const json = JSON.parse(formatVerificationResult(result, "json"));
    expect(json.ok).toBe(false);
    expect(json.manifest).toBeUndefined();
    expect(json.diagnostics[0].code).toBe("unsupported-reference");
  });
});
