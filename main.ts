import { Actor } from 'apify';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://foupthwcnnskqlzhoyep.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const clean = (v: unknown, max = 12000) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function stripHtml(value: string, max = 12000) {
  return clean(value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' '), max);
}

function looksLikeDescription(value: string) {
  const v = stripHtml(value, 12000);
  if (v.length < 30) return false;
  if (/^(description|product description|details)$/i.test(v)) return false;
  if (/^(resloadfail|undefined|null)$/i.test(v)) return false;
  return true;
}

function collectDescription(node: unknown, out: { value: string }, depth = 0) {
  if (depth > 12 || node == null || out.value) return;
  if (Array.isArray(node)) {
    for (const item of node) collectDescription(item, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  for (const [rawKey, rawValue] of Object.entries(node as Record<string, unknown>)) {
    const key = rawKey.toLowerCase().replace(/[-_\s]/g, '');
    if (typeof rawValue === 'string' && /^(description|productdescription|desc|descriptionhtml|productdesc|itemdescription|shortdescription|longdescription)$/.test(key)) {
      const candidate = stripHtml(rawValue, 12000);
      if (looksLikeDescription(candidate)) { out.value = candidate; return; }
    }
    if (rawValue && typeof rawValue === 'object') collectDescription(rawValue, out, depth + 1);
  }
}

function extractDescriptionFromText(text: string) {
  const out = { value: '' };
  const keyPattern = '(?:description|productDescription|desc|descriptionHtml|productDesc|itemDescription|shortDescription|longDescription)';
  const re = new RegExp(`[\\\"']${keyPattern}[\\\"']\\s*:\\s*[\\\"']((?:\\\\.|[^\\\"']){30,})[\\\"']`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    let candidate = match[1];
    try { candidate = JSON.parse(`"${candidate.replace(/"/g, '\\"')}"`); } catch {}
    candidate = stripHtml(candidate, 12000);
    if (looksLikeDescription(candidate)) { out.value = candidate; break; }
  }
  return out.value;
}

function detectChallenge(title: string, bodyText: string, html: string) {
  const sample = `${title}\n${bodyText.slice(0, 20000)}\n${html.slice(0, 50000)}`.toLowerCase();
  const markers = [
    'captcha', 'verify you are human', 'verify you\'re human', 'security check',
    'access denied', 'unusual traffic', 'robot check', 'are you a robot',
    'challenge', 'please verify', 'checking your browser'
  ];
  return markers.filter(marker => sample.includes(marker));
}

async function extractDescription(url: string) {
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
      const interesting = /(?:api|product|item|sku|detail|page|pdp)/i.test(responseUrl) || /json/i.test(contentType);
      if (!interesting) return;
      try {
        const text = await response.text();
        if (text && text.length <= 500000) {
          networkPayloads.push({ url: responseUrl, contentType, text });
          if (networkPayloads.length > 100) networkPayloads.shift();
        }
      } catch {}
    });

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log(`PAGE_RESPONSE | status=${response?.status() ?? 'none'} | url=${response?.url() || url}`);

    await page.waitForTimeout(5000);
    for (let i = 0; i < 7; i++) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(3000);

    const result = await page.evaluate(`(() => {
      const clean = (v) => String(v ?? '').replace(/\\s+/g, ' ').trim();
      const selectors = [
        '#module_product_detail.pdp-block.module',
        '#module_product_detail',
        '[id*="product_detail" i]',
        '[id*="product-description" i]',
        '[class*="product-description" i]',
        '[class*="pdp-block__product-description" i]'
      ];
      let descriptionRoot = null;
      for (const selector of selectors) {
        const found = document.querySelector(selector);
        if (found) { descriptionRoot = found; break; }
      }
      const description = descriptionRoot ? clean(descriptionRoot.textContent || '') : '';
      const bodyText = clean(document.body?.innerText || '');
      const bodyHtml = document.body?.innerHTML || '';
      const moduleHtml = descriptionRoot ? descriptionRoot.outerHTML : '';
      const applicationJson = Array.from(document.querySelectorAll('script[type="application/json"]')).map(s => s.textContent || '').filter(Boolean);
      const allScripts = Array.from(document.scripts).map(s => s.textContent || '').filter(t => t.length >= 20 && t.length <= 500000);
      const challengeSelectors = [
        '[id*="captcha" i]', '[class*="captcha" i]', '[id*="challenge" i]',
        '[class*="challenge" i]', 'iframe[src*="captcha" i]', 'iframe[src*="challenge" i]'
      ];
      const challengeElements = challengeSelectors.reduce((count, selector) => count + document.querySelectorAll(selector).length, 0);
      return {
        description,
        applicationJson,
        allScripts,
        title: document.title,
        url: location.href,
        bodyText,
        bodyHtml,
        moduleHtml,
        moduleFound: !!descriptionRoot,
        moduleTextLength: description.length,
        moduleHtmlLength: moduleHtml.length,
        bodyTextLength: bodyText.length,
        bodyHtmlLength: bodyHtml.length,
        challengeElements
      };
    })()`);

    const challengeMarkers = detectChallenge(result.title as string, result.bodyText as string, result.bodyHtml as string);
    console.log(`PAGE_DIAGNOSTIC | title=${clean(result.title, 300)} | finalUrl=${clean(result.url, 500)}`);
    console.log(`PAGE_DIAGNOSTIC | bodyTextLength=${result.bodyTextLength} | bodyHtmlLength=${result.bodyHtmlLength} | moduleFound=${result.moduleFound} | moduleTextLength=${result.moduleTextLength} | moduleHtmlLength=${result.moduleHtmlLength}`);
    console.log(`PAGE_DIAGNOSTIC | challengeElements=${result.challengeElements} | challengeMarkers=${challengeMarkers.length ? challengeMarkers.join(',') : 'none'} | applicationJson=${(result.applicationJson as string[]).length} | allScripts=${(result.allScripts as string[]).length} | networkPayloads=${networkPayloads.length}`);
    console.log(`PAGE_BODY_START | ${clean(result.bodyText, 1500)}`);
    if (result.moduleFound) console.log(`MODULE_TEXT_START | ${clean(result.description, 1500)}`);
    else console.log('MODULE_TEXT_START | NOT_FOUND');

    if (challengeMarkers.length || Number(result.challengeElements) > 0) {
      throw new Error(`ANTIBOT_CHALLENGE | markers=${challengeMarkers.join(',') || 'selector'} | title=${clean(result.title, 200)}`);
    }

    let description = result.description as string;
    let descriptionSource = description ? 'dom' : '';

    if (!description) {
      const html = await page.content();
      const moduleRe = /<[^>]*id=["']module_product_detail["'][^>]*>([\s\S]*?)<\/[^>]+>/i;
      const match = html.match(moduleRe);
      if (match) {
        const candidate = stripHtml(match[1], 12000);
        console.log(`HTML_MODULE_FALLBACK | chars=${candidate.length}`);
        if (looksLikeDescription(candidate)) {
          description = candidate;
          descriptionSource = 'html';
        }
      } else {
        console.log('HTML_MODULE_FALLBACK | module_not_found');
      }
    }

    if (!description) {
      for (const scriptText of (result.applicationJson as string[])) {
        try {
          const json = JSON.parse(scriptText);
          const found = { value: '' };
          collectDescription(json, found);
          if (found.value) {
            description = found.value;
            descriptionSource = 'html-json';
            console.log(`HTML_JSON_DESCRIPTION_MATCH | chars=${description.length}`);
            break;
          }
        } catch {}
      }
    }

    if (!description) {
      for (const scriptText of (result.allScripts as string[])) {
        try {
          const json = JSON.parse(scriptText);
          const found = { value: '' };
          collectDescription(json, found);
          if (found.value) {
            description = found.value;
            descriptionSource = 'script-json';
            console.log(`SCRIPT_JSON_DESCRIPTION_MATCH | chars=${description.length}`);
            break;
          }
        } catch {}
        const textMatch = extractDescriptionFromText(scriptText);
        if (textMatch) {
          description = textMatch;
          descriptionSource = 'script-text';
          console.log(`SCRIPT_TEXT_DESCRIPTION_MATCH | chars=${description.length}`);
          break;
        }
      }
    }

    if (!description) {
      for (const payload of networkPayloads) {
        try {
          const json = JSON.parse(payload.text);
          const found = { value: '' };
          collectDescription(json, found);
          if (found.value) {
            description = found.value;
            descriptionSource = 'network-json';
            console.log(`DESCRIPTION_NETWORK_MATCH | url=${payload.url} | chars=${description.length}`);
            break;
          }
        } catch {}
        const textMatch = extractDescriptionFromText(payload.text);
        if (textMatch) {
          description = textMatch;
          descriptionSource = 'network-text';
          console.log(`DESCRIPTION_NETWORK_TEXT_MATCH | url=${payload.url} | chars=${description.length}`);
          break;
        }
      }
    }

    if (!description) {
      const html = await page.content();
      const htmlMatch = extractDescriptionFromText(html);
      if (htmlMatch) {
        description = htmlMatch;
        descriptionSource = 'html-text';
        console.log(`HTML_TEXT_DESCRIPTION_MATCH | chars=${description.length}`);
      }
    }

    await context.close();
    return { description, descriptionSource, finalUrl: result.url, title: result.title, descriptionFound: !!description };
  } finally {
    await browser.close();
  }
}

async function saveDescription(supabase: any, product: any, description: string) {
  if (!description) return false;
  const { error } = await supabase.from('products').update({
    description,
    description_scraped: true,
    description_scraped_at: new Date().toISOString()
  }).eq('id', product.id);
  if (error) throw error;
  return true;
}

async function markDescriptionAttempted(supabase: any, product: any) {
  const { error } = await supabase.from('products').update({
    description_scraped: true,
    description_scraped_at: new Date().toISOString()
  }).eq('id', product.id);
  if (error) throw error;
}

async function processOne(supabase: any, product: any, index: number, total: number) {
  try {
    console.log(`PRODUCT_START | ${index}/${total} | ${product.link}`);
    const extracted = await extractDescription(product.link);
    console.log(`DESCRIPTION | found=${extracted.descriptionFound} | chars=${extracted.description.length} | source=${extracted.descriptionSource || 'none'}`);
    if (!extracted.description) {
      await markDescriptionAttempted(supabase, product);
      console.log(`PRODUCT_NO_DESCRIPTION | ${index}/${total}`);
      return 'no_description';
    }
    await saveDescription(supabase, product, extracted.description);
    await Actor.pushData({
      url: product.link,
      status: 'updated',
      description: extracted.description,
      descriptionSource: extracted.descriptionSource
    });
    console.log(`PRODUCT_DONE | ${index}/${total} | description=${extracted.description.length} chars`);
    return 'success';
  } catch (error) {
    console.error(`PRODUCT_FAILED | ${index}/${total} | ${error instanceof Error ? error.message : String(error)}`);
    return 'failed';
  }
}

async function runAll(supabase: any) {
  const pageSize = 200;
  let processed = 0, success = 0, failed = 0, noDescription = 0;
  for (;;) {
    const { data, error } = await supabase.from('products')
      .select('id,title,link,description,description_scraped')
      .ilike('website', '%daraz%')
      .ilike('link', '%daraz.com.np%')
      .not('link', 'is', null)
      .eq('description_scraped', false)
      .order('id', { ascending: true })
      .limit(pageSize);
    if (error) throw error;
    if (!data?.length) break;

    console.log(`BATCH_START | size=${data.length}`);
    for (const product of data) {
      processed++;
      const result = await processOne(supabase, product, processed, 0);
      if (result === 'success') success++;
      else if (result === 'failed') failed++;
      else noDescription++;
    }
  }
  console.log(`RUN_ALL_DONE | processed=${processed} | success=${success} | no_description=${noDescription} | failed=${failed}`);
}

async function main() {
  await Actor.init();
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');

  const input = ((await Actor.getInput()) || {}) as Record<string, unknown>;
  const productUrl = clean(input.productUrl || input.url || '', 2500);
  const runAllFlag = input.runAll === true || input.runAll === 'true';

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  if (runAllFlag) {
    await runAll(supabase);
    await Actor.exit();
    return;
  }

  if (!/^https?:\/\//i.test(productUrl)) throw new Error('productUrl is required, or set runAll=true');

  const { data: product, error } = await supabase.from('products')
    .select('id,title,link,description,description_scraped')
    .eq('link', productUrl)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!product) throw new Error(`Product not found in Supabase: ${productUrl}`);

  const extracted = await extractDescription(productUrl);
  console.log(`DESCRIPTION | found=${extracted.descriptionFound} | chars=${extracted.description.length} | source=${extracted.descriptionSource || 'none'}`);

  if (!extracted.description) {
    await markDescriptionAttempted(supabase, product);
    await Actor.pushData({ url: productUrl, status: 'no_description', description: '' });
    await Actor.exit();
    return;
  }

  await saveDescription(supabase, product, extracted.description);
  await Actor.pushData({
    url: productUrl,
    status: 'updated',
    description: extracted.description,
    descriptionSource: extracted.descriptionSource
  });
  console.log(`DESCRIPTION_DONE | chars=${extracted.description.length}`);
  await Actor.exit();
}

main().catch(async error => {
  console.error(error);
  try { await Actor.fail(); } catch {}
});