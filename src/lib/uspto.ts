// USPTO Open Data Portal client.
// Docs: https://data.uspto.gov/apis/patent-file-wrapper
// All responses cached in Postgres `uspto_cache` table with 24h TTL.

import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

const BASE = "https://api.uspto.gov/api/v1";
const TTL_MS = 24 * 60 * 60 * 1000;

function headers(): HeadersInit {
  const key = process.env.USPTO_ODP_KEY;
  if (!key) throw new Error("USPTO_ODP_KEY not set");
  return {
    "X-API-KEY": key,
    Accept: "application/json",
  };
}

function normalizeApplicationNumber(applicationNumber: string): string {
  return applicationNumber.replace(/[^a-zA-Z0-9]/g, "");
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

async function odpJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: headers() });
  if (!res.ok) {
    throw new Error(`USPTO ODP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

interface PatentFileWrapperResponse {
  count?: number;
  patentFileWrapperDataBag?: Array<{
    applicationNumberText?: string;
    applicationMetaData?: {
      applicationStatusDescriptionText?: string;
      applicationStatusDate?: string;
      examinerNameText?: string;
      groupArtUnitNumber?: string;
      filingDate?: string;
      effectiveFilingDate?: string;
      inventionTitle?: string;
      patentNumber?: string;
      grantDate?: string;
      firstApplicantName?: string;
      firstInventorName?: string;
      earliestPublicationNumber?: string;
      earliestPublicationDate?: string;
      applicationTypeLabelName?: string;
      docketNumber?: string;
    };
    eventDataBag?: Array<{
      eventDate?: string;
      eventDescriptionText?: string;
      eventCode?: string;
    }>;
  }>;
}

export interface ApplicationDocument {
  applicationNumber: string;
  officialDate: string | null;
  documentIdentifier: string;
  documentCode: string | null;
  description: string | null;
  direction: string | null;
  downloadOptions: Array<{
    mimeType: string | null;
    downloadUrl: string;
    pageCount: number | null;
  }>;
}

interface DocumentsResponse {
  count?: number;
  documentBag?: Array<{
    applicationNumberText?: string;
    officialDate?: string;
    documentIdentifier?: string;
    documentCode?: string;
    documentCodeDescriptionText?: string;
    directionCategory?: string;
    downloadOptionBag?: Array<{
      mimeTypeIdentifier?: string;
      downloadUrl?: string;
      pageTotalQuantity?: number;
    }>;
  }>;
}

export interface ApplicationStatus {
  applicationNumber: string;
  title: string | null;
  status: string | null;
  statusDate: string | null;
  examinerName: string | null;
  artUnit: string | null;
  filingDate: string | null;
  effectiveFilingDate: string | null;
  patentNumber: string | null;
  grantDate: string | null;
  firstApplicant: string | null;
  firstInventor: string | null;
  earliestPublicationNumber: string | null;
  earliestPublicationDate: string | null;
  applicationType: string | null;
  docketNumber: string | null;
  transactions: Array<{ date: string; description: string }>;
  documents: ApplicationDocument[];
}

export async function getApplicationMetadata(
  applicationNumber: string,
): Promise<PatentFileWrapperResponse> {
  const normalized = normalizeApplicationNumber(applicationNumber);
  return cached(`meta:${normalized}`, () =>
    odpJson<PatentFileWrapperResponse>(
      `/patent/applications/${encodeURIComponent(normalized)}/meta-data`,
    ),
  );
}

export async function searchApplicationWrapper(
  applicationNumber: string,
): Promise<PatentFileWrapperResponse> {
  const normalized = normalizeApplicationNumber(applicationNumber);
  const q = encodeURIComponent(`applicationNumberText:${normalized}`);
  return cached(`search:${normalized}`, () =>
    odpJson<PatentFileWrapperResponse>(
      `/patent/applications/search?q=${q}&offset=0&limit=1`,
    ),
  );
}

export async function getApplicationDocuments(
  applicationNumber: string,
): Promise<ApplicationDocument[]> {
  const normalized = normalizeApplicationNumber(applicationNumber);
  const payload = await cached(`documents:${normalized}`, () =>
    odpJson<DocumentsResponse>(
      `/patent/applications/${encodeURIComponent(normalized)}/documents`,
    ),
  );

  return (payload.documentBag ?? [])
    .filter((doc) => doc.documentIdentifier)
    .map((doc) => ({
      applicationNumber: doc.applicationNumberText ?? normalized,
      officialDate: doc.officialDate ?? null,
      documentIdentifier: doc.documentIdentifier!,
      documentCode: doc.documentCode ?? null,
      description: doc.documentCodeDescriptionText ?? null,
      direction: doc.directionCategory ?? null,
      downloadOptions: (doc.downloadOptionBag ?? [])
        .filter((option) => option.downloadUrl)
        .map((option) => ({
          mimeType: option.mimeTypeIdentifier ?? null,
          downloadUrl: option.downloadUrl!,
          pageCount: option.pageTotalQuantity ?? null,
        })),
    }));
}

export async function getApplicationStatus(
  applicationNumber: string,
): Promise<ApplicationStatus> {
  const normalized = normalizeApplicationNumber(applicationNumber);
  const [metadataPayload, searchPayload, documents] = await Promise.all([
    getApplicationMetadata(normalized),
    searchApplicationWrapper(normalized).catch(() => null),
    getApplicationDocuments(normalized).catch(() => []),
  ]);

  const wrapper = metadataPayload.patentFileWrapperDataBag?.[0] ?? {};
  const metadata = wrapper.applicationMetaData ?? {};
  const events =
    searchPayload?.patentFileWrapperDataBag?.[0]?.eventDataBag ??
    wrapper.eventDataBag ??
    [];

  return {
    applicationNumber: wrapper.applicationNumberText ?? normalized,
    title: metadata.inventionTitle ?? null,
    status: metadata.applicationStatusDescriptionText ?? null,
    statusDate: metadata.applicationStatusDate ?? null,
    examinerName: metadata.examinerNameText ?? null,
    artUnit: metadata.groupArtUnitNumber ?? null,
    filingDate: metadata.filingDate ?? null,
    effectiveFilingDate: metadata.effectiveFilingDate ?? null,
    patentNumber: metadata.patentNumber ?? null,
    grantDate: metadata.grantDate ?? null,
    firstApplicant: metadata.firstApplicantName ?? null,
    firstInventor: metadata.firstInventorName ?? null,
    earliestPublicationNumber: metadata.earliestPublicationNumber ?? null,
    earliestPublicationDate: metadata.earliestPublicationDate ?? null,
    applicationType: metadata.applicationTypeLabelName ?? null,
    docketNumber: metadata.docketNumber ?? null,
    transactions: events.map((event) => ({
      date: event.eventDate ?? "(date unavailable)",
      description:
        event.eventDescriptionText ??
        event.eventCode ??
        "(description unavailable)",
    })),
    documents,
  };
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
