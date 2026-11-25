import { formatCron } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { cronLabels } from "./cron";

describe("cronLabels", () => {
  it("keeps schedules readable, including an interval of one", () => {
    const labels = cronLabels("en");
    expect(formatCron("*/1 * * * *", labels)).toBe("Every 1 minute");
    expect(formatCron("0 8 * * 1-5", labels)).toBe("Weekdays at 8:00 AM");
    expect(formatCron("43 */2 * * *", labels)).toBe("Every 2 hours at :43");
    expect(formatCron("0 9,17 * * 1-5", labels)).toBe("Weekdays at 9:00 AM and 5:00 PM");
  });
});
