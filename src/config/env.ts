import { z } from "zod";
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const Env = z.object({
  DRY_RUN: bool.default(true),
  // Kill switch for the Facebook Marketplace leg. eBay legs keep running when off.
  FACEBOOK_MONITORING_ENABLED: bool.default(false),
  BRIGHT_DATA_API_KEY: z.string().default(""),
  // Bright Data's public Facebook Marketplace scraper ("discover by keyword").
  BRIGHT_DATA_DATASET_ID: z
    .string()
    .regex(/^gd_[a-z0-9]+$/)
    .default("gd_lvt9iwuh6fbcwmx1a"),
  // Bright Data bills per returned record, including listings already seen.
  BRIGHT_DATA_MAX_RECORDS_PER_MONTH: z.coerce
    .number()
    .int()
    .min(0)
    .max(1000000)
    .default(4500),
  BRIGHT_DATA_INITIAL_RECORDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10),
  BRIGHT_DATA_POLL_RECORDS: z.coerce.number().int().min(1).max(50).default(2),
  // Bright Data's date_listed filter for follow-up polls; empty disables it.
  BRIGHT_DATA_RECENT_FILTER: z.string().max(40).default("Last 24 hours"),
  // Live tests: a 5-mile Marketplace search returned no exact matches and padded
  // results with unrelated items from other states; 20 miles returned exact matches.
  BRIGHT_DATA_MIN_RADIUS: z.coerce.number().int().min(1).max(500).default(20),
  // Optional Discord channel for per-search and per-listing diagnostics.
  DEBUG_CHANNEL_ID: z.string().regex(/^\d*$/).default(""),
  // Guard against runaway API loops (trigger, progress and download calls are free).
  BRIGHT_DATA_MAX_CALLS_PER_DAY: z.coerce
    .number()
    .int()
    .min(0)
    .max(20000)
    .default(2000),
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
  // A blank entry in a secrets file means "use the default", not "set to empty".
  return Env.parse(
    Object.fromEntries(Object.entries(input).filter(([, v]) => v !== "")),
  );
}
export type Env = ReturnType<typeof getEnv>;
export function requireValues(e: Env, keys: (keyof Env)[]) {
  for (const k of keys)
    if (!e[k]) throw new Error(`Missing ${k}; see .env.example`);
}
