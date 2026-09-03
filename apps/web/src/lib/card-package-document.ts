function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function prepareCardPackageDocument(
  html: string,
  origin: string,
  fullscreen: boolean,
): string {
  const safeOrigin = new URL(origin).origin;
  const policy = [
    "default-src 'none'",
    `script-src ${safeOrigin} 'unsafe-inline'`,
    `style-src ${safeOrigin} 'unsafe-inline'`,
    `img-src ${safeOrigin} data: blob:`,
    `font-src ${safeOrigin} data:`,
    `media-src ${safeOrigin} blob:`,
    `connect-src ${safeOrigin}`,
    "worker-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    `base-uri ${safeOrigin}`,
    "form-action 'none'",
  ].join('; ');
  const bootstrap = `${`<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">`}${
    fullscreen ? '<script>document.documentElement.dataset.cpiDisplay="fullscreen"</script>' : ''
  }`;
  if (/<head(?:\s[^>]*)?>/iu.test(html)) {
    return html.replace(/<head(\s[^>]*)?>/iu, (opening) => `${opening}${bootstrap}`);
  }
  return `<!doctype html><html><head>${bootstrap}</head><body>${html}</body></html>`;
}

export function cardPackageLoadingDocument(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{height:100%;margin:0;background:#101112;color:#fff;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{display:grid;place-items:center;min-height:240px}.loader{display:grid;justify-items:center;gap:14px;text-align:center}.dot{width:34px;height:34px;border:3px solid rgba(255,255,255,.18);border-top-color:#64d5d1;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}p{margin:0;color:#b7b9ba;font-size:14px}</style></head><body><div class="loader"><span class="dot"></span><p>Загружаем оформление…</p></div></body></html>`;
}

export function cardPackageErrorDocument(
  packageId: string,
  message = 'Не удалось открыть ZIP-оформление',
): string {
  const serializedPackageId = JSON.stringify(packageId).replaceAll('<', '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{height:100%;margin:0;background:#101112;color:#fff;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{display:grid;place-items:center;min-height:260px;padding:24px;box-sizing:border-box}.error{max-width:420px;text-align:center}h1{margin:0 0 10px;font-size:20px}p{margin:0 0 18px;color:#b7b9ba;line-height:1.45}button{min-height:44px;padding:0 18px;border:0;border-radius:12px;background:#64d5d1;color:#101112;font:inherit;font-weight:800;cursor:pointer}</style></head><body><div class="error"><h1>${escapeHtml(message)}</h1><p>Проверьте соединение и попробуйте загрузить карточку ещё раз.</p><button type="button" onclick='parent.postMessage({type:"cpi-card-retry",packageId:${serializedPackageId}},"*")'>Повторить</button></div></body></html>`;
}
