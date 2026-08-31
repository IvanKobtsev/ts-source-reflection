# ts-source-reflection

`ts-source-reflection` provides compile-time source information for TypeScript.
Its first feature is a Vite pre-transform plugin that injects the importing
module's extensionless filename into marked React components. It has no runtime
reflection dependency and requires no marker at JSX usage sites.

## Setup

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sourceAwareProps } from "ts-source-reflection";

export default defineConfig({
  plugins: [sourceAwareProps(), react()],
});
```

Declare a named component with a direct marker:

```tsx
import type { WithFileName } from "ts-source-reflection";

type ProviderProps = WithFileName<{ children: React.ReactNode }>;

export const Provider = ({ children, _inj_sourceFileName }: ProviderProps) => (
  <section data-source={_inj_sourceFileName}>{children}</section>
);
```

Normal callers remain clean:

```tsx
import { Provider } from "./Provider";

export const RepositoryPage = () => <Provider>content</Provider>;
// Compiles as: <Provider _inj_sourceFileName="RepositoryPage">content</Provider>
```

The prop is intentionally optional in TypeScript. The plugin guarantees it for
supported JSX transformed by Vite, but direct function calls, tests that bypass
Vite, and other runtimes must still handle `undefined`.

## Options

```ts
sourceAwareProps({
  include: ["src/**/*.ts", "src/**/*.tsx"],
  exclude: ["src/generated/**"],
  explicitProperty: "preserve", // or 'error'
});
```

An explicitly written `_inj_sourceFileName` wins by default. JSX spreads on marked
components are rejected because their precedence cannot be determined safely.

## MVP boundaries

The plugin supports named exported functions and arrow functions, direct named
imports (including local aliases), inline `WithFileName<Props>` annotations, and
one immediately referenced local marked type alias.

It does not currently support barrels, default or separately declared exports,
namespace/compound components, `memo`, `forwardRef`, HOCs, local same-module
usage, compiled third-party providers, or semantic TypeScript alias resolution.
Using a known marked import through a dynamic or otherwise unsupported expression
is a build error rather than a silent loss of the injected property.
