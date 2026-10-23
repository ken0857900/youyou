"""Independent PathFinder retrieval tools. All service configuration is lazy."""
from .config import Config
from .clients import Models, ServiceError
from .storage import (connection as db_connection, fetchone, check_quotes, DatabaseError,
                      StaleIndexError)
from .indexing import prepare, index as _index_article, write_prepared, PreparedIndex
from .situation import parse
from .retrieval import run


def parse_situation(query):
    models = Models(Config.load())
    return {**parse(query, models), 'api_calls': models.calls}


def prepare_index(article, decision_points):
    """Input IDs must match the IDs subsequently written into the database."""
    return prepare(article, decision_points, Models(Config.load()))


def save_index(prepared: PreparedIndex, connection):
    """Persist a prepared index in the caller's transaction; does not commit it."""
    return write_prepared(prepared, connection, Config.load())


def index_article(article_id, connection=None):
    return _index_article(article_id, Models(Config.load()), connection)


def index(article_id, connection=None):
    """Public alias for index_article; never commits a caller-owned transaction."""
    return index_article(article_id, connection)


def search(query, filters=None, top_k=30, on_step=None):
    return run(query, Models(Config.load()), filters, top_k, on_step)


def verify_quotes(article_id, quotes, connection=None):
    if not isinstance(quotes, list):
        raise ValueError('quotes must be a list')
    with db_connection(Config.load(), connection) as conn:
        row = fetchone(conn, 'SELECT content FROM articles WHERE id=%s', (article_id,))
    if not row:
        return [{'quote': q, 'valid': False, 'reason': 'article_not_found', 'start': None, 'end': None} for q in quotes]
    return [{'article_id': article_id, **r} for r in check_quotes(row['content'], quotes)]


__all__ = ['parse_situation', 'prepare_index', 'save_index', 'index_article', 'search', 'verify_quotes',
           'index', 'PreparedIndex', 'ServiceError', 'DatabaseError', 'StaleIndexError']
