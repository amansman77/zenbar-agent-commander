FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir .
ENV ZENBAR_APP_SERVER_MANAGED=false
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD python -c "import os,urllib.request; r=urllib.request.Request('http://127.0.0.1:8000/projects',headers={'X-Zenbar-Token':os.getenv('ZENBAR_API_TOKEN','')}); urllib.request.urlopen(r,timeout=3)" || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
