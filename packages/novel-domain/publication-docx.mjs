import {
  Document,
  Paragraph,
  TextRun,
  Packer,
  Footer,
  PageNumber,
  AlignmentType,
  HeadingLevel,
  Tab,
  ImageRun,
} from "docx";
import { createHash } from "node:crypto";
import { verifyPublicationSnapshot } from "./publication.mjs";
import { publicationDocxOptions } from "./publication-docx-options.mjs";
import { publicationDocxImages } from "./publication-docx-images.mjs";

export const publicationDocxLimits = Object.freeze({
  bytes: 8 * 1024 * 1024,
  paragraphs: 20_000,
  breaks: 100_000,
});
const templateVersion = 1;
function checkedText(value) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/u.test(value))
    throw new Error("DOCX内容含不支持的XML控制字符；原快照未改动");
  return value;
}
function runs(text) {
  return text.split("\n").map(
    (line, index) =>
      new TextRun({
        ...(index ? { break: 1 } : {}),
        children: line
          .split("\t")
          .flatMap((part, index) => (index ? [new Tab(), part] : [part])),
      }),
  );
}

/** Editable OOXML from a verified public projection; no active author markup. */
export async function publicationDocx(input, layout, inputImages = new Map()) {
  const snapshot = verifyPublicationSnapshot(input),
    options = publicationDocxOptions(layout);
  const resources = snapshot.content.resources || [];
  if (
    Buffer.byteLength(JSON.stringify(snapshot.content)) >
    publicationDocxLimits.bytes
  )
    throw new Error("本次DOCX内容超过8 MiB，请缩小发布章节范围；原快照未改动");
  const { metadata, chapters } = snapshot.content;
  let paragraphCount = 0,
    breaks = 0;
  const checkLimit = () => {
    if (
      paragraphCount > publicationDocxLimits.paragraphs ||
      breaks > publicationDocxLimits.breaks
    )
      throw new Error("DOCX段落或换行超过本次排版保护上限，请缩小选章范围");
  };
  const normalize = (text) => {
    const normalized = checkedText(text)
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n");
    for (
      let index = normalized.indexOf("\n");
      index !== -1;
      index = normalized.indexOf("\n", index + 1)
    ) {
      breaks++;
      checkLimit();
    }
    return normalized;
  };
  const single = (text) => {
    const normalized = normalize(text);
    paragraphCount++;
    checkLimit();
    return normalized;
  };
  const paragraphs = (text) => {
    const normalized = normalize(text);
    const parts = normalized.split(/\n[\t ]*\n/u);
    paragraphCount += parts.length;
    checkLimit();
    return parts;
  };
  const title = single(metadata.title);
  const front = [
    metadata.author,
    metadata.synopsis,
    metadata.rights,
    metadata.aiDisclosure,
  ]
    .filter(Boolean)
    .flatMap(paragraphs);
  const contents = chapters.map((chapter) => ({
    id: chapter.id,
    title: single(chapter.title),
    volumeTitle: chapter.volumeTitle ? single(chapter.volumeTitle) : "",
    paragraphs: paragraphs(chapter.body),
  }));
  const imageText = resources.map((item) => ({
    ...item,
    alt: single(item.alt),
    caption: item.caption ? paragraphs(item.caption) : [],
    credit: item.credit ? paragraphs(item.credit) : [],
  }));
  const images = await publicationDocxImages(resources, inputImages);
  const dimensions = {
    Letter: [12240, 15840],
    A4: [11906, 16838],
    A5: [8391, 11906],
  }[options.paper];
  const margin = Math.round(
    ((options.margin === "wide" ? 22 : 16) * 1440) / 25.4,
  );
  const figureWidth = (dimensions[0] - margin * 2) / 15;
  const figureHeight = (dimensions[1] - margin * 2 - 227) / 15 - 160;
  function figures(placement, chapterId) {
    return imageText
      .filter(
        (item) => item.placement === placement && item.chapterId === chapterId,
      )
      .flatMap((item) => {
        const ratio = Math.min(
          1,
          figureWidth / item.image.width,
          figureHeight / item.image.height,
        );
        const captions = [...item.caption, ...item.credit];
        return [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            keepNext: captions.length > 0,
            keepLines: true,
            spacing: { before: 120, after: 120, line: 240 },
            children: [
              new ImageRun({
                type: "png",
                data: images.get(item.image.sha256),
                transformation: {
                  width: item.image.width * ratio,
                  height: item.image.height * ratio,
                },
                altText: {
                  name: "小说插图",
                  title: item.alt,
                  description: item.alt,
                },
              }),
            ],
          }),
          ...captions.map(
            (text) =>
              new Paragraph({
                style: "PublicationCaption",
                alignment:
                  Array.from(text).length > 120
                    ? AlignmentType.LEFT
                    : AlignmentType.CENTER,
                children: runs(text),
                keepLines: false,
                widowControl: true,
                wordWrap: true,
              }),
          ),
        ];
      });
  }
  const font = options.font === "serif" ? "SimSun" : "Microsoft YaHei",
    size = options.size * 2;
  const children = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: runs(title),
    }),
    ...figures("cover", null),
    ...front.map((text) => new Paragraph({ children: runs(text) })),
  ];
  for (const chapter of contents) {
    children.push(
      new Paragraph({
        children: runs(chapter.title),
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: true,
      }),
    );
    if (chapter.volumeTitle)
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: chapter.volumeTitle, color: "555555" }),
          ],
          keepNext: true,
        }),
      );
    children.push(...figures("chapter-start", chapter.id));
    for (const text of chapter.paragraphs)
      children.push(
        new Paragraph({
          children: runs(text),
          keepLines:
            options.keepParagraphs === "balanced" &&
            Array.from(text).length <= 240,
          widowControl: true,
          wordWrap: true,
        }),
      );
    children.push(...figures("chapter-end", chapter.id));
  }
  const document = new Document({
    title: metadata.title,
    creator: metadata.author,
    description: metadata.synopsis,
    lastModifiedBy: metadata.author,
    revision: 1,
    customProperties: [
      { name: "ZiNovelSnapshot", value: snapshot.id },
      { name: "ZiNovelSnapshotHash", value: snapshot.hash },
    ],
    styles: {
      paragraphStyles: [
        {
          id: "PublicationCaption",
          name: "Publication caption",
          basedOn: "Normal",
          run: { font, size: 20, color: "444444" },
          paragraph: {
            alignment: AlignmentType.CENTER,
            spacing: { line: 288, before: 0, after: 120 },
          },
        },
        {
          id: "PublicationFooter",
          name: "Publication footer",
          basedOn: "Normal",
          run: { font, size: 16, color: "555555" },
          paragraph: {
            alignment: AlignmentType.CENTER,
            spacing: { line: 240, before: 0, after: 0 },
          },
        },
      ],
      default: {
        document: {
          run: {
            font: { ascii: font, hAnsi: font, eastAsia: font, cs: font },
            size,
            color: "000000",
          },
          paragraph: {
            spacing: { line: Math.round(options.leading * 240), after: 160 },
          },
        },
        title: {
          run: { color: "000000", size: Math.min(36, size * 1.5), bold: true },
          paragraph: { spacing: { before: 0, after: 240 } },
        },
        heading1: {
          run: { color: "000000", size: size + 6, bold: true },
          paragraph: { keepNext: true, spacing: { before: 0, after: 200 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: dimensions[0], height: dimensions[1] },
            margin: {
              top: margin,
              left: margin,
              right: margin,
              bottom: margin + 227,
              footer: 400,
            },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                style: "PublicationFooter",
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    size: 16,
                    children: [
                      PageNumber.CURRENT,
                      " / ",
                      PageNumber.TOTAL_PAGES,
                    ],
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  const bytes = await Packer.toBuffer(document);
  if (bytes.length > 64 * 1024 * 1024)
    throw new Error("DOCX输出超过64 MiB，未提交正式导出");
  return Object.freeze({
    bytes,
    options,
    templateVersion: resources.length ? 2 : templateVersion,
    illustrationCount: resources.length,
    embeddedImages: Object.freeze([
      ...new Map(
        resources.map((item) => [item.image.sha256, item.image]),
      ).values(),
    ]),
    snapshotId: snapshot.id,
    snapshotHash: snapshot.hash,
    recipeHash: createHash("sha256")
      .update(
        JSON.stringify({
          snapshotHash: snapshot.hash,
          options,
          templateVersion: resources.length ? 2 : templateVersion,
        }),
      )
      .digest("hex"),
    engine: "docx@9.14.0",
    paragraphCount,
  });
}
