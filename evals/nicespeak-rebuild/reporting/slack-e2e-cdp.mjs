import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const [, , action, ...args] = process.argv;
const targets = await fetch('http://127.0.0.1:9222/json/list').then((response) => response.json());
const target = action === 'screenshot-extensions'
  ? targets.find((candidate) => candidate.type === 'page' && candidate.url === 'chrome://extensions/')
  : targets.find((candidate) =>
      candidate.type === 'page' && candidate.url.includes('app.slack.com/client/'),
    );

if (!target) throw new Error('Browser target not found');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolveOpen, rejectOpen) => {
  socket.onopen = resolveOpen;
  socket.onerror = rejectOpen;
});

let nextId = 0;
const pending = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const resolveMessage = pending.get(message.id);
  if (!resolveMessage) return;
  pending.delete(message.id);
  resolveMessage(message);
};

function send(method, params = {}) {
  return new Promise((resolveMessage) => {
    const id = ++nextId;
    pending.set(id, resolveMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression, awaitPromise = false) {
  const response = await send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.text);
  }
  return response.result?.result?.value;
}

function quoted(value) {
  return JSON.stringify(value);
}

if (action === 'state') {
  const tag = args[0] ?? '';
  const state = await evaluate(`(() => {
    const panel = document.querySelector('[data-nicespeak-review="root"]');
    const editor = document.querySelector('[data-qa="texty_input"][contenteditable="true"]');
    const send = document.querySelector('[data-qa="texty_send_button"], [data-qa="send_button"], button[aria-label="Send message"], button[aria-label^="Send"]');
    const tag = ${quoted(tag)};
    const pageText = document.body.innerText;
    return {
      url: location.href,
      panel: panel?.innerText ?? null,
      editor: editor?.innerText ?? null,
      sendDisabled: send?.disabled ?? null,
      tagCount: tag ? pageText.split(tag).length - 1 : 0,
    };
  })()`);
  console.log(JSON.stringify(state, null, 2));
} else if (action === 'set-enter') {
  const text = args.join(' ');
  const result = await evaluate(`(() => {
    const editor = document.querySelector('[data-qa="texty_input"][contenteditable="true"]');
    if (!editor) throw new Error('Slack composer not found');
    editor.focus();
    editor.replaceChildren(document.createTextNode(${quoted(text)}));
    editor.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: ${quoted(text)},
    }));
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    });
    const dispatched = editor.dispatchEvent(event);
    return { dispatched, defaultPrevented: event.defaultPrevented, text: editor.innerText };
  })()`);
  console.log(JSON.stringify(result, null, 2));
} else if (action === 'click-panel') {
  const label = args.join(' ');
  const result = await evaluate(`(() => {
    const button = [...document.querySelectorAll('[data-nicespeak-review="root"] button')]
      .find((candidate) => candidate.textContent.trim() === ${quoted(label)});
    if (!button) return { clicked: false };
    button.click();
    return { clicked: true };
  })()`);
  console.log(JSON.stringify(result, null, 2));
} else if (action === 'press-enter') {
  await evaluate(`document.querySelector('[data-qa="texty_input"][contenteditable="true"]')?.focus()`);
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 36,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 36,
  });
  console.log('pressed Enter');
} else if (action === 'toggle') {
  const enabled = args[0] === 'on';
  const result = await evaluate(`(() => {
    const toggle = document.querySelector('[data-nicespeak-review="root"] input[type="checkbox"]');
    if (!toggle) throw new Error('NiceSpeak toggle not found');
    toggle.checked = ${enabled};
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    return { checked: toggle.checked };
  })()`);
  console.log(JSON.stringify(result, null, 2));
} else if (action === 'screenshot' || action === 'screenshot-extensions') {
  const path = resolve(args[0]);
  await mkdir(dirname(path), { recursive: true });
  const response = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true,
  });
  await writeFile(path, Buffer.from(response.result.data, 'base64'));
  console.log(path);
} else if (action === 'reload') {
  await send('Page.reload', { ignoreCache: true });
  console.log('reloaded');
} else {
  throw new Error(`Unknown action: ${action}`);
}

socket.close();
