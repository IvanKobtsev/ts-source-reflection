import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { build } from "vite";
import { sourceAwareInjectionPlugin } from "../dist/index.js";

const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "ts-source-reflection-dist-"),
);
const execFileAsync = promisify(execFile);

try {
  await fs.writeFile(
    path.join(root, "Provider.tsx"),
    `
      import { InjectFileName, InjectSourceLine, InjectUniqueId } from 'ts-source-reflection';
      type Props = InjectFileName<InjectSourceLine<InjectUniqueId<{}>>>;
      export const Provider = ({ _inj_sourceFileName, _inj_sourceLine, _inj_uniqueId }: Props) => [_inj_sourceFileName, _inj_sourceLine, _inj_uniqueId];
      export function run(props: InjectSourceLine<{}>) { return props._inj_sourceLine; }
      export function useToast() {
        const showToast = (props: InjectSourceLine<{}>) => props._inj_sourceLine;
        return { showToast };
      }
    `,
  );
  await fs.writeFile(
    path.join(root, "DistributionConsumer.tsx"),
    `
      import { Provider, run, useToast } from './Provider';
      const { showToast } = useToast();
      export const value = <Provider />;
      export const direct = run({});
      export const returned = showToast({});
    `,
  );

  const output = await build({
    root,
    logLevel: "silent",
    plugins: [
      sourceAwareInjectionPlugin({
        injectFileName: true,
        injectSourceLine: true,
        injectUniqueId: true,
      }),
    ],
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
  if (!code.includes("DistributionConsumer.tsx:4")) {
    throw new Error("Published ESM plugin did not inject the JSX source line");
  }
  if (!code.includes("DistributionConsumer.tsx:5")) {
    throw new Error(
      "Published ESM plugin did not inject a direct function call",
    );
  }
  if (!code.includes("DistributionConsumer.tsx:6")) {
    throw new Error(
      "Published ESM plugin did not inject a returned function call",
    );
  }
  if (!/inj_[0-9a-f]{32}/.test(code)) {
    throw new Error("Published ESM plugin did not inject a deterministic ID");
  }
  if (code.includes("node:crypto") || code.includes("createHash")) {
    throw new Error("Application output contains build-time hashing code");
  }

  const packageRoot = process.cwd();
  const pluginUrl = pathToFileURL(path.join(packageRoot, "dist/index.js")).href;
  await fs.writeFile(
    path.join(root, "vite.config.mjs"),
    `import { sourceAwareInjectionPlugin } from ${JSON.stringify(pluginUrl)};
     export default { plugins: [sourceAwareInjectionPlugin({ injectSourceLine: true })] };`,
  );
  const cli = path.join(packageRoot, "dist/cli.js");
  const { stdout } = await execFileAsync(process.execPath, [
    cli,
    "check",
    "--root",
    root,
  ]);
  if (!stdout.includes("All injection-aware usages are transformable")) {
    throw new Error("Published CLI did not verify the fixture project");
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
