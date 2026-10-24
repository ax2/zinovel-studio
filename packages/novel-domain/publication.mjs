import { createHash } from "node:crypto";
import { publicationResourceReferences } from "./publication-resources.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const hash = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
function text(value, label) {
  if (typeof value !== "string" || !value.isWellFormed())
    throw new Error(`${label}不是有效Unicode文本`);
  return value;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("发布来源版本无效");
  return value;
}
function exact(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error(`${label}格式不支持`);
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const metadataKeys = ["title", "author", "synopsis", "rights", "aiDisclosure"];
export function publicationMetadata(input) {
  exact(input, metadataKeys, "公开书目");
  const result = Object.fromEntries(
    metadataKeys.map((key) => [key, text(input[key], key)]),
  );
  if (!result.title.trim()) throw new Error("请填写公开书名");
  return result;
}
function chapter(input) {
  exact(
    input,
    ["id", "title", "volumeTitle", "revision", "savedHash", "bodyHash", "body"],
    "发布章节",
  );
  if (!uuid(input.id) || !hash(input.savedHash) || !hash(input.bodyHash))
    throw new Error("发布章节身份或hash无效");
  const body = text(input.body, "正文");
  if (digest(body) !== input.bodyHash)
    throw new Error("发布正文与冻结hash不符，原记录已保留");
  return {
    id: input.id,
    title: text(input.title, "章名"),
    volumeTitle: text(input.volumeTitle, "卷名"),
    revision: revision(input.revision),
    savedHash: input.savedHash,
    bodyHash: input.bodyHash,
    body,
  };
}
function content(input, version) {
  const withResources =
    version === 2 ||
    (version === undefined && input && Object.hasOwn(input, "resources"));
  exact(
    input,
    [
      "bookId",
      "bookRevision",
      "metadata",
      "chapters",
      ...(withResources ? ["resources"] : []),
    ],
    "发布内容",
  );
  if (
    !uuid(input.bookId) ||
    !Array.isArray(input.chapters) ||
    !input.chapters.length
  )
    throw new Error("发布范围为空或作品身份无效");
  const seen = new Set(),
    chapters = input.chapters.map((value) => {
      const result = chapter(value);
      if (seen.has(result.id)) throw new Error("发布章节重复");
      seen.add(result.id);
      return result;
    });
  return {
    bookId: input.bookId,
    bookRevision: revision(input.bookRevision),
    metadata: publicationMetadata(input.metadata),
    chapters,
    ...(withResources
      ? {
          resources: publicationResourceReferences(
            input.resources,
            chapters.map((item) => item.id),
          ),
        }
      : {}),
  };
}

/** Host capture must validate chapter membership, source bytes and scope before calling. */
export function makePublicationSnapshot({ id, createdAt, ...input }) {
  if (
    !uuid(id) ||
    typeof createdAt !== "string" ||
    !Number.isFinite(Date.parse(createdAt)) ||
    new Date(createdAt).toISOString() !== createdAt
  )
    throw new Error("发布快照身份或时间无效");
  const projection = content(input);
  return freeze({
    schemaVersion: Object.hasOwn(projection, "resources") ? 2 : 1,
    id,
    createdAt,
    content: projection,
    hash: digest(JSON.stringify(projection)),
  });
}
/** Rebuild the exact whitelist before trusting any loaded or renderer-supplied snapshot. */
export function verifyPublicationSnapshot(input) {
  exact(
    input,
    ["schemaVersion", "id", "createdAt", "content", "hash"],
    "发布快照",
  );
  if (![1, 2].includes(input.schemaVersion) || !hash(input.hash))
    throw new Error("发布快照版本或hash不支持");
  const result = makePublicationSnapshot({
    id: input.id,
    createdAt: input.createdAt,
    ...content(input.content, input.schemaVersion),
  });
  if (result.hash !== input.hash)
    throw new Error("发布快照清单与hash不符，原记录已保留");
  return result;
}
export function publicationText(input, format) {
  const snapshot = verifyPublicationSnapshot(input);
  if (snapshot.content.resources?.length)
    throw new Error(
      "当前文本导出尚不支持带图副本，未丢弃图像；请选择纯文字副本",
    );
  const {
    content: { metadata: book, chapters },
  } = snapshot;
  if (!["txt", "md"].includes(format)) throw new Error("文本导出格式不支持");
  const md = format === "md",
    parts = [md ? `# ${book.title}` : book.title];
  for (const key of ["author", "synopsis", "rights", "aiDisclosure"])
    if (book[key]) parts.push(book[key]);
  let volume = "";
  for (const item of chapters) {
    if (item.volumeTitle && item.volumeTitle !== volume)
      parts.push(md ? `## ${item.volumeTitle}` : item.volumeTitle);
    volume = item.volumeTitle;
    parts.push(md ? `### ${item.title}` : item.title, item.body);
  }
  return parts.join("\n\n") + "\n";
}
const escape = (value) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const paragraphs = (value) =>
  value
    .split(/\r\n|\n|\r/)
    .map((line) => `<p>${escape(line || "\u00a0")}</p>`)
    .join("\n");
const stylesheet = `:root{color-scheme:light dark;--bg:#f7f2e6;--fg:#302c26;--line:#d4c5a7;font-size:20px}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,sans-serif}a{color:inherit;text-underline-offset:.2em}header,nav,footer,main{max-width:52rem;margin:auto;padding:1rem}header{border-bottom:1px solid var(--line)}header>a{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}nav{display:flex;gap:1rem;flex-wrap:wrap}main{line-height:1.9;overflow-wrap:anywhere}article p{white-space:pre-wrap;font-family:serif}label{display:inline-flex;gap:.4rem;margin:.3rem}select{font:inherit;background:var(--bg);color:var(--fg);max-width:100%}h1,h2{line-height:1.4}ol{padding-left:1.5rem}li{padding:.35rem}footer{border-top:1px solid var(--line)}:root[data-theme=light]{color-scheme:light;--bg:#fff;--fg:#252525;--line:#ddd}:root[data-theme=dark]{color-scheme:dark;--bg:#19252b;--fg:#e4eaec;--line:#52636a}:root[data-theme=sepia]{color-scheme:light;--bg:#f7f2e6;--fg:#302c26;--line:#d4c5a7}@media(prefers-color-scheme:dark){:root:not([data-theme]){--bg:#19252b;--fg:#e4eaec;--line:#52636a}}@media(max-width:600px){header,nav,footer,main{padding:.8rem}h1{font-size:1.6rem}}`;
const fontRules = [16, 18, 20, 24, 28, 32]
  .map((size) => ` :root[data-font="${size}"]{font-size:${size}px}`)
  .join("");
const readerScript = `(()=>{const root=document.documentElement,key='zinovel.export-reader.'+document.body.dataset.publication,theme=document.querySelector('[name=theme]'),font=document.querySelector('[name=font]');const themes=['light','dark','sepia'],fonts=['16','18','20','24','28','32'];function apply(p){if(themes.includes(p.theme)){root.dataset.theme=p.theme;theme.value=p.theme}if(fonts.includes(p.font)){root.dataset.font=p.font;font.value=p.font}}try{apply(JSON.parse(localStorage.getItem(key)||'{}'))}catch{}function save(){const p={theme:theme.value,font:font.value};apply(p);try{localStorage.setItem(key,JSON.stringify(p))}catch{document.getElementById('reading-status').textContent='本机偏好未保存，仍可继续阅读。'}}theme.addEventListener('change',save);font.addEventListener('change',save)})();`;

/** Text-only first renderer; resource binding and target authorization belong to the host. */
export function publicationHtml(input) {
  const snapshot = verifyPublicationSnapshot(input),
    { metadata: book, chapters } = snapshot.content;
  if (snapshot.content.resources?.length)
    throw new Error("带图HTML导出尚未接入，未丢弃图像");
  const files = new Map([
    ["reader.css", stylesheet + fontRules],
    ["reader.js", readerScript],
  ]);
  const controls = `<div aria-label="阅读偏好"><label>背景<select aria-label="背景" name="theme"><option value="sepia">纸色</option><option value="light">浅色</option><option value="dark">深色</option></select></label><label>字号<select aria-label="字号" name="font">${[16, 18, 20, 24, 28, 32].map((size) => `<option value="${size}"${size === 20 ? " selected" : ""}>${size}px</option>`).join("")}</select></label><p id="reading-status" role="status"></p></div>`;
  function page(title, relative, navigation, body) {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'"><title>${escape(title)} · ${escape(book.title)}</title><link rel="stylesheet" href="${relative}reader.css"><script src="${relative}reader.js" defer></script></head><body data-publication="${snapshot.hash}"><header><a href="${relative}index.html">${escape(book.title)}</a>${controls}</header><nav aria-label="阅读导航">${navigation}</nav><main id="reading-content">${body}</main><footer>${escape(book.author)}${book.rights ? `<p>${escape(book.rights)}</p>` : ""}${book.aiDisclosure ? `<p>${escape(book.aiDisclosure)}</p>` : ""}</footer></body></html>`;
  }
  files.set(
    "index.html",
    page(
      "目录",
      "",
      `<a href="chapters/${chapters[0].id}.html">开始阅读</a>`,
      `<h1>${escape(book.title)}</h1>${paragraphs(book.synopsis)}<ol>${chapters.map((item) => `<li><a href="chapters/${item.id}.html">${escape(item.volumeTitle ? `${item.volumeTitle} · ${item.title}` : item.title)}</a></li>`).join("")}</ol>`,
    ),
  );
  chapters.forEach((item, index) => {
    const nav = `${index ? `<a rel="prev" href="${chapters[index - 1].id}.html">上一章</a>` : ""}<a href="../index.html">目录</a>${index + 1 < chapters.length ? `<a rel="next" href="${chapters[index + 1].id}.html">下一章</a>` : ""}`;
    files.set(
      `chapters/${item.id}.html`,
      page(
        item.title,
        "../",
        nav,
        `<article aria-label="${escape(item.title)}"><h1>${escape(item.title)}</h1>${paragraphs(item.body)}</article>`,
      ),
    );
  });
  const inventory = [...files]
    .map(([path, value]) => ({
      path,
      bytes: Buffer.byteLength(value),
      sha256: digest(value),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const manifest = freeze({
    schemaVersion: 1,
    state: "prepared",
    format: "html",
    snapshotId: snapshot.id,
    snapshotHash: snapshot.hash,
    files: inventory,
    hash: digest(JSON.stringify(inventory)),
  });
  files.set(
    "publication-manifest.json",
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return { files, manifest };
}
