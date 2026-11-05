import type { CardBlock } from "@rakazo/contracts";
import { cardBlockFromInput, ShowCardInput } from "@rakazo/contracts";
import { containsSecret } from "@rakazo/core";
import { z } from "zod";
import { argumentGiven } from "./update-bot-patch.js";

/** The card show_card posts, or why it cannot. */
export function showCardBlock(
  args: Record<string, unknown>,
  secrets: string[],
): { block: CardBlock } | { error: string } {
  // Serializers send unused optional fields blank.
  const given = Object.fromEntries(
    Object.entries(args).filter(([, value]) => argumentGiven(value)),
  );
  const parsed = ShowCardInput.safeParse(given);
  if (!parsed.success) {
    return { error: `Nothing was shown. ${z.prettifyError(parsed.error)}` };
  }
  if (containsSecret(parsed.data, secrets)) {
    return { error: "The card contains a secret value; nothing was shown." };
  }
  return { block: cardBlockFromInput(parsed.data) };
}
