"use server";

import { db, schema } from "@/lib/db";
import { getCurrentUserId } from "@/lib/auth";
import { createCaseSchema } from "@/lib/types";
import { revalidatePath } from "next/cache";

export async function createCase(
  formData: FormData,
): Promise<{ ok: true; caseId: string } | { ok: false; error: string }> {
  const raw = {
    name: formData.get("name"),
    applicationNumber: formData.get("applicationNumber") || null,
    dateStarted: formData.get("dateStarted") || null,
    nextActionDate: formData.get("nextActionDate") || null,
  };
  const parsed = createCaseSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const userId = await getCurrentUserId();
  const [created] = await db
    .insert(schema.cases)
    .values({
      userId,
      name: parsed.data.name,
      applicationNumber: parsed.data.applicationNumber || null,
      dateStarted: parsed.data.dateStarted || null,
      nextActionDate: parsed.data.nextActionDate || null,
    })
    .returning({ id: schema.cases.id });

  revalidatePath("/");
  return { ok: true, caseId: created.id };
}
