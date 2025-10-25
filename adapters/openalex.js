import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { checkOA, generateRelatedArticles } from "../modules/oa_helpers.js";

/**
 * Search OpenAlex for OA articles
 * @param {string} query - search query
 * @param {string} type - type of content (article/book/etc.)
 * @param {number} year_from
 * @param {number} year_to
 * @param {string} pdfDir - directory to store PDFs
 * @returns Array of OA articles with metadata and PDF URLs
 */
export async function searchOpenAlex(query, type="all", year_from, year_to, pdfDir){
  let url = `https://api.openalex.org/works?filter=open_access.is_oa:true,title.search:${encodeURIComponent(query)}`;
  if(year_from) url+=`,publication_year:>${year_from-1}`;
  if(year_to) url+=`,publication_year:<${year_to+1}`;

  const resp = await fetch(url);
  const data = await resp.json();
  if(!data.results) return [];

  const results = [];
  for(const r of data.results){
    if(!r.doi) continue;

    const oaInfo = await checkOA(r.doi);
    if(!oaInfo || !oaInfo.is_oa || !oaInfo.best_oa_location?.url_for_pdf) continue;

    // Save PDF locally
    const doiFile = r.doi.replace(/\//g,"_");
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
      title: r.display_name,
      authors: r.authorships?.map(a=>a.author.display_name).join(", ")||"",
      year: r.publication_year,
      doi: r.doi,
      source: "OpenAlex",
      pdf_url: `/article/${doiFile}/pdf`,
      abstract: r.abstract_inverted_index ? Object.keys(r.abstract_inverted_index).join(" ") : ""
    });
  }
  return results;
}
