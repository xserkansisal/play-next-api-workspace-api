import { describe, expect, it } from "vitest";
import { copyName, copyStem } from "../../src/services/copyName.js";

const free = () => false;

describe("copyStem", () => {
  it("leaves a name that was never copied alone", () => {
    expect(copyStem("Payments")).toBe("Payments");
    expect(copyStem("Payments (draft)")).toBe("Payments (draft)");
  });

  it("strips a trailing copy marker so copies of copies count up instead of nesting", () => {
    expect(copyStem("Payments (copy)")).toBe("Payments");
    expect(copyStem("Payments (copy 7)")).toBe("Payments");
    expect(copyStem("Payments (COPY 2)")).toBe("Payments");
  });

  it("only strips the last marker, so an earlier one stays part of the name", () => {
    expect(copyStem("Payments (copy) (copy)")).toBe("Payments (copy)");
  });

  it("keeps a name that is nothing but a marker, since there is no stem under it", () => {
    expect(copyStem("(copy)")).toBe("(copy)");
    expect(copyStem("(copy 3)")).toBe("(copy 3)");
  });
});

describe("copyName", () => {
  it("adds the first marker when nothing is in the way", () => {
    expect(copyName("Payments", free)).toBe("Payments (copy)");
  });

  it("counts up past the names that are taken", () => {
    const taken = new Set(["Payments (copy)", "Payments (copy 2)"]);
    expect(copyName("Payments", (candidate) => taken.has(candidate))).toBe("Payments (copy 3)");
  });

  it("counts from the stem, so copying a copy does not nest markers", () => {
    const taken = new Set(["Payments (copy)"]);
    expect(copyName("Payments (copy)", (candidate) => taken.has(candidate))).toBe("Payments (copy 2)");
  });

  it("asks about candidates rather than assuming, so a gap is filled", () => {
    const taken = new Set(["Payments (copy)", "Payments (copy 3)"]);
    expect(copyName("Payments", (candidate) => taken.has(candidate))).toBe("Payments (copy 2)");
  });

  it("trims the stem to stay within the 200 character limit, never the marker", () => {
    const long = "a".repeat(200);
    const result = copyName(long, free);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith(" (copy)")).toBe(true);
  });

  it("keeps the whole marker readable even when the number grows", () => {
    const long = "b".repeat(200);
    const taken = new Set([`${"b".repeat(193)} (copy)`]);
    const result = copyName(long, (candidate) => taken.has(candidate));
    expect(result).toBe(`${"b".repeat(191)} (copy 2)`);
    expect(result.length).toBe(200);
  });

  it("does not leave trailing whitespace where the stem was cut", () => {
    const long = `${"c".repeat(192)} ${"d".repeat(7)}`;
    expect(copyName(long, free)).toBe(`${"c".repeat(192)} (copy)`);
  });
});
