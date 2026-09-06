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
const SPEC_LABEL = /^(brand|brand name|model|model name|series|color|colour|color family|ram|ram memory|memory|storage|storage capacity|rom|display|screen|screen size|resolution|refresh rate|processor|cpu|gpu|graphics|chipset|operating system|os|camera|rear camera|front camera|battery|battery capacity|network|sim|sim type|connectivity|wifi|bluetooth|ports?|usb|hdmi|dimensions?|weight|capacity|power|power consumption|voltage|warranty|warranty period|condition|product type|panel|panel type|brightness|response time|printer type|print speed|paper size|lens|sensor|megapixel|zoom|video|refrigerant|energy rating|wash capacity|spin speed|cooling capacity|inverter|tonnage|door type|installation type|material|number of doors|freezer capacity|refrigerator capacity|energy class|compressor type|defrost|cooling system|noise level|annual energy consumption|country of origin|motor type|fuel type|horsepower|screen technology|graphics memory|storage type|operating frequency|voltage range|input|output|interface|connector|compatibility|water capacity|load capacity|temperature range)$/i;

function canonicalKey(key: string) {
  const k = clean(key, 120).toLowerCase();
  return CANONICAL[k] || clean(key, 120);
}
function looksLikeRealSpecKey(key: string) { return SPEC_LABEL.test(clean(key, 120)); }
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
  const k = canonicalKey(clean(key, 120));
  const v = clean(value, 350);
  if (!k || BAD_KEY.test(k) || !looksLikeRealSpecValue(v) || !looksLikeRealSpecKey(k)) return;
  out[k] = out[k] && out[k] !== v ? `${out[k]}; ${v}` : v;
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
    for (let i = 0; i < 7; i++) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(1500);

    const result = await page.evaluate(`(() => {
      const clean = (v) => String(v ?? '').replace(/\\s+/g, ' ').trim();
      const norm = (v) => clean(v).toLowerCase();
      const rows = [];
      const add = (k, v) => { k = clean(k); v = clean(v); if (k && v) rows.push([k, v]); };
      const all = Array.from(document.querySelectorAll('*'));

      const exactSpecs = all.filter(el => norm(el.textContent) === 'specifications');
      const fuzzySpecs = all.filter(el => norm(el.textContent).startsWith('specifications') && clean(el.textContent).length < 1000);
      const classMatches = all.filter(el => typeof el.className === 'string' && /pdp-product-details/i.test(String(el.className)));

      // Collect likely specification section candidates from the actual rendered DOM.
      let section = null;
      let heading = null;
      const candidateList = [...exactSpecs, ...fuzzySpecs].sort((a, b) => a.children.length - b.children.length);
      if (candidateList.length) {
        heading = candidateList[0];
        let node = heading;
        for (let i = 0; i < 8 && node.parentElement; i++) {
          const p = node.parentElement;
          const txt = clean(p.innerText || p.textContent || '');
          if (txt.toLowerCase().includes('specifications') && txt.length > clean(heading.textContent).length && txt.length < 30000) {
            section = p;
          }
          if (p.querySelectorAll('table,tr,li,dt').length > 0 && txt.length < 15000) {
            section = p;
            break;
          }
        }
      }

      if (section) {
        for (const el of section.querySelectorAll('tr')) {
          const cells = Array.from(el.querySelectorAll('th,td')).map(x => clean(x.textContent)).filter(Boolean);
          if (cells.length >= 2) add(cells[0], cells.slice(1).join(' | '));
        }
        for (const el of section.querySelectorAll('dt')) {
          const dd = el.nextElementSibling;
          if (dd) add(el.textContent, dd.textContent);
        }
        for (const parent of Array.from(section.querySelectorAll('*'))) {
          if (parent.children.length !== 2) continue;
          const parts = Array.from(parent.children).map(x => clean(x.textContent));
          if (parts.length === 2 && parts[0].length <= 120 && parts[1].length <= 350) add(parts[0], parts[1]);
        }
      }

      return {
        rows,
        url: location.href,
        classMatches: classMatches.slice(0, 20).map(el => ({ tag: el.tagName, cls: String(el.className), text: clean(el.innerText || el.textContent || '').slice(0, 1000) })),
        exactSpecs: exactSpecs.slice(0, 20).map(el => ({ tag: el.tagName, cls: String(el.className || ''), text: clean(el.textContent).slice(0, 500), html: String(el.outerHTML).slice(0, 3000) })),
        fuzzySpecs: fuzzySpecs.slice(0, 20).map(el => ({ tag: el.tagName, cls: String(el.className || ''), text: clean(el.textContent).slice(0, 500), html: String(el.outerHTML).slice(0, 3000) })),
        sectionFound: !!section,
        sectionText: clean(section?.innerText || section?.textContent || '').slice(0, 15000)
      };
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
  const input = ((await Actor.getInput()) || {}) as Record<string, unknown>;
  const productUrl = clean(input.productUrl || input.url || '', 2500);
  if (!/^https?:\/\//i.test(productUrl)) throw new Error('productUrl is required');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const productId = productIdFromUrl(productUrl);
  console.log(`SPEC_START | url=${productUrl}`);
  const extracted = await extractProduct(productUrl);
  console.log(`SPEC_CONTAINER | pdp-product-details matches=${extracted.classMatches.length}`);
  console.log(`SPEC_CLASS_SAMPLES | ${JSON.stringify(extracted.classMatches)}`);
  console.log(`SPEC_EXACT_SPECS | ${JSON.stringify(extracted.exactSpecs)}`);
  console.log(`SPEC_FUZZY_SPECS | ${JSON.stringify(extracted.fuzzySpecs)}`);
  console.log(`SPEC_SECTION | found=${extracted.sectionFound}`);
  console.log(`SPEC_SECTION_TEXT | ${JSON.stringify(extracted.sectionText)}`);
  console.log(`SPEC_EXTRACTED | count=${Object.keys(extracted.specs).length} | final=${extracted.finalUrl}`);
  console.log(`SPECIFICATIONS | ${JSON.stringify(extracted.specs)}`);

  const { data: existing, error: existingError } = await supabase.from('products').select('id,title,price,image,link,reviews,rating,specifications').eq('link', productUrl).limit(1).maybeSingle();
  if (existingError) throw existingError;
  const current = existing?.specifications && typeof existing.specifications === 'object' && !Array.isArray(existing.specifications) ? existing.specifications as Record<string, unknown> : {};
  if (!Object.keys(extracted.specs).length) {
    await Actor.pushData({ url: productUrl, status: 'no_verified_specs', specifications: current, diagnostic: { classMatches: extracted.classMatches, exactSpecs: extracted.exactSpecs, fuzzySpecs: extracted.fuzzySpecs, sectionText: extracted.sectionText } });
    console.log('SPEC_DONE | no verified specs');
    await Actor.exit(); return;
  }
  const merged: Record<string, unknown> = { ...current, ...extracted.specs };
  const payload = { title: clean(existing?.title || input.title || 'Daraz Product', 500), price: Number(existing?.price || 0), currency: 'NPR', image: existing?.image || null, link: productUrl, reviews: existing?.reviews ?? null, rating: existing?.rating ?? null, search_term: 'product-url-specification', website: 'Daraz Nepal', marketplace_id: MARKETPLACE_ID, external_id: productId, specifications: merged };
  const { data: saved, error: saveError } = await supabase.from('products').upsert(payload, { onConflict: 'marketplace_id,external_id' }).select('id').single();
  if (saveError) throw saveError;
  await supabase.from('product_enrichment_queue').upsert({ product_id: saved.id, brand: merged.Brand || null, model: merged.Model || null, product_type: merged['Product Type'] || null, parse_status: 'parsed', reason: 'Apify product URL specification actor', specifications: merged, updated_at: new Date().toISOString() }, { onConflict: 'product_id' });
  await Actor.pushData({ url: productUrl, status: 'updated', specifications: merged });
  console.log(`SPEC_DONE | saved=${Object.keys(extracted.specs).length}`);
  await Actor.exit();
}
main().catch(async error => { console.error(error); try { await Actor.fail(); } catch {} });