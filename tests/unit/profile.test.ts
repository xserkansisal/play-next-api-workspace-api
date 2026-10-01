import { describe, expect, it } from "vitest";
import { deriveUserProfileName } from "../../src/auth/profile.js";

describe("deriveUserProfileName", () => {
  it.each([
    ["serkan@sisal.com", { firstName: "Serkan", lastName: "" }],
    ["serkan.taghan@sisal.com", { firstName: "Serkan", lastName: "Taghan" }],
    ["ada.marie.lovelace@example.com", { firstName: "Ada", lastName: "Marie Lovelace" }],
    ["..ada...marie..lovelace..@example.com", { firstName: "Ada", lastName: "Marie Lovelace" }],
    ["..serKan.vAN.TagHan..@sisal.com", { firstName: "SerKan", lastName: "VAN TagHan" }],
    ["...@sisal.com", { firstName: "", lastName: "" }],
  ])("%s derives the expected profile name", (email, expected) => {
    expect(deriveUserProfileName(email)).toEqual(expected);
  });
});
