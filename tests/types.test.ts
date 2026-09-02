import { expectTypeOf, it } from "vitest";
import type { InjectFileName, InjectSourceLine, InjectUniqueId } from "../src";
import type { SourceAwareInjectionPluginOptions } from "../src";

it("does not expose per-injector enable flags", () => {
  const options: SourceAwareInjectionPluginOptions = {
    // @ts-expect-error Injection markers are the sole opt-in mechanism.
    injectFileName: true,
  };
  expectTypeOf(options).toMatchTypeOf<SourceAwareInjectionPluginOptions>();
});

it("makes only _inj_sourceFileName optional and string-valued", () => {
  type Props = InjectFileName<{
    required: number;
    _inj_sourceFileName: boolean;
  }>;
  const omitted: Props = { required: 1 };
  const explicit: Props = { required: 1, _inj_sourceFileName: "manual" };
  expectTypeOf<Props>().toMatchTypeOf<{
    required: number;
    _inj_sourceFileName?: string;
  }>();
  expectTypeOf(omitted.required).toEqualTypeOf<number>();
  expectTypeOf(explicit._inj_sourceFileName).toEqualTypeOf<
    string | undefined
  >();
});

it("composes unique IDs with the other injection types", () => {
  type Props = InjectUniqueId<
    InjectSourceLine<
      InjectFileName<{ required: number; _inj_uniqueId: number }>
    >
  >;
  const value: Props = { required: 1 };
  expectTypeOf(value._inj_uniqueId).toEqualTypeOf<string | undefined>();
  expectTypeOf(value._inj_sourceLine).toEqualTypeOf<string | undefined>();
  expectTypeOf(value._inj_sourceFileName).toEqualTypeOf<string | undefined>();
});

it("composes filename and source-line injection types", () => {
  type Props = InjectSourceLine<
    InjectFileName<{
      required: number;
      _inj_sourceLine: number;
    }>
  >;
  const value: Props = { required: 1 };
  expectTypeOf(value._inj_sourceFileName).toEqualTypeOf<string | undefined>();
  expectTypeOf(value._inj_sourceLine).toEqualTypeOf<string | undefined>();
});
