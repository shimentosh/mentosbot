import { HttpDecisionProvider } from "../../../approvals/http-decisions.js";
import type { DecisionModelDescriptor } from "../../../approvals/model-descriptor.js";

export const typesafeDecisionModel: DecisionModelDescriptor = {
  create: (options) => new HttpDecisionProvider("typesafe", options),
  deploymentApiKey: (env) => env.TYPESAFE_API_KEY?.trim() || undefined,
  provider: "typesafe",
  id: "jev-1.14",
  // jev-1.14.0 is the id this fork saved before it took upstream's entry.
  aliases: ["jev-latest", "jev-1.14.0"],
  inputUsdPerMillion: 0.042,
  pricingVersion: "decision-pricing-2026-11-17",
  pricingUrl: "https://help.typesafe.ai/articles/5187202169-how-much-does-jev-cost",
  calibration: { confidenceScale: "linear", minPassProbability: 0.75 },
  // Connected directly, its key only answers decisions; it never runs a chat.
  decisionsOnly: true,
  keyCheck: {
    url: "https://api.typesafe.ai/v1/models",
    headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
    rejected: async (response) => response.status === 401 || response.status === 403,
  },
  catalog: {
    provider: "typesafe",
    providerName: "TypeSafe",
    id: "jev-1.14",
    label: "Jev 1.14",
    protocol: "decisions",
    billing: "Uses your API key",
    auth: "api-key",
  },
};
