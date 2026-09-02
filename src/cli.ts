#!/usr/bin/env node
import path from "node:path";
import { resolveConfig, type Plugin, type ResolvedConfig } from "vite";
import type { SourceAwarePluginApi } from "./plugin";
import { formatVerificationResult } from "./verifier";

interface CliOptions {
  command?: string;
  config?: string;
  root: string;
  mode: string;
  format: "pretty" | "json";
}

class CliError extends Error {}

function usage(): string {
  return `Usage: ts-source-reflection check [options]

Options:
  --config <file>          Vite config file
  --root <directory>       Vite project root (default: current directory)
  --mode <mode>            Vite mode (default: production)
  --format <pretty|json>   Output format (default: pretty)
  --help                   Show this help`;
}

function parseArguments(argv: string[]): CliOptions {
  const result: CliOptions = {
    root: process.cwd(),
    mode: "production",
    format: "pretty",
  };
  const args = [...argv];
  result.command = args.shift();
  while (args.length) {
    const argument = args.shift()!;
    if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    }
    const value = args.shift();
    if (!value) throw new CliError(`Missing value for ${argument}`);
    if (argument === "--config") result.config = value;
    else if (argument === "--root") result.root = value;
    else if (argument === "--mode") result.mode = value;
    else if (argument === "--format") {
      if (value !== "pretty" && value !== "json")
        throw new CliError(`Unsupported output format: ${value}`);
      result.format = value;
    } else throw new CliError(`Unknown option: ${argument}`);
  }
  return result;
}

function configuredApis(config: ResolvedConfig): SourceAwarePluginApi[] {
  return config.plugins.flatMap((plugin: Plugin) => {
    const api = (plugin as Plugin & { api?: Partial<SourceAwarePluginApi> })
      .api;
    return api?.kind === "ts-source-reflection" && api.version === 1
      ? [api as SourceAwarePluginApi]
      : [];
  });
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.command !== "check")
    throw new CliError(
      options.command
        ? `Unknown command: ${options.command}\n\n${usage()}`
        : usage(),
    );
  const root = path.resolve(options.root);
  const config = await resolveConfig(
    {
      root,
      configFile: options.config
        ? path.resolve(root, options.config)
        : undefined,
      mode: options.mode,
    },
    "build",
    options.mode,
  );
  const apis = configuredApis(config);
  if (apis.length === 0)
    throw new CliError(
      "The resolved Vite config does not register sourceAwareInjectionPlugin().",
    );
  if (apis.length > 1)
    throw new CliError(
      "The resolved Vite config contains multiple sourceAwareInjectionPlugin() instances.",
    );
  const api = apis[0]!;
  if (!api.enabled)
    throw new CliError(
      "sourceAwareInjectionPlugin() has no enabled injection types.",
    );
  const resolve = config.createResolver();
  const result = await api.verify(
    async (source, importer) =>
      (await resolve(source, importer, false, false)) ?? null,
  );
  console.log(formatVerificationResult(result, options.format));
  if (!result.ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 2;
});
