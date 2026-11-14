#!/usr/bin/env node
// RAG quality evaluation over the golden set (citation precision, Recall@10, correct
// abstention, fabricated chunk ids). The golden set and the pipeline it measures are
// built in Phase 3; until then this command fails on purpose rather than report a
// made-up score.
process.stderr.write(
  'pnpm eval is not available yet: the golden set and the RAG pipeline are delivered in Phase 3.\n',
);
process.exit(1);
