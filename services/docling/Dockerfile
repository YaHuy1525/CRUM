# CRUM document parse sidecar (Docling). Heavy image: docling pulls torch +
# model code. Started only via `docker compose --profile parse up`, so the
# default stack never pays for it.
FROM python:3.12-slim
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
EXPOSE 8090
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8090"]
