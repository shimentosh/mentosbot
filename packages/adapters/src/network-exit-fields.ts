import type { NetworkExitDescriptor } from "@rakazo/contracts";

/** Shared field checks: required values, length, and secrets kept out of settings. */
export function splitNetworkExitValues(
  descriptor: NetworkExitDescriptor,
  values: Record<string, string>,
) {
  const known = new Set(descriptor.fields.map((field) => field.key));
  for (const key of Object.keys(values)) {
    if (!known.has(key)) throw new Error("Unknown network setting");
  }
  const settings: Record<string, string> = {};
  const credentials: Record<string, string> = {};
  for (const field of descriptor.fields) {
    const value = values[field.key]?.trim() ?? "";
    if (field.required && !value) throw new Error(`${field.label} is required`);
    if (value.length > 4096) throw new Error(`${field.label} is too long`);
    if (!value) continue;
    (field.kind === "secret" ? credentials : settings)[field.key] = value;
  }
  return { settings, credentials };
}
