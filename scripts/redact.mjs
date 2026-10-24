import { redact, MAX_CHARACTERS } from '../src/index.mjs';
// Stdin only: avoid placing credentials in shell history or process arguments.
try {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const part of process.stdin) {
    text += part;
    if (text.length > MAX_CHARACTERS) throw new Error();
  }
  process.stdout.write(redact(text).text);
} catch {
  process.stderr.write('CkretGuard could not scan the input. No input was printed.\n');
  process.exitCode = 2;
}
