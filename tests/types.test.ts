import { expectTypeOf, it } from "vitest";
import type { WithFileName } from "../src";

it("makes only _inj_sourceFileName optional and string-valued", () => {
  type Props = WithFileName<{ required: number; _inj_sourceFileName: boolean }>;
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
