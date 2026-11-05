import * as z from "zod";

/** Limits on a card a bot shows in chat: a compact receipt, never a document. */
export const CARD_TITLE_MAX_LENGTH = 80;
export const CARD_FIELD_LIMIT = 6;
export const CARD_FIELD_LABEL_MAX_LENGTH = 32;
export const CARD_FIELD_VALUE_MAX_LENGTH = 120;
export const CARD_LINK_LIMIT = 2;
export const CARD_LINK_LABEL_MAX_LENGTH = 32;
export const CARD_LINK_URL_MAX_LENGTH = 2_048;

export const CardStatus = z.enum(["done", "pending", "failed", "info"]);
export type CardStatus = z.infer<typeof CardStatus>;

/** An http(s) URL without credentials; anything else is never shown as a link. */
export function isCardLinkUrl(value: string): boolean {
  if (value.length > CARD_LINK_URL_MAX_LENGTH) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

const cardLinkUrl = z
  .string()
  .max(CARD_LINK_URL_MAX_LENGTH)
  .refine(isCardLinkUrl, "url must be an http or https link");

/**
 * The persisted card. Only `lines` predates the other fields, and a card without a title renders
 * the old way. Lengths are capped where show_card reads its input, so stored text never fails to
 * parse; a link is checked here too because renderers open it.
 */
export const CardBlock = z.object({
  kind: z.literal("card"),
  title: z.string().optional(),
  status: CardStatus.optional(),
  lines: z.array(z.object({ k: z.string(), v: z.string() })),
  links: z
    .array(z.object({ label: z.string(), url: cardLinkUrl }))
    .max(CARD_LINK_LIMIT)
    .optional(),
});
export type CardBlock = z.infer<typeof CardBlock>;

const oneLine = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .transform((value) => value.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1));

/** What show_card accepts from the model. */
export const ShowCardInput = z
  .object({
    title: oneLine(CARD_TITLE_MAX_LENGTH).describe('A few words, e.g. "Post published".'),
    status: CardStatus.default("done").describe("done (default), pending, failed, or info."),
    fields: z
      .array(
        z
          .object({
            label: oneLine(CARD_FIELD_LABEL_MAX_LENGTH),
            value: oneLine(CARD_FIELD_VALUE_MAX_LENGTH),
          })
          .strict(),
      )
      .max(CARD_FIELD_LIMIT)
      .default([])
      .describe('Short facts, e.g. {label:"Account", value:"@handle"}.'),
    links: z
      .array(
        z
          .object({
            label: oneLine(CARD_LINK_LABEL_MAX_LENGTH),
            url: z.string().trim().max(CARD_LINK_URL_MAX_LENGTH).pipe(cardLinkUrl),
          })
          .strict(),
      )
      .max(CARD_LINK_LIMIT)
      .default([])
      .describe('http(s) links to the result, main one first, e.g. {label:"View post", url}.'),
  })
  .strict();
export type ShowCardInput = z.input<typeof ShowCardInput>;

export function cardBlockFromInput(input: z.output<typeof ShowCardInput>): CardBlock {
  return {
    kind: "card",
    title: input.title,
    status: input.status,
    lines: input.fields.map((field) => ({ k: field.label, v: field.value })),
    ...(input.links.length ? { links: input.links } : {}),
  };
}
