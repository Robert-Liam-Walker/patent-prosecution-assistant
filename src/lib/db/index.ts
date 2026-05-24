import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Lazy singleton so `next build` can collect page data without DATABASE_URL set.
// First actual query — at request time — is when we fail loudly.
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function init() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and provide a Postgres URL.",
    );
  }
  const client = postgres(url, { max: 10 });
  return drizzle(client, { schema });
}

export const db: ReturnType<typeof drizzle<typeof schema>> = new Proxy(
  {} as ReturnType<typeof drizzle<typeof schema>>,
  {
    get(_, prop, receiver) {
      if (!_db) _db = init();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return Reflect.get(_db as any, prop, receiver);
    },
  },
);

export type DB = typeof db;
export { schema };
