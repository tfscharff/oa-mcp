import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { checkOA } from "../server.js";

/**
 * Search DOAJ for OA articles
 * @param {string} query - search query
 * @param {string} type - type of content
 * @param {number} year_from
 * @param {number} year_to
 * @param {string} pdfDir - directory to store PDFs
 * @returns Array of OA articles with metadata and PDF URLs
 */
export async function searchDOAJ(query, type="all", year_from, year_to, pdfDir){
  const url = `https://doaj.org/api/v2/search/articles/${encodeURIComponent(query)}?pageSize=50`;

  const resp = await fetch(url);
  const data = await resp.json();
  if(!data.results) return [];

  const results = [];
  for(const r of data.results){
    const bib = r.bibjson;
    if(!bib || !bib.identifier) continue;
    const doiObj = bib.identifier.find(i=>i.type==="doi");
    if(!doiObj) continue;

    const doi = doiObj.id;
    const oaInfo = await checkOA(doi);
    if(!oaInfo || !oaInfo.is_oa || !oaInfo.best_oa_location?.url_for_pdf) continue;

    // Save PDF locally
    const doiFile = doi.replace(/\//g,"_");
    const pdfPath = path.join(pdfDir, `${doiFile}.pdf`);
    if(!fs.existsSync(pdfPath)){
      try{
        const pdfResp = await fetch(oaInfo.best_oa_location.url_for_pdf);
        if(pdfResp.ok){
          const buffer = await pdfResp.arrayBuffer();
          fs.writeFileSync(pdfPath, Buffer.from(buffer));
        }
      }catch(err){console.warn("Failed to fetch PDF:",err);}
    }

    results.push({
      title: bib.title,
      authors: bib.author?.map(a=>a.name).join(", ")||"",
      year: bib.year,
      doi: doi,
      source: "DOAJ",
      pdf_url: `/article/${doiFile}/pdf`,
      abstract: bib.abstract || ""
    });
  }
  return results;
}
