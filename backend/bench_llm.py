"""测 LLM 速度：网络来回、最短回答、一次真的 multi-agent 搜索。用法（仓库根目录）：
backend\\.venv\\Scripts\\python backend\\bench_llm.py
"""
import os
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / '.env')
key, base, model = os.getenv('LLM_API_KEY'), os.getenv('LLM_BASE_URL'), os.getenv('LLM_MODEL')
H = {'Authorization': f'Bearer {key}'}
body = {'model': model, 'messages': [{'role': 'user', 'content': '回一个字：好'}]}
if os.getenv('LLM_THINKING') == 'disabled':
    body['thinking'] = {'type': 'disabled'}

for i in range(3):
    t = time.time()
    r = httpx.get(base + '/models', headers=H, timeout=15)
    print(f'网络来回 {i + 1}: {r.status_code} {round((time.time() - t) * 1000)} ms')

t = time.time()
r = httpx.post(base + '/chat/completions', headers=H, json=body, timeout=60)
print(f'最短回答: {r.status_code} {round(time.time() - t, 1)} s')

t = time.time()
try:
    d = httpx.get('http://localhost:8000/api/search', params={'q': '双非考研'}, timeout=240).json()
    print(f"搜索「双非考研」: {round(time.time() - t, 1)} s  source={d.get('source')} fallback={d.get('fallback')} 调用={d.get('llmCalls')}")
    for s in d.get('steps', []):
        print('  ', s.get('label'), '|', str(s.get('detail'))[:60], '|', s.get('ms'), 'ms')
except httpx.HTTPError as e:
    print('搜索失败（后端没开？）', type(e).__name__)
