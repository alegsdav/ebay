import { z } from "zod";
import { getEnv } from "../config/env.js";
export function cloudConfig(raw: Record<string, string | undefined>) {
  const cloud = z
    .object({
      SUPABASE_URL: z.url(),
      SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
      DISCORD_PUBLIC_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
      WORKER_SECRET: z.string().min(32),
      CLOUD_ITEMS_PER_WATCH: z.coerce.number().int().min(1).max(50).default(20),
      CLOUD_MONITORING_ENABLED: z
        .enum(["true", "false"])
        .default("false")
        .transform((v) => v === "true"),
    })
    .parse(raw);
  const env = getEnv(raw);
  if (
    !env.DISCORD_TOKEN ||
    !env.DISCORD_APPLICATION_ID ||
    !env.DISCORD_GUILD_ID
  )
    throw new Error("Missing Discord configuration");
  return { ...cloud, env };
}
export type CloudConfig = ReturnType<typeof cloudConfig>;
