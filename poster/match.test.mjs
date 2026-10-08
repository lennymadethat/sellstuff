import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sellingSearchQueries, pickBestCard, pickConfirmedCard, scoreTitleMatch } from './match.mjs';

// Fake "Your listings" cards. Real runs read these off the Facebook page.
const SELLING = [
  { id: 'caliper', text: 'Acme 6in Digital Caliper Stainless Steel IP54 w/ Case & Extras\n$18\nActive' },
  { id: 'conduit', text: 'Brandco T8150-6" Conduit Carrier Kit End Caps Saddle Brackets U-Bolts\n$40\nActive' },
  { id: 'rack', text: 'Widgetline H-100 Wall Mount Louvered Panel Rack 36x19 Bin Storage\n$40\nActive' },
  { id: 'chair', text: 'Tall Mesh Drafting Chair w/ Adjustable Arms & Foot Ring\n$45\nActive' },
  { id: 'mon20', text: 'Acme 20" LCD Monitor - Works, Great for Home/Office\n$20\nActive' },
  { id: 'mon24cables', text: 'Acme 24" Monitor with Adjustable Stand and Cables\n$34\nActive' },
  { id: 'mon24led', text: 'Acme 24" LED Monitor Widescreen with Stand - Works Great\n$20\nActive' },
  { id: 'laser', text: 'Zorbo Laser Engraver Cutter Large Format w/ Air Assist Pump Kit\n$150\nActive' },
];

test('search queries prefer short distinctive tokens, not a 40-char prefix', () => {
  const q = sellingSearchQueries('Zorbo Laser Engraver Cutter Large Format w/ Air Assist Pump Kit');
  assert.ok(q.includes('zorbo'));
  assert.ok(q[0].split(' ').length <= 4);
  assert.ok(!q.some((s) => s.length > 40));
});

test('an inch-mark does not become a dead double-space prefix', () => {
  const q = sellingSearchQueries('Acme 24" Monitor with Adjustable Stand and Cables');
  assert.ok(q.includes('acme 24 monitor adjustable') || q.includes('acme 24'));
  assert.ok(!q.some((s) => /acme 24  /.test(s)));
});

test('picks the laser out of the default unfiltered selling list', () => {
  const hit = pickBestCard(SELLING, 'Zorbo Laser Engraver Cutter Large Format w/ Air Assist Pump Kit');
  assert.equal(hit && hit.id, 'laser');
});

test('does not confuse the two 24 inch monitors', () => {
  const cables = pickBestCard(SELLING, 'Acme 24" Monitor with Adjustable Stand and Cables');
  const led = pickBestCard(SELLING, 'Acme 24" LED Monitor Widescreen with Stand - Works Great');
  assert.equal(cables && cables.id, 'mon24cables');
  assert.equal(led && led.id, 'mon24led');
});

test('chair and 20 inch monitor still match when the list is filtered to one card', () => {
  assert.equal(pickBestCard([SELLING[3]], 'Tall Mesh Drafting Chair w/ Adjustable Arms & Foot Ring')?.id, 'chair');
  assert.equal(pickBestCard([SELLING[4]], 'Acme 20" LCD Monitor - Works, Great for Home/Office')?.id, 'mon20');
});

test('an unrelated card does not false-hit a laser query', () => {
  assert.equal(pickBestCard(SELLING.slice(0, 3), 'Zorbo Laser Engraver Cutter Large Format w/ Air Assist Pump Kit'), null);
  assert.ok(scoreTitleMatch(SELLING[0].text, 'Zorbo Laser Engraver Cutter Large Format w/ Air Assist Pump Kit').hits < 2);
});

test('two stray shared words do not make a match', () => {
  // Under a looser rule these shared just "waterproof" and "case", and the
  // winch remote would have been linked to the survival kit's listing id.
  const cards = [
    { id: '1', text: 'Rugged Waterproof Adventure Survival Kit Case w/ Multi-Tool Compass Flashlight\n$45\nActive\n · Listed on 18/08' },
    { id: '2', text: 'Printer Scanner Copier All-in-One Wireless\n$50\nActive\n · Listed on 16/08' },
  ];
  assert.equal(pickBestCard(cards, 'Brandco Apex 56504 Wireless Winch Remote 80ft 5-Pin w/ Waterproof Case'), null);
});

test('an exact card still matches once the list is filtered down to it', () => {
  const cards = [
    { id: '999', text: 'Brandco Apex 56504 Wireless Winch Remote 80ft 5-Pin w/ Waterproof Case\n$36\nActive\n · Listed on 14/08' },
  ];
  const best = pickBestCard(cards, 'Brandco Apex 56504 Wireless Winch Remote 80ft 5-Pin w/ Waterproof Case');
  assert.equal(best && best.id, '999');
});

test('two near-identical listings stay ambiguous rather than guess', () => {
  const cards = [
    { id: '111', text: 'Widgetline H-100 Wall Mount Louvered Panel Rack 36x19" Steel Bin Panel\n$32\nActive' },
    { id: '222', text: 'Widgetline H-100 Wall Mount Louvered Panel Rack 36x19 Bin Storage\n$36\nActive' },
  ];
  assert.equal(pickBestCard(cards, 'Widgetline H-100 Wall Mount Louvered Panel Rack 36x19 Bin Storage'), null);
});

test('a title you confirmed beats scoring, even between near-identical listings', () => {
  const cards = [
    { id: '111', title: 'Widgetline H-100 Wall Mount Louvered Panel Rack 36x19" Steel Bin Panel', text: 'Widgetline H-100 Wall Mount Louvered Panel Rack 36x19" Steel Bin Panel\n$32\nActive' },
    { id: '222', title: 'Widgetline H-100 Wall Mount Louvered Panel Rack 36x19 Bin Storage', text: 'Widgetline H-100 Wall Mount Louvered Panel Rack 36x19 Bin Storage\n$36\nActive' },
  ];
  const t = 'Widgetline H-100 Wall Mount Louvered Panel Rack 36x19 Bin Storage';
  assert.equal(pickBestCard(cards, t), null);                    // unconfirmed: refuses
  assert.equal(pickBestCard(cards, t, t).id, '222');             // confirmed: exact
});

test('a confirmed title that matches two cards still refuses rather than guessing', () => {
  const dupes = [
    { id: '1', title: 'Same Title', text: 'Same Title\n$10\nActive' },
    { id: '2', title: 'Same Title', text: 'Same Title\n$10\nActive' },
  ];
  assert.equal(pickConfirmedCard(dupes, 'Same Title'), null);
});
