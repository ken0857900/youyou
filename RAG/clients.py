import math
import time
import httpx


class ServiceError(RuntimeError):
    """Sanitized model-service error; never includes request/response bodies."""


class Models:
    def __init__(self, config):
        self.config = config
        self.calls = 0

    def request(self, url, key, body):
        if not key:
            raise ServiceError('model API key is not configured')
        for attempt in range(3):
            try:
                self.calls += 1
                r = httpx.post(url, headers={'Authorization': f'Bearer {key}'}, json=body, timeout=self.config.timeout)
                if r.status_code in (429, 502, 503, 504) and attempt < 2:
                    time.sleep(0.25 * 2 ** attempt)
                    continue
                r.raise_for_status()
                return r.json()
            except (httpx.HTTPError, ValueError) as error:
                if attempt == 2:
                    status = getattr(getattr(error, 'response', None), 'status_code', None)
                    reason = f'HTTP_{status}' if status is not None else type(error).__name__
                    raise ServiceError(f'model service request failed: {reason}') from None
        raise ServiceError('model service request failed')

    def embed(self, texts):
        vectors = []
        for start in range(0, len(texts), 16):
            batch = texts[start:start + 16]
            try:
                out = self.request(self.config.base_url + '/embeddings', self.config.api_key,
                                   {'model': self.config.embedding_model, 'input': batch})
                rows = sorted(out['data'], key=lambda d: d['index'])
                if [d['index'] for d in rows] != list(range(len(batch))):
                    raise ValueError()
                for row in rows:
                    v = row['embedding']
                    if len(v) != 1024 or not all(isinstance(x, (float, int)) and math.isfinite(x) for x in v) or not any(v):
                        raise ValueError()
                    vectors.append(v)
            except (KeyError, TypeError, ValueError):
                raise ServiceError('invalid embedding response') from None
        return vectors

    def rerank(self, query, texts):
        try:
            out = self.request(self.config.base_url + '/rerank', self.config.api_key,
                               {'model': self.config.rerank_model, 'query': query, 'documents': texts,
                                'top_n': len(texts), 'return_documents': False})
            rows = out['results']
            if sorted(r['index'] for r in rows) != list(range(len(texts))):
                raise ValueError()
            scores = {r['index']: float(r['relevance_score']) for r in rows}
            if not all(math.isfinite(s) for s in scores.values()):
                raise ValueError()
            return scores
        except (KeyError, TypeError, ValueError):
            raise ServiceError('invalid reranker response') from None
