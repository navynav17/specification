import { Actor } from 'apify';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://foupthwcnnskqlzhoyep.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MARKETPLACE_ID = process.env.MARKETPLACE_ID || '6a4f8822-e1bc-4e8b-be61-4d1a400f3c13';

const clean = (v: unknown, max = 500) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const productIdFromUrl = (url: string) => url.match(/(?:\/i|\/products\/[^?#]*?-i)(\d+)/i)?.[1] || url;

const BAD_KEY = /^(type|class|id|src|href|style|alt|width|height|role|loading|decoding|itemprop|itemtype|itemscope|crossorigin|aria-|data-|script|css|html|body)$/i;
const BAD_VALUE = /^(img|image|text|script|style|div|span|html|body|null|undefined)$/i;
const CANONICAL: Record<string, string> = {
  brand: 'Brand', 'brand name': 'Brand', model: 'Model', 'model name': 'Model',
  colour: 'Color', color: 'Color', 'color family': 'Color Family', capacity: 'Capacity',
  type: 'Product Type', 'product type': 'Product Type', warranty: 'Warranty',
  'warranty period': 'Warranty', weight: 'Weight', dimension: 'Dimensions', dimensions: 'Dimensions'
};

function canonicalKey(key: string) {
  const k = clean(key, 120).toLowerCase();
  return CANONICAL[k] || clean(key, 120);
}

function addSpec(out: Record<string, string>, key: unknown, value: unknown) {
  const k = canonicalKey(String(key ?? ''));
  const v = clean(value, 350);
  if (!k || BAD_KEY.test(k) || BAD_VALUE.test(v)) return;
  if (!v || /^https?:\/\//i.test(v) || /^data:/i.test(v) || /<[^>]+>/i.test(v)) return;
  if (/\b(no ratings?|add to wishlist|out of stock|in stock|buy now|add to cart|sold by|delivery|cash on delivery|free shipping|flash sale|choice|follow|chat now|message|more kitchen appliances|more from)\b/i.test(v)) return;
  out[k] = v;
}

function collectNestedSpecs(root: unknown, out: Record<string, string>) {
  if (!root || typeof root !== 'object') return;
  if (Array.isArray(root)) { for (const x of root) collectNestedSpecs(x, out); return; }
  for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
    if (BAD_KEY.test(k)) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') addSpec(out, k, v);
    else collectNestedSpecs(v, out);
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500);

    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(1500);

    const result = await page.evaluate(`(() => {
      const clean = (v) => String(v ?? '').replace(/\\s+/g, ' ').trim();
      const headings = Array.from(document.querySelectorAll('div.pdp-product-details *'))
        .filter(el => clean(el.textContent) === 'Specifications');

      const heading = headings.find(el => {
        const cls = String(el.className || '');
        return cls.includes('title') || cls.includes('spec') || /^(H[1-6]|DIV|SPAN|P)$/i.test(el.tagName);
      }) || headings[0] || null;

      let section = null;
      if (heading) {
        let node = heading.parentElement;
        for (let i = 0; node && i < 5; i++, node = node.parentElement) {
          const text = clean(node.textContent);
          if (text.length > 25 && text.length < 20000 && node.querySelectorAll('tr,dt,dd,li').length > 0) {
            section = node;
            break;
          }
        }
        if (!section) section = heading.parentElement;
      }

      const rows = [];
      const seen = new Set();
      const add = (k, v) => {
        k = clean(k); v = clean(v);
        if (!k || !v) return;
        const sig = k + '\\0' + v;
        if (!seen.has(sig)) { seen.add(sig); rows.push([k, v]); }
      };

      if (section) {
        for (const el of section.querySelectorAll('tr')) {
          const cells = Array.from(el.querySelectorAll('th,td')).map(x => clean(x.textContent)).filter(Boolean);
          if (cells.length >= 2) add(cells[0], cells.slice(1).join(' | '));
        }
        for (const el of section.querySelectorAll('dt')) {
          const dd = el.nextElementSibling;
          if (dd) add(el.textContent, dd.textContent);
        }

        const leafs = Array.from(section.querySelectorAll('li,p,span,div')).filter(el => el.children.length === 0);
        for (const el of leafs) {
          const t = clean(el.textContent);
          if (!t || t.length > 300) continue;
          const m = t.match(/^([^:]{2,100}):\\s*(.{1,220})$/);
          if (m) add(m[1], m[2]);
        }

        // Common Daraz specification structure: consecutive text nodes/elements inside a row.
        for (const row of Array.from(section.querySelectorAll('div'))) {
          const children = Array.from(row.children).filter(x => clean(x.textContent));
          if (children.length === 2) {
            const a = clean(children[0].textContent);
            const b = clean(children[1].textContent);
            if (a && b && a.length <= 100 && b.length <= 300) add(a, b);
          }
        }
      }

      const root = document.querySelector('div.pdp-product-details');
      const rootText = clean(root?.innerText || '');
      const sectionText = clean(section?.innerText || '');
      return { rows, url: location.href, headingFound: !!heading, rootFound: !!root, rootText, sectionText };
    })()`);

    const specs: Record<string, string> = {};
    for (const [k, v] of result.rows as Array<[string, string]>) addSpec(specs, k, v);

    return {
      specs,
      finalUrl: result.url,
      rootFound: result.rootFound,
      headingFound: result.headingFound,
      rootText: result.rootText,
      sectionText: result.sectionText
    };
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

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const productId = productIdFromUrl(productUrl);

  console.log(`SPEC_START | url=${productUrl}`);
  const extracted = await extractProduct(productUrl);
  console.log(`SPEC_ROOT | found=${extracted.rootFound} | chars=${extracted.rootText.length}`);
  console.log(`SPEC_TITLE | found=${extracted.headingFound}`);
  console.log(`SPEC_SECTION_TEXT | ${JSON.stringify(extracted.sectionText)}`);
  console.log(`SPEC_EXTRACTED | count=${Object.keys(extracted.specs).length} | final=${extracted.finalUrl}`);
  console.log(`SPECIFICATIONS | ${JSON.stringify(extracted.specs)}`);

  const { data: existing, error: existingError } = await supabase.from('products')
    .select('id,title,price,image,link,reviews,rating,specifications')
    .eq('link', productUrl).limit(1).maybeSingle();
  if (existingError) throw existingError;

  const current = existing?.specifications && typeof existing.specifications === 'object' && !Array.isArray(existing.specifications)
    ? existing.specifications as Record<string, unknown> : {};

  if (!Object.keys(extracted.specs).length) {
    await Actor.pushData({ url: productUrl, status: 'no_verified_specs', specifications: current });
    console.log('SPEC_DONE | no verified specs');
    await Actor.exit();
    return;
  }

  const merged: Record<string, unknown> = { ...current, ...extracted.specs };
  const payload = {
    title: clean(existing?.title || input.title || 'Daraz Product', 500),
    price: Number(existing?.price || 0), currency: 'NPR', image: existing?.image || null, link: productUrl,
    reviews: existing?.reviews ?? null, rating: existing?.rating ?? null, search_term: 'product-url-specification',
    website: 'Daraz Nepal', marketplace_id: MARKETPLACE_ID, external_id: productId, specifications: merged
  };
  const { data: saved, error: saveError } = await supabase.from('products')
    .upsert(payload, { onConflict: 'marketplace_id,external_id' }).select('id').single();
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

  await Actor.pushData({ url: productUrl, status: 'updated', specifications: merged });
  console.log(`SPEC_DONE | saved=${Object.keys(extracted.specs).length}`);
  await Actor.exit();
}

main().catch(async error => {
  console.error(error);
  try { await Actor.fail(); } catch {}
});