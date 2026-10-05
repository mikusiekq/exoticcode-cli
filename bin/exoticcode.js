#!/usr/bin/env node
import { maybeUpdate } from '../src/update.js';

const args = process.argv.slice(2);

// najpierw ewentualna aktualizacja z GitHuba — dopiero potem ładujemy resztę programu
if (!(await maybeUpdate(args))) {
  const { main } = await import('../src/repl.js');
  main(args).catch((err) => {
    console.error(`\n✖ ${err?.message || err}`);
    process.exit(1);
  });
}
