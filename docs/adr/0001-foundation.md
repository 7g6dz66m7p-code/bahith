# ADR-0001 — Modular monolith and evidence-first foundation
Status: accepted for foundation, 2026-11-14.
Choose TypeScript domain contracts, PostgreSQL relational ownership, private object storage and asynchronous workers. Plan Next.js for web/API; do not add a separate API service until measured pressure justifies it. No production services created.
Phase 1 uses Node 24 native TypeScript execution and strict tsc. PGlite executes PostgreSQL migration and RLS tests without requiring a local database server; this is not a substitute for native PostgreSQL, network pool, backup or concurrency tests.
Search starts with PostgreSQL lexical search, then pgvector after bilingual retrieval benchmarks and embedding model selection. No vector dimension is guessed. The initial lexical configuration is simple; Arabic normalization/stemming and hybrid ranking are not implemented.
Agents are typed workflow steps, not eight always-running processes. Models never grant permissions or mark their own findings human-verified.
