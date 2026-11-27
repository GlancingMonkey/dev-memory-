"""Verify the proposed TEXT[] DB contract in a disposable DB, not the user's DB.

uv run --locked python - --apply < tests/manual_study_concept_check.py
The ALTER TABLE below is a test fixture only; DB migrations belong to DB owner.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import uuid
from unittest.mock import patch

from fastapi.testclient import TestClient
import psycopg
from psycopg import sql

from backend import database
from backend.main import app


def snapshot(connection):
    with connection.transaction():
        connection.execute("SET TRANSACTION READ ONLY")
        rows = connection.execute("SELECT to_jsonb(s) FROM public.snippets s ORDER BY id").fetchall()
    return len(rows), hashlib.sha256(json.dumps(rows,sort_keys=True).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply",action="store_true")
    if not parser.parse_args().apply:
        print("No DB changes. Use --apply for a new disposable test database.")
        return 0
    admin = database.connect_db()
    admin.autocommit = True
    before = snapshot(admin)
    name = "study_concept_check_" + uuid.uuid4().hex
    dsn = os.environ["DATABASE_URL"]
    created = False
    try:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
        created = True
        def connect():
            return psycopg.connect(dsn,dbname=name,connect_timeout=5)
        with connect() as connection:
            connection.execute(Path("database/init.sql").read_text())
            connection.execute("ALTER TABLE public.snippets ADD COLUMN concepts TEXT[] NOT NULL DEFAULT '{}'")
        vector = [1.0]+[0.0]*767
        base = {"project_name":"study-alpha","file_path":"a.py","language":"python",
                "function_name":"add","start_line":1,"end_line":2,"code":"def add(a,b):\n    return a+b"}
        with patch("backend.database.connect_db",side_effect=connect),patch("backend.main.warmup_model"),\
             patch("backend.routers.snippets.embed_code",return_value=vector),\
             patch("backend.routers.search.embed_query",return_value=vector),TestClient(app) as client:
            ids=[]
            for fields in ({},{"concepts":[" loop ","loop","modulo"]},
                           {"project_name":"study-beta","language":"typescript","concepts":["loop"]}):
                response=client.post("/snippets",json={**base,**fields})
                assert response.status_code==200 and response.json()["embedding_status"]=="ready"
                ids.append(response.json()["id"])
            response=client.get("/search",params={"q":"반복 코드","concept":" loop ","limit":20})
            assert response.status_code==200
            assert [item["id"] for item in response.json()["results"]]==ids[1:]
            response=client.get("/search",params={"q":"코드","concept":"loop","limit":1,"project":"study-alpha","language":"python"})
            assert response.status_code==200 and response.json()["results"][0]["id"]==ids[1]
            assert response.json()["filters"]=={"project":"study-alpha","language":"python","concept":"loop"}
            injection=client.get("/search",params={"q":"코드","concept":"x'); DROP TABLE snippets; --"})
            assert injection.status_code==200 and injection.json()["results"]==[]
            assert client.get("/search",params={"q":"코드","concept":"x"*101}).status_code==422
            with connect() as connection:
                rows=connection.execute("SELECT id,concepts FROM public.snippets ORDER BY id").fetchall()
            assert rows==[(ids[0],[]),(ids[1],["loop","modulo"]),(ids[2],["loop"])]
        print("Real PostgreSQL: old 7 fields + optional concepts stored: OK")
        print("Concept WHERE before Top-K + combined project/language: OK")
        print("SQL-like concept is a value; other rows preserved: OK")
        print("Fixture concept column only; production migration: not applied")
    finally:
        try:
            if created:
                admin.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(name)))
            assert snapshot(admin)==before
            print("Original DB snapshot preserved; disposable DB removed: True")
        finally:
            admin.close()
    return 0


if __name__=="__main__":
    raise SystemExit(main())
