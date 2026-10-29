"""CRUM document parse sidecar: Docling over HTTP.

Accepts a file upload, returns the structured block intermediate the 0011
schema stores: per-page blocks with type, Markdown content, and a normalized
top-left bbox. Deliberately fail-soft on docling API drift: every per-item
extraction is guarded, and the client (src/mastra/docling.ts) falls back to
the in-process parsers on any error here.

Model artifacts are downloaded by docling on first conversion (~hundreds of
MB), so the first /convert after a cold start is slow; /healthz answers
immediately.
"""

import os
import tempfile
from importlib.metadata import version as pkg_version

from fastapi import FastAPI, File, HTTPException, UploadFile
from docling.document_converter import DocumentConverter

app = FastAPI(title="crum-docling-sidecar")

_converter: DocumentConverter | None = None

# docling item class name -> document_blocks.block_type (migration 0011 CHECK).
BLOCK_TYPE_MAP = {
    "TableItem": "table",
    "SectionHeaderItem": "section_header",
    "TitleItem": "title",
    "ListItem": "list_item",
    "PictureItem": "figure",
    "CodeItem": "text",
    "FormulaItem": "text",
    "TextItem": "text",
    "CaptionItem": "other",
}


def converter() -> DocumentConverter:
    global _converter
    if _converter is None:
        _converter = DocumentConverter()
    return _converter


def parser_version() -> str:
    try:
        return pkg_version("docling")
    except Exception:
        return ""


def _bbox(item, doc):
    """(page_no, [x0,y0,x1,y1] normalized top-left origin) best-effort."""
    prov = getattr(item, "prov", None)
    if not prov:
        return 1, None
    src = prov[0]
    page_no = getattr(src, "page_no", 1) or 1
    bbox = getattr(src, "bbox", None)
    if bbox is None:
        return int(page_no), None
    try:
        page = doc.pages.get(page_no)
        size = getattr(page, "size", None) if page is not None else None
        width = float(getattr(size, "width", 0) or 0)
        height = float(getattr(size, "height", 0) or 0)
        if width <= 0 or height <= 0:
            return int(page_no), None
        # docling uses a bottom-left origin: t is the bottom, b the top edge.
        x0 = max(0.0, min(1.0, float(bbox.l) / width))
        x1 = max(0.0, min(1.0, float(bbox.r) / width))
        y0 = max(0.0, min(1.0, 1.0 - float(bbox.b) / height))
        y1 = max(0.0, min(1.0, 1.0 - float(bbox.t) / height))
        return int(page_no), [round(x0, 4), round(y0, 4), round(x1, 4), round(y1, 4)]
    except Exception:
        return int(page_no), None


def _content(item, doc) -> str:
    if type(item).__name__ == "TableItem":
        # export_to_markdown's signature moved across docling versions.
        for kwargs in ({}, {"doc": doc}):
            try:
                md = item.export_to_markdown(**kwargs)
            except TypeError:
                continue
            except Exception:
                break
            if isinstance(md, str) and md.strip():
                return md
        return ""
    text = getattr(item, "text", None)
    if isinstance(text, str):
        return text
    caption = getattr(item, "caption_text", None)
    if isinstance(caption, str):
        return caption
    return ""


def _items(doc):
    try:
        return list(doc.iterate_items(with_groups=False))
    except TypeError:
        return list(doc.iterate_items())


@app.get("/healthz")
def healthz():
    return {"ok": True, "parser_version": parser_version()}


@app.post("/convert")
async def convert(file: UploadFile = File(...)):
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty upload")

    suffix = os.path.splitext(file.filename or "")[1] or ".pdf"
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, f"input{suffix}")
        with open(path, "wb") as fh:
            fh.write(data)
        try:
            result = converter().convert(path)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"conversion failed: {exc}")

    doc = result.document
    blocks: list[dict] = []
    per_page_index: dict[int, int] = {}
    for item, _level in _items(doc):
        content = _content(item, doc).strip()
        if not content:
            continue
        page_no, bbox = _bbox(item, doc)
        idx = per_page_index.get(page_no, 0)
        per_page_index[page_no] = idx + 1
        blocks.append(
            {
                "page_number": page_no,
                "block_index": idx,
                "block_type": BLOCK_TYPE_MAP.get(type(item).__name__, "other"),
                "content_md": content,
                "bbox": bbox,
                "confidence": None,
            }
        )

    if not blocks:
        raise HTTPException(status_code=422, detail="no text-bearing blocks")

    page_count = max(b["page_number"] for b in blocks)
    return {"parser_version": parser_version(), "page_count": page_count, "blocks": blocks}
