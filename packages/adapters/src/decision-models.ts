import type { ModelCatalogEntry } from "@rakazo/contracts";

/** Protocol/pricing belongs to the adapter catalog, never approval policy. */
const models = [
  {
    provider: "openrouter",
    providerName: "OpenRouter",
    id: "typesafe/jev-1.14",
    label: "Jev 1.14",
    inputUsdPerMillion: 0.042,
  },
  {
    provider: "typesafe",
    providerName: "TypeSafe",
    id: "jev-1.14.0",
    label: "Jev 1.14",
    inputUsdPerMillion: 0.042,
  },
];
export type DecisionModelProvider = "openrouter" | "typesafe";
export function decisionModel(provider: string, id: string) {
  return models.find((model) => model.provider === provider && model.id === id);
}
/** The decisions API a catalog provider's decision models are answered through. */
export function decisionProviderOf(provider: string): DecisionModelProvider {
  return provider === "typesafe" ? "typesafe" : "openrouter";
}
/** Providers whose connections only answer decisions; they never run a chat. */
export function decisionOnlyProvider(provider: string): boolean {
  return models.some((model) => model.provider === provider) && provider !== "openrouter";
}
export function decisionModelCatalog(): ModelCatalogEntry[] {
  return models.map((model) => ({
    provider: model.provider,
    providerName: model.providerName,
    id: model.id,
    label: model.label,
    protocol: "decisions",
    billing: "Uses your API key",
    auth: "api-key",
  }));
}
