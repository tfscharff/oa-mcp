// modules/analyze.js
import fs from "fs";
import path from "path";
import pdfParse from "pdf-parse";
import { checkOA, generateRelatedArticles } from "../modules/oa_helpers.js";

const PDF_DIR = "./pdfs";

export async function analyzeArticlesAndReferences(articles) {
  const analyzed = [];

  for (const article of articles) {
    const pdfPath = path.join(PDF_DIR, `${article.doi.replace(/\//g, "_")}.pdf`);
    if (!fs.existsSync(pdfPath)) continue;

    const pdfBuffer = fs.readFileSync(pdfPath);
    const pdfText = await pdfParse(pdfBuffer).then(d => d.text);

    // 🧩 3a. Extract DOIs from references
    const references = Array.from(
      pdfText.matchAll(/doi:\s*(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/ig)
    ).map(m => m[1]);

    // 🧩 3b. Verify OA access for each reference
    const accessibleRefs = [];
    for (const refDoi of references) {
      const oaInfo = await checkOA(refDoi);
      if (oaInfo && oaInfo.is_oa && oaInfo.best_oa_location?.url_for_pdf) {
        accessibleRefs.push({
          title: oaInfo.title || "Unknown",
          doi: refDoi,
          source: oaInfo.journal_name || "OA Source",
          pdf_url: oaInfo.best_oa_location.url_for_pdf
        });
      }
    }

    // 🧠 3c. AI suggests semantically related OA articles
    const relatedArticles = await generateRelatedArticles(pdfText, article.doi);

    analyzed.push({
      ...article,
      accessible_references: accessibleRefs,
      ai_suggested_articles: relatedArticles
    });
  }

  return analyzed;
}
