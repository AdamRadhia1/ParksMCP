// Photos searchable on the site. Put the image files in the "photos" folder.
// Keep this list in sync with photos.json in the meridian-events-mcp folder.
// These three are SAMPLES; the image files don't exist until you add them.
const photos = [
  {
    file: 'photos/drum-circle.jpg',
    caption: 'Drummers on the upper terrace at sunset',
    date: '2026-09-13',
    event: 'Sunday Drum Circle',
    location: 'Upper terrace',
    tags: ['drums', 'music', 'sunset', 'crowd']
  },
  {
    file: 'photos/fountain.jpg',
    caption: 'The cascading fountain on a sunny afternoon',
    date: '2026-09-06',
    event: '',
    location: 'Cascade fountain',
    tags: ['fountain', 'water', 'architecture']
  },
  {
    file: 'photos/picnic.jpg',
    caption: 'Friends sharing food on the lower lawn',
    date: '2026-09-20',
    event: 'Malcolm X Park Community Picnic',
    location: 'Lower lawn',
    tags: ['picnic', 'food', 'lawn']
  }
];

const photosModal = document.getElementById('photos-modal');
const photosSearch = document.getElementById('photos-search');
const photosResults = document.getElementById('photos-results');

const PUBLIC_BASE = 'Meridian Hill Park';
let publicTimer = null;
let searchToken = 0; // ignores results from an older search that finish late

function makeCard(imgSrc, alt, title, metaText, linkUrl, onMissing) {
  const card = document.createElement('div');
  card.className = 'photo-card';

  const img = document.createElement('img');
  img.src = imgSrc;
  img.alt = alt;
  img.loading = 'lazy';
  img.onerror = onMissing;

  const info = document.createElement('div');
  info.className = 'photo-info';
  const strong = document.createElement('strong');
  strong.textContent = title;
  const meta = document.createElement('div');
  meta.className = 'photo-meta';
  meta.textContent = metaText;
  info.append(strong, meta);

  if (linkUrl) {
    const a = document.createElement('a');
    a.href = linkUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'View source';
    info.appendChild(a);
  }
  card.append(img, info);
  return card;
}

function makeSection(id, heading) {
  const wrap = document.createElement('div');
  wrap.id = id;
  wrap.className = 'photo-section';
  const h = document.createElement('h3');
  h.textContent = heading;
  const grid = document.createElement('div');
  grid.className = 'photo-grid';
  wrap.append(h, grid);
  return { wrap, grid };
}

function renderPhotos() {
  const query = photosSearch.value.trim();
  const q = query.toLowerCase();
  const found = photos
    .filter((p) => `${p.caption} ${p.event} ${p.location} ${p.tags.join(' ')}`.toLowerCase().includes(q))
    .sort((a, b) => b.date.localeCompare(a.date));

  photosResults.replaceChildren();

  // Your own photos. A card with no image file yet is removed, so samples stay hidden.
  const local = makeSection('photos-local', 'Our photos');
  found.forEach((p) => {
    const card = makeCard(p.file, p.caption, p.caption,
      [p.date, p.event, p.location].filter(Boolean).join(' · '), null,
      () => { card.remove(); if (!local.grid.children.length) local.wrap.remove(); });
    local.grid.appendChild(card);
  });
  if (found.length) photosResults.appendChild(local.wrap);

  const pub = makeSection('photos-public', 'Public photos (open licenses)');
  const status = document.createElement('p');
  status.className = 'photo-status';
  status.textContent = 'Searching public photos...';
  pub.grid.appendChild(status);
  photosResults.appendChild(pub.wrap);

  clearTimeout(publicTimer);
  const token = ++searchToken;
  publicTimer = setTimeout(async () => {
    const term = query ? `${PUBLIC_BASE} ${query}` : PUBLIC_BASE;
    const results = await searchPublicPhotos(term);
    if (token !== searchToken) return;
    pub.grid.replaceChildren();
    if (!results.length) {
      status.textContent = `No public photos found for "${query}".`;
      pub.grid.appendChild(status);
      return;
    }
    results.forEach((r) => {
      const card = makeCard(r.image, r.title, r.title,
        `By ${r.author} · ${r.license} · ${r.source}`, r.page,
        () => card.remove());
      pub.grid.appendChild(card);
    });
  }, 400);
}

const stripHtml = (t = '') => t.replace(/<[^>]*>/g, '').trim();

async function fetchCommons(term) {
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*' +
    '&generator=search&gsrnamespace=6&gsrlimit=6&gsrsearch=' + encodeURIComponent(term) +
    '&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=400';
  const data = await (await fetch(url)).json();
  return Object.values(data.query?.pages ?? {})
    .filter((p) => p.imageinfo?.[0])
    .map((p) => {
      const info = p.imageinfo[0];
      const m = info.extmetadata ?? {};
      return {
        title: p.title.replace(/^File:/, '').replace(/\.\w+$/, ''),
        image: info.thumburl || info.url,
        page: info.descriptionurl,
        author: stripHtml(m.Artist?.value) || 'Unknown',
        license: m.LicenseShortName?.value || 'See page',
        source: 'Wikimedia Commons'
      };
    });
}

async function fetchOpenverse(term) {
  const url = 'https://api.openverse.org/v1/images/?page_size=6&q=' + encodeURIComponent(term);
  const data = await (await fetch(url)).json();
  return (data.results ?? []).map((r) => ({
    title: r.title || 'Untitled',
    image: r.thumbnail || r.url,
    page: r.foreign_landing_url,
    author: r.creator || 'Unknown',
    license: `${(r.license || '').toUpperCase()} ${r.license_version || ''}`.trim() || 'See page',
    source: 'Openverse'
  }));
}

async function searchPublicPhotos(term) {
  const settled = await Promise.allSettled([fetchCommons(term), fetchOpenverse(term)]);
  return settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
}

function openPhotos() {
  photosModal.hidden = false;
  renderPhotos();
  photosSearch.focus();
}
function closePhotos() { photosModal.hidden = true; }

document.getElementById('photos-open').addEventListener('click', openPhotos);
document.getElementById('photos-close').addEventListener('click', closePhotos);
photosModal.addEventListener('click', (e) => { if (e.target === photosModal) closePhotos(); });
photosSearch.addEventListener('input', renderPhotos);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !photosModal.hidden) closePhotos(); });
