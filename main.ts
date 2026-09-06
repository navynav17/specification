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
const UI_NOISE = /^(more|from|more .+ from|no ratings?|ratings?|add to wishlist|share|report|quantity|out of stock|in stock|buy now|add to cart|sold by|delivery|cash on delivery|free shipping|emi|flash sale|choice|follow|chat now|message)$/i;
const CANONICAL: Record<string, string> = {
  brand: 'Brand', 'brand name': 'Brand', model: 'Model', 'model name': 'Model',
  colour: 'Color', color: 'Color', 'color family': 'Color Family',
  capacity: 'Capacity', type: 'Product Type', 'product type': 'Product Type',
  warranty: 'Warranty', 'warranty period': 'Warranty', weight: 'Weight',
  dimension: 'Dimensions', dimensions: 'Dimensions'
};
const SPEC_LABEL = /^(brand|brand name|model|model name|series|color|colour|color family|ram|ram memory|memory|storage|storage capacity|rom|display|screen|screen size|resolution|refresh rate|processor|cpu|gpu|graphics|chipset|operating system|os|camera|rear camera|front camera|battery|battery capacity|network|sim|sim type|connectivity|wifi|bluetooth|ports?|usb|hdmi|dimensions?|weight|capacity|power|power consumption|voltage|warranty|warranty period|condition|product type|panel|panel type|brightness|response time|printer type|print speed|paper size|lens|sensor|megapixel|zoom|video|refrigerant|energy rating|wash capacity|spin speed|cooling capacity|inverter|tonnage|door type|installation type|material|number of doors|freezer capacity|refrigerator capacity|energy class|compressor type|defrost|cooling system|noise level|annual energy consumption|country of origin|motor type|fuel type|horsepower|screen technology|graphics memory|storage type|operating frequency|power consumption|voltage range|input|output|interface|connector|compatibility|water capacity|load capacity|temperature range)$/i;

function canonicalKey(key: string) {
  const k = clean(key, 120).toLowerCase();
  return CANONICAL[k] || clean(key, 120);
}

function looksLikeRealSpecKey(key: string) {
  return SPEC_LABEL.test(clean(key, 120));
}

function looksLikeRealSpecValue(value: string) {
  const v = clean(value, 350);
  if (!v || BAD_VALUE.test(v) || UI_NOISE.test(v)) return false;
  if (/^https?:\/\//i.test(v) || /^data:/i.test(v) || /<[^>]+>/i.test(v)) return false;
  if (/\b(react|webpack|next\.js|tailwind|hydration|crossorigin)\b/i.test(v)) return false;
  if (/^more\s+(kitchen|mobile|computer|electronics|home|appliances|products?)/i.test(v)) return false;
  if (/\b(no ratings?|add to wishlist|out of stock|in stock)\b/i.test(v)) return false;
  return true;
}

function addSpec(out: Record<string, string>, key: unknown, value: unknown) {
  const rawKey = clean(key, 120);
  const k = canonicalKey(rawKey);
  const v = clean(value, 350);
  if (!k || BAD_KEY.test(k) || !looksLikeRealSpecValue(v) || !looksLikeRealSpecKey(k)) return;
  out[k] = out[k] && out[k] !== v ? `${out[k]}; ${v}` : v;
}

function collectNestedSpecs(root: unknown, out: Record<string, string>) {
  if (!root || typeof root !== 'object') return;
  if (Array.isArray(root)) {
    for (const x of root) collectNestedSpecs(x, out);
    return;
  }
  for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
    if (BAD_KEY.test(k)) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      if (looksLikeRealSpecKey(k)) addSpec(out, k, v);
    } else {
      collectNestedSpecs(v, out);
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500);

    // Scroll through the product page so lazy-loaded specification content is rendered.
    for (let i = 0; i < 7; i++) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(1500);

    const result = await page.evaluate(`(() => {
      const clean = (v) => String(v ?? '').replace(/\\s+/g, ' ').trim();
      const rows = [];
      const seen = new Set();
      const add = (k, v) => {
        k = clean(k); v = clean(v);
        if (!k || !v) return;
        const sig = k + '\\0' + v;
        if (!seen.has(sig)) { seen.add(sig); rows.push([k, v]); }
      };

      // Daraz places product specifications inside this container.
      const root = document.querySelector('div.pdp-product-details');
      if (root) {
        for (const el of root.querySelectorAll('tr')) {
          const cells = Array.from(el.querySelectorAll('th,td')).map(x => clean(x.textContent)).filter(Boolean);
          if (cells.length >= 2) add(cells[0], cells.slice(1).join(' | '));
        }

        for (const el of root.querySelectorAll('dt')) {
          const dd = el.nextElementSibling;
          if (dd) add(el.textContent, dd.textContent);
        }

        for (const el of Array.from(root.querySelectorAll('li,p,span,div'))) {
          const t = clean(el.textContent);
          if (t.length < 1 || t.length > 220) continue;

          // key:value inside a single element
          const m = t.match(/^([^:]{2,100}):\\s*(.{1,180})$/);
          if (m) add(m[1], m[2]);

          // Common Daraz layout: a label element followed by a value element.
          const direct = el.children.length === 0 ? el : null;
          if (direct) {
            const parent = el.parentElement;
            if (parent && parent.children.length === 2) {
              const siblings = Array.from(parent.children).map(x => clean(x.textContent));
              if (siblings.length === 2) add(siblings[0], siblings[1]);
            }
          }
        }
      }

      const bodyText = clean(document.body?.innerText || '');
      const html = root?.outerHTML || '';
      const scripts = Array.from(document.scripts).map(s => s.textContent || '').filter(Boolean).join('\\n');
      return { rows, bodyText, html, scripts, url: location.href, rootFound: !!root, rootText: clean(root?.innerText || '') };
    })()`);

    const specs: Record<string, string> = {};
    for (const [k, v] of result.rows as Array<[string, string]>) addSpec(specs, k, v);

    // Search serialized data only for explicit spec keys.
    const rawSources = `${result.html}\n${result.scripts}`;
    for (const marker of ['specifications', 'specification', 'attributes', 'skuAttributeMap']) {
      let from = 0;
      while (true) {
        const idx = rawSources.indexOf(marker, from);
        if (idx < 0) break;
        const start = rawSources.indexOf('{', idx);
        if (start < 0) break;
        let depth = 0, inString = false, escaped = false, foundEnd = -1;
        for (let i = start; i < Math.min(rawSources.length, start + 500000); i++) {
          const ch = rawSources[i];
          if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
          }
          if (ch === '"') inString = true;
          else if (ch === '{') depth++;
          else if (ch === '}' && --depth === 0) { foundEnd = i; break; }
        }
        if (foundEnd > 0) {
          try { collectNestedSpecs(JSON.parse(rawSources.slice(start, foundEnd + 1)), specs); } catch {}
        }
        from = idx + marker.length;
      }
    }

    await context.close();
    return {
      specs,
      title: clean(result.bodyText.slice(0, 500), 500),
      finalUrl: result.url,
      bodyLength: result.bodyText.length,
      rootFound: result.rootFound,
      rootText: result.rootText
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
  console.log(`SPEC_CONTAINER | found=${extracted.rootFound} | chars=${extracted.rootText.length}`);
  console.log(`SPEC_CONTAINER_TEXT | ${JSON.stringify(extracted.rootText)}`);
  console.log(`SPEC_EXTRACTED | count=${Object.keys(extracted.specs).length} | final=${extracted.finalUrl} | bodyChars=${extracted.bodyLength}`);
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
    title: clean(existing?.title || input.title || extracted.title || 'Daraz Product', 500),
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