import { expect, test } from "bun:test";
import { autoAccessWall, autoNotOffered, autoPickerCopy, autoWallCopy, freeAutoSwitchedOff, unavailableDesktopFreeStatus } from "../src/app/lib/inference-access";

test("Auto that is running but not offered to this organization says why, and never looks like an outage", () => {
  const subtitles = Object.fromEntries(["free_not_enrolled", "free_not_offered", "managed_models_disabled_for_dpa", "not_eligible", "desktop_build_unverified"]
    .map((code) => [code, autoPickerCopy("not_offered", true, null, code).subtitle]));
  expect(subtitles).toEqual({
    free_not_enrolled: "Free · not on for your organization yet",
    free_not_offered: "Free · turned off by your organization",
    managed_models_disabled_for_dpa: "Free · not available for your organization",
    not_eligible: "Free · not available for this account",
    desktop_build_unverified: "Free · not available on this build",
  });
  for (const code of Object.keys(subtitles)) {
    expect(autoNotOffered({ code })).toBe(true);
    expect(freeAutoSwitchedOff({ code })).toBe(false);
    expect(autoPickerCopy("not_offered", true, null, code).action).toBeNull();
    const wall = autoAccessWall({ ...unavailableDesktopFreeStatus(), code });
    expect(wall).toMatchObject({ state: "not_offered", code });
    expect(autoWallCopy(wall!, true).title).not.toContain("temporarily");
  }
  expect(autoPickerCopy("unavailable", true).subtitle).toBe("Free · temporarily unavailable");
  expect(freeAutoSwitchedOff({ code: "free_disabled" })).toBe(true);
});
