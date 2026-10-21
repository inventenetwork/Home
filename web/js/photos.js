import { apiBlobUrl } from './api.js';
import { h } from './ui.js';

/**
 * An <img> for a protected image. It starts empty and fills in once the picture has been fetched with the login token.
 * The temporary blob: URL is released when the page changes (pass ctx.onCleanup).
 */
export function protectedImg(path, alt, onCleanup, cls = 'thumb') {
  const img = h('img', { class: cls, alt, loading: 'lazy' });
  let url = null;
  let gone = false;
  apiBlobUrl(path).then(
    (u) => {
      if (gone) return URL.revokeObjectURL(u);
      url = u;
      img.src = u;
      img.dataset.loaded = '1';
    },
    () => img.replaceWith(h('span', { class: 'muted small' }, '—')),
  );
  onCleanup(() => {
    gone = true;
    if (url) URL.revokeObjectURL(url);
  });
  return img;
}
