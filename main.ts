import { Actor } from 'apify';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://foupthwcnnskqlzhoyep.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DARAZ_HOST = 'daraz.com.np';

const clean = (v: unknown, max = 500) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

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

const ALLOWED_KEYS = /^(brand|brand name|model|model name|colour|color|color family|capacity|product type|type|warranty|warranty period|weight|dimension|dimensions|sku|storage|ram|display|screen|battery|camera|operating system|memory|processor|chipset|refresh rate|resolution|sim|network|material|power|voltage|frequency|number of doors|refrigerator type|refrigerator capacity|charging|charging speed|battery capacity|rom|internal storage|main camera|front camera|screen size|screen type|storage capacity|os version|graphics|gpu|cpu|connectivity|bluetooth|wifi|ports|usb|series|generation|processor speed|cores|threads|dedicated graphics|integrated graphics|screen resolution|panel type|touchscreen|backlit keyboard|keyboard layout|webcam|camera resolution|battery life)$/i;
const BAD_KEY = /^(class|class name|style|display|position|width|height|top|left|right|bottom|margin|padding|background|font|font-family|font-size|line-height|opacity|visibility|z-index|float|text|overflow|content|skuid|brandid|lzd|selector|tag|node|element|href|src|id|name)$/i;
const BAD_VALUE = /^(img|image|text|script|style|div|span|html|body|null|undefined|inline-block|block|none|relative|absolute|fixed|visible|hidden|auto|inherit|initial)$/i;
const BAD_VALUE_PARTS = /(^|[\s:/_-])(?:lzd|skuId|brand_id|age-restriction|popups|inline-block|javascript)([\s:/_-]|$)/i;
const UI_NOISE = /\b(no ratings?|add to wishlist|out of stock|in stock|buy now|add to cart|sold by|delivery|cash on delivery|free shipping|more kitchen appliances|quantity|wishlist|share|report|chat now)\b/i;

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
      const roots = Array.from(document.querySelectorAll('.pdp-mod-specification'));
      const rows = [];
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
      const specRoot = roots.find(root => Array.from(root.querySelectorAll('.pdp-mod-section-title'))
        .some(el => clean(el.textContent).toLowerCase() === 'specifications')) || null;
      return {
        rows,
        rootCount: roots.length,
        specFound: !!specRoot,
        sectionText: clean(specRoot?.innerText || '').slice(0, 15000),
        url: location.href
      };
    })()`);

    const specs: Record<string, string> = {};
    for (const [k, v] of result.rows as Array<[string, string]>) addSpec(specs, k, v);
    await context.close();
    return { specs, finalUrl: result.url, rootCount: result.rootCount, specFound: result.specFound, sectionText: result.sectionText };
  } finally {
    await browser.close();
  }
}

async function main() {
  await Actor.init();
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Process all pending Daraz Nepal product URLs.
  const pageSize = 200;
  let offset = 0;
  let totalSelected = 0;
  let totalProcessed = 0;
  let totalSaved = 0;
  let totalNoSpecs = 0;

  while (true) {
    const { data: pending, error } = await supabase
      .from('products')
      .select('id,title,link,created_at')
      .not('link', 'is', null)
      .like('link', '%daraz.com.np%')
      .not('link', 'like', '%/categories/%')
      .order('created_at', { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!pending?.length) break;

    const candidates = pending.filter((p: any) => {
      try {
        const u = new URL(p.link);
        return (u.hostname === DARAZ_HOST || u.hostname === `www.${DARAZ_HOST}`) && /\/products\//i.test(u.pathname) && /-i\d+\.html/i.test(u.pathname);
      } catch {
        return false;
      }
    });

    for (const selected of candidates) {
      const { data: already, error: alreadyError } = await supabase.from('updated_specifications').select('id').eq('product_id', selected.id).limit(1).maybeSingle();
      if (alreadyError) throw alreadyError;
      if (already) continue;

      totalSelected++;
      const productUrl = clean(selected.link, 2500);
      console.log(`SPEC_START | daraz_url=${productUrl} | product_id=${selected.id}`);

      try {
        const extracted = await extractProduct(productUrl);
        const specs = extracted.specs;
        totalProcessed++;

        console.log(`SPEC_ROOT | found=${extracted.specFound} | count=${extracted.rootCount}`);
        console.log(`SPEC_EXTRACTED | count=${Object.keys(specs).length} | final=${extracted.finalUrl}`);
        console.log(`SPECIFICATIONS | ${JSON.stringify(specs)}`);

        if (Object.keys(specs).length === 0) {
          totalNoSpecs++;
          await Actor.pushData({ url: productUrl, status: 'no_verified_specs', productId: selected.id, specifications: {} });
          console.log(`SPEC_SKIP | product_id=${selected.id} | reason=no_verified_specs`);
          continue;
        }

        const { error: saveError } = await supabase.from('updated_specifications').upsert({
          product_id: selected.id,
          product_url: productUrl,
          specifications: specs,
          source: 'apify-specification',
          updated_at: new Date().toISOString()
        }, { onConflict: 'product_url' });
        if (saveError) throw saveError;

        totalSaved++;
        await Actor.pushData({ url: productUrl, status: 'updated', productId: selected.id, specifications: specs });
        console.log(`SPEC_DONE | saved=${Object.keys(specs).length} | table=updated_specifications | product_id=${selected.id}`);
      } catch (err) {
        totalProcessed++;
        console.error(`SPEC_ERROR | product_id=${selected.id} | error=${String(err)}`);
        await Actor.pushData({ url: productUrl, status: 'error', productId: selected.id, error: String(err) });
      }
    }

    offset += pageSize;
    if (pending.length < pageSize) break;
  }

  await Actor.pushData({ status: 'completed', mode: 'all_pending_daraz', selected: totalSelected, processed: totalProcessed, saved: totalSaved, noVerifiedSpecs: totalNoSpecs });
  console.log(`SPEC_BATCH_DONE | selected=${totalSelected} | processed=${totalProcessed} | saved=${totalSaved} | no_verified_specs=${totalNoSpecs}`);
  await Actor.exit();
}

main().catch(async error => {
  console.error(error);
  try { await Actor.fail(); } catch {}
});