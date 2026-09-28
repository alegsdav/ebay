import { z } from "zod";
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const Env = z.object({
  DRY_RUN: bool.default(true),
  // Kill switch for the Facebook Marketplace leg. eBay legs keep running when off.
  FACEBOOK_MONITORING_ENABLED: bool.default(false),
  // Reserved for the real Bright Data adapter; the current stub reads neither.
  BRIGHT_DATA_API_KEY: z.string().default(""),
  BRIGHT_DATA_DATASET_ID: z.string().default(""),
  BRIGHT_DATA_MAX_CALLS_PER_DAY: z.coerce
    .number()
    .int()
    .min(0)
    .max(1000)
    .default(10),
  DISCORD_TOKEN: z.string().default(""),
  DISCORD_APPLICATION_ID: z.string().default(""),
  DISCORD_GUILD_ID: z.string().default(""),
  ALLOWED_USER_IDS: z.string().default(""),
  LLM_PROVIDER: z.enum(["gemini", "openai"]).default("gemini"),
  LLM_MODEL: z.string().default("gemini-3.8-flash"),
  GEMINI_API_KEY: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  EBAY_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  EBAY_CLIENT_ID: z.string().default(""),
  EBAY_CLIENT_SECRET: z.string().default(""),
  EBAY_POSTAL_CODE: z
    .string()
    .regex(/^\d{5}$|^$/)
    .default(""),
  EBAY_ALLOW_AUCTIONS: bool.default(false),
  MAX_PAGES_PER_WATCH: z.coerce.number().int().min(1).max(10).default(2),
  MAX_LLM_CALLS_PER_DAY: z.coerce
    .number()
    .int()
    .min(1)
    .max(100000)
    .default(300),
  EBAY_MAX_CALLS_PER_DAY: z.coerce
    .number()
    .int()
    .min(1)
    .max(5000)
    .default(4000),
});
export function getEnv(
  input: Record<string, string | undefined> = process.env,
) {
  return Env.parse(input);
}
export type Env = ReturnType<typeof getEnv>;
export function requireValues(e: Env, keys: (keyof Env)[]) {
  for (const k of keys)
    if (!e[k]) throw new Error(`Missing ${k}; see .env.example`);
}
