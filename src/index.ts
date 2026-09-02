export { sourceAwareInjectionPlugin } from "./plugin";
export type { SourceAwareInjectionPluginOptions } from "./plugin";

export type InjectFileName<Props> = Omit<Props, "_inj_sourceFileName"> & {
  _inj_sourceFileName?: string;
};

export type InjectSourceLine<Props> = Omit<Props, "_inj_sourceLine"> & {
  _inj_sourceLine?: string;
};

export type InjectUniqueId<Props> = Omit<Props, "_inj_uniqueId"> & {
  _inj_uniqueId?: string;
};
