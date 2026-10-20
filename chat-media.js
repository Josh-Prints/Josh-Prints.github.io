/* Chat extras shared by the customer and admin order chats.
   - richText(text): message text with links made clickable, and GIF / image links from known GIF hosts
     (Giphy, Tenor, Imgur) shown inline so they play right in the chat. Other sites stay plain links, so a
     message can't make everyone's browser load images from anywhere.
   - pasteFiles(textarea, add): pasting a GIF or picture (or the keyboard's GIF picker on a phone) adds it
     as an attachment instead of doing nothing. */

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MEDIA_HOSTS = /^(media\d*\.giphy\.com|i\.giphy\.com|media\d*\.tenor\.com|c\.tenor\.com|i\.imgur\.com)$/i;
const IMG_PATH = /\.(gif|png|jpe?g|webp)$/i;

// a link that should play inline, as the image address to show (or null)
function mediaSrc(u){
  let url; try { url = new URL(u); } catch (e) { return null; }
  if (url.protocol !== 'https:') return null;
  if (MEDIA_HOSTS.test(url.hostname) && (IMG_PATH.test(url.pathname) || /giphy\.com$/i.test(url.hostname))) return url.href;
  // a giphy.com page link: giphy.com/gifs/some-name-ID -> the GIF itself
  const g = url.hostname.match(/^(www\.)?giphy\.com$/i) && url.pathname.match(/^\/(?:gifs|stickers)\/(?:[\w-]*-)?([A-Za-z0-9]{8,})\/?$/);
  if (g) return 'https://media.giphy.com/media/' + g[1] + '/giphy.gif';
  // an imgur page link to a single image: imgur.com/ID -> i.imgur.com/ID.gif
  const im = url.hostname.match(/^(www\.)?imgur\.com$/i) && url.pathname.match(/^\/([A-Za-z0-9]{5,8})$/);
  if (im) return 'https://i.imgur.com/' + im[1] + '.gif';
  return null;
}

export function richText(text){
  const parts = String(text || '').split(/(https?:\/\/[^\s<>"']+)/g);
  let media = '';
  const html = parts.map((p, i) => {
    if (i % 2 === 0) return esc(p);
    const link = p.replace(/[.,!?)\]]+$/, ''), trail = p.slice(link.length);
    const src = mediaSrc(link);
    if (src){ media += '<img class="chat-gif" src="' + esc(src) + '" alt="GIF" loading="lazy" referrerpolicy="no-referrer">'; return esc(trail); }
    return '<a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer nofollow">' + esc(link) + '</a>' + esc(trail);
  }).join('').trim();
  return (html ? '<div>' + html + '</div>' : '') + media;
}

export function pasteFiles(textarea, add){
  textarea.addEventListener('paste', e => {
    const items = Array.from((e.clipboardData && e.clipboardData.files) || []).filter(f => /^image\//.test(f.type));
    if (!items.length) return;
    e.preventDefault();
    add(items.map((f, i) => {
      if (f.name && f.name !== 'image.png' && /\.\w+$/.test(f.name)) return f;
      const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      return new File([f], 'pasted-' + Date.now() + (i ? '-' + i : '') + '.' + ext, { type: f.type });
    }));
  });
}

// styles for inline GIFs (injected once)
if (!document.getElementById('chat-media-css')){
  const s = document.createElement('style'); s.id = 'chat-media-css';
  s.textContent = '.chat-gif{display:block;max-width:min(260px,100%);max-height:260px;border-radius:10px;margin-top:6px;cursor:zoom-in;background:rgba(127,127,127,.12)}';
  document.head.appendChild(s);
}
