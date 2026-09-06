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
  colour: 'Color', color: 'Color', 'color family': 'Color Family',
  capacity: 'Capacity', type: 'Product Type', 'product type': 'Product Type',
  warranty: 'Warranty', 'warranty period': 'Warranty', weight: 'Weight',
  dimension: 'Dimensions', dimensions: 'Dimensions'
};
const SPEC_LABEL = /^(brand|brand name|model|model name|series|color|colour|color family|ram|ram memory|memory|storage|storage capacity|rom|display|screen|screen size|resolution|refresh rate|processor|cpu|gpu|graphics|chipset|operating system|os|camera|rear camera|front camera|battery|battery capacity|network|sim|sim type|connectivity|wifi|bluetooth|ports?|usb|hdmi|dimensions?|weight|capacity|power|power consumption|voltage|warranty|warranty period|condition|type|product type|panel|panel type|brightness|response time|printer type|print speed|paper size|lens|sensor|megapixel|zoom|video|refrigerant|energy rating|wash capacity|spin speed|cooling capacity|inverter|tonnage|door type|installation type|material|number of doors|freezer capacity|refrigerator capacity|energy class|compressor type|defrost|cooling system|noise level|annual energy consumption|country of origin)$/i;
function canonicalKey(key: string) { const k = clean(key, 120).toLowerCase(); return CANONICAL[k] || clean(key, 120); }
function addSpec(out: Record<string, string>, key: unknown, value: unknown) {
  const k = canonicalKey(String(key ?? '')); const v = clean(value, 350);
  if (!k || BAD_KEY.test(k) || !v || BAD_VALUE.test(v)) return;
  if (/^https?:\/\//i.test(v) || /^data:/i.test(v) || /<[^>]+>/i.test(v)) return;
  if (/\b(react|webpack|next\.js|tailwind|hydration|crossorigin)\b/i.test(v)) return;
  if (v.length > 350 || (!SPEC_LABEL.test(k) && !/^[A-Za-z][A-Za-z0-9 /()&+._-]{1,80}$/.test(k))) return;
  out[k] = out[k] && out[k] !== v ? `${out[k]}; ${v}` : v;
}
function collectNestedSpecs(root: unknown, out: Record<string, string>) {
  if (!root || typeof root !== 'object') return;
  if (Array.isArray(root)) { for (const x of root) collectNestedSpecs(x, out); return; }
  for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
    if (BAD_KEY.test(k)) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      if (SPEC_LABEL.test(clean(k, 120))) addSpec(out, k, v);
    } else collectNestedSpecs(v, out);
  }
}
function extractPairsFromText(text: string, out: Record<string, string>) {
  const lines = text.split(/\r?\n/).map(x => clean(x, 350)).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i];
    const m = a.match(/^([^:]{2,100}):\s*(.+)$/);
    if (m) addSpec(out, m[1], m[2]);
    if (i + 1 < lines.length && SPEC_LABEL.test(a) && !a.includes(':')) addSpec(out, a, lines[i + 1]);
  }
}
async function extractProduct(url: string) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151 Safari/537.36' });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); });
    await page.waitForTimeout(1500);
    const result = await page.evaluate(`(() => {
      const clean = (v) => String(v ?? '').replace(/\\s+/g, ' ').trim();
      const rows = [];
      const seen = new Set();
      const add = (k,v) => { k=clean(k); v=clean(v); if(!k || !v) return; const key=k+'\\0'+v; if(!seen.has(key)){seen.add(key);rows.push([k,v]);} };
      for (const el of document.querySelectorAll('tr')) { const cells=Array.from(el.querySelectorAll('th,td')).map(x=>clean(x.textContent)).filter(Boolean); if(cells.length>=2)add(cells[0],cells.slice(1).join(' | ')); }
      for (const el of document.querySelectorAll('dt')) { const dd=el.nextElementSibling; if(dd)add(el.textContent,dd.textContent); }
      for (const el of document.querySelectorAll('li,div,p,span')) {
        const t=clean(el.textContent); const m=t.match(/^([^:]{2,100}):\\s*(.{1,350})$/); if(m)add(m[1],m[2]);
      }
      const bodyText=clean(document.body?.innerText||'');
      const scripts=Array.from(document.scripts).map(s=>s.textContent||'').filter(Boolean).join('\\n');
      return {rows,bodyText,scripts,url:location.href};
    })()`);
    const specs: Record<string, string> = {};
    for (const [k,v] of result.rows as Array<[string,string]>) addSpec(specs,k,v);
    extractPairsFromText(result.bodyText, specs);
    for (const marker of ['__NEXT_DATA__','pageData','window.pageData','window.__pageData__']) {
      const idx=result.scripts.indexOf(marker); if(idx<0) continue;
      const start=result.scripts.indexOf('{',idx); if(start<0) continue;
      let depth=0,inString=false,escaped=false;
      for(let i=start;i<result.scripts.length;i++){
        const ch=result.scripts[i];
        if(inString){ if(escaped) escaped=false; else if(ch==='\\') escaped=true; else if(ch==='"') inString=false; continue; }
        if(ch==='"') inString=true; else if(ch==='{') depth++; else if(ch==='}' && --depth===0){ try{collectNestedSpecs(JSON.parse(result.scripts.slice(start,i+1)),specs);}catch{} break; }
      }
    }
    await context.close();
    return { specs, title: clean(result.bodyText.slice(0, 500), 500), finalUrl: result.url, bodyLength: result.bodyText.length };
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
  console.log(`SPEC_EXTRACTED | count=${Object.keys(extracted.specs).length} | final=${extracted.finalUrl} | bodyChars=${extracted.bodyLength}`);
  const { data: existing, error: existingError } = await supabase.from('products').select('id,title,price,image,link,reviews,rating,specifications').eq('link', productUrl).limit(1).maybeSingle();
  if (existingError) throw existingError;
  const current = existing?.specifications && typeof existing.specifications === 'object' && !Array.isArray(existing.specifications) ? existing.specifications as Record<string, unknown> : {};
  if (!Object.keys(extracted.specs).length) { await Actor.pushData({url:productUrl,status:'no_verified_specs',specifications:current}); console.log('SPEC_DONE | no verified specs'); await Actor.exit(); return; }
  const merged: Record<string, unknown> = {...current,...extracted.specs};
  const payload={title:clean(existing?.title||input.title||extracted.title||'Daraz Product',500),price:Number(existing?.price||0),currency:'NPR',image:existing?.image||null,link:productUrl,reviews:existing?.reviews??null,rating:existing?.rating??null,search_term:'product-url-specification',website:'Daraz Nepal',marketplace_id:MARKETPLACE_ID,external_id:productId,specifications:merged};
  const {data:saved,error:saveError}=await supabase.from('products').upsert(payload,{onConflict:'marketplace_id,external_id'}).select('id').single();
  if(saveError) throw saveError;
  await supabase.from('product_enrichment_queue').upsert({product_id:saved.id,brand:merged.Brand||null,model:merged.Model||null,product_type:merged['Product Type']||null,parse_status:'parsed',reason:'Apify product URL specification actor',specifications:merged,updated_at:new Date().toISOString()},{onConflict:'product_id'});
  await Actor.pushData({url:productUrl,status:'updated',specifications:merged});
  console.log(`SPEC_DONE | saved=${Object.keys(extracted.specs).length}`);
  await Actor.exit();
}
main().catch(async error=>{console.error(error);try{await Actor.fail();}catch{}});
