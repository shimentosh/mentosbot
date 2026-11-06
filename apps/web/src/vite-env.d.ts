/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Build id (`YYYYMMDDHHMMSS`) of a production build; empty on the dev server. */
  readonly RAKAZO_BUILD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.po" {
  export const messages: Record<string, unknown>;
}
