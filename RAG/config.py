"""Configuration is loaded lazily; importing RAG never connects to a service."""
import os
import json
import math
from pathlib import Path
from dataclasses import dataclass
from dotenv import load_dotenv


@dataclass
class Config:
    database_url: str
    api_key: str
    base_url: str
    embedding_model: str
    rerank_model: str
    llm_key: str
    llm_url: str
    llm_model: str
    timeout: float
    threshold: float | None
    chunk_version: str = 'decision-v1'

    @classmethod
    def load(cls):
        load_dotenv(Path(__file__).resolve().parents[1] / '.env')
        threshold = os.getenv('RAG_RELEVANCE_THRESHOLD')
        config = cls(os.getenv('DATABASE_URL', 'postgresql://pathfinder:pathfinder@127.0.0.1:5432/pathfinder'),
                   os.getenv('SILICONFLOW_API_KEY', ''), os.getenv('SILICONFLOW_BASE_URL', 'https://api.siliconflow.cn/v1').rstrip('/'),
                   os.getenv('EMBEDDING_MODEL', 'BAAI/bge-m3'), os.getenv('RERANK_MODEL', 'BAAI/bge-reranker-v2-m3'),
                   os.getenv('LLM_API_KEY', ''), os.getenv('LLM_BASE_URL', 'https://api.deepseek.com').rstrip('/'),
                   os.getenv('LLM_MODEL', 'deepseek-chat'), float(os.getenv('RAG_TIMEOUT', '12')),
                   float(threshold) if threshold else None, os.getenv('RAG_CHUNK_VERSION', 'decision-v1'))
        calibration_path = os.getenv('RAG_CALIBRATION_FILE')
        if calibration_path and threshold is None:
            calibration = json.loads(Path(calibration_path).read_text())
            if any(calibration.get(k) != getattr(config, k) for k in ('embedding_model', 'rerank_model', 'chunk_version')):
                raise ValueError('calibration model/version does not match active configuration')
            config.threshold = float(calibration['threshold'])
        if config.timeout <= 0 or not math.isfinite(config.timeout):
            raise ValueError('RAG_TIMEOUT must be finite and positive')
        if config.threshold is not None and not math.isfinite(config.threshold):
            raise ValueError('relevance threshold must be finite')
        return config
