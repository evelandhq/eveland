import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

export const revalidate = false;

// Static export: this emits the serialized search documents as a static file
// at /api/search; the client (RootProvider search type "static") downloads it
// and searches locally, so no per-locale server tokenizer is involved.
export const { staticGET: GET } = createFromSource(source);
