import { createHash } from "node:crypto";
import { verifyPublicationSnapshot } from "./publication.mjs";
import { publicationPdfOptions } from "./publication-pdf-options.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
export const publicationPdfInputLimit = 8 * 1024 * 1024;
const templateVersion = 1;
function escape(value) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))
    throw new Error(
      "PDF内容含不支持的控制字符；原快照未改动，请检查后重新冻结",
    );
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Pure rendering plan. Content comes exclusively from the verified frozen snapshot. */
export function publicationPdfDocument(input, layout) {
  const snapshot = verifyPublicationSnapshot(input),
    options = publicationPdfOptions(layout);
  const resources = snapshot.content.resources || [];
  const { metadata, chapters } = snapshot.content;
  const contentBytes = Buffer.byteLength(JSON.stringify(snapshot.content));
  if (contentBytes > publicationPdfInputLimit)
    throw new Error(
      "本次PDF排版内容超过8 MiB，请缩小发布章节范围；原快照未改动",
    );
  const margin = options.margin === "wide" ? 22 : 16;
  const fonts =
    options.font === "serif"
      ? '"Noto Serif CJK SC","Source Han Serif SC",SimSun,PMingLiU,serif'
      : '"Noto Sans CJK SC","Microsoft YaHei",DengXian,sans-serif';
  const usableWidth = (options.paper === "A4" ? 210 : 148) - margin * 2;
  const usableHeight = (options.paper === "A4" ? 297 : 210) - margin * 2 - 4;
  const shortLimit = Math.max(
    80,
    Math.min(
      600,
      Math.floor(
        (((usableWidth * 72) / 25.4 / options.size) *
          ((usableHeight * 72) / 25.4 / options.size / options.leading)) /
          3,
      ),
    ),
  );
  const paragraphs = (value) =>
    value
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      .split(/\n[\t ]*\n/u)
      .map(
        (body) =>
          `<p class="${
            options.keepParagraphs === "balanced" &&
            Array.from(body).length <= shortLimit
              ? "keep"
              : "flow"
          }">${escape(body)}</p>`,
      )
      .join("\n");
  const figures = (placement, chapterId) =>
    resources
      .filter(
        (item) => item.placement === placement && item.chapterId === chapterId,
      )
      .map(
        (item) =>
          `<figure class="publication-figure"><img src="images/${item.image.sha256}.png" width="${item.image.width}" height="${item.image.height}" alt="${escape(item.alt)}"><figcaption>${item.caption ? paragraphs(item.caption) : ""}${item.credit ? paragraphs(item.credit) : ""}</figcaption></figure>`,
      )
      .join("\n");
  const cover = `<section class="cover"><h1 class="${Array.from(metadata.title).length > 48 ? "long-title" : "title"}">${escape(metadata.title)}</h1>${figures("cover", null)}${[
    metadata.author,
    metadata.synopsis,
    metadata.rights,
    metadata.aiDisclosure,
  ]
    .filter(Boolean)
    .map(paragraphs)
    .join("\n")}</section>`;
  const body = chapters
    .map(
      (chapter) =>
        `<section class="chapter">${
          chapter.volumeTitle
            ? `<div class="volume">${escape(chapter.volumeTitle)}</div>`
            : ""
        }<h2>${escape(chapter.title)}</h2>${figures("chapter-start", chapter.id)}${paragraphs(chapter.body)}${figures("chapter-end", chapter.id)}</section>`,
    )
    .join("\n");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'${resources.length ? "; img-src 'self'" : ""}">
<title>${escape(metadata.title)}</title><style>
@page{size:${options.paper};margin:${margin}mm ${margin}mm ${margin + 4}mm}
*{box-sizing:border-box}html{color:#111;background:white}
body{margin:0;font-family:${fonts};font-size:${options.size}pt;line-height:${options.leading};overflow-wrap:anywhere}
h1{font-size:2em;line-height:1.4}h1.long-title{font-size:1.2em;line-height:1.3}h2{font-size:1.5em;line-height:1.5;break-after:avoid}
p{white-space:pre-wrap;margin:0 0 .8em;orphans:2;widows:2}p.keep{break-inside:avoid}p.flow{break-inside:auto}
.cover{break-after:page}.cover h1{margin:0 0 1em}.cover p{font-size:.9em;line-height:1.45;margin:0 0 .55em}.chapter+.chapter{break-before:page}.volume{font-size:.9em;break-after:avoid;color:#555}${resources.length ? `\n.publication-figure{margin:1em 0;break-inside:auto}.publication-figure img{display:block;max-width:100%;max-height:${usableHeight - 48}mm;width:auto;height:auto;margin:0 auto;break-inside:avoid;break-after:avoid}.publication-figure figcaption{break-before:avoid}.publication-figure figcaption p{font-size:10pt;line-height:1.5;margin:.4em 0;color:#444;break-inside:auto}` : ""}
</style></head><body>${cover}${body}</body></html>`;
  return Object.freeze({
    html,
    options,
    title: metadata.title,
    snapshotId: snapshot.id,
    snapshotHash: snapshot.hash,
    htmlHash: digest(html),
    templateVersion: resources.length ? 2 : templateVersion,
    ...(resources.length ? { resources } : {}),
  });
}
