export const SYSTEM_PROMPT = `You are a patent-prosecution research assistant for a registered patent practitioner.

Rules:
- Answer ONLY from the provided sources. If sources don't address the question, say so plainly.
- Cite every substantive claim as [Source N], matching the numbered sources in context.
- When citing MPEP, USC, CFR, PTAB, or Federal Circuit material, also restate the formal citation.
- Distinguish binding authority (statute, regs, controlling caselaw) from persuasive (MPEP guidance, non-precedential PTAB).
- Never invent application numbers, examiner names, dates, or case citations.
- You are NOT giving legal advice to an end client — the user is a practitioner. Be precise and technical.`;

export const DRAFT_MOTION_PROMPT = (caseSummary: string) =>
  `Below is the current state of an in-progress patent application. Identify the most likely next motion or response document needed, then draft it.

Output structure:
1. **Recommended next action** (single sentence)
2. **Draft document** — properly formatted with caption, claim references, and MPEP/case citations
3. **Open questions for the practitioner**

Case context:
${caseSummary}`;

export const DRAFT_EMAIL_PROMPT = (caseSummary: string) =>
  `Draft a professional email related to the case below. First decide the recipient (client vs examiner), then write accordingly.

Output structure:
1. **Recipient:** client | examiner
2. **Subject:**
3. **Body:**

Case context:
${caseSummary}`;

export const PREDICT_NEXT_ACTION_PROMPT = (
  caseSummary: string,
  examinerStats?: string,
) =>
  `Analyze this patent application and predict the next likely USPTO action.

Consider:
- Current status (RCE? appeal-eligible? final OA outstanding?)
- Outstanding rejections (§101 / §102 / §103 / §112)
- Examiner statistics${examinerStats ? `:\n${examinerStats}` : " (none available — flag that)"}
- Typical USPTO timelines

Output structure:
1. **Most likely next action** with rough probability
2. **Reasoning** (cite §§ / MPEP)
3. **Alternative scenarios** (lower probability)
4. **Recommended preparation steps**

Case context:
${caseSummary}`;

export const SUMMARIZE_STATUS_PROMPT = (
  uspto: string,
  uploaded: string,
) => `Summarize the current state of this patent application for a busy practitioner.

USPTO Open Data Portal:
${uspto}

Uploaded case documents:
${uploaded}

Produce a 5-bullet status card:
- **Application:** number, status, filing date
- **Latest action:** OA type / date / examiner
- **Outstanding deadlines:** specific dates
- **Open issues:** rejections + claims affected
- **Recommended next step:** one sentence`;
