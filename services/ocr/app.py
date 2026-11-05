from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse
from PIL import Image
import pytesseract
from io import BytesIO
import base64
import logging
import os
from typing import Optional

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="OCR Service", version="1.0.0")

ALLOWED_MIME_TYPES = {
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/tiff",
    "image/tif",
    "image/bmp",
    "image/webp",
}

@app.get("/healthz")
async def healthz():
    try:
        version = pytesseract.get_tesseract_version()
        return {"status": "ok", "tesseract_version": str(version)}
    except Exception as e:
        logger.error(f"Tesseract not available: {e}")
        return JSONResponse(
            status_code=503,
            content={"status": "unavailable", "error": "Tesseract OCR not installed or not in PATH"}
        )

@app.post("/ocr")
async def extract_text(
    file: UploadFile = File(...),
    lang: Optional[str] = "eng",
    psm: Optional[int] = 3,
):
    if file.content_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported media type: {file.content_type}. Allowed: {', '.join(ALLOWED_MIME_TYPES)}"
        )
    
    try:
        contents = await file.read()
        if len(contents) > 15 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="File too large. Max 15MB")
        
        image = Image.open(BytesIO(contents))
        
        custom_config = f'--oem 3 --psm {psm}'
        text = pytesseract.image_to_string(image, lang=lang, config=custom_config)
        
        data = pytesseract.image_to_data(image, lang=lang, config=custom_config, output_type=pytesseract.Output.DICT)
        
        blocks = []
        current_block = {
            "page_number": 1,
            "block_index": 0,
            "block_type": "text",
            "content_md": "",
            "bbox": None,
            "confidence": None,
            "words": []
        }
        
        for i in range(len(data['text'])):
            word = data['text'][i].strip()
            if not word:
                continue
            
            conf = int(data['conf'][i])
            if conf == -1:
                continue
            
            x, y, w, h = data['left'][i], data['top'][i], data['width'][i], data['height'][i]
            
            current_block["words"].append({
                "text": word,
                "confidence": conf,
                "bbox": [x, y, x + w, y + h]
            })
            
            if current_block["bbox"] is None:
                current_block["bbox"] = [x, y, x + w, y + h]
            else:
                current_block["bbox"][0] = min(current_block["bbox"][0], x)
                current_block["bbox"][1] = min(current_block["bbox"][1], y)
                current_block["bbox"][2] = max(current_block["bbox"][2], x + w)
                current_block["bbox"][3] = max(current_block["bbox"][3], y + h)
            
            current_block["content_md"] += word + " "
        
        if current_block["content_md"].strip():
            current_block["content_md"] = current_block["content_md"].strip()
            if current_block["words"]:
                avg_conf = sum(w["confidence"] for w in current_block["words"]) / len(current_block["words"])
                current_block["confidence"] = round(avg_conf / 100.0, 3)
            blocks.append(current_block)
        
        if not blocks:
            blocks.append({
                "page_number": 1,
                "block_index": 0,
                "block_type": "other",
                "content_md": "",
                "bbox": None,
                "confidence": None,
                "words": []
            })
        
        overall_confidence = None
        if blocks and blocks[0].get("confidence") is not None:
            overall_confidence = blocks[0]["confidence"]
        
        return {
            "text": text.strip(),
            "blocks": blocks,
            "confidence": overall_confidence,
            "parser": "tesseract",
            "parser_version": str(pytesseract.get_tesseract_version()),
            "language": lang,
            "psm": psm,
        }
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"OCR processing failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"OCR processing failed: {str(e)}")

@app.post("/ocr/base64")
async def extract_text_base64(
    payload: dict,
    lang: Optional[str] = "eng",
    psm: Optional[int] = 3,
):
    if "data" not in payload:
        raise HTTPException(status_code=400, detail="Missing 'data' field in payload")
    
    try:
        image_data = base64.b64decode(payload["data"])
        image = Image.open(BytesIO(image_data))
        
        custom_config = f'--oem 3 --psm {psm}'
        text = pytesseract.image_to_string(image, lang=lang, config=custom_config)
        
        data = pytesseract.image_to_data(image, lang=lang, config=custom_config, output_type=pytesseract.Output.DICT)
        
        blocks = []
        current_block = {
            "page_number": 1,
            "block_index": 0,
            "block_type": "text",
            "content_md": "",
            "bbox": None,
            "confidence": None,
            "words": []
        }
        
        for i in range(len(data['text'])):
            word = data['text'][i].strip()
            if not word:
                continue
            
            conf = int(data['conf'][i])
            if conf == -1:
                continue
            
            x, y, w, h = data['left'][i], data['top'][i], data['width'][i], data['height'][i]
            
            current_block["words"].append({
                "text": word,
                "confidence": conf,
                "bbox": [x, y, x + w, y + h]
            })
            
            if current_block["bbox"] is None:
                current_block["bbox"] = [x, y, x + w, y + h]
            else:
                current_block["bbox"][0] = min(current_block["bbox"][0], x)
                current_block["bbox"][1] = min(current_block["bbox"][1], y)
                current_block["bbox"][2] = max(current_block["bbox"][2], x + w)
                current_block["bbox"][3] = max(current_block["bbox"][3], y + h)
            
            current_block["content_md"] += word + " "
        
        if current_block["content_md"].strip():
            current_block["content_md"] = current_block["content_md"].strip()
            if current_block["words"]:
                avg_conf = sum(w["confidence"] for w in current_block["words"]) / len(current_block["words"])
                current_block["confidence"] = round(avg_conf / 100.0, 3)
            blocks.append(current_block)
        
        if not blocks:
            blocks.append({
                "page_number": 1,
                "block_index": 0,
                "block_type": "other",
                "content_md": "",
                "bbox": None,
                "confidence": None,
                "words": []
            })
        
        overall_confidence = None
        if blocks and blocks[0].get("confidence") is not None:
            overall_confidence = blocks[0]["confidence"]
        
        return {
            "text": text.strip(),
            "blocks": blocks,
            "confidence": overall_confidence,
            "parser": "tesseract",
            "parser_version": str(pytesseract.get_tesseract_version()),
            "language": lang,
            "psm": psm,
        }
    
    except Exception as e:
        logger.error(f"OCR processing failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"OCR processing failed: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("OCR_PORT", "8091"))
    uvicorn.run(app, host="0.0.0.0", port=port)
