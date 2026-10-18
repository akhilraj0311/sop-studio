FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8080
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Cloud Run sends traffic to $PORT
CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 2 --timeout-keep-alive 75
