# Daraz Product Specification Actor

Standalone Apify Actor for extracting product specifications from an exact Daraz Nepal product URL.

## Input

```json
{
  "productUrl": "https://www.daraz.com.np/products/example-i123456.html"
}
```

## Flow

Exact product URL → Playwright/Chromium → rendered product page → specification tables and embedded product data → normalized specification JSON → optional Supabase update.

The Actor does not use Gemini, external search, or a separately supplied product title to invent specifications.
