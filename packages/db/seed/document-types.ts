import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, documentTypes } from "../src";

/**
 * Feature 008 — proof-document type seed (clarify Q2). LABELED SCAFFOLDING (Constitution II): the five
 * MVP proof types with pt-BR labels so documents are demonstrable end-to-end. Explicitly NOT final
 * business sign-off (mirrors 007's reason-code seed). Idempotent: keyed on `code`. Run AFTER db:migrate:
 *   pnpm --filter @brazil-tms/db db:seed:document-types
 */
const ROWS = [
  { code: "pod", labelPt: "Comprovante de entrega (POD)", sort: 1 },
  { code: "cte", labelPt: "CT-e (Conhecimento de Transporte Eletrônico)", sort: 2 },
  { code: "mdfe", labelPt: "MDF-e (Manifesto Eletrônico de Documentos Fiscais)", sort: 3 },
  { code: "gate_receipt", labelPt: "Comprovante de portaria", sort: 4 },
  { code: "portal_ref", labelPt: "Referência do portal do cliente", sort: 5 },
] as const;

async function main(): Promise<void> {
  let inserted = 0;
  for (const r of ROWS) {
    const existing = await db
      .select({ id: documentTypes.id })
      .from(documentTypes)
      .where(eq(documentTypes.code, r.code))
      .limit(1);
    if (existing[0]) continue;
    await db.insert(documentTypes).values({ code: r.code, labelPt: r.labelPt, sortOrder: r.sort });
    inserted += 1;
  }
  console.log(
    `Seeded document_types scaffolding: ${inserted} new of ${ROWS.length} types (labeled defaults — NOT final business sign-off).`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
