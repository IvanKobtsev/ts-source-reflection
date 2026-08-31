import { expectTypeOf, it } from "vitest";
import type { WithFileName } from "../src";

it("makes only sourceFileName optional and string-valued", () => {
  type Props = WithFileName<{ required: number; sourceFileName: boolean }>;
  const omitted: Props = { required: 1 };
  const explicit: Props = { required: 1, sourceFileName: "manual" };
  expectTypeOf<Props>().toMatchTypeOf<{
    required: number;
    sourceFileName?: string;
  }>();
  expectTypeOf(omitted.required).toEqualTypeOf<number>();
  expectTypeOf(explicit.sourceFileName).toEqualTypeOf<string | undefined>();
});
