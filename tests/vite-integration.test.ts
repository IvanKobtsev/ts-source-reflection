import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "vite";
import { sourceAwareProps } from "../src";

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
        import type { WithFileName } from 'ts-source-reflection';
        type Props = WithFileName<{}>;
        export const Provider = ({ _inj_sourceFileName }: Props) => _inj_sourceFileName;
      `,
    );
    await fs.writeFile(
      path.join(root, "RepositoryPage.test.tsx"),
      `
        import { Provider as Local } from './Provider';
        export const value = <Local />;
      `,
    );

    const output = await build({
      root,
      logLevel: "silent",
      plugins: [sourceAwareProps()],
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
  });
});
