// USPTO Open Data Portal client.
// Docs: https://developer.uspto.gov/ — paths below are best-effort
// and should be verified against the current API before depending on them.
// All responses cached in Postgres `uspto_cache` table with 24h TTL.

import { db, schema } from "@/lib/db";
import { eq, gt } from "drizzle-orm";

const BASE = "https://api.uspto.gov";
const TTL_MS = 24 * 60 * 60 * 1000;

function headers(): HeadersInit {
  const key = process.env.USPTO_ODP_KEY;
  if (!key) throw new Error("USPTO_ODP_KEY not set");
  return {
    "X-API-KEY": key,
    Accept: "application/json",
  };
}

async function cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const rows = await db
    .select()
    .from(schema.usptoCache)
    .where(eq(schema.usptoCache.key, key))
    .limit(1);

  if (rows.length > 0) {
    const age = Date.now() - rows[0].fetchedAt.getTime();
    if (age < TTL_MS) {
      return rows[0].payload as T;
    }
  }

  const fresh = await fetcher();
  await db
    .insert(schema.usptoCache)
    .values({ key, payload: fresh as object, fetchedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.usptoCache.key,
      set: { payload: fresh as object, fetchedAt: new Date() },
    });
  return fresh;
}

export interface ApplicationStatus {
  applicationNumber: string;
  status: string;
  statusDate: string | null;
  examinerName: string | null;
  artUnit: string | null;
  filingDate: string | null;
  transactions: Array<{ date: string; description: string }>;
}

export async function getApplicationStatus(
  applicationNumber: string,
): Promise<ApplicationStatus> {
  const key = `status:${applicationNumber}`;
  return cached(key, async () => {
    // Endpoint path is illustrative — verify at developer.uspto.gov.
    const url = `${BASE}/api/v1/patent/applications/${encodeURIComponent(applicationNumber)}/status`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) {
      throw new Error(`USPTO ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as ApplicationStatus;
  });
}

export interface ExaminerStats {
  examinerName: string;
  allowanceRate: number | null;
  avgOfficeActions: number | null;
  sampleSize: number | null;
}

export async function getExaminerStats(
  examinerName: string,
): Promise<ExaminerStats> {
  const key = `examiner:${examinerName}`;
  return cached(key, async () => {
    // Placeholder — real ODP endpoint TBD per current API.
    return {
      examinerName,
      allowanceRate: null,
      avgOfficeActions: null,
      sampleSize: null,
    };
  });
}
