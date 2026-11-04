import {
  ipVersion,
  isCloudMetadataHost,
  isInternalHostname,
  isNonPublicAddress,
} from "@rakazo/contracts";
import type { NetworkExitProvider } from "./network-exit.js";
import { splitNetworkExitValues } from "./network-exit-fields.js";

const descriptor = {
  id: "proxy",
  displayName: "Proxy",
  helpUrl: "https://rakazo.com/docs/own-network",
  fields: [
    { key: "address", label: "Proxy address", kind: "text" as const, required: true },
    { key: "username", label: "Username", kind: "text" as const, required: false },
    { key: "password", label: "Password", kind: "secret" as const, required: false },
  ],
};

// host:port, with an IPv6 host in brackets.
const ADDRESS = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):(\d{1,5})$/;
// Credentials go into the forwarder's configuration as user:password.
const CREDENTIAL = /^[^\s:"\\]{1,256}$/;

/** An HTTP proxy of the person's own, such as one on their phone or home network. */
export const proxyNetworkExit: NetworkExitProvider = {
  ...descriptor,
  verify(values) {
    const split = splitNetworkExitValues(descriptor, values);
    const match = ADDRESS.exec(split.settings.address ?? "");
    const port = Number(match?.[2]);
    if (!match || port < 1 || port > 65535)
      throw new Error("Proxy address must be a host and port, like proxy.example.com:8080");
    const host = match[1]!.replace(/^\[|\]$/g, "");
    // The forwarder runs beside the computer, so it may only reach the public internet.
    if (
      isInternalHostname(host) ||
      isCloudMetadataHost(host) ||
      (ipVersion(host) && isNonPublicAddress(host))
    )
      throw new Error("Proxy address must be a public address");
    const { username } = split.settings;
    const { password } = split.credentials;
    if (Boolean(username) !== Boolean(password))
      throw new Error("Enter both a username and a password, or neither");
    if ((username && !CREDENTIAL.test(username)) || (password && !CREDENTIAL.test(password)))
      throw new Error("Username and password can't contain spaces, colons or quotes");
    return split;
  },
};
