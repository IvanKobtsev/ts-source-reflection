import { describe, expect, it } from "vitest";
import {
  discoverComponents,
  findNamedImports,
  SourceAwareCompilerError,
  transformConsumer,
} from "../src/compiler";
import { deriveConsumerFileName } from "../src/plugin";

const provider = "/src/Provider.tsx";

describe("component discovery", () => {
  it("discovers exported functions and arrows with inline or direct alias markers", () => {
    const code = `
      import type { WithFileName as InjectFile } from 'ts-source-reflection';
      type Props = InjectFile<{ required: string }>;
      export function FunctionProvider(props: Props) { return null }
      export const ArrowProvider = (props: InjectFile<{}>) => null;
      export const Plain = (props: {}) => null;
    `;
    expect(
      discoverComponents(code, provider).map((item) => item.exportName),
    ).toEqual(["FunctionProvider", "ArrowProvider"]);
  });

  it("supports several marked exports and ignores indirect aliases", () => {
    const code = `
      import type { WithFileName } from 'ts-source-reflection';
      type Marked = WithFileName<{}>;
      type Indirect = Marked;
      export const One = (props: Marked) => null;
      export const Two = (props: WithFileName<{}>) => null;
      export const Unsupported = (props: Indirect) => null;
    `;
    expect(
      discoverComponents(code, provider).map((item) => item.exportName),
    ).toEqual(["One", "Two"]);
  });

  it("rejects malformed markers with a code frame", () => {
    const code = `
      import type { WithFileName } from 'ts-source-reflection';
      export const Bad = (props: WithFileName) => null;
    `;
    expect(() => discoverComponents(code, provider)).toThrow(
      /exactly one type argument/,
    );
    expect(() => discoverComponents(code, provider)).toThrow(
      /Provider\.tsx:3:/,
    );
  });
});

describe("named import parsing", () => {
  it("follows aliases and ignores type-only specifiers", () => {
    const imports = findNamedImports(
      `import { Provider as Local, type Props } from './Provider';`,
      "/src/View.tsx",
    );
    expect(imports).toEqual([
      {
        source: "./Provider",
        specifiers: [{ exportName: "Provider", localName: "Local" }],
      },
    ]);
  });
});

describe("consumer filenames", () => {
  it.each([
    ["/src/pages/RepositoryPage.tsx", "RepositoryPage"],
    ["/src/pages/RepositoryPage.test.tsx?import#hash", "RepositoryPage.test"],
    ["C:\\src\\pages\\index.tsx", "index"],
    ["\0virtual:module", null],
    ["/src/extensionless", null],
  ])("derives %s as %s", (id, expected) => {
    expect(deriveConsumerFileName(id)).toBe(expected);
  });
});

describe("consumer transformation", () => {
  const component = {
    localName: "Local",
    exportName: "Provider",
    providerModuleId: provider,
  };

  const transform = (
    code: string,
    explicitProperty: "preserve" | "error" = "preserve",
    id = "/src/pages/RepositoryPage.test.tsx?import",
  ) =>
    transformConsumer({
      code,
      id,
      fileName: "RepositoryPage.test",
      components: [component],
      explicitProperty,
    });

  it("injects aliases into nested and self-closing JSX and emits a source map", () => {
    const result = transform(`
      import { Provider as Local } from './Provider';
      export const View = () => <><Local><Local /></Local></>;
    `);
    expect(
      result?.code.match(/_inj_sourceFileName="RepositoryPage\.test"/g),
    ).toHaveLength(2);
    expect(result?.map?.sources).toContain(
      "/src/pages/RepositoryPage.test.tsx?import",
    );
  });

  it("preserves an explicit property", () => {
    const result = transform(`
      import { Provider as Local } from './Provider';
      export const View = () => <Local _inj_sourceFileName="logical-name" />;
    `);
    expect(result).toBeNull();
  });

  it("errors on explicit properties when configured", () => {
    expect(() =>
      transform(
        `import { Provider as Local } from './Provider'; <Local _inj_sourceFileName="x" />;`,
        "error",
      ),
    ).toThrow(/Explicit _inj_sourceFileName/);
  });

  it("rejects spreads and unsupported value references", () => {
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

  it("leaves unrelated code untouched", () => {
    expect(
      transformConsumer({
        code: `export const View = () => <div />`,
        id: "/src/View.tsx",
        fileName: "View",
        components: [],
        explicitProperty: "preserve",
      }),
    ).toBeNull();
  });
});
