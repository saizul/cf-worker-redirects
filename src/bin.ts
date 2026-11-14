#!/usr/bin/env node
import { run } from "./cli.js";

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${(err as Error)?.stack ?? String(err)}\n`);
    process.exit(1);
  },
);
