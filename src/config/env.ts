import { z } from "zod";
import { Fees } from "./schema.js";
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const rate = (fallback: number) =>
  z.coerce.number().min(0).max(1).default(fallback);
const Env = z.object({
  DATABASE_PATH: z.string().default("./data/scout.sqlite"),
  DRY_RUN: bool.default(true),
  FACEBOOK_MONITORING_ENABLED: z
    .literal("false")
    .default("false")
    .transform(() => false),
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
  MAX_LLM_CALLS_PER_SCAN: z.coerce.number().int().min(1).max(1000).default(50),
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
  TAX_RATE: rate(0.08),
  BUYER_FEE_RATE: rate(0),
  BUYER_FIXED_FEE: z.coerce.number().nonnegative().default(0),
  SELLING_FEE_RATE: rate(0.15),
  SELLING_FIXED_FEE: z.coerce.number().nonnegative().default(0.3),
  OUTBOUND_SHIPPING: z.coerce.number().nonnegative().default(7),
  RISK_RESERVE_RATE: rate(0.05),
});
export function getEnv(
  input: Record<string, string | undefined> = process.env,
) {
  return Env.parse(input);
}
export type Env = ReturnType<typeof getEnv>;
export function feeDefaults(e: Env) {
  return Fees.parse({
    taxRate: e.TAX_RATE,
    buyerRate: e.BUYER_FEE_RATE,
    buyerFixed: e.BUYER_FIXED_FEE,
    sellingRate: e.SELLING_FEE_RATE,
    sellingFixed: e.SELLING_FIXED_FEE,
    outboundShipping: e.OUTBOUND_SHIPPING,
    riskRate: e.RISK_RESERVE_RATE,
  });
}
export function requireValues(e: Env, keys: (keyof Env)[]) {
  for (const k of keys)
    if (!e[k]) throw new Error(`Missing ${k}; see .env.example`);
}
