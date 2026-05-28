// Wrap a Python script so it runs on the remote without shell-quoting issues:
// base64-encode locally, decode + pipe to python3 remotely. The base64 alphabet
// contains no shell metacharacters, so it's safe inside single quotes.
export function pyCommand(script: string): string {
  const b64 = Buffer.from(script, 'utf-8').toString('base64');
  return `echo '${b64}' | base64 -d | python3 -`;
}
