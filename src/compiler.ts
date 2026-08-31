import { codeFrameColumns } from "@babel/code-frame";
import generatorModule from "@babel/generator";
import { parse } from "@babel/parser";
import traverseModule, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";

// Babel 7 publishes these packages as CommonJS. Native ESM exposes their
// callable default as `.default.default`, while transpilers often flatten it.
// Normalize both shapes because this code executes from the published bundle.
const traverse: typeof traverseModule =
  typeof traverseModule === "function"
    ? traverseModule
    : (traverseModule as unknown as { default: typeof traverseModule }).default;
const generate: typeof generatorModule =
  typeof generatorModule === "function"
    ? generatorModule
    : (generatorModule as unknown as { default: typeof generatorModule })
        .default;

export interface SourceAwareComponentMetadata {
  moduleId: string;
  exportName: string;
  injections: [
    { property: "_inj_sourceFileName"; source: "importer-file-name" },
  ];
}

export interface ImportedComponent {
  localName: string;
  exportName: string;
  providerModuleId: string;
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

function parseModule(code: string, id: string) {
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

function markerReference(
  node: t.TSType | null | undefined,
  markers: Set<string>,
  code: string,
  id: string,
): boolean {
  if (!node || !t.isTSTypeReference(node) || !t.isIdentifier(node.typeName))
    return false;
  if (!markers.has(node.typeName.name)) return false;
  if (node.typeParameters?.params.length !== 1) {
    throw new SourceAwareCompilerError(
      "WithFileName must have exactly one type argument",
      code,
      id,
      node,
    );
  }
  return true;
}

function parameterType(
  parameter: t.Function["params"][number] | undefined,
): t.TSType | undefined {
  if (!parameter) return undefined;
  const candidate = t.isTSParameterProperty(parameter)
    ? parameter.parameter
    : parameter;
  if (t.isRestElement(candidate)) return undefined;
  const annotation =
    "typeAnnotation" in candidate ? candidate.typeAnnotation : undefined;
  return t.isTSTypeAnnotation(annotation)
    ? annotation.typeAnnotation
    : undefined;
}

export function discoverComponents(
  code: string,
  id: string,
): SourceAwareComponentMetadata[] {
  const ast = parseModule(code, id);
  const markers = new Set<string>();
  const markedAliases = new Set<string>();
  const result = new Map<string, SourceAwareComponentMetadata>();

  for (const statement of ast.program.body) {
    if (
      !t.isImportDeclaration(statement) ||
      statement.source.value !== "ts-source-reflection"
    )
      continue;
    for (const specifier of statement.specifiers) {
      if (
        t.isImportSpecifier(specifier) &&
        ((t.isIdentifier(specifier.imported) &&
          specifier.imported.name === "WithFileName") ||
          (t.isStringLiteral(specifier.imported) &&
            specifier.imported.value === "WithFileName"))
      ) {
        markers.add(specifier.local.name);
      }
    }
  }

  if (markers.size === 0) return [];

  for (const statement of ast.program.body) {
    if (
      t.isTSTypeAliasDeclaration(statement) &&
      markerReference(statement.typeAnnotation, markers, code, id)
    ) {
      markedAliases.add(statement.id.name);
    }
  }

  const isMarked = (type: t.TSType | undefined): boolean => {
    if (markerReference(type, markers, code, id)) return true;
    return Boolean(
      type &&
      t.isTSTypeReference(type) &&
      t.isIdentifier(type.typeName) &&
      markedAliases.has(type.typeName.name),
    );
  };

  const add = (name: string, node: t.Node) => {
    if (result.has(name)) {
      throw new SourceAwareCompilerError(
        `Conflicting source-aware metadata for export ${name}`,
        code,
        id,
        node,
      );
    }
    result.set(name, {
      moduleId: id,
      exportName: name,
      injections: [
        { property: "_inj_sourceFileName", source: "importer-file-name" },
      ],
    });
  };

  for (const statement of ast.program.body) {
    if (!t.isExportNamedDeclaration(statement) || !statement.declaration)
      continue;
    const declaration = statement.declaration;
    if (t.isFunctionDeclaration(declaration) && declaration.id) {
      if (isMarked(parameterType(declaration.params[0])))
        add(declaration.id.name, declaration);
      continue;
    }
    if (!t.isVariableDeclaration(declaration)) continue;
    for (const item of declaration.declarations) {
      if (
        t.isIdentifier(item.id) &&
        t.isArrowFunctionExpression(item.init) &&
        isMarked(parameterType(item.init.params[0]))
      ) {
        add(item.id.name, item);
      }
    }
  }

  return [...result.values()];
}

export function findNamedImports(code: string, id: string): NamedImport[] {
  const ast = parseModule(code, id);
  const imports: NamedImport[] = [];
  traverse(ast, {
    Program(programPath) {
      for (const statement of ast.program.body) {
        if (
          !t.isImportDeclaration(statement) ||
          statement.importKind === "type"
        )
          continue;
        const specifiers: NamedImport["specifiers"] = [];
        for (const specifier of statement.specifiers) {
          if (
            !t.isImportSpecifier(specifier) ||
            specifier.importKind === "type"
          )
            continue;
          const binding = programPath.scope.getBinding(specifier.local.name);
          const hasRuntimeReference = binding?.referencePaths.some(
            (reference) => !reference.findParent((parent) => parent.isTSType()),
          );
          if (!hasRuntimeReference) continue;
          specifiers.push({
            exportName: t.isIdentifier(specifier.imported)
              ? specifier.imported.name
              : specifier.imported.value,
            localName: specifier.local.name,
          });
        }
        if (specifiers.length > 0)
          imports.push({ source: statement.source.value, specifiers });
      }
    },
  });
  return imports;
}

function isSupportedJsxReference(
  path: NodePath<t.Identifier | t.JSXIdentifier>,
): boolean {
  const parent = path.parentPath;
  return Boolean(
    parent &&
    (parent.isJSXOpeningElement() || parent.isJSXClosingElement()) &&
    parent.node.name === path.node,
  );
}

export function transformConsumer(options: {
  code: string;
  id: string;
  fileName: string;
  components: ImportedComponent[];
  explicitProperty: "preserve" | "error";
}): { code: string; map: ReturnType<typeof generate>["map"] } | null {
  const { code, id, fileName, components, explicitProperty } = options;
  if (components.length === 0) return null;
  const ast = parseModule(code, id);
  const byLocalName = new Map(
    components.map((component) => [component.localName, component]),
  );
  let changed = false;

  traverse(ast, {
    Program(programPath) {
      for (const component of components) {
        const binding = programPath.scope.getBinding(component.localName);
        if (!binding) continue;
        for (const reference of binding.referencePaths) {
          if (
            isSupportedJsxReference(
              reference as NodePath<t.Identifier | t.JSXIdentifier>,
            )
          )
            continue;
          throw new SourceAwareCompilerError(
            "Marked component is referenced through an unsupported expression",
            code,
            id,
            reference.node,
            [
              `Component: ${component.localName} (export ${component.exportName})`,
              `Provider: ${component.providerModuleId}`,
              "Property: _inj_sourceFileName",
            ],
          );
        }
      }
    },
    JSXOpeningElement(path) {
      if (!t.isJSXIdentifier(path.node.name)) return;
      const component = byLocalName.get(path.node.name.name);
      if (!component) return;
      const spread = path.node.attributes.find((attribute) =>
        t.isJSXSpreadAttribute(attribute),
      );
      if (spread) {
        throw new SourceAwareCompilerError(
          "Spread attributes are unsupported on a marked component",
          code,
          id,
          spread,
          [
            `Component: ${component.localName} (export ${component.exportName})`,
            `Provider: ${component.providerModuleId}`,
            "Property: _inj_sourceFileName",
          ],
        );
      }
      const explicit = path.node.attributes.find(
        (attribute) =>
          t.isJSXAttribute(attribute) &&
          t.isJSXIdentifier(attribute.name) &&
          attribute.name.name === "_inj_sourceFileName",
      );
      if (explicit) {
        if (explicitProperty === "error") {
          throw new SourceAwareCompilerError(
            "Explicit _inj_sourceFileName is forbidden by plugin configuration",
            code,
            id,
            explicit,
            [
              `Component: ${component.localName} (export ${component.exportName})`,
              `Provider: ${component.providerModuleId}`,
              "Property: _inj_sourceFileName",
            ],
          );
        }
        return;
      }
      path.node.attributes.push(
        t.jsxAttribute(
          t.jsxIdentifier("_inj_sourceFileName"),
          t.stringLiteral(fileName),
        ),
      );
      changed = true;
    },
  });

  if (!changed) return null;
  const output = generate(
    ast,
    { sourceMaps: true, sourceFileName: id, retainLines: true, comments: true },
    code,
  );
  return { code: output.code, map: output.map };
}
