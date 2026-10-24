"""Independent development QA; never shipped as an application dependency."""
import argparse
import json
import hashlib
from pathlib import Path

import pdfplumber
import pypdf
import pypdfium2 as pdfium
from PIL import Image, ImageDraw

parser = argparse.ArgumentParser()
parser.add_argument("pdf")
parser.add_argument("expected", help="JSON containing required, forbidden and paper fields")
parser.add_argument("output")
args = parser.parse_args()
source, output = Path(args.pdf), Path(args.output)
output.mkdir(parents=True, exist_ok=True)
expected = json.loads(Path(args.expected).read_text(encoding="utf-8-sig"))
reader = pypdf.PdfReader(source)
assert not reader.is_encrypted
assert reader.pages
root = reader.trailer["/Root"]
assert "/JavaScript" not in root.get("/Names", {})
assert "/OpenAction" not in root
parts = []
for index, page in enumerate(reader.pages):
    content_parts, footer_parts = [], []
    # Chromium emits the fixed 9px footer separately; the smallest author text
    # is 9pt (12px), with a 0.9em volume label. Verify, then exclude page labels
    # so a title spanning pages can still be checked as one Unicode string.
    def visit(value, _cm, _tm, _font, size):
        (footer_parts if size <= 9.1 else content_parts).append(value)
    page.extract_text(visitor_text=visit)
    assert "".join("".join(footer_parts).split()) == f"{index + 1}/{len(reader.pages)}"
    parts.append("".join(content_parts))
text = "\n".join(parts)
compact = "".join(text.split())
for value in expected["required"]:
    assert "".join(value.split()) in compact, f"Required text missing: {value!r}"
for value in expected["forbidden"]:
    assert "".join(value.split()) not in compact, f"Private/excluded text present: {value!r}"
assert "\ufffd" not in text
position = -1
for value in expected.get("ordered", []):
    found = compact.find("".join(value.split()), position + 1)
    assert found > position, f"Chapter order incorrect: {value!r}"
    position = found
for value, count in expected.get("counts", {}).items():
    assert text.count(value) == count, f"Character count mismatch: {value!r}"
font_reports = []
sizes = []
for page in reader.pages:
    width, height = float(page.mediabox.width), float(page.mediabox.height)
    paper = {"A4": (595.28, 841.89), "A5": (419.53, 595.28)}[expected["paper"]]
    assert abs(width - paper[0]) < 1 and abs(height - paper[1]) < 1
    sizes.append([width, height])
    for annotation in page.get("/Annots", []):
        item = annotation.get_object()
        assert "/A" not in item and "/AA" not in item
    for font_ref in page["/Resources"].get("/Font", {}).values():
        font = font_ref.get_object()
        assert "/ToUnicode" in font, "Font lacks Unicode mapping"
        if font["/Subtype"] == "/Type3":
            assert font.get("/CharProcs"), "Type3 glyph procedures missing"
            embedded = True
        else:
            descendant = font.get("/DescendantFonts", [font])[0].get_object()
            descriptor = descendant.get("/FontDescriptor", {}).get_object()
            embedded = any(key in descriptor for key in ["/FontFile", "/FontFile2", "/FontFile3"])
        assert embedded, "Font program not embedded"
        font_reports.append({"name": str(font.get("/BaseFont", "Type3")), "embedded": embedded})
outside = []
with pdfplumber.open(source) as pdf:
    for index, page in enumerate(pdf.pages):
        for char in page.chars:
            if char["text"].strip() and (char["x0"] < -1 or char["x1"] > page.width + 1 or
                    char["top"] < -1 or char["bottom"] > page.height + 1):
                outside.append({"page": index + 1, "text": char["text"]})
assert not outside, f"Glyphs outside page: {outside[:5]}"
document = pdfium.PdfDocument(str(source))
thumbnails = []
rendered_pages = []
try:
    for index in range(len(document)):
        page = document[index]
        selected = index in {0, len(document) // 2, len(document) - 1}
        bitmap = page.render(scale=1.5 if selected else 0.6)
        rendered = bitmap.to_pil().copy()
        if selected:
            image_name = f"page-{index + 1:03}.png"
            rendered.save(output / image_name)
            rendered_pages.append(image_name)
        rendered.thumbnail((280, 430))
        thumbnails.append(rendered)
        bitmap.close()
        page.close()
finally:
    document.close()
columns = min(4, len(thumbnails))
rows = (len(thumbnails) + columns - 1) // columns
sheet = Image.new("RGB", (columns * 300, rows * 460), "#dddddd")
draw = ImageDraw.Draw(sheet)
for index, thumbnail in enumerate(thumbnails):
    x, y = index % columns * 300 + 10, index // columns * 460 + 20
    sheet.paste(thumbnail, (x, y))
    draw.text((x, y - 15), str(index + 1), fill="black")
sheet.save(output / "contact-sheet.png")
report = {"status": "passed", "pages": len(reader.pages), "sizes": sizes,
          "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
          "renderedPages": rendered_pages, "contactSheet": "contact-sheet.png",
          "fonts": font_reports, "outsidePaper": outside,
          "required": expected["required"], "outline": str(reader.outline),
          "scope": "Independent text/font/bounds checks and PDFium raster; visual review is separate"}
(output / "inspection.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"status": "passed", "pages": len(reader.pages), "output": str(output)}, ensure_ascii=False))
