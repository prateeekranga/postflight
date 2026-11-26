import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  countPlatformText,
  extractBlueskyFacets,
  simulatePlatformFold,
  normalizeUnicodeFancyFonts,
  detectUnicodeFancyFonts,
  detectInvisibleZeroWidthChars,
  stripInvisibleZeroWidthChars,
  toPascalCaseHashtag,
  autoFixDraftText,
  lintForPlatform,
  runPreFlight,
  formatReportAsSarif,
  analyzeSafeZone,
  validateMediaAttachments,
  validateOpenGraph,
  calculateContrastRatio,
  buildFfmpegNormalizeCommand,
  auditUtmUrl,
  buildCanonicalUtmUrl,
  detectDuplicatesAndCannibalization,
  triageComments,
  auditOAuthTokens,
  createKillSwitchState,
  activateKillSwitch,
  releaseKillSwitch,
  recordGovernanceEvent,
  verifyAuditChain,
  canPublish,
  parseCanonicalMarkdown,
  compileCanonicalPost,
  PLATFORM_IDS,
} from '../dist/index.js';

describe('@postflight/core — Platform Counters', () => {
  it('counts X weighted length with t.co=23 URLs and emoji/CJK=2', () => {
    const res = countPlatformText('Hi 🚀 https://example.com/very/long/path/with?query=12345', 'x');
    // 'Hi ' (3) + '🚀' (2) + ' ' (1) + URL (23) = 29
    assert.equal(res.count, 29);
    assert.equal(res.overLimit, false);
    assert.equal(res.urlCount, 1);
  });

  it('computes exact UTF-8 byte offsets for Bluesky facets after multi-byte emojis', () => {
    const text = '🚀🔥 Check https://postflight.dev #OpenSource @alice.bsky.social';
    const facets = extractBlueskyFacets(text);
    const bytes = new TextEncoder().encode(text);
    const decoder = new TextDecoder();

    assert.equal(facets.length, 3);
    const linkFacet = facets.find((f) => f.features[0]?.$type === 'app.bsky.richtext.facet#link');
    const tagFacet = facets.find((f) => f.features[0]?.$type === 'app.bsky.richtext.facet#tag');
    const mentionFacet = facets.find((f) => f.features[0]?.$type === 'app.bsky.richtext.facet#mention');

    assert.ok(linkFacet && tagFacet && mentionFacet);
    assert.equal(
      decoder.decode(bytes.slice(linkFacet.index.byteStart, linkFacet.index.byteEnd)),
      'https://postflight.dev',
    );
    assert.equal(
      decoder.decode(bytes.slice(tagFacet.index.byteStart, tagFacet.index.byteEnd)),
      '#OpenSource',
    );
    assert.equal(
      decoder.decode(bytes.slice(mentionFacet.index.byteStart, mentionFacet.index.byteEnd)),
      '@alice.bsky.social',
    );
  });

  it('weights complex emojis by UTF-8 bytes on Threads', () => {
    const familyEmoji = '👨‍👩‍👧‍👦'; // 25 UTF-8 bytes!
    const res = countPlatformText(`Hello ${familyEmoji}`, 'threads');
    assert.ok(res.count >= 6 + 20, `Expected UTF-8 emoji weight, got ${res.count}`);
  });

  it('strips remote instance domains and counts CW + 23-char URLs on Mastodon', () => {
    const res = countPlatformText('Ping @alice@mastodon.social https://example.com/a/b/c/d/e/f', 'mastodon', {
      contentWarning: 'Tech',
    });
    // CW 'Tech'(4) + 'Ping '(5) + '@alice'(6) + ' '(1) + URL(23) = 39
    assert.equal(res.count, 39);
  });

  it('detects TikTok 2,200 API vs 4,000 native caption divergence', () => {
    const longCaption = 'a'.repeat(2500);
    const nativeCount = countPlatformText(longCaption, 'tiktok', { publishViaApi: false });
    const apiCount = countPlatformText(longCaption, 'tiktok', { publishViaApi: true });
    assert.equal(nativeCount.overLimit, false);
    assert.equal(nativeCount.overApiLimit, true);
    assert.equal(apiCount.overLimit, true);
    assert.equal(apiCount.effectiveLimit, 2200);
  });
});

describe('@postflight/core — Fold Simulator & Linter Rules', () => {
  it('catches LinkedIn blank-line mobile fold starvation', () => {
    const text = 'Big announcement today.\n\nHere is the actual hook that gets cut off on mobile devices.\n\nAnd more details below.';
    const fold = simulatePlatformFold(text, 'linkedin', { hasMedia: true });
    assert.equal(fold.mobile.truncated, true);
    assert.ok(fold.mobile.blankLinesConsumed >= 1);

    const report = lintForPlatform(
      { text, media: [{ type: 'image', altText: 'Dashboard screenshot showing metrics' }] },
      'linkedin',
    );
    assert.ok(report.diagnostics.some((d) => d.ruleId === 'fold/blank-line-starvation'));
  });

  it('flags FTC disclosure below mobile fold and prohibited shorthand (#spon)', () => {
    const buried = `${'Great productivity tool we tested all month long with our engineering team. '.repeat(3)} #spon`;
    const report = lintForPlatform({ text: buried, isSponsored: true }, 'instagram-feed');
    assert.ok(report.diagnostics.some((d) => d.ruleId === 'compliance/ftc-missing-disclosure'));
    assert.ok(report.diagnostics.some((d) => d.ruleId === 'compliance/ftc-prohibited-shorthand'));

    const buriedValid = `${'Great productivity tool we tested all month long with our engineering team. '.repeat(3)} #ad`;
    const reportBuried = lintForPlatform({ text: buriedValid, isSponsored: true }, 'instagram-feed');
    assert.ok(reportBuried.diagnostics.some((d) => d.ruleId === 'compliance/ftc-below-fold'));

    const clean = '#Ad We tested Acme CI across 50 repos and cut build times by 42%.';
    const reportClean = lintForPlatform({ text: clean, isSponsored: true }, 'instagram-feed');
    assert.equal(
      reportClean.diagnostics.filter((d) => d.category === 'compliance' && d.severity === 'error').length,
      0,
    );
  });

  it('catches Instagram 2025 5-hashtag cap, Unicode faux-bold, and produces idempotent auto-fix', () => {
    const dirty =
      '𝐔𝐧𝐥𝐨𝐜𝐤 growth today! #socialmediamarketing #growthhacking #devtools #opensource #saas #startup #marketingtips';
    assert.ok(detectUnicodeFancyFonts(dirty).length > 0);
    assert.equal(normalizeUnicodeFancyFonts('𝐔𝐧𝐥𝐨𝐜𝐤').text, 'Unlock');
    assert.equal(toPascalCaseHashtag('#socialmediatips'), '#SocialMediaTips');

    const report = lintForPlatform({ text: dirty, isSponsored: true }, 'instagram-feed');
    assert.ok(report.diagnostics.some((d) => d.ruleId === 'algorithm/hashtag-hard-cap'));
    assert.ok(report.diagnostics.some((d) => d.ruleId === 'accessibility/unicode-faux-bold'));

    const fixed1 = autoFixDraftText(dirty, 'instagram-feed', { isSponsored: true });
    assert.equal(fixed1.changed, true);
    assert.ok(fixed1.fixedText.startsWith('#Ad '));
    assert.equal(detectUnicodeFancyFonts(fixed1.fixedText).length, 0);

    const fixed2 = autoFixDraftText(fixed1.fixedText, 'instagram-feed', { isSponsored: true });
    assert.equal(fixed2.changed, false, 'Auto-fix should be idempotent');
  });

  it('generates valid SARIF 2.1.0 output', () => {
    const report = runPreFlight({ text: 'Check https://example.com #a #b #c #d #e #f', isSponsored: true }, [
      'instagram-feed',
      'linkedin',
    ]);
    const sarif = formatReportAsSarif(report, 'examples/campaigns/test.md');
    assert.equal(sarif.version, '2.1.0');
    assert.ok(Array.isArray(sarif.runs) && sarif.runs.length === 1);
  });
});

describe('@postflight/core — Safe-Zone Collision Geometry', () => {
  it('detects TikTok Ad lower-right notch collision and clears centered safe box', () => {
    const analysis = analyzeSafeZone('tiktok-ad', [
      { id: 'safe', label: 'Headline', x: 200, y: 400, width: 500, height: 150 },
      { id: 'notch', label: 'Corner Badge', x: 800, y: 950, width: 150, height: 120 },
    ]);
    assert.equal(analysis.allClear, false);
    const safeRes = analysis.collisions.find((c) => c.boxId === 'safe');
    const notchRes = analysis.collisions.find((c) => c.boxId === 'notch');
    assert.equal(safeRes?.collides, false);
    assert.equal(notchRes?.collides, true);
    assert.ok(notchRes?.violatedEdges.includes('lower-right-notch'));
  });

  it('detects Instagram 4:5 -> 3:4 profile grid 34px edge slicing', () => {
    const analysis = analyzeSafeZone('instagram-feed-to-grid', [
      { id: 'edge', label: 'Left Logo', x: 10, y: 200, width: 120, height: 80 },
    ]);
    assert.equal(analysis.allClear, false);
    assert.ok(analysis.collisions[0]?.violatedEdges.includes('left'));
  });
});

describe('@postflight/core — Media, OG, WCAG, FFmpeg, Attribution, Intelligence & Governance', () => {
  it('catches Bluesky 2,000,000 decimal byte trap, IG Graph API 3:4 trap, YT Shorts 16:9 trap, and WhatsApp 300KB OG drop', () => {
    // 2,050,000 bytes is < 2 MiB (2,097,152) yet exceeds Bluesky's 2,000,000 decimal cap!
    const bskyDiags = validateMediaAttachments(
      [{ type: 'image', sizeBytes: 2050000, altText: 'Product architecture diagram' }],
      'bluesky',
    );
    assert.ok(bskyDiags.some((d) => d.severity === 'error'));

    const igApiDiags = validateMediaAttachments(
      [{ type: 'image', width: 1080, height: 1440, aspectRatio: '3:4', altText: 'Editorial cover' }],
      'instagram-feed',
      true,
    );
    assert.ok(igApiDiags.some((d) => d.severity === 'error'));

    const ytDiags = validateMediaAttachments(
      [{ type: 'video', width: 1920, height: 1080, durationSec: 45, filename: 'tiktok_export.mp4' }],
      'youtube-shorts',
    );
    assert.ok(ytDiags.some((d) => d.ruleId === 'media/competitor-watermark'));
    assert.ok(ytDiags.some((d) => d.severity === 'error'));

    const ogDiags = validateOpenGraph(
      {
        url: 'https://postflight.dev',
        title: 'PostFlight',
        imageWidth: 1200,
        imageHeight: 630,
        imageSizeBytes: 420_000,
        imageFormat: 'png',
      },
      'x',
    );
    assert.ok(ogDiags.some((d) => d.ruleId === 'media/og-whatsapp-300kb-drop'));
  });

  it('computes exact WCAG 2.2 contrast ratios and FFmpeg Rec.709/LUFS commands', () => {
    const bw = calculateContrastRatio('#000000', '#FFFFFF');
    assert.equal(bw.ratio, 21);
    assert.equal(bw.aaaNormal, true);

    const low = calculateContrastRatio('#999999', '#FFFFFF');
    assert.equal(low.aaNormal, false);

    const ff = buildFfmpegNormalizeCommand('instagram-reels', { isHdr: true, targetFps: 30 });
    assert.ok(ff.command.includes('yuv420p'));
    assert.ok(ff.command.includes('+faststart'));
    assert.ok(ff.command.includes('bt709'));
    assert.ok(ff.command.includes('loudnorm=I=-14'));
  });

  it('audits and normalizes UTMs while stripping click-ID pollution', () => {
    const audit = auditUtmUrl(
      'https://postflight.dev/launch?utm_source=LinkedIn&utm_medium=Paid%20Social&fbclid=abc123',
      { platform: 'linkedin' },
    );
    assert.equal(audit.hasClickIdNoise, true);
    assert.ok(audit.issues.length > 0);
    assert.ok(!audit.normalizedUrl.includes('fbclid'));

    const clean = buildCanonicalUtmUrl('https://postflight.dev/launch?fbclid=xyz', {
      platform: 'linkedin',
      campaign: 'Q4 Launch',
    });
    assert.ok(clean.includes('utm_source=linkedin'));
    assert.ok(clean.includes('utm_campaign=q4-launch'));
    assert.ok(!clean.includes('fbclid'));
  });

  it('detects duplicates, LinkedIn <24h cannibalization, buyer/crisis triage, and OAuth token risks', () => {
    const dupes = detectDuplicatesAndCannibalization([
      {
        id: 'post-1',
        text: 'We launched PostFlight to catch hidden social media failures before publishing.',
        platform: 'linkedin',
        publishedAt: '2026-11-25T08:00:00Z',
      },
      {
        id: 'post-2',
        text: 'We launched PostFlight to catch hidden social media failures before publishing!',
        platform: 'linkedin',
        publishedAt: '2026-11-25T16:00:00Z',
      },
    ]);
    assert.equal(dupes.length, 1);
    assert.ok(dupes[0]?.cannibalizationWarning);

    const triaged = triageComments([
      { id: '1', author: '@spam', platform: 'instagram-feed', text: 'DM me on Telegram for 10k followers!' },
      { id: '2', author: '@buyer', platform: 'instagram-feed', text: 'How much is pricing and does it integrate with HubSpot?' },
      { id: '3', author: '@alarm', platform: 'x', text: 'URGENT: your checkout is down and throwing 500 errors!' },
    ]);
    assert.equal(triaged[0]?.intent, 'crisis-urgent');
    assert.equal(triaged[1]?.intent, 'buyer-intent');
    assert.equal(triaged[2]?.intent, 'bot-noise');

    const tokens = auditOAuthTokens(
      [
        {
          id: 'x1',
          accountHandle: '@acme',
          platform: 'x',
          accessTokenIssuedAt: '2026-11-25T00:00:00Z',
          hasOfflineAccess: false,
          concurrentWorkers: 2,
        },
      ],
      '2026-11-25T03:00:00Z',
    );
    assert.equal(tokens[0]?.status, 'expired');
    assert.ok((tokens[0]?.risks.length ?? 0) >= 2);
  });

  it('enforces tamper-evident SHA-256 hash-chained Crisis Kill-Switch', () => {
    let state = createKillSwitchState();
    assert.equal(canPublish(state).allowed, true);
    state = activateKillSwitch(state, 'oncall-sre', 'Production outage P1', '2026-11-25T08:00:00Z');
    assert.equal(canPublish(state).allowed, false);
    state = releaseKillSwitch(state, 'oncall-sre', 'Incident resolved', '2026-11-25T09:00:00Z');
    assert.equal(canPublish(state).allowed, true);
    assert.deepEqual(verifyAuditChain(state.auditLog), { valid: true, brokenAtSeq: null });

    // Tamper test
    const tampered = structuredClone(state.auditLog);
    tampered[0].reason = 'Edited history';
    const check = verifyAuditChain(tampered);
    assert.equal(check.valid, false);
    assert.equal(check.brokenAtSeq, 1);
  });

  it('rejects every kind of edit to Kill-Switch ledger history', () => {
    let state = createKillSwitchState();
    state = activateKillSwitch(state, 'oncall-sre', 'Production outage P1', '2026-11-25T08:00:00Z');
    state = releaseKillSwitch(state, 'oncall-sre', 'Incident resolved', '2026-11-25T09:00:00Z');
    state = activateKillSwitch(state, 'comms-lead', 'Brand safety hold', '2026-11-25T10:00:00Z');
    const ledger = state.auditLog;
    assert.equal(ledger.length, 3);
    assert.deepEqual(verifyAuditChain(ledger), { valid: true, brokenAtSeq: null });
    assert.deepEqual(verifyAuditChain([]), { valid: true, brokenAtSeq: null });

    const expectBroken = (label, mutate, brokenAtSeq) => {
      const copy = structuredClone(ledger);
      const edited = mutate(copy) ?? copy;
      const check = verifyAuditChain(edited);
      assert.equal(check.valid, false, `${label}: tampered ledger must not verify`);
      assert.equal(check.brokenAtSeq, brokenAtSeq, `${label}: wrong brokenAtSeq`);
    };

    // Editing any hashed field of a middle entry breaks the chain at that entry.
    expectBroken('actor', (l) => { l[1].actor = 'attacker'; }, 2);
    expectBroken('timestamp', (l) => { l[1].timestamp = '2026-11-25T08:30:00Z'; }, 2);
    expectBroken('action', (l) => { l[1].action = 'KILL_SWITCH_ACTIVATED'; }, 2);
    expectBroken('reason', (l) => { l[2].reason = 'Nothing to see here'; }, 3);
    expectBroken('targetId added', (l) => { l[1].targetId = 'post-42'; }, 2);
    expectBroken('hash', (l) => { l[2].hash = 'f'.repeat(64); }, 3);
    expectBroken('prevHash', (l) => { l[1].prevHash = '0'.repeat(64); }, 2);
    expectBroken('seq', (l) => { l[2].seq = 4; }, 4);

    // Re-hashing the edited entry does not help: the next entry's prevHash no longer matches.
    expectBroken('re-hashed forgery', (l) => {
      const forged = recordGovernanceEvent(createKillSwitchState(), {
        actor: l[0].actor,
        action: l[0].action,
        reason: 'Routine drill',
        timestamp: l[0].timestamp,
      }).auditLog[0];
      assert.deepEqual(verifyAuditChain([forged]), { valid: true, brokenAtSeq: null });
      l[0] = forged;
    }, 2);

    // Structural edits: deleting, reordering or duplicating entries.
    expectBroken('deleted first entry', (l) => l.slice(1), 2);
    expectBroken('deleted middle entry', (l) => [l[0], l[2]], 3);
    expectBroken('swapped entries', (l) => [l[0], l[2], l[1]], 3);
    expectBroken('duplicated entry', (l) => [l[0], l[1], l[1], l[2]], 2);
  });

  it('compiles 1 canonical Markdown post cleanly across all 9 platforms', () => {
    const md = `---
id: demo-launch
title: PostFlight v1 Launch
campaign: v1-launch
url: https://postflight.dev/
hashtags: [OpenSource, SocialMediaEngineering, DevTools]
---
We built PostFlight to eliminate silent social media failures.

Every platform has hidden traps: LinkedIn blank-line folds, Instagram 5-hashtag caps, and Bluesky UTF-8 byte offsets.

Try it locally with zero API keys required.`;

    const parsed = parseCanonicalMarkdown(md);
    assert.equal(parsed.frontmatter.id, 'demo-launch');
    const bundle = compileCanonicalPost(parsed, [...PLATFORM_IDS]);
    assert.equal(bundle.artifacts.length, PLATFORM_IDS.length);
    for (const art of bundle.artifacts) {
      assert.equal(art.lintSummary.errors, 0, `${art.platform} compiled artifact had errors`);
    }
    const bsky = bundle.artifacts.find((a) => a.platform === 'bluesky');
    assert.ok(bsky?.facets && bsky.facets.length > 0);
  });

  it('catches invisible zero-width chars, dead .page.link shorteners, placeholders, X @mention trap, numeric tags, DST schedule hazards, and preserves emoji ZWJs', () => {
    const emojiFamily = '👨‍👩‍👧‍👦';
    const rainbowFlag = '🏳️‍🌈';
    assert.equal(detectInvisibleZeroWidthChars(`${emojiFamily} ${rainbowFlag}`).length, 0);

    const brokenText = `@partner Launch ${emojiFamily} {{campaign_link}} #2026 via https://acme.page.link/go #Open\u200BSource`;
    const hidden = detectInvisibleZeroWidthChars(brokenText);
    assert.ok(hidden.length >= 1);

    const stripped = stripInvisibleZeroWidthChars(brokenText);
    assert.ok(stripped.text.includes(emojiFamily));
    assert.ok(stripped.text.includes('#OpenSource'));

    const xReport = lintForPlatform(
      { text: brokenText, scheduledAt: '2026-03-08T02:00:00' },
      'x',
    );
    assert.ok(xReport.diagnostics.some((d) => d.ruleId === 'accessibility/invisible-zero-width-chars'));
    assert.ok(xReport.diagnostics.some((d) => d.ruleId === 'governance/unresolved-template-placeholders'));
    assert.ok(xReport.diagnostics.some((d) => d.ruleId === 'algorithm/public-url-shortener-risk' && d.severity === 'error'));
    assert.ok(xReport.diagnostics.some((d) => d.ruleId === 'algorithm/x-leading-mention-reply-trap'));
    assert.ok(xReport.diagnostics.some((d) => d.ruleId === 'governance/schedule-timing-hazard'));

    const mastoReport = lintForPlatform({ text: 'Happy new year #2026!' }, 'mastodon');
    assert.ok(mastoReport.diagnostics.some((d) => d.ruleId === 'accessibility/numeric-only-hashtag'));

    const reelsGrid = analyzeSafeZone('instagram-reels-to-grid', [
      { id: 'title', label: 'Top Title', x: 100, y: 150, width: 600, height: 140 },
    ]);
    assert.equal(reelsGrid.allClear, false);
    assert.ok(reelsGrid.collisions[0]?.violatedEdges.includes('top'));

    const xApiSixImgs = validateMediaAttachments(
      Array.from({ length: 6 }, (_, i) => ({
        type: 'image',
        width: 1200,
        height: 675,
        altText: `Screenshot ${i + 1}`,
      })),
      'x',
      true,
    );
    assert.ok(xApiSixImgs.some((d) => d.ruleId === 'media/x-api-4-image-cap'));

    const piiTriaged = triageComments([
      { id: 'pii-1', author: '@user', platform: 'x', text: 'Email me my order at jane.doe@example.com or 555-234-5678' },
    ]);
    assert.ok(piiTriaged[0]?.complianceFlag?.includes('PII'));
  });
});
