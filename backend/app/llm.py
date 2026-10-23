"""LLM 薄客户端（现用 DeepSeek）（OpenAI 兼容）＋从 docs/07_提示詞.md 读提示词（07 是唯一来源，改提示词改那份）。
没填 LLM_API_KEY → LLMUnavailable，调用方各自走退路。"""
import json
import os
import re
import threading
import time
from pathlib import Path

import httpx
from pydantic import BaseModel, ValidationError

from . import db  # noqa: F401  确保仓库根 .env 已载入

PROMPT_FILE = Path(__file__).resolve().parents[2] / 'docs' / '07_提示詞.md'
TIMEOUT = int(os.getenv('LLM_TIMEOUT', '30'))  # 单次请求秒数
_sem = threading.Semaphore(int(os.getenv('LLM_CONCURRENCY', '2')))  # 同时最多几个请求


class LLMUnavailable(Exception):
    pass


def _prompts():
    # 07 里按顺序的 11 个 ``` 代码块：抽取、处境、判断、审查、退路、邀请分享者、日历助手、保鲜度三段、列表推荐理由
    blocks = re.findall(r'```\n(.*?)```', PROMPT_FILE.read_text(encoding='utf-8'), re.S)
    return dict(zip(['extract', 'situation', 'judge', 'review', 'fallback', 'invite', 'calendar', 'claims', 'rules', 'fresh_judge', 'list_why'], blocks))


PROMPTS = _prompts()


def fill(name, **kw):
    # 提示词里有 JSON 大括号，不能用 str.format
    text = PROMPTS[name]
    for k, v in kw.items():
        text = text.replace('{' + k + '}', v if isinstance(v, str) else json.dumps(v, ensure_ascii=False))
    return text


def available():
    return bool(os.getenv('LLM_API_KEY'))


# ponytail: 全局累计请求数，搜索前后相减得本次次数；同时多人搜索会混算，要精确再改成按请求传计数器
CALLS = [0]
_lock = threading.Lock()


def chat(messages, tools=None, temperature=None):
    """一次请求，回 assistant message（dict）。测试 monkeypatch 这个函数。"""
    key = os.getenv('LLM_API_KEY')
    if not key:
        raise LLMUnavailable('LLM_API_KEY 没填')
    body = {'model': os.getenv('LLM_MODEL', 'deepseek-flash'), 'messages': messages,
            'response_format': {'type': 'json_object'}}
    if os.getenv('LLM_THINKING') == 'disabled':  # deepseek-flash 预设开思考，不关会慢 5–10 倍
        body['thinking'] = {'type': 'disabled'}
    if tools:
        body['tools'] = tools
    if temperature is not None and body['model'].startswith('deepseek'):  # 换别家模型不一定接受 temperature，只对 DeepSeek 传
        body['temperature'] = temperature
    with _lock:
        CALLS[0] += 1
    url = os.getenv('LLM_BASE_URL', 'https://api.deepseek.com').rstrip('/') + '/chat/completions'
    for attempt in range(4):  # 429（请求太频繁）指数退避重试：1s、2s、4s
        try:
            with _sem:  # 限制同时请求数，新账号并发上限低
                r = httpx.post(url, headers={'Authorization': f'Bearer {key}'}, json=body, timeout=TIMEOUT)
            if r.status_code == 429 and attempt < 3:
                time.sleep(2 ** attempt)
                continue
            r.raise_for_status()
            break
        except httpx.HTTPError as e:  # 不把 key 带进错误信息
            code = getattr(getattr(e, 'response', None), 'status_code', '')  # 402 = 余额不足
            raise LLMUnavailable(f'LLM 请求失败：{type(e).__name__} {code}') from None
    return r.json()['choices'][0]['message']


def parse(content, model: type[BaseModel]):
    return model.model_validate(json.loads(content or ''))


def ask(messages, model: type[BaseModel], msg=None, temperature=None):
    """JSON 模式问一次（或验已拿到的 msg），pydantic 验不过就带上错误重来一次；再不过抛 ValueError。
    temperature：抽取类要稳定的传 0（同一句每次结果一样）；None＝模型默认。"""
    t = {} if temperature is None else {'temperature': temperature}
    msg = msg or chat(messages, **t)
    try:
        return parse(msg.get('content'), model)
    except (ValueError, ValidationError) as e:
        retry = [*messages, {'role': 'assistant', 'content': msg.get('content') or ''},
                 {'role': 'user', 'content': f'输出格式不对（{str(e)[:300]}），请只输出符合要求的 JSON。'}]
        return parse(chat(retry, **t).get('content'), model)
