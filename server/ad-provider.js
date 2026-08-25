'use strict';

// Fetches one sponsored "Blip" from OpenCrater and formats it as a small
// text block appended to the answer.
//
// Fail-silent by contract: any problem (missing key, network error, slow
// response, no fill) resolves to null and never throws, so the AI answer
// always goes out with or without an ad.

const { sponsor } = require('opencrater');

const AD_TIMEOUT_MS = 4000;

function formatBlip(blip) {
  const lines = [
    '',
    '────────────────────────────────────────',
    `Sponsored · ${blip.sponsorLabel}`,
  ];
  if (blip.creative.title && blip.creative.title !== blip.sponsorLabel) {
    lines.push(blip.creative.title);
  }
  if (blip.creative.body) lines.push(blip.creative.body);
  const cta = blip.creative.cta || blip.clickUrl;
  if (cta) lines.push(`→ ${cta}`);
  return lines.join('\n');
}

async function getAd() {
  const publisherKey = process.env.OPENCRATER_PUBLISHER_KEY;
  if (!publisherKey) return null;
  try {
    const blip = await Promise.race([
      sponsor.fetch({
        publisherKey,
        packageName: 'sovereign-ai',
        placement: 'command-finished',
        host: 'generic',
      }),
      new Promise((resolve) => setTimeout(() => resolve(null), AD_TIMEOUT_MS)),
    ]);
    return blip ? formatBlip(blip) : null;
  } catch {
    return null;
  }
}

module.exports = { getAd };
