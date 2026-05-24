import { z } from "zod";

export const createCaseSchema = z.object({
  name: z.string().min(1).max(200),
  applicationNumber: z.string().max(40).optional().nullable(),
  dateStarted: z.coerce.date().optional().nullable(),
  nextActionDate: z.coerce.date().optional().nullable(),
});
export type CreateCaseInput = z.infer<typeof createCaseSchema>;

export const sendMessageSchema = z.object({
  conversationId: z.string().uuid().optional(),
  caseId: z.string().uuid().optional(),
  content: z.string().min(1),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
