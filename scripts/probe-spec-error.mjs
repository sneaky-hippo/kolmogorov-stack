import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext();
const page = await ctx.newPage();
page.on('pageerror', e => {
  console.log('PAGEERROR:', e.message);
  console.log('  NAME:', e.name);
  console.log('  STACK:', e.stack);
});
const client = await ctx.newCDPSession(page);
await client.send('Log.enable');
await client.send('Runtime.enable');
client.on('Log.entryAdded', ({ entry }) => {
  if (entry.level === 'error' || entry.level === 'warning') {
    console.log('LOG_' + entry.level.toUpperCase() + ':', entry.text, 'url:', entry.url, 'line:', entry.lineNumber);
  }
});
client.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
  console.log('RUNTIME_EXCEPTION:', exceptionDetails.text);
  console.log('  url:', exceptionDetails.url);
  console.log('  line:', exceptionDetails.lineNumber, 'col:', exceptionDetails.columnNumber);
  console.log('  script:', exceptionDetails.scriptId);
});
await page.goto('http://localhost:8787/spec', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await b.close();
