# ts-source-reflection

`ts-source-reflection` injects compile-time source information into marked React
components. JSX usage sites remain clean and the finished application has no
reflection runtime.

## Setup

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sourceAwareInjectionPlugin } from "ts-source-reflection";

export default defineConfig({
  plugins: [
    sourceAwareInjectionPlugin({
      injectFileName: true,
      injectSourceLine: true,
      injectUniqueId: true,
    }),
    react(),
  ],
});
```

All injection kinds are disabled by default. Enable only the metadata used by
the project.

## Injection types

```tsx
import type {
  InjectFileName,
  InjectSourceLine,
  InjectUniqueId,
} from "ts-source-reflection";

type ProviderProps = InjectFileName<
  InjectSourceLine<InjectUniqueId<{ children: React.ReactNode }>>
>;

export const Provider = ({
  children,
  _inj_sourceFileName,
  _inj_sourceLine,
  _inj_uniqueId,
}: ProviderProps) => (
  <section
    data-file={_inj_sourceFileName}
    data-source={_inj_sourceLine}
    data-id={_inj_uniqueId}
  >
    {children}
  </section>
);
```

Normal usage:

```tsx
import { Provider } from "./Provider";

export const RepositoryPage = () => <Provider>content</Provider>;
```

Conceptual output:

```tsx
<Provider
  _inj_sourceFileName="RepositoryPage"
  _inj_sourceLine="src/pages/RepositoryPage.tsx:3"
  _inj_uniqueId="inj_8d36e0c245d74bd2a6ecb4763ad1db42"
>
  content
</Provider>
```

Source-line values use a Vite-root-relative path with `/` separators and the
1-based line containing the JSX opening tag. Multiple component usages receive
their own lines.

Unique IDs are deterministic 128-bit call-site hashes. They remain stable while
the root-relative path, line, column, call kind, and parameter position remain
unchanged. Repeated runtime executions of one static call site intentionally
reuse the same ID; moving the call changes it. Hashing happens only while Vite
builds the module.

Injected props remain optional in TypeScript because direct calls and runtimes
that bypass the Vite transform cannot receive compile-time values.

## Functions and returned functions

Injection markers can target any required object parameter:

```ts
export async function runAction(
  name: string,
  props: InjectSourceLine<{ doThing(): void }>,
) {
  await props.doThing();
}

runAction("save", { doThing() {} });
// Receives: { _inj_sourceLine: "src/actions/save.ts:12", doThing() {} }
```

One-level factory results are also supported:

```ts
export function useToast() {
  const showToast = (props: InjectSourceLine<ToastProps>) => {
    /* ... */
  };
  return { showToast };
}

const { showToast } = useToast();
showToast({ content: "Saved" });
```

Direct and renamed destructuring, stored result member calls, and chained calls
such as `useToast().showToast({})` are supported. Injected call arguments must be
object literals without spreads. A final marked `props?` parameter may be omitted
when it is the function's only optional argument; the plugin synthesizes the
object. Defaulted and rest marked parameters remain unsupported.

## Options

```ts
sourceAwareInjectionPlugin({
  injectFileName: true,
  injectSourceLine: false,
  injectUniqueId: true,
  include: ["src/**/*.ts", "src/**/*.tsx"],
  exclude: ["src/generated/**"],
  explicitProperty: "preserve", // or "error"
});
```

`include` and `exclude` apply to discovery, consumer transformation, and HMR.
Patterns resolve from the Vite project root. Explicit injected props win by
default. JSX spreads on marked components are rejected because precedence is
ambiguous.

## Current boundaries

The plugin supports named exported functions and arrow functions, direct named
imports with local aliases, directly nested injection markers, and one immediate
local marked type alias.

It does not support barrels, default or separately declared exports, namespace
or compound components, `memo`, `forwardRef`, HOCs, local same-module usage,
compiled third-party providers, or semantic TypeScript alias resolution.

`WithFileName`, `sourceAwareProps`, and `SourceAwarePropsOptions` were removed in
favor of `InjectFileName`, `sourceAwareInjectionPlugin`, and
`SourceAwareInjectionPluginOptions`.
