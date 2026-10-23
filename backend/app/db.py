import os
from pathlib import Path

import psycopg
from dotenv import load_dotenv
from psycopg.rows import dict_row

load_dotenv(Path(__file__).resolve().parents[2] / '.env')  # 仓库根目录的 .env
DATABASE_URL = os.getenv('DATABASE_URL', 'postgresql://pathfinder:pathfinder@localhost:5432/pathfinder')
# Windows 上 localhost 先试 IPv6（::1），Docker 没听 → 每条连接白等 3 秒超时才走 IPv4，直接写死 IPv4
DATABASE_URL = DATABASE_URL.replace('@localhost:', '@127.0.0.1:')


# ponytail: 每次请求开一条连接，流量大了换 psycopg_pool
def connect():
    return psycopg.connect(DATABASE_URL, row_factory=dict_row, connect_timeout=3)


def query(sql, params=None):
    with connect() as conn:
        return conn.execute(sql, params).fetchall()


def one(sql, params=None):
    rows = query(sql, params)
    return rows[0] if rows else None
