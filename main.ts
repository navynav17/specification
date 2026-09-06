import { Actor } from 'apify';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://foupthwcnnskqlzhoyep.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DARAZ_HOST = 'daraz.com.np';

const clean = (v: unknown, max = 500) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const CANONICAL: Record<string, string> = {
  brand: 'Brand', 'brand name': 'Brand', model: 'Model', 'model name': 'Model',
  colour: 'Color', color: 'Color', 'color family': 'Color Family', capacity: 'Capacity',
  'product type': 'Product Type', type: 'Product Type', warranty: 'Warranty',
  'warranty period': 'Warranty', weight: 'Weight', dimension: 'Dimensions', dimensions: 'Dimensions'
};

const ALLOWED_KEYS = /^(brand|brand name|model|model name|color|colour|color family|capacity|product type|type|warranty|warranty period|weight|dimensions?|sku|storage|ram|display|screen|battery|camera|operating system|memory|processor|chipset|refresh rate|resolution|sim|network|material|power|voltage|frequency|number of doors|refrigerator type|refrigerator capacity|charging|charging speed|battery capacity|rom|internal storage|main camera|front camera|screen size|screen type|storage capacity|os version|graphics|gpu|cpu|connectivity|bluetooth|wifi|ports|usb|waterproof|mounting type|compatible brand|compatible model)$/i;
const BAD_KEY = /^(class|class name|style|display|position|width|height|top|left|right|bottom|margin|padding|background|font|font-family|font-size|line-height|opacity|visibility|z-index|float|text|overflow|content|skuid|brandid|lzd|selector|tag|node|element|href|src|id|name)$/i;
const BAD_VALUE = /^(img|image|text|script|style|div|span|html|body|null|undefined|inline-block|block|none|relative|absolute|fixed|visible|hidden|auto|inherit|initial|lzd\/popups|lzd\/age-restriction)$/i;
const BAD_VALUE_PARTS = /(^|[\s:/_-])(?:lzd|skuId|brand_id|age-restriction|popups|inline-block|javascript)([\s:/_-]|$)/i;
const UI_NOISE = /\b(no ratings?|add to wishlist|out of stock|in stock|buy now|add to cart|sold by|delivery|cash on delivery|free shipping|more kitchen appliances|quantity|wishlist|share|report)\b/i;

function canonicalKey(key: string) {
  const k = clean(key, 120).toLowerCase();
  return CANONICAL[k] || clean(key, 120);
}

function looksLikeRealPair(key: string, value: string) {
  const k = clean(key, 120);
  const v = clean(value, 350);
  if (!k || !v || BAD_KEY.test(k) || BAD_VALUE.test(v) || BAD_VALUE_PARTS.test(v)) return false;
  if (!ALLOWED_KEYS.test(k)) return false;
  if (/^https?:\/\//i.test(v) || /^data:/i.test(v) || /<[^>]+>/i.test(v)) return false;
  if (UI_NOISE.test(v)) return false;
  return true;
}

function addSpec(out: Record<string, string>, key: unknown, value: unknown) {
  const rawKey = clean(key, 120);
  const k = canonicalKey(rawKey);
  const v = clean(value, 350);
  if (!looksLikeRealPair(rawKey, v)) return;
  out[k] = v;
}

async function extractProduct(url: string) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1400 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151 Safari/537.36',
      locale: 'en-US'
    });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5500);

    for (let i = 0; i < 14; i++) {
      await page.mouse.wheel(0, 1000);
      await page.waitForTimeout(450);
    }
    await page.waitForTimeout(2500);

    try {
      const labels = page.getByText('Specifications', { exact: true });
      const count = await labels.count();
      for (let i = 0; i < Math.min(count, 5); i++) {
        try {
          await labels.nth(i).scrollIntoViewIfNeeded();
          await labels.nth(i).click({ timeout: 2000 });
          await page.waitForTimeout(1200);
        } catch {}
      }
    } catch {}

    const result = await page.evaluate(`(() => {
      const clean = (v) => String(v ?? '').replace(/\\s+/g, ' ').trim();
      const rows = [];
      const seen = new Set();
      const push = (k, v) => {
        k = clean(k); v = clean(v);
        if (!k || !v) return;
        const sig = k + '\\u0000' + v;
        if (seen.has(sig)) return;
        seen.add(sig);
        rows.push([k, v]);
      };

      // 1) Preferred Daraz specification component.
      for (const root of Array.from(document.querySelectorAll('.pdp-mod-specification'))) {
        const title = Array.from(root.querySelectorAll('.pdp-mod-section-title'))
          .find(el => clean(el.textContent).toLowerCase() === 'specifications');
        if (!title) continue;
        for (const li of root.querySelectorAll('ul.specification-keys > li.key-li')) {
          push(li.querySelector('.key-title')?.textContent, li.querySelector('.key-value')?.textContent);
        }
      }

      // 2) Only inspect rows directly associated with a real Specifications heading.
      const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,p,div,span'))
        .filter(el => clean(el.textContent).toLowerCase() === 'specifications');
      for (const heading of headings.slice(0, 8)) {
        let parent = heading.parentElement;
        for (let depth = 0; depth < 5 && parent; depth++, parent = parent.parentElement) {
          for (const tr of parent.querySelectorAll('tr')) {
            const cells = Array.from(tr.querySelectorAll('th,td')).map(c => clean(c.textContent)).filter(Boolean);
            if (cells.length === 2) push(cells[0], cells[1]);
          }
          for (const item of parent.querySelectorAll('li')) {
            const spans = Array.from(item.querySelectorAll(':scope > span, :scope > div'))
              .map(x => clean(x.textContent)).filter(Boolean);
            if (spans.length === 2) push(spans[0], spans[1]);
          }
        }
      }

      // 3) Embedded JSON fallback, strictly limited to known specification keys.
      const allowed = /^(brand|brand name|model|model name|color|colour|color family|capacity|product type|type|warranty|warranty period|weight|dimensions?|sku|storage|ram|display|screen|battery|camera|operating system|memory|processor|chipset|refresh rate|resolution|sim|network|material|power|voltage|frequency|number of doors|refrigerator type|refrigerator capacity|charging|charging speed|battery capacity|rom|internal storage|main camera|front camera|screen size|screen type|storage capacity|os version|graphics|gpu|cpu|connectivity|bluetooth|wifi|ports|usb|waterproof|mounting type|compatible brand|compatible model)$/i;
      for (const script of Array.from(document.scripts)) {
        const text = script.textContent || '';
        if (!/specification|specifications|keyValue/i.test(text)) continue;
        const pairs = text.matchAll(/(?:\"|')([^\"']{2,80})(?:\"|')\\s*[:=]\\s*(?:\"|')([^\"']{1,300})(?:\"|')/g);
        for (const m of pairs) {
          const k = clean(m[1]);
          const v = clean(m[2]);
          if (allowed.test(k)) push(k, v);
        }
      }

      return { rows, title: clean(document.title || ''), url: location.href };
    })()`);

    const specs: Record<string, string> = {};
    for (const [k, v] of result.rows as Array<[string, string]>) addSpec(specs, k, v);

    await context.close();
    return { specs, finalUrl: result.url, title: result.title };
  } finally {
    await browser.close();
  }
}

async function main() {
  await Actor.init();
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: pending, error: queueError } = await supabase
    .from('products')
    .select('id,title,price,image,link,reviews,rating,created_at')
    .not('link', 'is', null)
    .like('link', '%daraz.com.np%')
    .not('link', 'like', '%/categories/%')
    .order('created_at', { ascending: true })
    .limit(200);
  if (queueError) throw queueError;

  const candidates = (pending || []).filter((p: any) => {
    try {
      const u = new URL(p.link);
      return (u.hostname === DARAZ_HOST || u.hostname === `www.${DARAZ_HOST}`) && /\/products\//i.test(u.pathname) && /-i\d+\.html/i.test(u.pathname);
    } catch { return false; }
  });

  let selected: any = null;
  for (const candidate of candidates) {
    const { data: already } = await supabase
      .from('updated_specifications')
      .select('id')
      .eq('product_id', candidate.id)
      .limit(1)
      .maybeSingle();
    if (!already) { selected = candidate; break; }
  }

  if (!selected) {
    await Actor.pushData({ status: 'no_pending_daraz_products' });
    await Actor.exit();
    return;
  }

  const productUrl = clean(selected.link, 2500);
  console.log(`SPEC_START | daraz_url=${productUrl} | product_id=${selected.id}`);

  const extracted = await extractProduct(productUrl);
  console.log(`SPEC_EXTRACTED | count=${Object.keys(extracted.specs).length} | final=${extracted.finalUrl}`);
  console.log(`SPECIFICATIONS | ${JSON.stringify(extracted.specs)}`);

  const specs = extracted.specs;
  if (Object.keys(specs).length === 0) {
    console.log('SPEC_DONE | skipped empty/invalid extraction');
    await Actor.pushData({ url: productUrl, status: 'no_verified_specs', productId: selected.id, specifications: {} });
    await Actor.exit();
    return;
  }

  const { error: saveError } = await supabase.from('updated_specifications').upsert({
    product_id: selected.id,
    product_url: productUrl,
    specifications: specs,
    source: 'apify-specification',
    updated_at: new Date().toISOString()
  }, { onConflict: 'product_url' });
  if (saveError) throw saveError;

  await Actor.pushData({ url: productUrl, status: 'updated', productId: selected.id, specifications: specs });
  console.log(`SPEC_DONE | saved=${Object.keys(specs).length} | table=updated_specifications`);
  await Actor.exit();
}

main().catch(async error => {
  console.error(error);
  try { await Actor.fail(); } catch {}
});
