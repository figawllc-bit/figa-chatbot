// No file, environment, clipboard, SDK or network access. Intended for a local
// interactive terminal only, never the Codex tool console or a redirected pipe.
export function requireCleanTerminalStartup(execArgv, environmentKeys) {
  if (execArgv.length || environmentKeys.some(key => ['NODE_OPTIONS', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'NODE_V8_COVERAGE'].includes(key.toUpperCase()))) throw new Error('secure_input_unavailable');
}
const activeInputs = new WeakSet();
const limits = { 'Client ID': 256, 'Client Secret': 512, JWT: 8192 };
function promptSequence(labels, { input = process.stdin, output = process.stdout } = {}) {
  if (labels.some(label => !Object.hasOwn(limits, label)) || !input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function' || activeInputs.has(input)) return Promise.reject(new Error('secure_input_unavailable'));
  activeInputs.add(input);
  return new Promise((resolve, reject) => {
    let text = '', done = false, index = 0, timer;
    const values = [];
    const previousRaw = !!input.isRaw;
    const finish = (error) => {
      if (done) return;
      done = true; clearTimeout(timer);
      input.off('data', data); input.off('error', failed); input.off('end', failed); input.off('close', failed);
      try { input.setRawMode(previousRaw); } catch { error = true; }
      input.pause();
      try { output.write('\n'); } catch { error = true; }
      activeInputs.delete(input);
      const result = values.splice(0); text = '';
      if (error) reject(new Error('secure_input_unavailable')); else resolve(result);
    };
    const failed = () => finish(true);
    const nextPrompt = () => {
      clearTimeout(timer); timer = setTimeout(failed, 120000);
      output.write(`${labels[index]} (hidden): `);
    };
    const data = chunk => {
      try {
        const characters = chunk.toString('utf8');
        for (let i = 0; i < characters.length; i++) {
          const character = characters[i];
          if (character === '\r' || character === '\n') {
            // Windows CRLF may arrive in separate events. An empty Enter/LF
            // never submits a credential or advances to the next prompt.
            if (text.length === 0) continue;
            // Never silently split a multi-line paste into separate secrets.
            if (!/^[\r\n]*$/.test(characters.slice(i + 1))) { finish(true); return; }
            values.push(text); text = ''; index++;
            if (index === labels.length) finish(false);
            else { output.write('\n'); nextPrompt(); }
            return;
          }
          if (character === '\b' || character === '\x7f') text = text.slice(0, -1);
          else if (!/^[\x21-\x7e]$/.test(character) || text.length >= limits[labels[index]]) { finish(true); return; }
          else text += character;
        }
      } catch { finish(true); }
    };
    input.on('data', data); input.on('error', failed); input.on('end', failed); input.on('close', failed);
    // One listener and uninterrupted raw mode across all fields prevent a
    // listener/pause race or a cooked-mode echo between hidden prompts.
    try { input.setRawMode(true); nextPrompt(); input.resume(); }
    catch { finish(true); }
  });
}

export function promptHidden(label, terminal) {
  return promptSequence([label], terminal).then(values => values[0]);
}

export async function promptJwtCredentials(binding, terminal) {
  const [clientId, clientSecret, jwt] = await promptSequence(['Client ID', 'Client Secret', 'JWT'], terminal);
  return { ...binding, kind: 'jwt', clientId, clientSecret, jwt };
}
