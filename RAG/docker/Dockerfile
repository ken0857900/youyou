# 开发用数据库：PostgreSQL 17 + pgvector（向量）+ zhparser（中文分词全文检索）
# 在每台机器上从源码编译 zhparser，所以 Intel / Apple 芯片都能用
FROM pgvector/pgvector:pg17

# Optional development build: use a Debian mirror; extension sources stay upstream.
RUN sed -i 's|http://deb.debian.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates

RUN sed -i 's|http://apt.postgresql.org|https://apt.postgresql.org|g' /etc/apt/sources.list.d/* \
 && apt-get update \
 && apt-get install -y --no-install-recommends build-essential postgresql-server-dev-17 git wget bzip2 ca-certificates \
 && wget --timeout=30 --tries=2 -q -O - http://www.xunsearch.com/scws/down/scws-1.2.3.tar.bz2 | tar xjf - -C /tmp \
 && cd /tmp/scws-1.2.3 && ./configure && make install \
 && git clone --depth 1 https://github.com/amutu/zhparser.git /tmp/zhparser \
 && cd /tmp/zhparser && make && make install \
 && apt-get purge -y build-essential postgresql-server-dev-17 git wget && apt-get autoremove -y \
 && rm -rf /tmp/* /var/lib/apt/lists/*

COPY init.sql /docker-entrypoint-initdb.d/
COPY zh_dict.sql /docker-entrypoint-initdb.d/zz_zh_dict.sql
