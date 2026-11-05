# Phase 2 Implementation: Enhanced OCR & Layout Understanding

## Summary

Successfully implemented standalone OCR service for image-based documents, extending CRUM's document processing capabilities to match Sola.ai's layout-aware extraction approach.

## Changes Made

### 1. OCR Service (`services/ocr/`)

**Python FastAPI Sidecar** (`app.py`):
- Tesseract OCR integration with configurable language and PSM modes
- Two endpoints:
  - `POST /ocr` - multipart file upload
  - `POST /ocr/base64` - base64-encoded image data
- Returns structured blocks with:
  - Word-level bounding boxes
  - Per-word confidence scores
  - Block-level aggregated confidence
  - Full extracted text
- Supports: PNG, JPEG, TIFF, BMP, WebP
- Max file size: 15MB
- Health check endpoint: `GET /healthz`

**Docker Configuration**:
- `Dockerfile` - Python 3.12-slim with Tesseract OCR
- `requirements.txt` - FastAPI, pytesseract, Pillow
- Pre-installed: `tesseract-ocr`, `tesseract-ocr-eng`

### 2. TypeScript OCR Client (`src/mastra/ocr.ts`)

**Core Functions**:
- `convertWithOcr()` - multipart upload to OCR service
- `convertBase64WithOcr()` - base64 upload alternative
- `ocrBlocksToText()` - join blocks into plain text
- `computeOcrConfidence()` - average confidence across blocks

**Type Definitions**:
- `OcrDocumentBlock` - structured block with bbox and confidence
- `OcrWord` - word-level data with position and confidence
- `OcrResult` - complete OCR response
- `OcrUnavailable` - error class for service unavailability

**Block Types**: Matches Docling vocabulary (header, footer, title, section_header, page_number, list_item, figure, table, key_value, text, comment, signature, other)

### 3. Document Intake Workflow Updates (`src/mastra/workflows/document-intake.ts`)

**Enhanced parseBinaryStep**:
- Added OCR fallback path for image documents
- Priority chain: Docling → OCR (Tesseract) → plain text
- Image detection: MIME type or file extension (.png, .jpg, .jpeg, .tiff, .tif, .bmp, .webp)
- Converts OCR blocks to DocumentBlock format
- Records parser metadata (language, PSM mode)

**Type Updates**:
- Extended `ParseRun.parser` enum to include `'tesseract'`
- Updated Zod schema: `z.enum(['docling', 'unpdf', 'mammoth', 'plain', 'tesseract'])`

### 4. Environment Configuration (`src/config/env.ts`)

**New Variable**:
```typescript
OCR_URL: optionalString
```
- Unset or unreachable: image intake falls back to plain text path
- Works alongside or instead of Docling
- Example: `OCR_URL=http://localhost:8091`

### 5. Docker Compose Updates (`docker-compose.yml`)

**New Service**:
```yaml
ocr:
  profiles: ["ocr"]
  build:
    context: ./services/ocr
    dockerfile: Dockerfile
  restart: unless-stopped
```

**API Service Updates**:
- Added `OCR_URL` environment variable
- Profile-based activation: `docker compose --profile ocr up`

## Architecture

```
Image Upload → Document Intake Workflow
                    ↓
              Is Docling available?
              ├─ YES → Docling (layout + tables + bboxes)
              └─ NO  → Is OCR_URL set?
                       ├─ YES → OCR Service (Tesseract)
                       └─ NO  → Plain text fallback
```

## API Contract

### OCR Service Response

```json
{
  "text": "Extracted full text...",
  "blocks": [
    {
      "page_number": 1,
      "block_index": 0,
      "block_type": "text",
      "content_md": "Block content...",
      "bbox": [x0, y0, x1, y1],
      "confidence": 0.95,
      "words": [
        {
          "text": "word",
          "confidence": 95,
          "bbox": [x, y, x+w, y+h]
        }
      ]
    }
  ],
  "confidence": 0.95,
  "parser": "tesseract",
  "parser_version": "5.3.0",
  "language": "eng",
  "psm": 3
}
```

## Configuration

### Required Environment Variables
```bash
OCR_URL=http://localhost:8091  # OCR service URL
```

### OCR Service Configuration
- **Port**: 8091 (configurable via `OCR_PORT` env var)
- **Language**: `eng` (default, configurable via `lang` query param)
- **PSM Mode**: 3 (default, configurable via `psm` query param)
  - 3 = Fully automatic page segmentation with OSD
  - See Tesseract documentation for other modes

### Docker Compose Profiles
```bash
# Start with OCR service
docker compose --profile ocr up

# Start with both Docling and OCR
docker compose --profile parse --profile ocr up

# Start all optional services
docker compose --profile parse --profile ocr up --build
```

## Testing

### Manual Testing

1. **Start OCR service**:
```bash
cd services/ocr
docker build -t crum-ocr .
docker run -p 8091:8091 crum-ocr
```

2. **Test health check**:
```bash
curl http://localhost:8091/healthz
```

3. **Test OCR endpoint**:
```bash
curl -X POST http://localhost:8091/ocr \
  -F "file=@test-image.png" \
  -F "lang=eng" \
  -F "psm=3"
```

4. **Test document upload**:
```bash
curl -X POST http://localhost:4113/api/documents/upload \
  -H "x-tenant-id: 00000000-0000-4000-8000-000000000001" \
  -H "x-user-id: 00000000-0000-4000-8000-000000000002" \
  -F "file=@receipt.png"
```

### Automated Testing

Future: Add integration tests in `tests/` directory:
- Test image upload with OCR
- Test fallback chain (Docling → OCR → plain)
- Test confidence scoring
- Test multi-language OCR

## Performance Characteristics

**OCR Service**:
- Cold start: ~2-3 seconds (Tesseract initialization)
- Per-image processing: 1-5 seconds (depends on image size and complexity)
- Memory usage: ~200-300 MB (Tesseract models)
- Concurrent requests: Limited by Tesseract's single-threaded nature

**Optimization Opportunities**:
- Add request queue for burst handling
- Implement image preprocessing (deskew, denoise)
- Cache results for identical images (content hash)
- Use GPU-accelerated OCR (CUDA-based Tesseract)

## Comparison with Sola.ai

| Feature | Sola.ai | CRUM Phase 2 |
|---------|---------|--------------|
| Layout-aware parsing | ✓ (Computer Vision) | ✓ (Docling + Tesseract) |
| Standalone OCR | ✓ | ✓ (Tesseract) |
| Multi-format support | ✓ | ✓ (PDF, DOCX, images) |
| Confidence scoring | ✓ | ✓ (word + block level) |
| Bounding boxes | ✓ | ✓ (word + block level) |
| Self-healing | ✓ (AI-adaptive) | ✗ (static fallback chain) |
| Cloud OCR integration | ✓ | △ (architecture ready) |

## Next Steps

**Phase 3: Self-Healing Layout Adaptation**
- Implement layout clustering
- Add confidence-based retry logic
- Build layout fingerprint database
- Enable adaptive schema selection

**Phase 4: Cloud OCR Integration**
- Add AWS Textract adapter
- Add Azure Document Intelligence adapter
- Implement automatic provider selection based on document type
- Add cost tracking and rate limiting

## Migration Notes

**Breaking Changes**: None. OCR is an optional enhancement.

**Backward Compatibility**: Full. Existing document processing works without OCR service.

**Dependencies**:
- Python 3.12+ (for OCR service)
- Tesseract OCR 5.x (installed in Docker image)
- No changes to existing Node.js dependencies

**Database**: No schema changes required.

## Known Limitations

1. **Single-threaded OCR**: Tesseract processes one image at a time
2. **Language support**: Only English pre-installed (add language packs as needed)
3. **Handwriting recognition**: Not supported (Tesseract OCR, not ICR/HTR)
4. **Table extraction**: Basic (Docling is better for complex tables)
5. **Image quality**: Requires reasonably clear images (no advanced preprocessing)

## Troubleshooting

**OCR service not starting**:
- Check Tesseract installation: `tesseract --version`
- Verify Python dependencies: `pip install -r requirements.txt`
- Check port availability: `lsof -i :8091`

**Low confidence scores**:
- Adjust PSM mode (try 6 for uniform block of text)
- Preprocess images (increase contrast, deskew)
- Ensure adequate image resolution (300 DPI minimum)

**Fallback to plain text**:
- Verify `OCR_URL` is set in environment
- Check OCR service health: `curl http://localhost:8091/healthz`
- Review API server logs for connection errors
