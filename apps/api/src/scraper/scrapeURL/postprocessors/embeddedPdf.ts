import type { Meta } from "..";
import type { Postprocessor } from ".";
import type { EngineScrapeResult } from "../engines";
import { scrapeURLWithEngine } from "../engines";
import { isPdfUrl } from "../../../lib/document-formats";
import * as cheerio from "cheerio";

export function extractEmbeddedPdfUrl(
  html: string,
  baseUrl: string,
): string | null {
  try {
    const $ = cheerio.load(html);
    let embeddedPdfUrl: string | null = null;

    const elements = $("iframe, object, embed");

    for (const element of elements) {
      const $el = $(element);
      const tagName = element.tagName.toLowerCase();

      const url = tagName === "object" ? $el.attr("data") : $el.attr("src");

      if (url) {
        try {
          const absoluteUrl = new URL(url, baseUrl).href;

          if (isPdfUrl(absoluteUrl)) {
            embeddedPdfUrl = absoluteUrl;
            break;
          }
        } catch {
          continue;
        }
      }
    }
    return embeddedPdfUrl;
  } catch (error) {
    return null;
  }
}

export const embeddedPdfPostprocessor: Postprocessor = {
  name: "embedded-pdf",
  shouldRun: (meta: Meta, url: URL, postProcessorsUsed?: string[]) => {
    if (postProcessorsUsed?.includes("embedded-pdf")) {
      return false;
    }

    if (meta.options.lockdown) {
      return false;
    }

    const isPdfRequest = meta.featureFlags.has("pdf");
    if (isPdfRequest) {
      return false;
    }
    return true;
  },
  run: async (meta: Meta, engineResult: EngineScrapeResult) => {
    if (meta.options.lockdown) {
      return engineResult;
    }

    if (!engineResult.html || typeof engineResult.html !== "string") {
      return engineResult;
    }

    const baseUrl = engineResult.url;
    const embeddedPdfUrl = extractEmbeddedPdfUrl(engineResult.html, baseUrl);

    if (!embeddedPdfUrl || !isPdfUrl(embeddedPdfUrl)) {
      return engineResult;
    }

    meta.logger.info("Found embedded PDF, scraping it", {
      embeddedPdfUrl,
      baseUrl,
    });

    try {
      const originalUrlObj = new URL(baseUrl);
      const pdfUrlObj = new URL(embeddedPdfUrl);
      let safeHeaders = { ...(meta.options.headers || {}) };

      if (originalUrlObj.origin !== pdfUrlObj.origin) {
        const allowedHeaders = new Set([
          "user-agent",
          "accept",
          "accept-language",
          "accept-encoding",
        ]);

        safeHeaders = Object.fromEntries(
          Object.entries(safeHeaders).filter(([key]) =>
            allowedHeaders.has(key.toLowerCase()),
          ),
        );
      }
      const pdfMeta = {
        ...meta,
        logger: meta.logger.child({ method: "embeddedPdfPostprocessor" }),
        url: embeddedPdfUrl,
        rewrittenUrl: embeddedPdfUrl,
      };

      const pdfResult = await scrapeURLWithEngine(pdfMeta, "pdf");

      return {
        ...engineResult,
        ...pdfResult,
        url: engineResult.url,
        statusCode: engineResult.statusCode,
        markdown: pdfResult.markdown ?? engineResult.markdown,
        html: pdfResult.html ?? engineResult.html,
        contentType: "application/pdf",
        postprocessorsUsed: [
          ...(engineResult.postprocessorsUsed ?? []),
          "embedded-pdf",
        ],
      };
    } catch (error) {
      meta.logger.warn(
        "Failed to scrape embedded PDF, returning original result",
        {
          embeddedPdfUrl,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return engineResult;
    }
  },
};
