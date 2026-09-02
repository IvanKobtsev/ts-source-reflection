import { codeFrameColumns } from "@babel/code-frame";
import generatorModule from "@babel/generator";
import { parse, type ParseResult } from "@babel/parser";
import traverseModule, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { createHash } from "node:crypto";

const traverse: typeof traverseModule =
  typeof traverseModule === "function"
    ? traverseModule
    : (traverseModule as unknown as { default: typeof traverseModule }).default;
const generate: typeof generatorModule =
  typeof generatorModule === "function"
    ? generatorModule
    : (generatorModule as unknown as { default: typeof generatorModule })
        .default;

export type InjectionSource =
  "importer-file-name" | "importer-source-line" | "importer-unique-id";
export interface InjectionMetadata {
  property: "_inj_sourceFileName" | "_inj_sourceLine" | "_inj_uniqueId";
  source: InjectionSource;
}
export interface InjectionContext {
  consumerFileName: string;
  consumerSourcePath: string;
  line: number;
  column: number;
  callKind: "jsx" | "function";
  parameterIndex: number;
}
export interface InjectionDefinition extends InjectionMetadata {
  markerName: "InjectFileName" | "InjectSourceLine" | "InjectUniqueId";
  enabled: boolean;
  resolve(context: InjectionContext): string;
}
export interface InjectionTarget {
  parameterIndex: number;
  injections: InjectionMetadata[];
}
export interface CallableInjectionMetadata {
  targets: InjectionTarget[];
}
export interface ReturnedMemberMetadata {
  memberName: string;
  callable: CallableInjectionMetadata;
}
export interface SourceAwareExportMetadata {
  moduleId: string;
  exportName: string;
  callable?: CallableInjectionMetadata;
  returnedMembers?: ReturnedMemberMetadata[];
}

export function createInjectionRegistry(options: {
  injectFileName: boolean;
  injectSourceLine: boolean;
  injectUniqueId?: boolean;
}): InjectionDefinition[] {
  return [
    {
      markerName: "InjectFileName",
      property: "_inj_sourceFileName",
      source: "importer-file-name",
      enabled: options.injectFileName,
      resolve: ({ consumerFileName }) => consumerFileName,
    },
    {
      markerName: "InjectSourceLine",
      property: "_inj_sourceLine",
      source: "importer-source-line",
      enabled: options.injectSourceLine,
      resolve: ({ consumerSourcePath, line }) =>
        `${consumerSourcePath}:${line}`,
    },
    {
      markerName: "InjectUniqueId",
      property: "_inj_uniqueId",
      source: "importer-unique-id",
      enabled: options.injectUniqueId ?? false,
      resolve: createDeterministicUniqueId,
    },
  ];
}

export function createDeterministicUniqueId(context: InjectionContext): string {
  const identity = [
    context.consumerSourcePath.replaceAll("\\", "/"),
    context.callKind,
    context.line,
    context.column,
    context.parameterIndex,
    "_inj_uniqueId",
  ].join("\0");
  return `inj_${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

interface MemberCallAnalysis {
  calls: t.CallExpression[];
  unsupportedReference?: t.Node;
}
interface FactoryCallAnalysis {
  call: t.CallExpression;
  members: Map<string, MemberCallAnalysis>;
  unsupportedResult?: t.Node;
}
interface AnalyzedImportSpecifier {
  exportName: string;
  localName: string;
  openingElements: t.JSXOpeningElement[];
  directCalls: t.CallExpression[];
  factoryCalls: FactoryCallAnalysis[];
  unsupportedReference?: t.Node;
}
interface AnalyzedNamedImport {
  source: string;
  specifiers: AnalyzedImportSpecifier[];
}
export interface ParsedConsumer {
  ast: ParseResult<t.File>;
  code: string;
  id: string;
  imports: AnalyzedNamedImport[];
}
export interface ResolvedExportUsage extends AnalyzedImportSpecifier {
  providerModuleId: string;
  metadata: SourceAwareExportMetadata;
}
export interface NamedImport {
  source: string;
  specifiers: Array<{ exportName: string; localName: string }>;
}

export class SourceAwareCompilerError extends Error {
  constructor(
    reason: string,
    code: string,
    file: string,
    node?: t.Node | null,
    details: string[] = [],
  ) {
    const location = node?.loc?.start;
    const where = location
      ? `${file}:${location.line}:${location.column + 1}`
      : file;
    const frame = location
      ? codeFrameColumns(
          code,
          { start: { line: location.line, column: location.column + 1 } },
          { highlightCode: false },
        )
      : "";
    super(
      [`${where} - ${reason}`, ...details, frame].filter(Boolean).join("\n"),
    );
    this.name = "SourceAwareCompilerError";
  }
}

function parseModule(code: string, id: string): ParseResult<t.File> {
  try {
    return parse(code, {
      sourceType: "module",
      sourceFilename: id,
      plugins: ["typescript", "jsx"],
    });
  } catch (error) {
    throw new SourceAwareCompilerError(
      error instanceof Error ? error.message : "Unable to parse module",
      code,
      id,
    );
  }
}

function unwrapParameter(parameter: t.Function["params"][number]): t.Node {
  return t.isTSParameterProperty(parameter) ? parameter.parameter : parameter;
}

function parameterType(
  parameter: t.Function["params"][number],
): t.TSType | undefined {
  const candidate = unwrapParameter(parameter);
  if (t.isAssignmentPattern(candidate))
    return parameterType(candidate.left as t.Function["params"][number]);
  const annotation =
    "typeAnnotation" in candidate ? candidate.typeAnnotation : undefined;
  return t.isTSTypeAnnotation(annotation)
    ? annotation.typeAnnotation
    : undefined;
}

function staticPropertyName(
  node: t.ObjectProperty | t.ObjectMethod,
): string | null {
  if (node.computed) return null;
  if (t.isIdentifier(node.key)) return node.key.name;
  if (t.isStringLiteral(node.key)) return node.key.value;
  return null;
}

function countFactoryReturns(node: t.Node): number {
  if (t.isFunction(node) && !t.isBlockStatement(node)) return 0;
  let count = t.isReturnStatement(node) ? 1 : 0;
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    const child = (node as unknown as Record<string, unknown>)[key];
    for (const item of Array.isArray(child) ? child : [child]) {
      if (!item || typeof item !== "object" || !("type" in item)) continue;
      const childNode = item as t.Node;
      if (childNode !== node && t.isFunction(childNode)) continue;
      count += countFactoryReturns(childNode);
    }
  }
  return count;
}

export function discoverExports(
  code: string,
  id: string,
  registry: readonly InjectionDefinition[],
): SourceAwareExportMetadata[] {
  const ast = parseModule(code, id);
  const localMarkers = new Map<string, InjectionDefinition>();
  const publicMarkers = new Map(
    registry.map((definition) => [definition.markerName, definition]),
  );
  const markedAliases = new Map<string, InjectionMetadata[]>();
  const result = new Map<string, SourceAwareExportMetadata>();

  for (const statement of ast.program.body) {
    if (
      !t.isImportDeclaration(statement) ||
      statement.source.value !== "ts-source-reflection"
    )
      continue;
    for (const specifier of statement.specifiers) {
      if (!t.isImportSpecifier(specifier)) continue;
      const importedName = t.isIdentifier(specifier.imported)
        ? specifier.imported.name
        : specifier.imported.value;
      const definition = publicMarkers.get(
        importedName as InjectionDefinition["markerName"],
      );
      if (definition) localMarkers.set(specifier.local.name, definition);
    }
  }
  if (localMarkers.size === 0) return [];

  const readMarkerChain = (
    node: t.TSType | null | undefined,
  ): InjectionMetadata[] | null => {
    if (!node || !t.isTSTypeReference(node) || !t.isIdentifier(node.typeName))
      return null;
    const definition = localMarkers.get(node.typeName.name);
    if (!definition) return null;
    if (node.typeParameters?.params.length !== 1)
      throw new SourceAwareCompilerError(
        `${definition.markerName} must have exactly one type argument`,
        code,
        id,
        node,
      );
    const nested = readMarkerChain(node.typeParameters.params[0]) ?? [];
    const injections: InjectionMetadata[] = definition.enabled
      ? [
          { property: definition.property, source: definition.source },
          ...nested,
        ]
      : nested;
    const properties = new Set<string>();
    for (const injection of injections) {
      if (properties.has(injection.property))
        throw new SourceAwareCompilerError(
          `Duplicate injection marker for ${injection.property}`,
          code,
          id,
          node,
        );
      properties.add(injection.property);
    }
    return injections;
  };
  for (const statement of ast.program.body) {
    if (!t.isTSTypeAliasDeclaration(statement)) continue;
    const injections = readMarkerChain(statement.typeAnnotation);
    if (injections) markedAliases.set(statement.id.name, injections);
  }
  const injectionsForType = (
    type: t.TSType | undefined,
  ): InjectionMetadata[] | null => {
    const inline = readMarkerChain(type);
    if (inline) return inline;
    return type && t.isTSTypeReference(type) && t.isIdentifier(type.typeName)
      ? (markedAliases.get(type.typeName.name) ?? null)
      : null;
  };
  const callableFor = (
    fn: t.Function,
  ): CallableInjectionMetadata | undefined => {
    const targets: InjectionTarget[] = [];
    fn.params.forEach((parameter, parameterIndex) => {
      const injections = injectionsForType(parameterType(parameter));
      if (!injections || injections.length === 0) return;
      const candidate = unwrapParameter(parameter);
      const optional = "optional" in candidate && candidate.optional;
      if (
        optional ||
        t.isAssignmentPattern(candidate) ||
        t.isRestElement(candidate)
      ) {
        const kind = optional
          ? "optional"
          : t.isAssignmentPattern(candidate)
            ? "defaulted"
            : "rest";
        throw new SourceAwareCompilerError(
          `Injected parameter ${parameterIndex} cannot be ${kind}`,
          code,
          id,
          candidate,
        );
      }
      targets.push({ parameterIndex, injections });
    });
    return targets.length > 0 ? { targets } : undefined;
  };

  const returnedMembersFor = (
    fn: t.Function,
  ): ReturnedMemberMetadata[] | undefined => {
    let returned: t.ObjectExpression | undefined;
    const localFunctions = new Map<string, t.Function>();
    if (t.isBlockStatement(fn.body)) {
      const returns = fn.body.body.filter(
        (statement): statement is t.ReturnStatement =>
          t.isReturnStatement(statement),
      );
      for (const statement of fn.body.body) {
        if (t.isFunctionDeclaration(statement) && statement.id)
          localFunctions.set(statement.id.name, statement);
        if (t.isVariableDeclaration(statement)) {
          for (const declaration of statement.declarations) {
            if (
              t.isIdentifier(declaration.id) &&
              (t.isArrowFunctionExpression(declaration.init) ||
                t.isFunctionExpression(declaration.init))
            )
              localFunctions.set(declaration.id.name, declaration.init);
          }
        }
      }
      const hasMarkedLocal = [...localFunctions.values()].some((local) =>
        Boolean(callableFor(local)),
      );
      if (
        countFactoryReturns(fn.body) !== 1 ||
        returns.length !== 1 ||
        !t.isObjectExpression(returns[0]?.argument)
      ) {
        if (hasMarkedLocal)
          throw new SourceAwareCompilerError(
            "A factory returning injected functions must have one direct unconditional object return",
            code,
            id,
            returns[0] ?? fn,
          );
        return undefined;
      }
      returned = returns[0].argument;
    } else if (t.isObjectExpression(fn.body)) returned = fn.body;
    if (!returned) return undefined;

    const members: ReturnedMemberMetadata[] = [];
    for (const property of returned.properties) {
      if (t.isSpreadElement(property)) continue;
      const memberName = staticPropertyName(property);
      if (!memberName) continue;
      let returnedFunction: t.Function | undefined;
      if (t.isObjectMethod(property)) returnedFunction = property;
      else if (
        t.isArrowFunctionExpression(property.value) ||
        t.isFunctionExpression(property.value)
      )
        returnedFunction = property.value;
      else if (t.isIdentifier(property.value))
        returnedFunction = localFunctions.get(property.value.name);
      if (!returnedFunction) continue;
      const callable = callableFor(returnedFunction);
      if (callable) members.push({ memberName, callable });
    }
    return members.length > 0 ? members : undefined;
  };

  const add = (exportName: string, fn: t.Function, node: t.Node) => {
    if (result.has(exportName))
      throw new SourceAwareCompilerError(
        `Conflicting source-aware metadata for export ${exportName}`,
        code,
        id,
        node,
      );
    const callable = callableFor(fn);
    const returnedMembers = returnedMembersFor(fn);
    if (callable || returnedMembers)
      result.set(exportName, {
        moduleId: id,
        exportName,
        callable,
        returnedMembers,
      });
  };
  for (const statement of ast.program.body) {
    if (!t.isExportNamedDeclaration(statement) || !statement.declaration)
      continue;
    const declaration = statement.declaration;
    if (t.isFunctionDeclaration(declaration) && declaration.id)
      add(declaration.id.name, declaration, declaration);
    if (t.isVariableDeclaration(declaration)) {
      for (const item of declaration.declarations) {
        if (
          t.isIdentifier(item.id) &&
          (t.isArrowFunctionExpression(item.init) ||
            t.isFunctionExpression(item.init))
        )
          add(item.id.name, item.init, item);
      }
    }
  }
  return [...result.values()];
}

/** @deprecated Internal compatibility for tests and callers of the unpublished compiler module. */
export const discoverComponents = discoverExports;

function isTypeReference(path: NodePath): boolean {
  return Boolean(path.findParent((parent) => parent.isTSType()));
}
function isJsxReference(path: NodePath): boolean {
  const parent = path.parentPath;
  return Boolean(
    parent &&
    (parent.isJSXOpeningElement() || parent.isJSXClosingElement()) &&
    parent.node.name === path.node,
  );
}
function transparentParent(path: NodePath): NodePath {
  let current = path;
  while (
    current.parentPath &&
    (current.parentPath.isTSAsExpression() ||
      current.parentPath.isTSSatisfiesExpression() ||
      current.parentPath.isTSNonNullExpression() ||
      current.parentPath.isParenthesizedExpression())
  )
    current = current.parentPath;
  return current;
}
function directCallForReference(
  path: NodePath,
): NodePath<t.CallExpression> | null {
  const current = transparentParent(path);
  const parent = current.parentPath;
  return parent?.isCallExpression() && parent.node.callee === current.node
    ? parent
    : null;
}
function memberName(
  path: NodePath<t.MemberExpression | t.OptionalMemberExpression>,
): string | null {
  if (path.node.computed) return null;
  return t.isIdentifier(path.node.property) ? path.node.property.name : null;
}

function classifyMemberBinding(
  programPath: NodePath<t.Program>,
  localName: string,
): Map<string, MemberCallAnalysis> {
  const members = new Map<string, MemberCallAnalysis>();
  const binding = programPath.scope.getBinding(localName);
  const add = (name: string, call?: t.CallExpression, unsupported?: t.Node) => {
    const analysis = members.get(name) ?? { calls: [] };
    if (call) analysis.calls.push(call);
    analysis.unsupportedReference ??= unsupported;
    members.set(name, analysis);
  };
  for (const reference of binding?.referencePaths ?? []) {
    const current = transparentParent(reference);
    const parent = current.parentPath;
    if (!parent?.isMemberExpression() || parent.node.object !== current.node) {
      add("*", undefined, reference.node);
      continue;
    }
    const name = memberName(parent);
    if (!name) {
      add("*", undefined, parent.node);
      continue;
    }
    const memberCurrent = transparentParent(parent);
    const call = memberCurrent.parentPath;
    if (call?.isCallExpression() && call.node.callee === memberCurrent.node)
      add(name, call.node);
    else add(name, undefined, parent.node);
  }
  if ((binding?.constantViolations.length ?? 0) > 0)
    add("*", undefined, binding!.constantViolations[0]!.node);
  return members;
}

function analyzeFactoryCall(
  callPath: NodePath<t.CallExpression>,
  programPath: NodePath<t.Program>,
): FactoryCallAnalysis {
  const analysis: FactoryCallAnalysis = {
    call: callPath.node,
    members: new Map(),
  };
  const current = transparentParent(callPath);
  const parent = current.parentPath;
  if (parent?.isVariableDeclarator() && parent.node.init === current.node) {
    if (t.isIdentifier(parent.node.id))
      analysis.members = classifyMemberBinding(
        programPath,
        parent.node.id.name,
      );
    else if (t.isObjectPattern(parent.node.id)) {
      for (const property of parent.node.id.properties) {
        if (t.isRestElement(property) || !t.isObjectProperty(property)) {
          analysis.unsupportedResult ??= property;
          continue;
        }
        const name = staticPropertyName(property);
        if (!name || !t.isIdentifier(property.value)) {
          analysis.unsupportedResult ??= property;
          continue;
        }
        const binding = programPath.scope.getBinding(property.value.name);
        const member: MemberCallAnalysis = {
          calls: [],
          unsupportedReference: binding?.constantViolations[0]?.node,
        };
        for (const reference of binding?.referencePaths ?? []) {
          const directCall = directCallForReference(reference);
          if (directCall) member.calls.push(directCall.node);
          else member.unsupportedReference ??= reference.node;
        }
        analysis.members.set(name, member);
      }
    } else analysis.unsupportedResult = parent.node.id;
    return analysis;
  }
  if (parent?.isMemberExpression() && parent.node.object === current.node) {
    const name = memberName(parent);
    const memberCurrent = transparentParent(parent);
    const memberCall = memberCurrent.parentPath;
    if (
      name &&
      memberCall?.isCallExpression() &&
      memberCall.node.callee === memberCurrent.node
    )
      analysis.members.set(name, { calls: [memberCall.node] });
    else analysis.unsupportedResult = parent.node;
    return analysis;
  }
  if (!parent?.isExpressionStatement())
    analysis.unsupportedResult = current.node;
  return analysis;
}

export function analyzeConsumer(code: string, id: string): ParsedConsumer {
  const ast = parseModule(code, id);
  const imports: AnalyzedNamedImport[] = [];
  traverse(ast, {
    Program(programPath) {
      for (const statement of ast.program.body) {
        if (
          !t.isImportDeclaration(statement) ||
          statement.importKind === "type"
        )
          continue;
        const specifiers: AnalyzedImportSpecifier[] = [];
        for (const specifier of statement.specifiers) {
          if (
            !t.isImportSpecifier(specifier) ||
            specifier.importKind === "type"
          )
            continue;
          const binding = programPath.scope.getBinding(specifier.local.name);
          const runtimeReferences =
            binding?.referencePaths.filter(
              (reference) => !isTypeReference(reference),
            ) ?? [];
          if (runtimeReferences.length === 0) continue;
          const openingElements: t.JSXOpeningElement[] = [];
          const directCalls: t.CallExpression[] = [];
          const factoryCalls: FactoryCallAnalysis[] = [];
          let unsupportedReference: t.Node | undefined;
          for (const reference of runtimeReferences) {
            if (isJsxReference(reference)) {
              if (reference.parentPath?.isJSXOpeningElement())
                openingElements.push(reference.parentPath.node);
              continue;
            }
            const call = directCallForReference(reference);
            if (call) {
              directCalls.push(call.node);
              factoryCalls.push(analyzeFactoryCall(call, programPath));
              continue;
            }
            unsupportedReference ??= reference.node;
          }
          specifiers.push({
            exportName: t.isIdentifier(specifier.imported)
              ? specifier.imported.name
              : specifier.imported.value,
            localName: specifier.local.name,
            openingElements,
            directCalls,
            factoryCalls,
            unsupportedReference,
          });
        }
        if (specifiers.length > 0)
          imports.push({ source: statement.source.value, specifiers });
      }
    },
  });
  return { ast, code, id, imports };
}

export function findNamedImports(code: string, id: string): NamedImport[] {
  return analyzeConsumer(code, id).imports.map(({ source, specifiers }) => ({
    source,
    specifiers: specifiers.map(({ exportName, localName }) => ({
      exportName,
      localName,
    })),
  }));
}

function unwrapObjectArgument(
  argument: t.CallExpression["arguments"][number] | undefined,
): t.ObjectExpression | null {
  let current = argument;
  while (
    current &&
    (t.isTSAsExpression(current) ||
      t.isTSSatisfiesExpression(current) ||
      t.isTSNonNullExpression(current) ||
      t.isTypeCastExpression(current))
  )
    current = current.expression;
  return current && t.isObjectExpression(current) ? current : null;
}
function hasObjectProperty(
  object: t.ObjectExpression,
  property: string,
): t.ObjectProperty | t.ObjectMethod | undefined {
  return object.properties.find(
    (item): item is t.ObjectProperty | t.ObjectMethod =>
      !t.isSpreadElement(item) && staticPropertyName(item) === property,
  );
}

function callSiteLocation(
  call: t.CallExpression,
): t.SourceLocation["start"] | null {
  const callee = call.callee;
  if (
    (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
    callee.property.loc
  )
    return callee.property.loc.start;
  return callee.loc?.start ?? null;
}

export function transformConsumer(options: {
  parsed: ParsedConsumer;
  usages: ResolvedExportUsage[];
  registry: readonly InjectionDefinition[];
  consumerFileName: string;
  consumerSourcePath: string;
  explicitProperty: "preserve" | "error";
}): { code: string; map: ReturnType<typeof generate>["map"] } | null {
  const {
    parsed,
    usages,
    registry,
    consumerFileName,
    consumerSourcePath,
    explicitProperty,
  } = options;
  if (usages.length === 0) return null;
  const definitions = new Map(
    registry.map((definition) => [definition.source, definition]),
  );
  let changed = false;
  const details = (usage: ResolvedExportUsage, member?: string) => [
    `Export: ${usage.localName} (imported ${usage.exportName})`,
    `Provider: ${usage.providerModuleId}`,
    ...(member ? [`Returned member: ${member}`] : []),
  ];
  const injectCall = (
    call: t.CallExpression,
    callable: CallableInjectionMetadata,
    usage: ResolvedExportUsage,
    member?: string,
  ) => {
    for (const target of callable.targets) {
      const argument = call.arguments[target.parameterIndex];
      const object = unwrapObjectArgument(argument);
      if (!argument)
        throw new SourceAwareCompilerError(
          `Missing required injected argument at parameter ${target.parameterIndex}`,
          parsed.code,
          parsed.id,
          call,
          details(usage, member),
        );
      if (!object)
        throw new SourceAwareCompilerError(
          `Injected argument at parameter ${target.parameterIndex} must be an object literal`,
          parsed.code,
          parsed.id,
          argument,
          details(usage, member),
        );
      const spread = object.properties.find((property) =>
        t.isSpreadElement(property),
      );
      if (spread)
        throw new SourceAwareCompilerError(
          `Spread properties are unsupported in injected argument ${target.parameterIndex}`,
          parsed.code,
          parsed.id,
          spread,
          details(usage, member),
        );
      const generated: t.ObjectProperty[] = [];
      for (const injection of target.injections) {
        const explicit = hasObjectProperty(object, injection.property);
        if (explicit) {
          if (explicitProperty === "error")
            throw new SourceAwareCompilerError(
              `Explicit ${injection.property} is forbidden by plugin configuration`,
              parsed.code,
              parsed.id,
              explicit,
              [
                ...details(usage, member),
                `Parameter: ${target.parameterIndex}`,
                `Property: ${injection.property}`,
              ],
            );
          continue;
        }
        const definition = definitions.get(injection.source);
        if (!definition)
          throw new SourceAwareCompilerError(
            `No enabled injection resolver exists for ${injection.source}`,
            parsed.code,
            parsed.id,
            call,
          );
        const location = callSiteLocation(call);
        if (!location)
          throw new SourceAwareCompilerError(
            `Cannot determine the call line for ${injection.property}`,
            parsed.code,
            parsed.id,
            call,
          );
        generated.push(
          t.objectProperty(
            t.identifier(injection.property),
            t.stringLiteral(
              definition.resolve({
                consumerFileName,
                consumerSourcePath,
                line: location.line,
                column: location.column,
                callKind: "function",
                parameterIndex: target.parameterIndex,
              }),
            ),
          ),
        );
      }
      if (generated.length) {
        object.properties.unshift(...generated);
        changed = true;
      }
    }
  };
  const injectJsx = (
    element: t.JSXOpeningElement,
    callable: CallableInjectionMetadata,
    usage: ResolvedExportUsage,
  ) => {
    if (callable.targets.some(({ parameterIndex }) => parameterIndex !== 0))
      throw new SourceAwareCompilerError(
        "JSX cannot inject parameters other than parameter 0",
        parsed.code,
        parsed.id,
        element,
        details(usage),
      );
    const target = callable.targets[0];
    if (!target) return;
    const spread = element.attributes.find((attribute) =>
      t.isJSXSpreadAttribute(attribute),
    );
    if (spread)
      throw new SourceAwareCompilerError(
        "Spread attributes are unsupported on a marked component",
        parsed.code,
        parsed.id,
        spread,
        details(usage),
      );
    for (const injection of target.injections) {
      const explicit = element.attributes.find(
        (attribute) =>
          t.isJSXAttribute(attribute) &&
          t.isJSXIdentifier(attribute.name) &&
          attribute.name.name === injection.property,
      );
      if (explicit) {
        if (explicitProperty === "error")
          throw new SourceAwareCompilerError(
            `Explicit ${injection.property} is forbidden by plugin configuration`,
            parsed.code,
            parsed.id,
            explicit,
            details(usage),
          );
        continue;
      }
      const definition = definitions.get(injection.source);
      const location = element.loc?.start;
      if (!definition || !location)
        throw new SourceAwareCompilerError(
          `Cannot resolve ${injection.property} at JSX call site`,
          parsed.code,
          parsed.id,
          element,
        );
      element.attributes.push(
        t.jsxAttribute(
          t.jsxIdentifier(injection.property),
          t.stringLiteral(
            definition.resolve({
              consumerFileName,
              consumerSourcePath,
              line: location.line,
              column: location.column,
              callKind: "jsx",
              parameterIndex: 0,
            }),
          ),
        ),
      );
      changed = true;
    }
  };

  for (const usage of usages) {
    if (usage.unsupportedReference)
      throw new SourceAwareCompilerError(
        "Marked export is referenced through an unsupported expression",
        parsed.code,
        parsed.id,
        usage.unsupportedReference,
        details(usage),
      );
    if (usage.metadata.callable) {
      for (const call of usage.directCalls)
        injectCall(call, usage.metadata.callable, usage);
      for (const element of usage.openingElements)
        injectJsx(element, usage.metadata.callable, usage);
    } else if (usage.openingElements.length)
      throw new SourceAwareCompilerError(
        "An export without direct callable metadata cannot be used as JSX",
        parsed.code,
        parsed.id,
        usage.openingElements[0],
        details(usage),
      );
    if (!usage.metadata.returnedMembers) continue;
    const returned = new Map(
      usage.metadata.returnedMembers.map((member) => [
        member.memberName,
        member.callable,
      ]),
    );
    for (const factory of usage.factoryCalls) {
      if (factory.unsupportedResult)
        throw new SourceAwareCompilerError(
          "Factory result is consumed through an unsupported expression",
          parsed.code,
          parsed.id,
          factory.unsupportedResult,
          details(usage),
        );
      for (const [memberName, callable] of returned) {
        const member = factory.members.get(memberName);
        if (!member) continue;
        if (member.unsupportedReference)
          throw new SourceAwareCompilerError(
            "Injected returned function is referenced through an unsupported expression",
            parsed.code,
            parsed.id,
            member.unsupportedReference,
            details(usage, memberName),
          );
        for (const call of member.calls)
          injectCall(call, callable, usage, memberName);
      }
      const wildcard = factory.members.get("*");
      if (wildcard?.unsupportedReference)
        throw new SourceAwareCompilerError(
          "Factory result is referenced through an unsupported expression",
          parsed.code,
          parsed.id,
          wildcard.unsupportedReference,
          details(usage),
        );
    }
  }
  if (!changed) return null;
  const output = generate(
    parsed.ast,
    {
      sourceMaps: true,
      sourceFileName: parsed.id,
      retainLines: true,
      comments: true,
    },
    parsed.code,
  );
  return { code: output.code, map: output.map };
}
