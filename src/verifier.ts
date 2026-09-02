import { promises as fs } from "node:fs";
import path from "node:path";
import { codeFrameColumns } from "@babel/code-frame";
import { parse } from "@babel/parser";
import * as t from "@babel/types";
import fg from "fast-glob";
import { normalizePath } from "vite";
import {
  analyzeConsumer,
  discoverExports,
  findSameModuleExportReferences,
  SourceAwareCompilerError,
  transformConsumer,
  type InjectionDefinition,
  type ResolvedExportUsage,
  type SourceAwareExportMetadata,
} from "./compiler";

export type VerificationDiagnosticCode =
  | "invalid-declaration"
  | "invalid-call-site"
  | "unsupported-reference"
  | "unsupported-re-export"
  | "unsupported-same-module-reference"
  | "unresolved-project-import"
  | "excluded-injection-declaration"
  | "excluded-injection-import"
  | "unverifiable-excluded-file";

export interface VerificationDiagnostic {
  code: VerificationDiagnosticCode;
  file: string;
  line?: number;
  column?: number;
  reason: string;
  frame?: string;
  provider?: string;
  exportName?: string;
  memberName?: string;
  parameterIndex?: number;
  properties?: string[];
}

export interface VerificationResult {
  ok: boolean;
  root: string;
  activeFiles: number;
  auditedFiles: number;
  injectionAwareExports: number;
  callSites: number;
  diagnostics: VerificationDiagnostic[];
  manifest: Map<string, Map<string, SourceAwareExportMetadata>>;
}

export interface VerificationOptions {
  root: string;
  registry: readonly InjectionDefinition[];
  explicitProperty: "preserve" | "error";
  isIncluded(id: string): boolean;
  resolve(source: string, importer: string): Promise<string | null>;
}

interface ModuleLink {
  source: string;
  imported: string;
  local?: string;
  node: t.Node;
  reExport: boolean;
  exportAll: boolean;
}

const HARD_EXCLUDE = ["**/node_modules/**", "**/dist/**", "**/*.d.ts"];
const MARKERS = ["InjectFileName", "InjectSourceLine", "InjectUniqueId"];

function canonical(id: string): string {
  return normalizePath(path.resolve(id.split(/[?#]/, 1)[0]!));
}

async function canonicalExisting(id: string): Promise<string> {
  const cleaned = id.split(/[?#]/, 1)[0]!;
  try {
    return normalizePath(await fs.realpath(cleaned));
  } catch {
    return canonical(cleaned);
  }
}

function sourcePath(root: string, id: string): string {
  return normalizePath(path.relative(path.resolve(root), id));
}

function fileName(id: string): string {
  const base = path.basename(id);
  return base.slice(0, base.lastIndexOf("."));
}

async function resolveModule(
  options: VerificationOptions,
  source: string,
  importer: string,
): Promise<string | null> {
  const resolved = await options.resolve(source, importer);
  if (resolved) return canonicalExisting(resolved);
  if (!source.startsWith(".")) return null;
  const base = path.resolve(path.dirname(importer), source);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    try {
      if ((await fs.stat(candidate)).isFile())
        return canonicalExisting(candidate);
    } catch {
      // Continue through the supported source extensions.
    }
  }
  return null;
}

function nodeDiagnostic(
  code: VerificationDiagnosticCode,
  reason: string,
  file: string,
  source: string,
  node?: t.Node | null,
  details: Partial<VerificationDiagnostic> = {},
): VerificationDiagnostic {
  const location = node?.loc?.start;
  return {
    code,
    file,
    line: location?.line,
    column: location ? location.column + 1 : undefined,
    reason,
    frame: location
      ? codeFrameColumns(
          source,
          { start: { line: location.line, column: location.column + 1 } },
          { highlightCode: false },
        )
      : undefined,
    ...details,
  };
}

function compilerDiagnostic(
  error: SourceAwareCompilerError,
  fallbackFile: string,
  code: VerificationDiagnosticCode,
): VerificationDiagnostic {
  return {
    code,
    file: error.file ?? fallbackFile,
    line: error.line,
    column: error.column,
    reason: error.reason ?? error.message,
    frame: error.frame || undefined,
  };
}

function parseLinks(code: string, id: string): ModuleLink[] {
  const ast = parse(code, {
    sourceType: "module",
    sourceFilename: id,
    plugins: ["typescript", "jsx"],
  });
  const links: ModuleLink[] = [];
  for (const statement of ast.program.body) {
    if (t.isImportDeclaration(statement)) {
      if (statement.importKind === "type") continue;
      for (const specifier of statement.specifiers) {
        if (!t.isImportSpecifier(specifier) || specifier.importKind === "type")
          continue;
        links.push({
          source: statement.source.value,
          imported: t.isIdentifier(specifier.imported)
            ? specifier.imported.name
            : specifier.imported.value,
          local: specifier.local.name,
          node: specifier,
          reExport: false,
          exportAll: false,
        });
      }
    }
    if (t.isExportNamedDeclaration(statement) && statement.source) {
      if (statement.exportKind === "type") continue;
      for (const specifier of statement.specifiers) {
        if (!t.isExportSpecifier(specifier) || specifier.exportKind === "type")
          continue;
        links.push({
          source: statement.source.value,
          imported: specifier.local.name,
          node: specifier,
          reExport: true,
          exportAll: false,
        });
      }
    }
    if (t.isExportAllDeclaration(statement) && statement.exportKind !== "type")
      links.push({
        source: statement.source.value,
        imported: "*",
        node: statement,
        reExport: true,
        exportAll: true,
      });
  }
  return links;
}

function countCallSites(usage: ResolvedExportUsage): number {
  let count = usage.openingElements.length + usage.directCalls.length;
  for (const factory of usage.factoryCalls)
    for (const member of factory.members.values()) count += member.calls.length;
  return count;
}

export async function verifyProject(
  options: VerificationOptions,
): Promise<VerificationResult> {
  const configuredRoot = path.resolve(options.root);
  const root = await canonicalExisting(configuredRoot);
  const files = await fg(["**/*.ts", "**/*.tsx"], {
    cwd: configuredRoot,
    absolute: true,
    onlyFiles: true,
    ignore: HARD_EXCLUDE,
  });
  const active = await Promise.all(
    files.filter(options.isIncluded).map(canonicalExisting),
  );
  const audited = await Promise.all(
    files.filter((id) => !options.isIncluded(id)).map(canonicalExisting),
  );
  const diagnostics: VerificationDiagnostic[] = [];
  const sources = new Map<string, string>();
  const manifest = new Map<string, Map<string, SourceAwareExportMetadata>>();

  for (const id of active) {
    const code = await fs.readFile(id, "utf8");
    sources.set(id, code);
    try {
      const metadata = discoverExports(code, id, options.registry);
      manifest.set(
        id,
        new Map(metadata.map((item) => [item.exportName, item])),
      );
      for (const reference of findSameModuleExportReferences(
        code,
        id,
        new Set(metadata.map(({ exportName }) => exportName)),
      ))
        diagnostics.push(
          nodeDiagnostic(
            "unsupported-same-module-reference",
            "Injection-aware exports cannot be referenced from their declaring module",
            id,
            code,
            reference.node,
            { provider: id, exportName: reference.exportName },
          ),
        );
    } catch (error) {
      diagnostics.push(
        error instanceof SourceAwareCompilerError
          ? compilerDiagnostic(error, id, "invalid-declaration")
          : nodeDiagnostic("invalid-declaration", String(error), id, code),
      );
    }
  }

  let callSites = 0;
  for (const id of active) {
    const code = sources.get(id)!;
    let links: ModuleLink[] = [];
    try {
      links = parseLinks(code, id);
    } catch (error) {
      diagnostics.push(
        nodeDiagnostic("invalid-call-site", String(error), id, code),
      );
      continue;
    }
    for (const link of links.filter(({ reExport }) => reExport)) {
      const resolved = await resolveModule(options, link.source, id);
      if (!resolved) {
        if (link.source.startsWith(".") || path.isAbsolute(link.source))
          diagnostics.push(
            nodeDiagnostic(
              "unresolved-project-import",
              `Could not resolve project re-export ${link.source}`,
              id,
              code,
              link.node,
            ),
          );
        continue;
      }
      const exports = manifest.get(resolved);
      if (exports?.size && (link.exportAll || exports.has(link.imported)))
        diagnostics.push(
          nodeDiagnostic(
            "unsupported-re-export",
            "Injection-aware exports cannot pass through barrel re-exports",
            id,
            code,
            link.node,
            { provider: resolved, exportName: link.imported },
          ),
        );
    }

    let parsed;
    try {
      parsed = analyzeConsumer(code, id);
    } catch (error) {
      diagnostics.push(
        error instanceof SourceAwareCompilerError
          ? compilerDiagnostic(error, id, "invalid-call-site")
          : nodeDiagnostic("invalid-call-site", String(error), id, code),
      );
      continue;
    }
    const usages: ResolvedExportUsage[] = [];
    for (const imported of parsed.imports) {
      const resolved = await resolveModule(options, imported.source, id);
      if (!resolved) {
        if (imported.source.startsWith(".") || path.isAbsolute(imported.source))
          diagnostics.push(
            nodeDiagnostic(
              "unresolved-project-import",
              `Could not resolve project import ${imported.source}`,
              id,
              code,
            ),
          );
        continue;
      }
      const providerId = resolved;
      const exports = manifest.get(providerId);
      for (const specifier of imported.specifiers) {
        const metadata = exports?.get(specifier.exportName);
        if (!metadata) continue;
        const usage: ResolvedExportUsage = {
          ...specifier,
          providerModuleId: providerId,
          metadata,
        };
        usages.push(usage);
        callSites += countCallSites(usage);
      }
    }
    try {
      transformConsumer({
        parsed,
        usages,
        registry: options.registry,
        consumerFileName: fileName(id),
        consumerSourcePath: sourcePath(root, id),
        explicitProperty: options.explicitProperty,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const codeName = /unsupported expression|unsupported/.test(reason)
        ? "unsupported-reference"
        : "invalid-call-site";
      diagnostics.push(
        error instanceof SourceAwareCompilerError
          ? compilerDiagnostic(error, id, codeName)
          : nodeDiagnostic(codeName, reason, id, code),
      );
    }
  }

  const providerIds = new Set(manifest.keys());
  for (const id of audited) {
    const code = await fs.readFile(id, "utf8");
    const mentionsMarker =
      code.includes("ts-source-reflection") &&
      MARKERS.some((marker) => code.includes(marker));
    let links: ModuleLink[];
    try {
      links = parseLinks(code, id);
    } catch (error) {
      if (mentionsMarker)
        diagnostics.push(
          nodeDiagnostic(
            "unverifiable-excluded-file",
            `Excluded file mentions injection markers but cannot be analyzed: ${String(error)}`,
            id,
            code,
          ),
        );
      continue;
    }
    if (mentionsMarker)
      diagnostics.push(
        nodeDiagnostic(
          "excluded-injection-declaration",
          "Excluded project file imports an injection marker and cannot be transformed",
          id,
          code,
          links.find(({ source }) => source === "ts-source-reflection")?.node,
        ),
      );
    for (const link of links) {
      if (link.source === "ts-source-reflection") continue;
      const resolved = await resolveModule(options, link.source, id);
      if (!resolved || !providerIds.has(resolved)) continue;
      const provider = manifest.get(resolved);
      if (!link.exportAll && !provider?.has(link.imported)) continue;
      diagnostics.push(
        nodeDiagnostic(
          "excluded-injection-import",
          "Excluded project file imports or re-exports an injection-aware callable",
          id,
          code,
          link.node,
          { provider: resolved, exportName: link.imported },
        ),
      );
    }
  }

  const injectionAwareExports = [...manifest.values()].reduce(
    (total, exports) => total + exports.size,
    0,
  );
  return {
    ok: diagnostics.length === 0,
    root,
    activeFiles: active.length,
    auditedFiles: audited.length,
    injectionAwareExports,
    callSites,
    diagnostics,
    manifest,
  };
}

export function formatVerificationResult(
  result: VerificationResult,
  format: "pretty" | "json" = "pretty",
): string {
  if (format === "json") {
    const serializable = {
      ok: result.ok,
      root: result.root,
      activeFiles: result.activeFiles,
      auditedFiles: result.auditedFiles,
      injectionAwareExports: result.injectionAwareExports,
      callSites: result.callSites,
      diagnostics: result.diagnostics,
    };
    return JSON.stringify(serializable, null, 2);
  }
  const lines: string[] = [];
  for (const diagnostic of result.diagnostics) {
    const location = diagnostic.line
      ? `:${diagnostic.line}:${diagnostic.column ?? 1}`
      : "";
    lines.push(
      `[${diagnostic.code}] ${diagnostic.file}${location}\n${diagnostic.reason}`,
    );
    if (diagnostic.provider) lines.push(`Provider: ${diagnostic.provider}`);
    if (diagnostic.exportName) lines.push(`Export: ${diagnostic.exportName}`);
    if (diagnostic.frame) lines.push(diagnostic.frame);
    lines.push("");
  }
  lines.push(
    `Checked ${result.activeFiles} active files and audited ${result.auditedFiles} filtered files.`,
    `Verified ${result.injectionAwareExports} injection-aware exports and ${result.callSites} call sites.`,
  );
  lines.push(
    result.ok
      ? "All injection-aware usages are transformable."
      : `Found ${result.diagnostics.length} verification error(s).`,
  );
  return lines.join("\n");
}
