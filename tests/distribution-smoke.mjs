import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import { sourceAwareProps } from "../dist/index.js";

const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "ts-source-reflection-dist-"),
);

try {
  await fs.writeFile(
    path.join(root, "Provider.tsx"),
    `
      import { WithFileName } from 'ts-source-reflection';
      type Props = WithFileName<{}>;
      export const Provider = ({ _inj_sourceFileName }: Props) => _inj_sourceFileName;
    `,
  );
  await fs.writeFile(
    path.join(root, "DistributionConsumer.tsx"),
    `
      import { Provider } from './Provider';
      export const value = <Provider />;
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
        entry: path.join(root, "DistributionConsumer.tsx"),
        formats: ["es"],
      },
      rollupOptions: { external: ["ts-source-reflection"] },
    },
  });
  const results = Array.isArray(output) ? output : [output];
  const code = results
    .flatMap((result) => result.output)
    .filter((item) => item.type === "chunk")
    .map((item) => item.code)
    .join("\n");
  if (!code.includes("DistributionConsumer")) {
    throw new Error(
      "Published ESM plugin did not inject the consumer filename",
    );
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
