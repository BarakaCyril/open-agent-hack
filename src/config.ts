import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8000),
  SAMPLE_MODE: z.enum(["true", "false"]).transform((value) => value === "true"),
  ZETARIS_REST_URL: z.string().min(1),
  ZETARIS_API_KEY: z.string().min(1),
  ZETARIS_ORG_ID: z.string().min(1),
  METERLESS_BASE_URL: z.string().min(1),
  METERLESS_RUNTIME_TOKEN: z.string().min(1),
  METERLESS_MODEL: z.string().min(1).default("meterless/auto"),
  SOURCE_TIMEOUT_SECONDS: z.coerce.number().positive().max(120),
  MAX_RETRIES: z.coerce.number().int().min(0).max(5),
  LOG_DIR: z.string().min(1).default("logs"),
});

export type AppConfig = z.infer<typeof EnvSchema>;

let cached: AppConfig | null = null;
let envLoaded = false;

function loadDotEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  const envPath = path.join(projectRoot(), ".env");
  try {
    process.loadEnvFile(envPath);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") {
      throw new Error("Could not read .env. Fix the file or unset it and pass variables in the environment.");
    }
  }
}

export function projectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i += 1) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function loadConfig(): AppConfig {
  if (cached) return cached;
  loadDotEnv();
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Environment validation failed: ${details}. Copy .env.example to .env and set the missing variables.`,
    );
  }
  const url = parsed.data.ZETARIS_REST_URL;
  if (/:8889(\/|$)/.test(url)) {
    throw new Error("ZETARIS_REST_URL must not use port 8889. Point it at the Zetaris REST endpoint.");
  }
  cached = parsed.data;
  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
  envLoaded = false;
}

/** Replace known secret values before anything is written to a log or a response. */
export function redact(text: string): string {
  let out = text;
  for (const key of ["ZETARIS_API_KEY", "ZETARIS_ORG_ID", "METERLESS_RUNTIME_TOKEN"]) {
    const value = process.env[key];
    if (value && value.length >= 4) out = out.split(value).join("[redacted]");
  }
  return out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 500);
}
