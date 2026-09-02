import { describe, expect, it } from "vitest";
import {
  analyzeConsumer,
  createDeterministicUniqueId,
  createInjectionRegistry,
  discoverComponents,
  findNamedImports,
  SourceAwareCompilerError,
  transformConsumer,
  type ResolvedExportUsage,
} from "../src/compiler";
import {
  createSourceFilter,
  deriveConsumerFileName,
  deriveConsumerSourcePath,
  sourceAwareInjectionPlugin,
} from "../src/plugin";

const provider = "/src/Provider.tsx";
const both = createInjectionRegistry({
  injectFileName: true,
  injectSourceLine: true,
});
const fileOnly = createInjectionRegistry({
  injectFileName: true,
  injectSourceLine: false,
});

describe("component discovery", () => {
  it("discovers functions, arrows, aliases, and nested markers", () => {
    const code = `
      import type { InjectFileName as File, InjectSourceLine as Line } from 'ts-source-reflection';
      type Props = File<Line<{ required: string }>>;
      export function FunctionProvider(props: Props) { return null }
      export const ArrowProvider = (props: Line<File<{}>>) => null;
      export const Plain = (props: {}) => null;
    `;
    const metadata = discoverComponents(code, provider, both);
    expect(metadata.map((item) => item.exportName)).toEqual([
      "FunctionProvider",
      "ArrowProvider",
    ]);
    expect(metadata[0]?.callable?.targets[0]?.injections).toEqual([
      { property: "_inj_sourceFileName", source: "importer-file-name" },
      { property: "_inj_sourceLine", source: "importer-source-line" },
    ]);
    expect(metadata[1]?.callable?.targets[0]?.injections).toEqual([
      { property: "_inj_sourceLine", source: "importer-source-line" },
      { property: "_inj_sourceFileName", source: "importer-file-name" },
    ]);
  });

  it("peels disabled outer markers and ignores indirect aliases", () => {
    const code = `
      import type { InjectFileName, InjectSourceLine } from 'ts-source-reflection';
      type Marked = InjectSourceLine<InjectFileName<{}>>;
      type Indirect = Marked;
      export const One = (props: Marked) => null;
      export const Unsupported = (props: Indirect) => null;
    `;
    const metadata = discoverComponents(code, provider, fileOnly);
    expect(metadata).toHaveLength(1);
    expect(metadata[0]?.callable?.targets[0]?.injections).toEqual([
      { property: "_inj_sourceFileName", source: "importer-file-name" },
    ]);
  });

  it("produces no metadata when all marker types are disabled", () => {
    const registry = createInjectionRegistry({
      injectFileName: false,
      injectSourceLine: false,
    });
    expect(
      discoverComponents(
        `import type { InjectFileName } from 'ts-source-reflection'; export const P = (p: InjectFileName<{}>) => null;`,
        provider,
        registry,
      ),
    ).toEqual([]);
  });

  it("enables source-line injection independently", () => {
    const lineOnly = createInjectionRegistry({
      injectFileName: false,
      injectSourceLine: true,
    });
    const metadata = discoverComponents(
      `import type { InjectFileName, InjectSourceLine } from 'ts-source-reflection'; export const P = (p: InjectFileName<InjectSourceLine<{}>>) => null;`,
      provider,
      lineOnly,
    );
    expect(metadata[0]?.callable?.targets[0]?.injections).toEqual([
      { property: "_inj_sourceLine", source: "importer-source-line" },
    ]);
  });

  it("rejects malformed and duplicate markers with code frames", () => {
    const malformed = `import type { InjectSourceLine } from 'ts-source-reflection';\nexport const Bad = (props: InjectSourceLine) => null;`;
    expect(() => discoverComponents(malformed, provider, both)).toThrow(
      /exactly one type argument/,
    );
    expect(() => discoverComponents(malformed, provider, both)).toThrow(
      /Provider\.tsx:2:/,
    );
    const duplicate = `import type { InjectFileName } from 'ts-source-reflection';\nexport const Bad = (props: InjectFileName<InjectFileName<{}>>) => null;`;
    expect(() => discoverComponents(duplicate, provider, both)).toThrow(
      /Duplicate injection marker/,
    );
  });
});

describe("consumer analysis", () => {
  it("follows aliases while ignoring type-only imports and uses", () => {
    expect(
      findNamedImports(
        `import { Provider as Local, type Props } from './Provider'; import { InjectFileName } from 'ts-source-reflection'; type P = InjectFileName<{}>; <Local />;`,
        "/src/View.tsx",
      ),
    ).toEqual([
      {
        source: "./Provider",
        specifiers: [{ exportName: "Provider", localName: "Local" }],
      },
    ]);
  });
});

describe("source values and filtering", () => {
  it.each([
    ["/src/pages/RepositoryPage.tsx", "RepositoryPage"],
    ["/src/pages/RepositoryPage.test.tsx?import#hash", "RepositoryPage.test"],
    ["C:\\src\\pages\\index.tsx", "index"],
    ["\0virtual:module", null],
  ])("derives filename %s as %s", (id, expected) => {
    expect(deriveConsumerFileName(id)).toBe(expected);
  });

  it("derives a portable root-relative source path", () => {
    expect(
      deriveConsumerSourcePath(
        "C:/repo/frontend",
        "C:/repo/frontend/src/pages/View.tsx?import",
      ),
    ).toBe("src/pages/View.tsx");
  });

  it("applies includes and exclusions to absolute IDs", () => {
    const filter = createSourceFilter("C:/repo/frontend", {
      include: ["src/**/*.tsx"],
      exclude: ["**/services/**"],
    });
    expect(filter("C:/repo/frontend/src/pages/View.tsx")).toBe(true);
    expect(filter("C:/repo/frontend/src/services/Api.tsx")).toBe(false);
    expect(filter("C:/repo/frontend/src/types.ts")).toBe(false);
  });
});

describe("deterministic unique IDs", () => {
  const context = {
    consumerFileName: "View",
    consumerSourcePath: "src/pages/View.tsx",
    line: 12,
    column: 4,
    callKind: "function" as const,
    parameterIndex: 0,
  };

  it("is stable, normalized, and formatted as a 128-bit hexadecimal ID", () => {
    const id = createDeterministicUniqueId(context);
    expect(id).toMatch(/^inj_[0-9a-f]{32}$/);
    expect(createDeterministicUniqueId(context)).toBe(id);
    expect(
      createDeterministicUniqueId({
        ...context,
        consumerSourcePath: "src\\pages\\View.tsx",
      }),
    ).toBe(id);
  });

  it.each([
    { consumerSourcePath: "src/pages/Other.tsx" },
    { line: 13 },
    { column: 5 },
    { callKind: "jsx" as const },
    { parameterIndex: 1 },
  ])("changes for a distinct static identity: %o", (change) => {
    expect(createDeterministicUniqueId({ ...context, ...change })).not.toBe(
      createDeterministicUniqueId(context),
    );
  });
});

describe("plugin options", () => {
  it("does not parse transforms when no injection type is enabled", async () => {
    const plugin = sourceAwareInjectionPlugin();
    expect(typeof plugin.transform).toBe("function");
    if (typeof plugin.transform !== "function") return;
    await expect(
      Reflect.apply(plugin.transform, {}, [
        "not valid TypeScript }}}",
        "/src/Bad.ts",
      ]),
    ).resolves.toBeNull();
  });
});

describe("consumer transformation", () => {
  function transform(
    code: string,
    metadata = discoverComponents(
      `import type { InjectFileName, InjectSourceLine } from 'ts-source-reflection'; export const Provider = (p: InjectFileName<InjectSourceLine<{}>>) => null;`,
      provider,
      both,
    )[0]!,
    explicitProperty: "preserve" | "error" = "preserve",
  ) {
    const parsed = analyzeConsumer(
      code,
      "/repo/src/pages/TestCaseView.tsx?import",
    );
    const specifier = parsed.imports[0]!.specifiers[0]!;
    const usage: ResolvedExportUsage = {
      ...specifier,
      providerModuleId: provider,
      metadata,
    };
    return transformConsumer({
      parsed,
      usages: [usage],
      registry: both,
      consumerFileName: "TestCaseView",
      consumerSourcePath: "src/pages/TestCaseView.tsx",
      explicitProperty,
    });
  }

  it("injects every requested value at each JSX call site in one AST", () => {
    const result = transform(
      `import { Provider as Local } from './Provider';\nexport const View = () => (\n  <><Local />\n    <Local></Local></>\n);`,
    );
    expect(
      result?.code.match(/_inj_sourceFileName="TestCaseView"/g),
    ).toHaveLength(2);
    expect(result?.code).toContain(
      '_inj_sourceLine="src/pages/TestCaseView.tsx:3"',
    );
    expect(result?.code).toContain(
      '_inj_sourceLine="src/pages/TestCaseView.tsx:4"',
    );
    expect(result?.map?.sources).toContain(
      "/repo/src/pages/TestCaseView.tsx?import",
    );
  });

  it("preserves each explicit property independently", () => {
    const result = transform(
      `import { Provider as Local } from './Provider';\n<Local _inj_sourceFileName="logical" />;`,
    );
    expect(result?.code).toContain('_inj_sourceFileName="logical"');
    expect(result?.code).toContain(
      '_inj_sourceLine="src/pages/TestCaseView.tsx:2"',
    );
  });

  it("errors for explicit properties under error policy", () => {
    expect(() =>
      transform(
        `import { Provider as Local } from './Provider'; <Local _inj_sourceLine="x" />;`,
        undefined,
        "error",
      ),
    ).toThrow(/Explicit _inj_sourceLine/);
  });

  it("rejects spreads and unsupported references", () => {
    expect(() =>
      transform(
        `import { Provider as Local } from './Provider'; <Local {...props} />;`,
      ),
    ).toThrow(/Spread attributes/);
    expect(() =>
      transform(
        `import { Provider as Local } from './Provider'; const Wrapped = Local;`,
      ),
    ).toThrow(SourceAwareCompilerError);
  });
});

describe("function injection discovery", () => {
  it("records marked parameters at any position and returned functions", () => {
    const metadata = discoverComponents(
      `
        import type { InjectFileName, InjectSourceLine } from 'ts-source-reflection';
        export async function direct(first: string, props: InjectSourceLine<{}>) {}
        export function factory(defaults: {}) {
          const showToast = async (props: InjectFileName<InjectSourceLine<{}>>) => {};
          return { showToast };
        }
      `,
      provider,
      both,
    );
    expect(metadata[0]?.callable?.targets[0]?.parameterIndex).toBe(1);
    expect(metadata[1]?.returnedMembers?.[0]?.memberName).toBe("showToast");
    expect(
      metadata[1]?.returnedMembers?.[0]?.callable.targets[0]?.injections,
    ).toHaveLength(2);
  });

  it.each([
    ["defaulted", "props: InjectSourceLine<{}> = {}"],
    ["rest", "...props: InjectSourceLine<{}>"],
  ])("rejects %s injected parameters", (_kind, parameter) => {
    expect(() =>
      discoverComponents(
        `import type { InjectSourceLine } from 'ts-source-reflection'; export function bad(${parameter}) {}`,
        provider,
        both,
      ),
    ).toThrow(/cannot be/);
  });

  it("allows one final optional injected parameter", () => {
    const metadata = discoverComponents(
      `import type { InjectSourceLine } from 'ts-source-reflection'; export function showErrorToast(message: string, props?: InjectSourceLine<{}>) {}`,
      provider,
      both,
    );
    expect(metadata[0]?.callable?.targets[0]).toMatchObject({
      parameterIndex: 1,
      allowsOmission: true,
    });
  });

  it("rejects a marked optional parameter when another argument is optional", () => {
    expect(() =>
      discoverComponents(
        `import type { InjectSourceLine } from 'ts-source-reflection'; export function bad(first?: string, props?: InjectSourceLine<{}>) {}`,
        provider,
        both,
      ),
    ).toThrow(/only optional argument/);
  });

  it("rejects conditional factory return shapes", () => {
    expect(() =>
      discoverComponents(
        `import type { InjectSourceLine } from 'ts-source-reflection'; export function factory(ok: boolean) { const run = (p: InjectSourceLine<{}>) => {}; if (ok) return { run }; return { run }; }`,
        provider,
        both,
      ),
    ).toThrow(/one direct unconditional object return/);
  });
});

describe("ordinary and factory-returned call transformation", () => {
  const transformCalls = (providerCode: string, consumerCode: string) => {
    const metadata = discoverComponents(providerCode, provider, both)[0]!;
    const parsed = analyzeConsumer(consumerCode, "/repo/src/Caller.ts");
    const specifier = parsed.imports[0]!.specifiers[0]!;
    const usage: ResolvedExportUsage = {
      ...specifier,
      providerModuleId: provider,
      metadata,
    };
    return transformConsumer({
      parsed,
      usages: [usage],
      registry: both,
      consumerFileName: "Caller",
      consumerSourcePath: "src/Caller.ts",
      explicitProperty: "preserve",
    });
  };

  it("injects required object literals at arbitrary parameter positions", () => {
    const result = transformCalls(
      `import type { InjectSourceLine } from 'ts-source-reflection'; export async function run(first: string, count: number, props: InjectSourceLine<{ doThing?: () => void }>) {}`,
      `import { run as execute } from './Provider';\nexecute("first", 2, { doThing() {} });`,
    );
    expect(result?.code).toContain('_inj_sourceLine: "src/Caller.ts:2"');
  });

  it("synthesizes an omitted final optional props object", () => {
    const result = transformCalls(
      `import type { InjectSourceLine } from 'ts-source-reflection'; export function showErrorToast(message: string, props?: InjectSourceLine<{}>) {}`,
      `import { showErrorToast } from './Provider';\nshowErrorToast("text");`,
    );
    expect(result?.code).toMatch(
      /showErrorToast\("text", \{\s*_inj_sourceLine: "src\/Caller\.ts:2"\s*\}\)/,
    );
  });

  it("injects destructured, renamed, stored-member, and chained factory calls", () => {
    const result = transformCalls(
      `import type { InjectSourceLine } from 'ts-source-reflection'; export function useToast(defaults: {}) { const showToast = (props: InjectSourceLine<{}>) => {}; return { showToast }; }`,
      `import { useToast } from './Provider';
const { showToast } = useToast({});
showToast({});
const { showToast: notify } = useToast({});
notify({});
const toast = useToast({});
toast.showToast({});
useToast({}).showToast({});`,
    );
    expect(
      result?.code.match(/_inj_sourceLine: "src\/Caller\.ts:/g),
    ).toHaveLength(4);
    expect(result?.code).toContain('_inj_sourceLine: "src/Caller.ts:3"');
    expect(result?.code).toContain('_inj_sourceLine: "src/Caller.ts:5"');
    expect(result?.code).toContain('_inj_sourceLine: "src/Caller.ts:7"');
    expect(result?.code).toContain('_inj_sourceLine: "src/Caller.ts:8"');
  });

  it("injects destructured factory members declared inside a function scope", () => {
    const result = transformCalls(
      `import type { InjectSourceLine } from 'ts-source-reflection'; export function useToast(defaults: {}) { const showToast = (props: InjectSourceLine<{}>) => {}; return { showToast }; }`,
      `import { useToast } from './Provider';
export function FloatingLinkEditor() {
  const { showToast } = useToast({});
  const submitLink = () => {
    showToast({ content: "invalid_link" });
  };
  return submitLink;
}`,
    );
    expect(result?.code).toContain('_inj_sourceLine: "src/Caller.ts:5"');
  });

  it("injects both factory arguments and returned calls", () => {
    const result = transformCalls(
      `import type { InjectFileName, InjectSourceLine } from 'ts-source-reflection'; export function make(options: InjectFileName<{}>) { return { run: (props: InjectSourceLine<{}>) => {} }; }`,
      `import { make } from './Provider';\nmake({}).run({});`,
    );
    expect(result?.code).toContain('_inj_sourceFileName: "Caller"');
    expect(result?.code).toContain('_inj_sourceLine: "src/Caller.ts:2"');
  });

  it.each([
    ["missing", `run()`],
    ["variable", `run(props)`],
    ["spread", `run({ ...props })`],
  ])("rejects %s injected call arguments", (_kind, call) => {
    expect(() =>
      transformCalls(
        `import type { InjectSourceLine } from 'ts-source-reflection'; export function run(props: InjectSourceLine<{}>) {}`,
        `import { run } from './Provider'; const props = {}; ${call};`,
      ),
    ).toThrow();
  });

  it("rejects extraction of an injected returned member", () => {
    expect(() =>
      transformCalls(
        `import type { InjectSourceLine } from 'ts-source-reflection'; export function make() { return { run: (props: InjectSourceLine<{}>) => {} }; }`,
        `import { make } from './Provider'; const result = make(); const run = result.run; run({});`,
      ),
    ).toThrow(/returned function|Factory result/);
  });

  it("rejects computed returned-member calls", () => {
    expect(() =>
      transformCalls(
        `import type { InjectSourceLine } from 'ts-source-reflection'; export function make() { return { run: (props: InjectSourceLine<{}>) => {} }; }`,
        `import { make } from './Provider'; make()["run"]({});`,
      ),
    ).toThrow(/Factory result/);
  });

  it("injects distinct stable IDs into direct and returned calls", () => {
    const uniqueRegistry = createInjectionRegistry({
      injectFileName: false,
      injectSourceLine: false,
      injectUniqueId: true,
    });
    const providerCode = `import type { InjectUniqueId } from 'ts-source-reflection'; export function make(props: InjectUniqueId<{}>) { return { run: (value: InjectUniqueId<{}>) => value }; }`;
    const metadata = discoverComponents(
      providerCode,
      provider,
      uniqueRegistry,
    )[0]!;
    const parsed = analyzeConsumer(
      `import { make } from './Provider';\nmake({}).run({});`,
      "/repo/src/Caller.ts",
    );
    const usage: ResolvedExportUsage = {
      ...parsed.imports[0]!.specifiers[0]!,
      providerModuleId: provider,
      metadata,
    };
    const result = transformConsumer({
      parsed,
      usages: [usage],
      registry: uniqueRegistry,
      consumerFileName: "Caller",
      consumerSourcePath: "src/Caller.ts",
      explicitProperty: "preserve",
    });
    const ids = result?.code.match(/inj_[0-9a-f]{32}/g) ?? [];
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
