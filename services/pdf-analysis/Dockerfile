FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PDF_ANALYSIS_HOST=0.0.0.0 \
    PDF_ANALYSIS_PORT=8091 \
    PDF_ANALYSIS_MODEL_DIR=/models \
    OMP_NUM_THREADS=4 \
    MKL_NUM_THREADS=4
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 libglib2.0-0 libgl1 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY pdf_analysis ./pdf_analysis
COPY prepare.py start.py ./
COPY model-manifest.lock.json ./
EXPOSE 8091
CMD ["python", "start.py"]
