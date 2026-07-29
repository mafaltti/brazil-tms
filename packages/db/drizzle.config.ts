import "dotenv/config";
import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to run drizzle-kit (see infra/supabase/.env).");
}

export default defineConfig({
  schema: "./schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  // The app owns only the public schema; auth.* is owned by GoTrue and must not be touched.
  schemaFilter: ["public"],
  verbose: true,
  strict: true,
});
