<div align="center">

# PostFlight

**The open-source pre-flight compiler, linter, and safe-zone X-ray for social media.**

*Catch the 77 silent failures that destroy reach, accessibility, and legal compliance — before you hit Publish.*

[![CI](https://github.com/prateeekranga/postflight/actions/workflows/ci.yml/badge.svg)](https://github.com/prateeekranga/postflight/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/Node.js-%3E%3D20-137547.svg)](package.json)
[![Core dependencies: 0](https://img.shields.io/badge/Core%20Dependencies-0-0D5E99.svg)](packages/core/package.json)
[![Rules: 77](https://img.shields.io/badge/Deterministic%20Rules-77-C43E1C.svg)](docs/RULES.md)
[![MCP Ready](https://img.shields.io/badge/MCP-JSON--RPC%202.0-8250DF.svg)](docs/MCP_INTEGRATION.md)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-137547.svg)](CONTRIBUTING.md)

</div>

![PostFlight architecture: open platform specs feed a zero-dependency core that powers the CLI, MCP server, Web Studio, and SDK](docs/assets/architecture.svg)

Every other open-source social tool rebuilds the same thing: a cron scheduler and a calendar UI on top of Postgres, Redis, and Temporal — and then makes you survive Meta App Review, a TikTok `SELF_ONLY` audit, and a paid X API tier before you can test a single post.

PostFlight does the opposite. It decouples **content engineering** from **delivery**. Every rule, counter, fold simulation, and collision check runs locally in milliseconds, with **zero API keys and zero infrastructure**, because the mistakes that actually cost you reach happen silently *before* anything reaches a publishing API.

> **New here?** The fastest useful contribution is a one-file platform spec update — limits change every quarter. See [CONTRIBUTING.md](CONTRIBUTING.md) and [good first issues](docs/GOOD_FIRST_ISSUES.md).

## The 60-second proof

No signup, no keys. Clone, build, and run it against the deliberately broken sample campaign:

```console
$ node packages/cli/dist/index.js check examples/campaigns/sponsored-promo-broken.md

────────────────────────────────────────────────────────────────────────
POSTFLIGHT PRE-FLIGHT CHECKLIST  •  examples/campaigns/sponsored-promo-broken.md
 HOLD — ISSUES FOUND   Overall: 0/100  F   15 errors  31 warnings  7 info
────────────────────────────────────────────────────────────────────────
   FAIL  LinkedIn (linkedin)  Score 0/100  F   3E 9W 2I
    Chars   [###-----------------] 466/3000 (2534 left) [utf16]
    Meta    Graphemes: 410 | UTF-8 bytes: 578 | URLs: 1 | Hashtags: 9
    Mobile  (140ch / 3L) TRUNCATED (line-limit) [1 blank line counted]
      "🚀🔥 𝐔𝐧𝐥𝐞𝐚𝐬𝐡 𝐭𝐡𝐞 𝐠𝐚𝐦𝐞-𝐜𝐡𝐚𝐧𝐠𝐞𝐫 𝐭𝐡𝐚𝐭 𝐰𝐢𝐥𝐥 𝐫𝐞𝐯𝐨𝐥𝐮𝐭𝐢𝐨𝐧𝐢𝐳𝐞 𝐲𝐨𝐮𝐫 𝐰... ...more"

    ERROR compliance/ftc-missing-disclosure [compliance] (-30pts) [auto-fix]
          Sponsored post on LinkedIn is missing an approved disclosure token
          (#Ad, Ad:, #Sponsored, Paid Partnership, #Advertisement).
          Fix: Prepend '#Ad ' at the very start of the post before the mobile fold.
          Spec: FTC 16 CFR Part 255 / ASA CAP Code

    WARN  accessibility/unicode-faux-bold [accessibility] (-14pts) [auto-fix]
          Detected 9 Unicode faux-bold/fancy-font run(s) (𝐔𝐧𝐥𝐞𝐚𝐬𝐡, 𝐭𝐡𝐞, 𝐠𝐚𝐦𝐞),
          which break screen readers and fail platform search indexing.
          Fix: Replace Unicode Mathematical Alphanumeric characters with standard ASCII.
          Spec: WCAG 2.2 / Unicode U+1D400-U+1D7FF

    WARN  fold/blank-line-starvation [fold] (-10pts) [auto-fix]
          Blank line in the opening 2 lines consumes 1 of 3 mobile visible line(s)
          before '...more' on LinkedIn.
          Fix: Remove the blank line between line 1 and line 2 so your full
          two-line hook sits above the mobile fold.
          Spec: PlatformSpec.folds.blankLinesCountAsLines
```

Add `--fix` to auto-repair everything marked `[auto-fix]`, or `--format sarif` to get native GitHub Code Scanning annotations on every pull request.

## Contents

- [Why PostFlight exists](#why-postflight-exists)
- [The LinkedIn fold trap](#the-linkedin-fold-trap)
- [Safe-Zone X-Ray](#safe-zone-x-ray)
- [Quickstart](#quickstart)
- [Pick your surface](#pick-your-surface)
- [CLI reference](#cli-reference)
- [How PostFlight compares](#how-postflight-compares)
- [Contributing](#contributing)

## Why PostFlight exists

These are the failure modes that never throw an error, never show up in analytics as a cause, and quietly cost you the post:

| Silent failure mode | What breaks in production | How PostFlight catches it |
| :--- | :--- | :--- |
| **LinkedIn blank-line fold trap** | Pressing `Enter` twice consumes a full visible mobile line (3 lines text-only, 2 with media), hiding your hook behind `...more`. | Exact mobile and desktop fold simulator that counts blank lines and media collapse. |
| **Instagram 3:4 grid crop & error `36003`** | The profile grid moved to `3:4`, slicing **34 px** off each edge of `4:5` posts and **240 px** off the top and bottom of `9:16` Reels covers — yet the Graph API hard-rejects `3:4` uploads. | Safe-Zone X-Ray with the exact `1012×1350` and `1080×1440` inner boxes, plus a Graph API pre-check. |
| **9:16 short-form UI collisions** | TikTok, Reels, and Shorts chrome swallows **35–48%** of the frame, differently for organic vs. paid — including TikTok's lower-right notch. | Pixel-accurate 2D collision engine across 16 presets. |
| **Invisible characters & dead links** | Pasting from Docs or Notion leaves hidden `U+200B`/Bidi characters that break hashtags and links. Firebase Dynamic Links (`*.page.link`) shut down in Aug 2025. | Detects and strips hidden characters while preserving emoji ZWJ clusters; flags dead shorteners, unfilled `{{templates}}`, and DST scheduling traps. |
| **2025–2026 hashtag cliffs** | Instagram and TikTok cut hashtags from **30 → 5**. Threads caps at **1** topic tag. YouTube Shorts above 60 tags silently ignores **all** of them. | Deterministic hard-cap linter with a one-click trimmer. |
| **Bluesky byte & facet bugs** | Bluesky enforces 300 graphemes **and** 3,000 UTF-8 bytes, exact UTF-8 `byteStart`/`byteEnd` facets (JS `.length` breaks on emoji), and **2,000,000 decimal bytes** — not 2 MiB — for images. | Real `Intl.Segmenter` + `TextEncoder` dual counter, exact ATProto facet compiler, decimal byte check. |
| **TikTok 2,200 API vs 4,000 native cliff** | Captions between 2,201 and 4,000 characters work natively but silently fail through the Content Posting API. | Dual native and API limit auditor (`--api`). |
| **Unicode faux-bold** | Pasting `𝐁𝐨𝐥𝐝 𝐇𝐨𝐨𝐤` (`U+1D400–U+1D7FF`) breaks screen readers *and* makes those keywords invisible to in-platform search. | Flags faux-bold and normalizes it back to clean ASCII. |
| **FTC / UK ASA above-the-fold exposure** | `#ad` buried past Instagram's 125-character or LinkedIn's 100-character fold — or using `#spon`/`#collab` — carries real civil penalty exposure. | Above-the-fold disclosure gate for FTC 16 CFR Part 255 and the UK ASA CAP Code. |
| **WhatsApp 300 KB OG drop** | Open Graph images above 300 KB silently vanish on WhatsApp and iMessage, killing dark-social previews. | OG card simulator plus a copy-ready FFmpeg Rec.709 / CFR / `yuv420p` / `-14 LUFS` command builder. |
| **Unchecked AI agents** | Agents with raw MCP write keys risk brand incidents; OAuth refresh races cause 3 a.m. silent outages. | Read-and-lint-only MCP server, SHA-256 hash-chained kill-switch, and an OAuth decay radar. |

All **77 rules** are documented in [docs/RULES.md](docs/RULES.md), generated directly from the engine's rule catalog so the docs can never drift from the code.

## The LinkedIn fold trap

The single most expensive formatting mistake on LinkedIn, and the easiest to miss:

![Two mobile previews side by side. With blank lines, the hook and disclosure fall below the see-more cutoff. Without them, three full lines of hook plus the ad disclosure stay visible.](docs/assets/fold-simulator.svg)

## Safe-Zone X-Ray

Platform UI chrome and profile-grid crops eat your frame. PostFlight does the collision math against 16 presets, offline:

![Three frames showing TikTok organic chrome consuming 47 percent of a 9:16 frame, Instagram Reels covers losing 240 pixels top and bottom to the 3:4 grid, and Instagram feed posts losing 34 pixels from each side.](docs/assets/safe-zone-xray.svg)

```bash
postflight safezone --preset tiktok-organic --box 60,1500,960,300:"caption card"
postflight safezone --list     # inspect all 16 presets
```

## Quickstart

Requires **Node.js 20 or newer**. Nothing else — no database, no Redis, no API keys.

```bash
git clone https://github.com/prateeekranga/postflight.git
cd postflight
npm install
npm run build
npm test
```

### Lint a draft or a whole campaign folder

```bash
# Catch every hidden failure in the broken sponsorship sample
node packages/cli/dist/index.js check examples/campaigns/sponsored-promo-broken.md

# Auto-fix: strips faux-bold, PascalCases hashtags, cleans UTMs, lifts #Ad above the fold
node packages/cli/dist/index.js check examples/campaigns/sponsored-promo-broken.md --fix

# SARIF 2.1.0 for GitHub Code Scanning PR annotations
node packages/cli/dist/index.js check examples/campaigns/launch-announcement.md \
  --format sarif --out results.sarif
```

### Compile one canonical post into platform-native artifacts

```bash
node packages/cli/dist/index.js compile examples/campaigns/launch-announcement.md --out ./dist-campaign
```

One Markdown file becomes:

- **X** — weighted-length auto-numbered thread (`1/N`, `t.co=23`), link moved to the final reply.
- **LinkedIn** — fold-optimized hook, clean body, link off-body to avoid the dwell-time penalty.
- **Bluesky** — auto-threaded under 300 graphemes / 3,000 bytes with exact UTF-8 ATProto `facets`.
- **Instagram / TikTok / Threads / YouTube Shorts / Mastodon** — 5-hashtag caps, 1 Threads topic tag, PascalCase accessibility tags, clean per-platform UTMs.

### Run the Web Studio locally

```bash
npm run studio     # http://127.0.0.1:4173
```

Zero telemetry. Uploaded preview frames never leave your browser's memory — safe for NDA work. Six instruments:

1. **Pre-Flight Composer & Live Fold Simulator** — mobile and desktop cut lines, one-click auto-fix, SARIF export
2. **Safe-Zone X-Ray Canvas** — upload a frame, drag or keyboard-nudge boxes across 16 presets
3. **1-to-N Canonical Compiler** — Markdown to native threads with a Bluesky facet inspector
4. **Media, OG Card, WCAG 2.2 Contrast & FFmpeg Lab**
5. **Buyer-Intent Comment Triage & Dark-Social UTM Lab**
6. **Agency Governance Deck** — hash-chained kill-switch, OAuth decay radar, duplicate and cannibalization scanner

## Pick your surface

| You want to… | Use | Start here |
| :--- | :--- | :--- |
| Block bad posts in CI | **CLI** → SARIF 2.1.0 | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |
| Give an AI agent deterministic eyes | **MCP server**, 9 governed read/lint tools | [docs/MCP_INTEGRATION.md](docs/MCP_INTEGRATION.md) |
| See the fold and safe zones visually | **Web Studio** | `npm run studio` |
| Embed the engine in your own app | **`@postflight/core`** SDK | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |

### Plug into Claude Code, Cursor, or any MCP agent

```json
{
  "mcpServers": {
    "postflight": {
      "command": "node",
      "args": ["/absolute/path/to/postflight/packages/mcp/dist/index.js"]
    }
  }
}
```

The MCP server is deliberately scoped to **read, lint, compile, triage, and govern**. It holds no publishing credentials and cannot post on your behalf.

### Embed the SDK

```ts
import { runPreFlight, analyzeSafeZone, compileCanonicalPost } from '@postflight/core';

const report = runPreFlight(
  { text: 'Your launch draft...', isSponsored: true },
  ['linkedin', 'x', 'instagram-feed', 'bluesky'],
);

console.log(report.overallScore, report.overallGrade, report.totalErrors);
```

## CLI reference

| Command | What it does |
| :--- | :--- |
| `postflight check <file-or-dir>` | Lint drafts or whole campaign folders (`--targets`, `--format pretty\|json\|sarif\|markdown`, `--fix`, `--strict`, `--quiet`, `--api`, `--sponsored`) |
| `postflight compile <post.md>` | Compile canonical Markdown + YAML into native threads, Bluesky facets, and UTM bundles |
| `postflight safezone --preset <id> --box x,y,w,h:label` | 2D collision math across 16 presets (`--list` to inspect them) |
| `postflight utm --url <url> --platform <id> --campaign <slug>` | Audit UTM hygiene, strip `fbclid`/`gclid`, build clean dark-social URLs |
| `postflight triage <comments.json>` | Separate P0 crises and high-intent buyers from bot noise, with SLA targets |
| `postflight ffmpeg --platform <id> [--hdr] [--fps 30]` | Generate Rec.709 / CFR / `yuv420p` / `faststart` / `-14 LUFS` pipelines |
| `postflight tokens <connections.json>` | Audit OAuth token decay cliffs and refresh race conditions |
| `postflight contrast --fg #FFFFFF --bg #0D5E99` | WCAG 2.2 AA/AAA contrast calculator |
| `postflight killswitch <status\|freeze\|resume\|verify>` | Emergency publish freeze with a tamper-evident SHA-256 hash-chained ledger |
| `postflight specs [platformId]` | Inspect the verified platform spec registry |
| `postflight rules [--category <id>]` | List all 77 deterministic rules |
| `postflight studio [--port 4173]` | Start the local Web Studio |

## How PostFlight compares

| Capability | Postiz / Mixpost | Buffer / Hootsuite | **PostFlight** |
| :--- | :---: | :---: | :---: |
| License | AGPL-3.0 / open-core | Proprietary SaaS | **MIT** |
| Works day 1 with zero API keys | No (OAuth + app review) | No | **Yes** |
| Infrastructure required | Postgres + Redis + Temporal | Cloud SaaS | **None** |
| Pixel safe-zone X-ray (16 presets) | No | No | **Yes, offline** |
| Exact platform counters (X `t.co`, Bluesky bytes/facets) | Partial | Partial | **Yes, 9 platforms** |
| FTC / ASA above-the-fold + WCAG faux-bold auto-fix | No | No | **Yes** |
| SARIF 2.1.0 CI linting | No | No | **Yes** |
| Governed MCP server (no rogue publishing) | Raw write MCP | No | **Yes, 9 tools** |

PostFlight is not a scheduler and does not try to be. It is the step *before* your scheduler — and it composes with Postiz, Mixpost, Buffer, or your own pipeline.

## Contributing

Platform limits change every quarter, which makes this project genuinely community-maintained. The highest-impact contribution takes about two minutes:

1. Edit a JSON file in [`specs/platforms/`](specs/platforms/) and update `lastVerified` + `sources`.
2. Mirror the change in [`packages/core/src/specs/registry.ts`](packages/core/src/specs/registry.ts).
3. Run `npm test` — a parity test verifies the two stay in sync.
4. Open a PR linking the official platform documentation.

Start with [**good first issues**](docs/GOOD_FIRST_ISSUES.md), read [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow, and see [ROADMAP.md](ROADMAP.md) for where the project is heading. Questions go to [Discussions](https://github.com/prateeekranga/postflight/discussions); security reports follow [SECURITY.md](SECURITY.md).

Everyone participating is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Documentation

| Document | Contents |
| :--- | :--- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Design principles, module layout, browser/Node parity |
| [docs/RULES.md](docs/RULES.md) | All 77 rules, grouped by category (generated) |
| [docs/MCP_INTEGRATION.md](docs/MCP_INTEGRATION.md) | MCP setup for Claude Code, Cursor, Windsurf |
| [docs/GOOD_FIRST_ISSUES.md](docs/GOOD_FIRST_ISSUES.md) | Scoped starter tasks with exact file paths |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## License

[MIT](LICENSE) — free for creators, developers, agencies, and commercial embedding.

### Error-only check diagnostics

`postflight check <file-or-dir> --quiet` suppresses warning and info diagnostics in pretty, Markdown, JSON and SARIF reports, including `--out` files. It also hides advisory duplicate reports and auto-fix descriptions. Summary counts, scores, pass/fail decisions and exit codes still reflect the complete check; `--quiet --strict` still fails on warnings. `--fix` still applies fixes. Without `--quiet`, output is unchanged.
