import { Actor } from 'apify';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://foupthwcnnskqlzhoyep.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DARAZ_HOST = 'daraz.com.np';

const clean = (v: unknown, max = 500) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const productIdFromUrl = (url: string) => url.match(/(?:\/i|\/products\/[^?#]*?-i)(\d+)/i)?.[1] || url;

const CANONICAL: Record<string, string> = {
  brand: 'Brand', 'brand name': 'Brand', model: 'Model', 'model name': 'Model',
  colour: 'Color', color: 'Color', 'color family': 'Color Family', capacity: 'Capacity',
  'product type': 'Product Type', type: 'Product Type', warranty: 'Warranty',
  'warranty period': 'Warranty', weight: 'Weight', dimension: 'Dimensions', dimensions: 'Dimensions'
};
const UI_NOISE = /^(more|from|no ratings?|ratings?|add to wishlist|share|report|quantity|out of stock|in stock|buy now|add to cart|sold by|delivery|cash on delivery|free shipping|emi|flash sale|choice|follow|chat now|message)$/i;
const BAD_VALUE = /^(img|image|text|script|style|div|span|html|body|null|undefined)$/i;
function canonicalKey(key: string) { const k = clean(key, 120).toLowerCase(); return CANONICAL[k] || clean(key, 120); }
function looksLikeRealValue(value: string) {
  const v = clean(value, 350);
  if (!v || BAD_VALUE.test(v) || UI_NOISE.test(v)) return false;
  if (/^https?:\/\//i.test(v) || /^data:/i.test(v) || /<[^>]+>/i.test(v)) return false;
  if (/\b(no ratings?|add to wishlist|out of stock|in stock|more kitchen appliances|more .* from)/i.test(v)) return false;
  return true;
}
function addSpec(out: Record<string, string>, key: unknown, value: unknown) {
  const k = canonicalKey(clean(key, 120)); const v = clean(value, 350);
  if (!k || !looksLikeRealValue(v)) return;
  out[k] = v;
}

async function extractProduct(url: string) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1200 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151 Safari/537.36',
      locale: 'en-US'
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500);
    for (let i = 0; i < 7; i++) { await page.mouse.wheel(0, 1200); await page.waitForTimeout(700); }
    await page.waitForTimeout(1500);
    const result = await page.evaluate(`(() => {
      const clean = (v) => String(v ?? '').replace(/\\s+/g, ' ').trim();
      const roots = Array.from(document.querySelectorAll('.pdp-mod-specification')); const rows = [];
      for (const root of roots) {
        const title = Array.from(root.querySelectorAll('.pdp-mod-section-title')).find(el => clean(el.textContent).toLowerCase() === 'specifications');
        if (!title) continue;
        for (const li of root.querySelectorAll('ul.specification-keys > li.key-li')) {
          const key = clean(li.querySelector('.key-title')?.textContent || '');
          const value = clean(li.querySelector('.key-value')?.textContent || '');
          if (key && value) rows.push([key, value]);
        }
      }
      const specRoot = roots.find(root => Array.from(root.querySelectorAll('.pdp-mod-section-title')).some(el => clean(el.textContent).toLowerCase() === 'specifications')) || null;
      return { rows, rootCount: roots.length, specFound: !!specRoot, sectionText: clean(specRoot?.innerText || '').slice(0, 15000), html: specRoot?.outerHTML?.slice(0, 30000) || '', url: location.href };
    })()`);
    const specs: Record<string, string> = {};
    for (const [k, v] of result.rows as Array<[string, string]>) addSpec(specs, k, v);
    await context.close();
    return { specs, finalUrl: result.url, ...result };
  } finally { await browser.close(); }
}

async function main() {
  await Actor.init();
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Only select Daraz Nepal product URLs that have not yet been processed.
  const { data: pending, error: queueError } = await supabase
    .from('products')
    .select('id,title,price,image,link,reviews,rating')
    .not('link', 'is', null)
    .like('link', '%daraz.com.np%')
    .not('link', 'like', '%/categories/%')
    .order('created_at', { ascending: true })
    .limit(100);
  if (queueError) throw queueError;

  const candidates = (pending || []).filter((p: any) => {
    try {
      const u = new URL(p.link);
      return u.hostname === DARAZ_HOST || u.hostname === `www.${DARAZ_HOST}`;
    } catch { return false; }
  });

  const urls = candidates.map((p: any) => p.link);
  if (!urls.length) {
    await Actor.pushData({ status: 'no_pending_daraz_products' });
    await Actor.exit();
    return;
  }

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
  const productId = productIdFromUrl(productUrl);
  console.log(`SPEC_START | daraz_url=${productUrl} | product_id=${selected.id}`);

  const extracted = await extractProduct(productUrl);
  console.log(`SPEC_ROOT | found=${extracted.rootCount > 0} | count=${extracted.rootCount}`);
  console.log(`SPEC_TITLE | found=${extracted.specFound}`);
  console.log(`SPEC_EXTRACTED | count=${Object.keys(extracted.specs).length} | final=${extracted.finalUrl}`);
  console.log(`SPECIFICATIONS | ${JSON.stringify(extracted.specs)}`);

  const specs = extracted.specs;
  const { error: saveError } = await supabase.from('updated_specifications').upsert({
    product_id: selected.id,
    product_url: productUrl,
    specifications: specs,
    source: 'apify-specification',
    updated_at: new Date().toISOString()
  }, { onConflict: 'product_url' });
  if (saveError) throw saveError;

  await Actor.pushData({
    url: productUrl,
    status: Object.keys(specs).length ? 'updated' : 'no_verified_specs',
    productId: selected.id,
    specifications: specs
  });

  console.log(`SPEC_DONE | saved=${Object.keys(specs).length} | table=updated_specifications`);
  await Actor.exit();
}

main().catch(async error => { console.error(error); try { await Actor.fail(); } catch {} });
