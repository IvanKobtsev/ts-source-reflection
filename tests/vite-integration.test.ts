import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "vite";
import { sourceAwareInjectionPlugin } from "../src";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("Vite integration", () => {
  it("discovers a provider and injects the production bundle value", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ts-source-reflection-"),
    );
    temporaryDirectories.push(root);
    await fs.writeFile(
      path.join(root, "Provider.tsx"),
      `
        import { InjectFileName, InjectSourceLine } from 'ts-source-reflection';
        type Props = InjectFileName<InjectSourceLine<{}>>;
        export const Provider = ({ _inj_sourceFileName, _inj_sourceLine }: Props) => [_inj_sourceFileName, _inj_sourceLine];
        export function run(props: InjectSourceLine<{}>) { return props._inj_sourceLine; }
        export function useToast() {
          const showToast = (props: InjectSourceLine<{}>) => props._inj_sourceLine;
          return { showToast };
        }
      `,
    );
    await fs.writeFile(
      path.join(root, "RepositoryPage.test.tsx"),
      `
        import { Provider as Local, run, useToast } from './Provider';
        const { showToast } = useToast();
        export const value = <Local />;
        export const direct = run({});
        export const returned = showToast({});
        export const chained = useToast().showToast({});
      `,
    );

    const output = await build({
      root,
      logLevel: "silent",
      plugins: [
        sourceAwareInjectionPlugin({
          injectFileName: true,
          injectSourceLine: true,
        }),
      ],
      build: {
        write: false,
        minify: false,
        lib: {
          entry: path.join(root, "RepositoryPage.test.tsx"),
          formats: ["es"],
        },
        rollupOptions: { external: ["ts-source-reflection"] },
      },
    });
    const rollupOutput = output as
      | { output: Array<{ type: string; code?: string }> }
      | Array<{ output: Array<{ type: string; code?: string }> }>;
    const generated = Array.isArray(rollupOutput)
      ? rollupOutput.flatMap((item) => item.output)
      : rollupOutput.output;
    const chunk = generated.find((item) => item.type === "chunk");
    expect(chunk?.code ?? "").toContain("RepositoryPage.test");
    expect(chunk?.code ?? "").toContain("RepositoryPage.test.tsx:4");
    expect(chunk?.code ?? "").toContain("RepositoryPage.test.tsx:5");
    expect(chunk?.code ?? "").toContain("RepositoryPage.test.tsx:6");
    expect(chunk?.code ?? "").toContain("RepositoryPage.test.tsx:7");
  });
});
