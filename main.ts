import { Actor } from 'apify';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://foupthwcnnskqlzhoyep.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MARKETPLACE_ID = process.env.MARKETPLACE_ID || '6a4f8822-e1bc-4e8b-be61-4d1a400f3c13';

const clean = (v: unknown, max = 500) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const productIdFromUrl = (url: string) => url.match(/(?:\/i|\/products\/[^?#]*?-i)(\d+)/i)?.[1] || url;

const CANONICAL: Record<string, string> = {
  brand: 'Brand',
  'brand name': 'Brand',
  model: 'Model',
  'model name': 'Model',
  colour: 'Color',
  color: 'Color',
  'color family': 'Color Family',
  capacity: 'Capacity',
  'product type': 'Product Type',
  type: 'Product Type',
  warranty: 'Warranty',
  'warranty period': 'Warranty',
  weight: 'Weight',
  dimension: 'Dimensions',
  dimensions: 'Dimensions'
};

const UI_NOISE = /^(more|from|no ratings?|ratings?|add to wishlist|share|report|quantity|out of stock|in stock|buy now|add to cart|sold by|delivery|cash on delivery|free shipping|emi|flash sale|choice|follow|chat now|message)$/i;
const BAD_VALUE = /^(img|image|text|script|style|div|span|html|body|null|undefined)$/i;

function canonicalKey(key: string) {
  const k = clean(key, 120).toLowerCase();
  return CANONICAL[k] || clean(key, 120);
}

function looksLikeRealValue(value: string) {
  const v = clean(value, 350);
  if (!v || BAD_VALUE.test(v) || UI_NOISE.test(v)) return false;
  if (/^https?:\/\//i.test(v) || /^data:/i.test(v) || /<[^>]+>/i.test(v)) return false;
  if (/\b(no ratings?|add to wishlist|out of stock|in stock|more kitchen appliances|more .* from)/i.test(v)) return false;
  return true;
}

function addSpec(out: Record<string, string>, key: unknown, value: unknown) {
  const k = canonicalKey(clean(key, 120));
  const v = clean(value, 350);
  if (!k || !looksLikeRealValue(v)) return;
  out[k] = v;
}

function collectObjectPairs(node: unknown, out: Record<string, string>, depth = 0) {
  if (depth > 8 || node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectObjectPairs(item, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;

  const obj = node as Record<string, unknown>;
  for (const [rawKey, rawValue] of Object.entries(obj)) {
    if (typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      const key = clean(rawKey, 120);
      const value = clean(rawValue, 350);
      if (/^(brand|brand name|model|model name|colour|color|color family|capacity|product type|type|warranty|warranty period|weight|dimension|dimensions|sku|storage|ram|display|screen|battery|camera|operating system|memory|processor|chipset|refresh rate|resolution|sim|network|material|power|voltage|frequency|number of doors|refrigerator type|refrigerator capacity|charging|charging speed|battery capacity|rom|internal storage|main camera|front camera|screen size|screen type|storage capacity|os version|graphics|gpu|cpu|connectivity|bluetooth|wifi|ports|usb|series|generation|processor speed|cores|threads|dedicated graphics|integrated graphics|screen resolution|panel type|touchscreen|backlit keyboard|keyboard layout|webcam|camera resolution|battery life)$/i.test(key)) {
        addSpec(out, key, value);
      }
    } else {
      collectObjectPairs(rawValue, out, depth + 1);
    }
  }
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
    const networkPayloads: Array<{ url: string; contentType: string; text: string }> = [];

    page.on('response', async response => {
      const responseUrl = response.url();
      const contentType = response.headers()['content-type'] || '';
      const interesting = /(?:api|product|item|sku|spec|attribute|detail|page)/i.test(responseUrl) || /json/i.test(contentType);
      if (!interesting) return;
      try {
        const text = await response.text();
        if (text && text.length <= 500000) {
          networkPayloads.push({ url: responseUrl, contentType, text });
          if (networkPayloads.length > 80) networkPayloads.shift();
        }
      } catch {}
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    for (let i = 0; i < 7; i++) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(3000);

    const result = await page.evaluate(`(() => {
      const clean = (v) => String(v ?? '').replace(/\\s+/g, ' ').trim();
      const rows = [];
      const roots = Array.from(document.querySelectorAll('.pdp-mod-specification'));

      for (const root of roots) {
        const title = Array.from(root.querySelectorAll('.pdp-mod-section-title'))
          .find(el => clean(el.textContent).toLowerCase() === 'specifications');
        if (!title) continue;
        for (const li of root.querySelectorAll('ul.specification-keys > li.key-li')) {
          const key = clean(li.querySelector('.key-title')?.textContent || '');
          const value = clean(li.querySelector('.key-value')?.textContent || '');
          if (key && value) rows.push([key, value]);
        }
      }

      return {
        rows,
        rootCount: roots.length,
        specFound: roots.some(root => Array.from(root.querySelectorAll('.pdp-mod-section-title'))
          .some(el => clean(el.textContent).toLowerCase() === 'specifications')),
        html: document.documentElement.outerHTML,
        title: document.title,
        bodyTextSample: clean(document.body?.innerText || '').slice(0, 12000),
        url: location.href
      };
    })()`);

    const specs: Record<string, string> = {};
    for (const [k, v] of result.rows as Array<[string, string]>) addSpec(specs, k, v);

    if (!Object.keys(specs).length) {
      const html = result.html as string;
      const hasSpecMarkup = /pdp-mod-specification/i.test(html) && /specification-keys/i.test(html);
      if (hasSpecMarkup) {
        console.log('SPEC_HTML_FALLBACK | exact specification markup detected in raw HTML');
        const rowRe = /<li[^>]*class=["'][^"']*\bkey-li\b[^"']*["'][^>]*>[\s\S]*?<span[^>]*class=["'][^"']*\bkey-title\b[^"']*["'][^>]*>([\s\S]*?)<\/span>[\s\S]*?<div[^>]*class=["'][^"']*\bkey-value\b[^"']*["'][^>]*>([\s\S]*?)<\/div>[\s\S]*?<\/li>/gi;
        const strip = (x: string) => clean(x.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' '));
        let m: RegExpExecArray | null;
        while ((m = rowRe.exec(html)) !== null) addSpec(specs, strip(m[1]), strip(m[2]));
        console.log(`SPEC_HTML_FALLBACK_EXTRACTED | count=${Object.keys(specs).length}`);
      }
    }

    if (!Object.keys(specs).length) {
      for (const payload of networkPayloads) {
        if (!/(?:spec|attribute|product|sku|detail)/i.test(payload.url)) continue;
        const text = payload.text;
        try {
          const json = JSON.parse(text);
          collectObjectPairs(json, specs);
        } catch {
          const pairs = text.match(/\"([^\"]{2,80})\"\s*:\s*\"([^\"]{1,350})\"/g) || [];
          for (const pair of pairs) {
            const match = pair.match(/^\"([^\"]{2,80})\"\s*:\s*\"([^\"]{1,350})\"$/);
            if (match) addSpec(specs, match[1], match[2]);
          }
        }
        if (Object.keys(specs).length) {
          console.log(`SPEC_NETWORK_MATCH | url=${payload.url} | count=${Object.keys(specs).length}`);
          break;
        }
      }
    }

    if (!Object.keys(specs).length) {
      console.log(`SPEC_NETWORK_DIAGNOSTIC | captured=${networkPayloads.length}`);
      for (const p of networkPayloads.slice(-30)) {
        console.log(`SPEC_NETWORK | ${p.contentType} | ${p.url}`);
      }
    }

    await context.close();
    return { specs, finalUrl: result.url, ...result };
  } finally {
    await browser.close();
  }
}

async function main() {
  await Actor.init();
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');

  const input = ((await Actor.getInput()) || {}) as Record<string, unknown>;
  const productUrl = clean(input.productUrl || input.url || '', 2500);
  if (!/^https?:\/\//i.test(productUrl)) throw new Error('productUrl is required');

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
  const productId = productIdFromUrl(productUrl);

  console.log(`SPEC_START | url=${productUrl}`);
  const extracted = await extractProduct(productUrl);
  console.log(`SPEC_ROOT | found=${extracted.rootCount > 0} | count=${extracted.rootCount}`);
  console.log(`SPEC_TITLE | found=${extracted.specFound} | text=${extracted.specFound ? 'Specifications' : ''}`);
  console.log(`SPEC_SECTION_TEXT | ${JSON.stringify(extracted.specFound ? 'Specifications section present' : '')}`);
  console.log(`SPEC_PAGE_TITLE | ${JSON.stringify(extracted.title)}`);
  console.log(`SPEC_BODY_SAMPLE | ${JSON.stringify(extracted.bodyTextSample)}`);
  console.log(`SPEC_HTML_LENGTH | ${extracted.html.length}`);
  console.log(`SPEC_HTML_HAS_SPEC_CLASS | ${/pdp-mod-specification/i.test(extracted.html)}`);
  console.log(`SPEC_HTML_HAS_SPEC_ROWS | ${/specification-keys/i.test(extracted.html)}`);
  console.log(`SPEC_EXTRACTED | count=${Object.keys(extracted.specs).length} | final=${extracted.finalUrl}`);
  console.log(`SPECIFICATIONS | ${JSON.stringify(extracted.specs)}`);

  if (!Object.keys(extracted.specs).length) {
    await Actor.pushData({
      url: productUrl,
      status: 'no_verified_specs',
      specifications: {},
      diagnostic: {
        rootCount: extracted.rootCount,
        specFound: extracted.specFound,
        finalUrl: extracted.finalUrl,
        title: extracted.title,
        bodyTextSample: extracted.bodyTextSample,
        htmlHasSpecClass: /pdp-mod-specification/i.test(extracted.html),
        htmlHasSpecRows: /specification-keys/i.test(extracted.html)
      }
    });
    console.log('SPEC_DONE | no verified specs');
    await Actor.exit();
    return;
  }

  const { data: existing, error: existingError } = await supabase
    .from('products')
    .select('id,title,price,image,link,reviews,rating,specifications')
    .eq('link', productUrl)
    .limit(1)
    .maybeSingle();
  if (existingError) throw existingError;

  const current = existing?.specifications && typeof existing.specifications === 'object' && !Array.isArray(existing.specifications)
    ? existing.specifications as Record<string, unknown>
    : {};

  const merged: Record<string, unknown> = { ...current, ...extracted.specs };
  const payload = {
    title: clean(existing?.title || input.title || 'Daraz Product', 500),
    price: Number(existing?.price || 0),
    currency: 'NPR',
    image: existing?.image || null,
    link: productUrl,
    reviews: existing?.reviews ?? null,
    rating: existing?.rating ?? null,
    search_term: 'product-url-specification',
    website: 'Daraz Nepal',
    marketplace_id: MARKETPLACE_ID,
    external_id: productId,
    specifications: merged
  };

  const { data: saved, error: saveError } = await supabase
    .from('products')
    .upsert(payload, { onConflict: 'marketplace_id,external_id' })
    .select('id')
    .single();
  if (saveError) throw saveError;

  await supabase.from('product_enrichment_queue').upsert({
    product_id: saved.id,
    brand: merged.Brand || null,
    model: merged.Model || null,
    product_type: merged['Product Type'] || null,
    parse_status: 'parsed',
    reason: 'Apify product URL specification actor',
    specifications: merged,
    updated_at: new Date().toISOString()
  }, { onConflict: 'product_id' });

  await Actor.pushData({
    url: productUrl,
    status: 'updated',
    specifications: merged
  });

  console.log(`SPEC_DONE | saved=${Object.keys(extracted.specs).length}`);
  await Actor.exit();
}

main().catch(async error => {
  console.error(error);
  try { await Actor.fail(); } catch {}
});