import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import { secretDestinationLabel, siteHost } from "./secret-destination";

describe("mobile credential destination label", () => {
  it("shows the derived variable for a command credential, not the empty origin", () => {
    const label = secretDestinationLabel({
      name: "netbird-setup-key",
      origin: "",
      auth: { type: "command" },
    });
    expect(label).toBe(`${t("Command variable")} $NETBIRD_SETUP_KEY`);
    expect(label).not.toBe("");
  });

  it("shows the site origin for non-login credential types", () => {
    expect(
      secretDestinationLabel({
        name: "example_api",
        origin: "https://api.example.test",
        auth: { type: "bearer" },
      }),
    ).toBe("https://api.example.test");
  });

  it("shows a login's host in the punycode form it was saved in", () => {
    expect(
      secretDestinationLabel({
        name: "site_login",
        origin: "https://xn--bcher-kva.example.test",
        auth: { type: "login" },
      }),
    ).toBe("xn--bcher-kva.example.test");
  });
});

it.each([
  ["https://billing.example.com", "billing.example.com"],
  ["https://example.com:8443", "example.com:8443"],
  ["https://example.com:443", "example.com"],
  ["invalid origin", "invalid origin"],
])("formats login destination %s as %s", (origin, expected) => {
  expect(secretDestinationLabel({ name: "login", origin, auth: { type: "login" } })).toBe(expected);
});

describe("mobile site host", () => {
  it("shows the host of an origin, and the text itself when it is not one", () => {
    expect(siteHost("https://login.example.test")).toBe("login.example.test");
    expect(siteHost("not a url")).toBe("not a url");
  });
});
