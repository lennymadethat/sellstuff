// One-time (and rarely-repeated) sign-in for the poster's Chrome profile.
//
// The poster drives a DEDICATED Chrome profile rather than your everyday one —
// a profile Playwright is attached to can't be shared with the browser you are
// actually using, and a separate profile means normal browsing is never
// disturbed. It is still your REAL Facebook account; this script just opens a
// window so you can log into it once. Facebook keeps that session for months.
//
//   node login.mjs           open the window, wait for sign-in, report + exit
//   node login.mjs --check   report whether the profile is already signed in
//
// You type the password yourself. The kit never sees it.

import { openBrowser, isLoggedIn } from './fb.mjs';
import { PROFILE_DIR } from './config.mjs';

const CHECK = process.argv.includes('--check');

const ctx = await openBrowser({ profileDir: PROFILE_DIR, watch: true });

if (CHECK) {
  console.log(await isLoggedIn(ctx) ? 'LOGGED IN' : 'NOT logged in');
  await ctx.close();
  process.exit(0);
}

const page = await ctx.newPage();
await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });

console.log(`\nProfile: ${PROFILE_DIR}`);
console.log('A Chrome window is open. Log into Facebook as yourself (and finish any 2FA).');
console.log('Waiting for the session cookie... (Ctrl+C to abort)\n');

const deadline = Date.now() + 10 * 60 * 1000;
let ok = false;
while (Date.now() < deadline) {
  if (await isLoggedIn(ctx)) { ok = true; break; }
  await new Promise((r) => setTimeout(r, 2000));
}

if (ok) {
  // Land on the create form once so any first-run interstitial (Marketplace
  // terms, location prompt) is dealt with by a human now rather than by the
  // poster mid-listing.
  await page.goto('https://www.facebook.com/marketplace/create/item', { waitUntil: 'domcontentloaded' }).catch(() => {});
  console.log('✅ Signed in. If Marketplace shows any first-time prompt in this window, clear it now.');
  console.log('   Closing in 45s — or Ctrl+C when you are done.');
  await new Promise((r) => setTimeout(r, 45000));
} else {
  console.log('❌ Timed out waiting for sign-in.');
}

await ctx.close();
process.exit(ok ? 0 : 1);
