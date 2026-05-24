import { loadEnvConfig } from "@next/env";
import type { Config } from "drizzle-kit";

// Load .env.local / .env using Next.js's loader, so DATABASE_URL is available
// when drizzle-kit runs outside `next dev`.
loadEnvConfig(process.cwd());

export default {
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  strict: true,
  verbose: true,
} satisfies Config;
