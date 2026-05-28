#!/usr/bin/env node
import { render } from 'ink';
import { App } from './components/App.js';
import { loadConfig, getConfigPath } from './config.js';

// Enter the alternate screen buffer so the TUI gets its own screen — mouse
// wheel no longer scrolls the terminal's scrollback through the dashboard,
// and on exit the user's previous shell content is restored cleanly.
const ENTER_ALT_SCREEN = '\x1b[?1049h';
const EXIT_ALT_SCREEN = '\x1b[?1049l';

async function main() {
  const config = await loadConfig();
  if (config.servers.length === 0) {
    console.error(`No servers configured. Edit ${getConfigPath()} and add at least one server.`);
    process.exit(1);
  }

  process.stdout.write(ENTER_ALT_SCREEN);
  process.once('exit', () => process.stdout.write(EXIT_ALT_SCREEN));

  const { waitUntilExit } = render(<App config={config} />);
  await waitUntilExit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
