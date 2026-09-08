import { Actor } from 'apify';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://foupthwcnnskqlzhoyep.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const clean = (v: unknown, max = 500) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const productIdFromUrl = (url: string) => url.match(/(?:\/i|\/products\/[^?#]*?-i)(\d+)/i)?.[1] || url;

const UI_NOISE = /^(more|from|no ratings?|ratings?|add to wishlist|share|report|quantity|out of stock|in stock|more kitchen appliances|more .* from|buy now|add to cart|sold by|delivery|cash on delivery|free shipping|emi|flash sale|choice|follow|chat now|message)$/i;
const BAD_VALUE = /^(img|image|text|script|style|div|span|html|body|null|undefined)$/i;

function looksLikeRealValue(value: string) {
  const v = clean(value, 350);
  if (!v || BAD_VALUE.test(v) || UI_NOISE.test(v)) return false;
  if (/^https?:\/\//i.test(v) || /^data:/i.test(v) || /<[^>]+>/i.test(v)) return false;
  return true;
}

function addSpec(out: Record<string, string>, key: unknown, value: unknown) {
  const k = clean(key, 120);
  const v = clean(value, 350);
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
        title: document.title,
        url: location.href
      };
    })()`);

    const specs: Record<string, string> = {};
    for (const [k, v] of result.rows as Array<[string, string]>) addSpec(specs, k, v);
    await context.close();
    return { specs, ...result };
  } finally {
    await browser.close();
  }
}

async function saveSpecs(supabase: any, product: any, specs: Record<string, string>) {
  const current = product.specifications && typeof product.specifications === 'object' && !Array.isArray(product.specifications)
    ? product.specifications as Record<string, unknown> : {};
  const merged = { ...current, ...specs };
  const { error } = await supabase.from('products').update({ specifications: merged }).eq('id', product.id);
  if (error) throw error;
  return merged;
}

async function processOne(supabase: any, product: any, index: number, total: number) {
  const url = clean(product.link, 2500);
  console.log(`PRODUCT_START | ${index}/${total} | id=${product.id} | url=${url}`);
  if (!/^https?:\/\/.*daraz\.com\.np/i.test(url)) {
    console.log(`PRODUCT_SKIP | ${index}/${total} | reason=not-daraz-url`);
    return 'skipped';
  }
  try {
    const extracted = await extractProduct(url);
    console.log(`SPEC_ROOT | found=${extracted.rootCount > 0} | count=${extracted.rootCount}`);
    console.log(`SPEC_TITLE | found=${extracted.specFound}`);
    console.log(`SPEC_EXTRACTED | count=${Object.keys(extracted.specs).length} | final=${extracted.url}`);
    if (!Object.keys(extracted.specs).length) {
      console.log(`PRODUCT_NO_SPECS | ${index}/${total}`);
      return 'no_specs';
    }
    const merged = await saveSpecs(supabase, product, extracted.specs);
    await supabase.from('product_enrichment_queue').upsert({
      product_id: product.id,
      brand: merged.Brand || null,
      model: merged.Model || null,
      product_type: merged['Product Type'] || null,
      parse_status: 'parsed',
      reason: 'Apify product URL specification actor',
      specifications: merged,
      updated_at: new Date().toISOString()
    }, { onConflict: 'product_id' });
    console.log(`PRODUCT_DONE | ${index}/${total} | specs=${Object.keys(extracted.specs).length}`);
    return 'success';
  } catch (error) {
    console.error(`PRODUCT_FAILED | ${index}/${total} | ${error instanceof Error ? error.message : String(error)}`);
    return 'failed';
  }
}

async function runAll(supabase: any) {
  const products: any[] = [];
  const pageSize = 200;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.from('products')
      .select('id,title,link,specifications')
      .ilike('website', '%daraz%')
      .ilike('link', '%daraz.com.np%')
      .not('link', 'is', null)
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;
    products.push(...data);
    console.log(`DB_PAGE | offset=${offset} | count=${data.length}`);
    if (data.length < pageSize) break;
  }

  console.log(`RUN_ALL_START | total=${products.length}`);
  const counts = { success: 0, no_specs: 0, failed: 0, skipped: 0 };
  for (let i = 0; i < products.length; i++) {
    const status = await processOne(supabase, products[i], i + 1, products.length);
    counts[status as keyof typeof counts]++;
  }
  console.log(`RUN_ALL_DONE | total=${products.length} | success=${counts.success} | no_specs=${counts.no_specs} | failed=${counts.failed} | skipped=${counts.skipped}`);
  await Actor.pushData({ status: 'run_all_complete', total: products.length, ...counts });
}

async function main() {
  await Actor.init();
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  const input = ((await Actor.getInput()) || {}) as Record<string, unknown>;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const runAllMode = input.runAll === true || input.runAll === 'true' || input.mode === 'all';

  if (runAllMode) {
    await runAll(supabase);
    await Actor.exit();
    return;
  }

  const productUrl = clean(input.productUrl || input.url || '', 2500);
  if (!/^https?:\/\//i.test(productUrl)) throw new Error('productUrl is required, or set runAll=true');
  const { data: product, error } = await supabase.from('products')
    .select('id,title,link,specifications')
    .eq('link', productUrl).limit(1).maybeSingle();
  if (error) throw error;
  if (!product) throw new Error(`Product not found in Supabase: ${productUrl}`);
  const status = await processOne(supabase, product, 1, 1);
  if (status === 'failed') throw new Error('Product processing failed');
  await Actor.exit();
}

main().catch(async error => {
  console.error(error);
  try { await Actor.fail(); } catch {}
});