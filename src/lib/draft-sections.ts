// Section keys and display titles for a drafted application.
//
// Deliberately free of server imports (no db, no ai, no provider config) so
// client components can import it. draft-application.ts re-exports these, but
// importing that module from the client would drag the model client and the
// database connection across the boundary.

export const SECTION_KEYS = [
  "title",
  "technicalField",
  "background",
  "summary",
  "briefDescriptionOfDrawings",
  "detailedDescription",
  "abstract",
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTION_TITLES: Record<SectionKey, string> = {
  title: "TITLE",
  technicalField: "TECHNICAL FIELD",
  background: "BACKGROUND",
  summary: "SUMMARY",
  briefDescriptionOfDrawings: "BRIEF DESCRIPTION OF THE DRAWINGS",
  detailedDescription: "DETAILED DESCRIPTION",
  abstract: "ABSTRACT",
};
