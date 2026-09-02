import { promises as fs } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { HmrContext, ModuleNode, Plugin, ResolvedConfig } from "vite";
import { createFilter, normalizePath } from "vite";
import {
  analyzeConsumer,
  createInjectionRegistry,
  discoverExports,
  SourceAwareCompilerError,
  transformConsumer,
  type ResolvedExportUsage,
  type SourceAwareExportMetadata,
} from "./compiler";
import {
  formatVerificationResult,
  verifyProject,
  type VerificationResult,
} from "./verifier";

export interface SourceAwareInjectionPluginOptions {
  include?: string[];
  exclude?: string[];
  explicitProperty?: "preserve" | "error";
  injectFileName?: boolean;
  injectSourceLine?: boolean;
  injectUniqueId?: boolean;
}

interface ProviderCacheEntry {
  version: number;
  signature: string;
}

export interface SourceAwarePluginApi {
  readonly kind: "ts-source-reflection";
  readonly version: 1;
  readonly enabled: boolean;
  verify(
    resolve: (source: string, importer: string) => Promise<string | null>,
  ): Promise<VerificationResult>;
}

const DEFAULT_INCLUDE = ["**/*.ts", "**/*.tsx"];
const DEFAULT_EXCLUDE = ["**/node_modules/**", "**/dist/**", "**/*.d.ts"];

export function createSourceFilter(
  root: string,
  options: Pick<SourceAwareInjectionPluginOptions, "include" | "exclude">,
): (id: string) => boolean {
  return createFilter(
    options.include ?? DEFAULT_INCLUDE,
    [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])],
    { resolve: root },
  );
}

function cleanId(id: string): string {
  return id.split(/[?#]/, 1)[0]!;
}

function canonicalFileId(id: string): string | null {
  const cleaned = cleanId(id);
  if (!cleaned || cleaned.startsWith("\0") || cleaned.includes("\0"))
    return null;
  return normalizePath(path.resolve(cleaned));
}

export function deriveConsumerFileName(id: string): string | null {
  const cleaned = cleanId(id).replaceAll("\\", "/");
  if (!cleaned || cleaned.startsWith("\0")) return null;
  const base = cleaned.slice(cleaned.lastIndexOf("/") + 1);
  if (!base || !base.includes(".")) return null;
  return base.slice(0, base.lastIndexOf("."));
}

export function deriveConsumerSourcePath(
  root: string,
  id: string,
): string | null {
  const consumerId = canonicalFileId(id);
  if (!consumerId) return null;
  return normalizePath(path.relative(path.resolve(root), consumerId));
}

function metadataSignature(metadata: SourceAwareExportMetadata[]): string {
  return JSON.stringify(
    metadata
      .map(({ exportName, callable, returnedMembers }) => ({
        exportName,
        callable,
        returnedMembers,
      }))
      .sort((left, right) => left.exportName.localeCompare(right.exportName)),
  );
}

export function sourceAwareInjectionPlugin(
  options: SourceAwareInjectionPluginOptions = {},
): Plugin & { api: SourceAwarePluginApi } {
  const explicitProperty = options.explicitProperty ?? "preserve";
  const registry = createInjectionRegistry({
    injectFileName: options.injectFileName ?? false,
    injectSourceLine: options.injectSourceLine ?? false,
    injectUniqueId: options.injectUniqueId ?? false,
  });
  const hasEnabledInjections = registry.some(({ enabled }) => enabled);
  const metadata = new Map<string, Map<string, SourceAwareExportMetadata>>();
  const providerCache = new Map<string, ProviderCacheEntry>();
  const providerConsumers = new Map<string, Set<string>>();
  const consumerProviders = new Map<string, Set<string>>();
  const importResolutionCache = new Map<string, Map<string, string | null>>();
  let config: ResolvedConfig;
  let isIncluded: (id: string) => boolean = () => true;

  const runVerification = async (
    resolve: (source: string, importer: string) => Promise<string | null>,
  ) => {
    const result = await verifyProject({
      root: config.root,
      registry,
      explicitProperty,
      isIncluded,
      resolve,
    });
    metadata.clear();
    for (const [moduleId, exports] of result.manifest)
      metadata.set(moduleId, exports);
    return result;
  };

  const removeConsumerEdges = (consumerId: string) => {
    for (const providerId of consumerProviders.get(consumerId) ?? []) {
      const consumers = providerConsumers.get(providerId);
      consumers?.delete(consumerId);
      if (consumers?.size === 0) providerConsumers.delete(providerId);
    }
    consumerProviders.delete(consumerId);
  };

  const addEdge = (providerId: string, consumerId: string) => {
    const consumers = providerConsumers.get(providerId) ?? new Set<string>();
    consumers.add(consumerId);
    providerConsumers.set(providerId, consumers);
    const providers = consumerProviders.get(consumerId) ?? new Set<string>();
    providers.add(providerId);
    consumerProviders.set(consumerId, providers);
  };

  const discoverFile = async (
    file: string,
    force = false,
  ): Promise<boolean> => {
    const id = canonicalFileId(file);
    if (!id || !isIncluded(id)) return false;
    let stat;
    try {
      stat = await fs.stat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const previous = providerCache.get(id);
      metadata.delete(id);
      providerCache.delete(id);
      return Boolean(previous?.signature && previous.signature !== "[]");
    }
    const cached = providerCache.get(id);
    if (!force && cached?.version === stat.mtimeMs) return false;
    const code = await fs.readFile(file, "utf8");
    const found = discoverExports(code, id, registry);
    const signature = metadataSignature(found);
    metadata.set(id, new Map(found.map((item) => [item.exportName, item])));
    providerCache.set(id, { version: stat.mtimeMs, signature });
    return cached !== undefined && cached.signature !== signature;
  };

  const invalidateConsumers = (
    ctx: HmrContext,
    providerId: string,
  ): ModuleNode[] => {
    const affected: ModuleNode[] = [];
    for (const consumerId of providerConsumers.get(providerId) ?? []) {
      const module = ctx.server.moduleGraph.getModuleById(consumerId);
      if (!module) continue;
      ctx.server.moduleGraph.invalidateModule(module);
      affected.push(module);
    }
    return affected;
  };

  return {
    name: "ts-source-reflection:source-aware-injection",
    enforce: "pre",
    api: {
      kind: "ts-source-reflection",
      version: 1,
      enabled: hasEnabledInjections,
      verify: runVerification,
    },
    configResolved(resolved) {
      config = resolved;
      isIncluded = createSourceFilter(config.root, options);
    },
    async buildStart() {
      if (!hasEnabledInjections) return;
      if (config.command === "build") {
        const result = await runVerification(async (source, importer) => {
          const resolved = await this.resolve(source, importer, {
            skipSelf: true,
          });
          return resolved?.id ?? null;
        });
        if (!result.ok) this.error(formatVerificationResult(result));
        return;
      }
      const files = await fg(options.include ?? DEFAULT_INCLUDE, {
        cwd: config.root,
        absolute: true,
        onlyFiles: true,
        ignore: [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])],
      });
      try {
        await Promise.all(files.map((file) => discoverFile(file)));
      } catch (error) {
        this.error(error instanceof Error ? error : String(error));
      }
    },
    async transform(code, rawId) {
      if (!hasEnabledInjections) return null;
      const id = canonicalFileId(rawId);
      const fileName = deriveConsumerFileName(rawId);
      const sourcePath = deriveConsumerSourcePath(config.root, rawId);
      if (
        !id ||
        !isIncluded(id) ||
        !fileName ||
        !sourcePath ||
        !/\.[cm]?[jt]sx?$/.test(cleanId(rawId))
      )
        return null;

      removeConsumerEdges(id);
      const imports = /\bfrom\s*['"]|\bimport\s*['"]/.test(code);
      if (!imports) return null;

      const parsed = analyzeConsumer(code, id);
      const resolvedExports: ResolvedExportUsage[] = [];
      const resolutionForConsumer =
        importResolutionCache.get(id) ?? new Map<string, string | null>();
      importResolutionCache.set(id, resolutionForConsumer);
      for (const imported of parsed.imports) {
        const source = imported.source;
        let providerId = resolutionForConsumer.get(source);
        if (providerId === undefined) {
          const resolved = await this.resolve(source, rawId, {
            skipSelf: true,
          });
          providerId = resolved ? canonicalFileId(resolved.id) : null;
          resolutionForConsumer.set(source, providerId);
        }
        if (!providerId) continue;
        let exports = metadata.get(providerId);
        if (!exports) {
          try {
            const realProviderId = normalizePath(
              await fs.realpath(cleanId(providerId)),
            );
            exports = metadata.get(realProviderId);
            if (exports) providerId = realProviderId;
          } catch {
            // Resolution diagnostics are handled by Vite or whole-project verification.
          }
        }
        if (!exports?.size) continue;
        for (const specifier of imported.specifiers) {
          const exportMetadata = exports.get(specifier.exportName);
          if (!exportMetadata) continue;
          resolvedExports.push({
            localName: specifier.localName,
            exportName: specifier.exportName,
            providerModuleId: providerId,
            metadata: exportMetadata,
            openingElements: specifier.openingElements,
            directCalls: specifier.directCalls,
            factoryCalls: specifier.factoryCalls,
            unsupportedReference: specifier.unsupportedReference,
          });
          addEdge(providerId, id);
        }
      }

      try {
        return transformConsumer({
          parsed,
          usages: resolvedExports,
          registry,
          consumerFileName: fileName,
          consumerSourcePath: sourcePath,
          explicitProperty,
        });
      } catch (error) {
        if (error instanceof SourceAwareCompilerError)
          this.error(error.message);
        throw error;
      }
    },
    async handleHotUpdate(ctx) {
      if (!hasEnabledInjections) return;
      const id = canonicalFileId(ctx.file);
      if (!id || !isIncluded(id)) return;
      importResolutionCache.delete(id);
      try {
        const changed = await discoverFile(ctx.file, true);
        if (!changed) return;
        return [...ctx.modules, ...invalidateConsumers(ctx, id)];
      } catch (error) {
        ctx.server.config.logger.error(
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    },
  };
}
