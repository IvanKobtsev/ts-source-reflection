export { sourceAwareProps } from "./plugin";
export type { SourceAwarePropsOptions } from "./plugin";

/**
 * Marks a component props type for compile-time filename injection.
 *
 * `_inj_sourceFileName` is optional because code can invoke the component outside a
 * transformed Vite module. The plugin guarantees it only for supported JSX.
 */
export type WithFileName<Props> = Omit<Props, "_inj_sourceFileName"> & {
  _inj_sourceFileName?: string;
};
