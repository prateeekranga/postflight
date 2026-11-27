#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  PLATFORM_IDS,
  RULE_CATALOG,
  SAFE_ZONE_PRESETS,
  activateKillSwitch,
  analyzeSafeZone,
  auditOAuthTokens,
  auditUtmUrl,
  autoFixDraftText,
  buildCanonicalUtmUrl,
  buildFfmpegNormalizeCommand,
  calculateContrastRatio,
  canPublish,
  compileCanonicalPost,
  detectDuplicatesAndCannibalization,
  formatReportAsSarif,
  getPlatformSpec,
  isPlatformId,
  listPlatformSpecs,
  listSafeZonePresets,
  parseCanonicalMarkdown,
  releaseKillSwitch,
  runPreFlight,
  triageComments,
  verifyAuditChain,
} from '@postflight/core';
import type {
  BoundingBox,
  BrandGuardrails,
  CommentItem,
  DuplicateCheckInput,
  OAuthConnectionInput,
  PlatformId,
  PreFlightReport,
  SafeZonePresetId,
  SocialDraft,
} from '@postflight/core';
import {
  createAnsi,
  formatCompilationPretty,
  formatContrastPretty,
  formatDuplicatesPretty,
  formatFfmpegPretty,
  formatKillSwitchPretty,
  formatPreFlightMarkdown,
  formatPreFlightPretty,
  formatSafeZonePretty,
  formatSpecPretty,
  formatTokensPretty,
  formatTriagePretty,
  formatUtmPretty,
  stripAnsi,
} from './formatters.js';
import {
  loadKillSwitchState,
  saveKillSwitchState,
  startStudioServer,
} from './studio-server.js';

export const CLI_VERSION = '1.0.0';

function writeOut(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function writeErr(text: string): void {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface LoadedConfig {
  guardrails?: BrandGuardrails;
  defaultTargets?: PlatformId[];
}

function loadProjectConfig(cwd: string = process.cwd()): LoadedConfig {
  const configPath = path.join(cwd, 'postflight.config.json');
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return {};
    }

    const guardrails: BrandGuardrails = isRecord(parsed.guardrails)
      ? (parsed.guardrails as BrandGuardrails)
      : (parsed as BrandGuardrails);

    let defaultTargets: PlatformId[] | undefined;
    if (Array.isArray(parsed.defaultTargets)) {
      const valid = parsed.defaultTargets.filter(
        (t): t is PlatformId => typeof t === 'string' && isPlatformId(t)
      );
      if (valid.length > 0) {
        defaultTargets = valid;
      }
    }

    return {
      guardrails,
      ...(defaultTargets ? { defaultTargets } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${configPath}: ${msg}`);
  }
}

function parseTargetsOption(raw?: string): PlatformId[] | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const parts = raw
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);

  if (parts.length === 0) {
    return undefined;
  }

  const targets: PlatformId[] = [];
  for (const part of parts) {
    if (!isPlatformId(part)) {
      throw new Error(
        `Unknown platform "${part}". Valid platforms: ${PLATFORM_IDS.join(', ')}`
      );
    }
    targets.push(part);
  }
  return targets;
}

function isSafeZonePresetId(value: string): value is SafeZonePresetId {
  return Object.prototype.hasOwnProperty.call(SAFE_ZONE_PRESETS, value);
}

function collectMarkdownFiles(dirPath: string): string[] {
  const found: string[] = [];
  const skipDirs = new Set(['node_modules', '.git', 'dist', '.postflight']);

  const walk = (current: string): void => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          walk(fullPath);
        }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        found.push(fullPath);
      }
    }
  };

  walk(dirPath);
  return found;
}

interface LoadedDraftFile {
  kind: 'markdown' | 'json' | 'text';
  rawContent: string;
  frontmatterPrefix: string;
  draft: SocialDraft;
  fileTargets?: PlatformId[];
  campaign?: string;
  jsonWrapper?: Record<string, unknown>;
}

function loadDraftFile(
  filePath: string,
  overrides: { api: boolean; sponsored: boolean }
): LoadedDraftFile {
  const rawContent = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.json') {
    const parsed: unknown = JSON.parse(rawContent);
    if (!isRecord(parsed)) {
      throw new Error(`JSON draft file "${filePath}" must contain a JSON object.`);
    }
    const draftNode = isRecord(parsed.draft) ? parsed.draft : parsed;
    if (typeof draftNode.text !== 'string') {
      throw new Error(`JSON draft file "${filePath}" requires a string "text" property.`);
    }

    const baseDraft = draftNode as unknown as SocialDraft;
    const draft: SocialDraft = {
      ...baseDraft,
      ...(overrides.api ? { publishViaApi: true } : {}),
      ...(overrides.sponsored ? { isSponsored: true } : {}),
    };

    let fileTargets: PlatformId[] | undefined;
    if (Array.isArray(parsed.targets)) {
      const valid = parsed.targets.filter(
        (t): t is PlatformId => typeof t === 'string' && isPlatformId(t)
      );
      if (valid.length > 0) fileTargets = valid;
    }

    return {
      kind: 'json',
      rawContent,
      frontmatterPrefix: '',
      draft,
      ...(fileTargets ? { fileTargets } : {}),
      jsonWrapper: parsed,
    };
  }

  if (ext === '.md' || ext === '.markdown') {
    const normalized = rawContent.replace(/^\uFEFF/, '');
    const fmMatch = /^(---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n)/.exec(normalized);
    const frontmatterPrefix = fmMatch?.[1] ?? '';

    const doc = parseCanonicalMarkdown(rawContent);
    const draft: SocialDraft = {
      id: doc.frontmatter.id ?? path.basename(filePath, ext),
      text: doc.body,
      ...(doc.frontmatter.title ? { title: doc.frontmatter.title } : {}),
      ...(doc.frontmatter.firstComment ? { firstComment: doc.frontmatter.firstComment } : {}),
      ...(doc.frontmatter.contentWarning
        ? { contentWarning: doc.frontmatter.contentWarning }
        : {}),
      ...(doc.frontmatter.sponsored !== undefined || overrides.sponsored
        ? { isSponsored: overrides.sponsored || doc.frontmatter.sponsored === true }
        : {}),
      ...(doc.frontmatter.aiGenerated !== undefined
        ? { isAiGenerated: doc.frontmatter.aiGenerated }
        : {}),
      ...(doc.frontmatter.media ? { media: doc.frontmatter.media } : {}),
      ...(overrides.api ? { publishViaApi: true } : {}),
    };

    return {
      kind: 'markdown',
      rawContent,
      frontmatterPrefix,
      draft,
      ...(doc.frontmatter.targets && doc.frontmatter.targets.length > 0
        ? { fileTargets: doc.frontmatter.targets }
        : {}),
      ...(doc.frontmatter.campaign ? { campaign: doc.frontmatter.campaign } : {}),
    };
  }

  return {
    kind: 'text',
    rawContent,
    frontmatterPrefix: '',
    draft: {
      id: path.basename(filePath, ext),
      text: rawContent.trim(),
      ...(overrides.api ? { publishViaApi: true } : {}),
      ...(overrides.sponsored ? { isSponsored: true } : {}),
    },
  };
}

function applyAutoFixesAcrossTargets(
  text: string,
  targets: readonly PlatformId[],
  options: {
    isSponsored?: boolean;
    disclosureJurisdiction?: BrandGuardrails['disclosureJurisdiction'];
    utmCampaign?: string;
  }
): { fixedText: string; changed: boolean; appliedFixes: string[] } {
  let current = text;
  const appliedFixes: string[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    const res = autoFixDraftText(current, target, options);
    if (res.changed) {
      current = res.fixedText;
      for (const fix of res.appliedFixes) {
        if (!seen.has(fix)) {
          seen.add(fix);
          appliedFixes.push(fix);
        }
      }
    }
  }

  return {
    fixedText: current,
    changed: current !== text,
    appliedFixes,
  };
}

function writeFixedDraftBack(
  filePath: string,
  loaded: LoadedDraftFile,
  fixedText: string
): void {
  if (loaded.kind === 'markdown') {
    const updated = `${loaded.frontmatterPrefix}${fixedText}\n`;
    fs.writeFileSync(filePath, updated, 'utf8');
    return;
  }
  if (loaded.kind === 'json' && loaded.jsonWrapper) {
    const copy = structuredClone(loaded.jsonWrapper);
    if (isRecord(copy.draft)) {
      copy.draft.text = fixedText;
    } else {
      copy.text = fixedText;
    }
    fs.writeFileSync(filePath, `${JSON.stringify(copy, null, 2)}\n`, 'utf8');
    return;
  }
  fs.writeFileSync(filePath, `${fixedText}\n`, 'utf8');
}

function mergeSarifReports(
  entries: Array<{ uri: string; report: PreFlightReport }>
): Record<string, unknown> {
  const rulesById = new Map<string, Record<string, unknown>>();
  const allResults: Array<Record<string, unknown>> = [];
  let totalErrors = 0;
  let totalWarnings = 0;
  let totalInfos = 0;
  let scoreSum = 0;

  for (const entry of entries) {
    const sarif = formatReportAsSarif(entry.report, entry.uri);
    const runs = sarif.runs as Array<Record<string, unknown>> | undefined;
    const run = runs?.[0];
    if (!run) continue;

    const tool = run.tool as { driver?: { rules?: Array<Record<string, unknown>> } } | undefined;
    for (const rule of tool?.driver?.rules ?? []) {
      const id = typeof rule.id === 'string' ? rule.id : '';
      if (id && !rulesById.has(id)) {
        rulesById.set(id, rule);
      }
    }

    const results = run.results as Array<Record<string, unknown>> | undefined;
    if (results) {
      allResults.push(...results);
    }

    totalErrors += entry.report.totalErrors;
    totalWarnings += entry.report.totalWarnings;
    totalInfos += entry.report.totalInfos;
    scoreSum += entry.report.overallScore;
  }

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'PostFlight',
            version: CLI_VERSION,
            informationUri: 'https://github.com/postflight/postflight',
            rules: Array.from(rulesById.values()),
          },
        },
        results: allResults,
        properties: {
          timestamp: new Date().toISOString(),
          fileCount: entries.length,
          averageScore: entries.length > 0 ? Math.round(scoreSum / entries.length) : 100,
          passed: totalErrors === 0,
          totalErrors,
          totalWarnings,
          totalInfos,
        },
      },
    ],
  };
}

function writeOutputOrFile(content: string, outPath?: string): void {
  if (outPath) {
    const resolved = path.resolve(outPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, stripAnsi(content.endsWith('\n') ? content : `${content}\n`), 'utf8');
    writeErr(`Wrote output to ${resolved}`);
  } else {
    writeOut(content);
  }
}

function handleCheckCommand(args: string[], config: LoadedConfig): number {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      targets: { type: 'string', short: 't' },
      format: { type: 'string', short: 'f', default: 'pretty' },
      fix: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      api: { type: 'boolean', default: false },
      sponsored: { type: 'boolean', default: false },
      out: { type: 'string', short: 'o' },
    },
  });

  const targetPath = parsed.positionals[0];
  if (!targetPath) {
    throw new Error(
      'Usage: postflight check <file-or-dir> [--targets x,linkedin,...] [--format pretty|json|sarif|markdown] [--fix] [--strict] [--api] [--sponsored] [--out <file>]'
    );
  }

  const format = (parsed.values.format ?? 'pretty').toLowerCase();
  if (!['pretty', 'json', 'sarif', 'markdown'].includes(format)) {
    throw new Error(
      `Invalid --format "${format}". Expected one of: pretty, json, sarif, markdown.`
    );
  }

  const cliTargets = parseTargetsOption(parsed.values.targets);
  const fix = Boolean(parsed.values.fix);
  const strict = Boolean(parsed.values.strict);
  const api = Boolean(parsed.values.api);
  const sponsored = Boolean(parsed.values.sponsored);
  const outPath = parsed.values.out;

  const resolvedInput = path.resolve(targetPath);
  if (!fs.existsSync(resolvedInput)) {
    throw new Error(`File or directory not found: ${targetPath}`);
  }

  const stat = fs.statSync(resolvedInput);
  const baseGuardrails: BrandGuardrails | undefined = config.guardrails
    ? {
        ...config.guardrails,
        ...(api ? { useApiLimits: true } : {}),
      }
    : api
      ? { useApiLimits: true }
      : undefined;

  if (stat.isDirectory()) {
    const files = collectMarkdownFiles(resolvedInput);
    if (files.length === 0) {
      throw new Error(`No Markdown (.md) campaign files found in directory: ${targetPath}`);
    }

    const fileResults: Array<{
      file: string;
      relativePath: string;
      report: PreFlightReport;
      appliedFixes: string[];
    }> = [];
    const duplicateInputs: DuplicateCheckInput[] = [];

    for (const file of files) {
      const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
      const loaded = loadDraftFile(file, { api, sponsored });
      const effectiveTargets =
        cliTargets ?? loaded.fileTargets ?? config.defaultTargets ?? [...PLATFORM_IDS];

      let draft = loaded.draft;
      let appliedFixes: string[] = [];

      if (fix) {
        const fixRes = applyAutoFixesAcrossTargets(draft.text, effectiveTargets, {
          isSponsored: draft.isSponsored,
          disclosureJurisdiction: baseGuardrails?.disclosureJurisdiction,
          utmCampaign: loaded.campaign ?? baseGuardrails?.expectedCampaign,
        });
        if (fixRes.changed) {
          writeFixedDraftBack(file, loaded, fixRes.fixedText);
          draft = { ...draft, text: fixRes.fixedText };
          appliedFixes = fixRes.appliedFixes;
        }
      }

      const report = runPreFlight(draft, effectiveTargets, baseGuardrails);
      fileResults.push({ file, relativePath: rel, report, appliedFixes });
      duplicateInputs.push({
        id: draft.id ?? rel,
        text: draft.text,
        platform: effectiveTargets[0],
        ...(draft.scheduledAt ? { publishedAt: draft.scheduledAt } : {}),
      });
    }

    const duplicates = detectDuplicatesAndCannibalization(duplicateInputs);
    const totalErrors = fileResults.reduce((acc, r) => acc + r.report.totalErrors, 0);
    const totalWarnings = fileResults.reduce((acc, r) => acc + r.report.totalWarnings, 0);
    const totalInfos = fileResults.reduce((acc, r) => acc + r.report.totalInfos, 0);
    const passed = totalErrors === 0 && (!strict || totalWarnings === 0);

    let output: string;
    if (format === 'json') {
      output = JSON.stringify(
        {
          directory: targetPath,
          fileCount: fileResults.length,
          passed,
          totalErrors,
          totalWarnings,
          totalInfos,
          files: fileResults.map((f) => ({
            file: f.relativePath,
            appliedFixes: f.appliedFixes,
            report: f.report,
          })),
          duplicates,
        },
        null,
        2
      );
    } else if (format === 'sarif') {
      output = JSON.stringify(
        mergeSarifReports(
          fileResults.map((f) => ({ uri: f.relativePath, report: f.report }))
        ),
        null,
        2
      );
    } else if (format === 'markdown') {
      const blocks = fileResults.map((f) =>
        formatPreFlightMarkdown(f.report, f.relativePath)
      );
      if (duplicates.length > 0) {
        const dupLines = [
          '### ⚠️ Duplicate & Cannibalization Collisions',
          '',
          '| Draft A | Draft B | Risk | Similarity | Recommendation |',
          '| --- | --- | :---: | :---: | --- |',
          ...duplicates.map(
            (d) =>
              `| \`${d.draftA}\` | \`${d.draftB}\` | **${d.risk.toUpperCase()}** | ${Math.round(d.jaccardSimilarity * 100)}% | ${d.recommendation} |`
          ),
        ];
        blocks.push(dupLines.join('\n'));
      }
      output = blocks.join('\n\n---\n\n');
    } else {
      const blocks: string[] = [];
      for (const f of fileResults) {
        if (f.appliedFixes.length > 0) {
          blocks.push(
            `Applied ${f.appliedFixes.length} auto-fix(es) to ${f.relativePath}:\n` +
              f.appliedFixes.map((a) => `  + ${a}`).join('\n')
          );
        }
        blocks.push(formatPreFlightPretty(f.report, f.relativePath));
      }
      if (duplicates.length > 0) {
        blocks.push(formatDuplicatesPretty(duplicates));
      }
      output = blocks.join('\n\n');
    }

    writeOutputOrFile(output, outPath);
    return passed ? 0 : 1;
  }

  // Single file check
  const relLabel = path.relative(process.cwd(), resolvedInput).replace(/\\/g, '/') || targetPath;
  const loaded = loadDraftFile(resolvedInput, { api, sponsored });
  const effectiveTargets =
    cliTargets ?? loaded.fileTargets ?? config.defaultTargets ?? [...PLATFORM_IDS];

  let draft = loaded.draft;
  let appliedFixes: string[] = [];

  if (fix) {
    const fixRes = applyAutoFixesAcrossTargets(draft.text, effectiveTargets, {
      isSponsored: draft.isSponsored,
      disclosureJurisdiction: baseGuardrails?.disclosureJurisdiction,
      utmCampaign: loaded.campaign ?? baseGuardrails?.expectedCampaign,
    });
    if (fixRes.changed) {
      writeFixedDraftBack(resolvedInput, loaded, fixRes.fixedText);
      draft = { ...draft, text: fixRes.fixedText };
      appliedFixes = fixRes.appliedFixes;
    }
  }

  const report = runPreFlight(draft, effectiveTargets, baseGuardrails);
  const passed = report.totalErrors === 0 && (!strict || report.totalWarnings === 0);

  let output: string;
  if (format === 'json') {
    output = JSON.stringify(
      fix ? { ...report, fixed: appliedFixes.length > 0, appliedFixes } : report,
      null,
      2
    );
  } else if (format === 'sarif') {
    output = JSON.stringify(formatReportAsSarif(report, relLabel), null, 2);
  } else if (format === 'markdown') {
    output = formatPreFlightMarkdown(report, relLabel);
  } else {
    const prefix =
      fix && appliedFixes.length > 0
        ? `Applied ${appliedFixes.length} auto-fix(es) to ${relLabel}:\n` +
          appliedFixes.map((a) => `  + ${a}`).join('\n') +
          '\n\n'
        : fix
          ? `No auto-fixable changes needed for ${relLabel}.\n\n`
          : '';
    output = `${prefix}${formatPreFlightPretty(report, relLabel)}`;
  }

  writeOutputOrFile(output, outPath);
  return passed ? 0 : 1;
}

function handleCompileCommand(args: string[], config: LoadedConfig): number {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      targets: { type: 'string', short: 't' },
      out: { type: 'string', short: 'o' },
      format: { type: 'string', short: 'f', default: 'pretty' },
    },
  });

  const filePath = parsed.positionals[0];
  if (!filePath) {
    throw new Error(
      'Usage: postflight compile <file.md> [--targets x,linkedin,...] [--out <dir>] [--format pretty|json]'
    );
  }

  const format = (parsed.values.format ?? 'pretty').toLowerCase();
  if (format !== 'pretty' && format !== 'json') {
    throw new Error(`Invalid --format "${format}". Expected "pretty" or "json".`);
  }

  const resolvedFile = path.resolve(filePath);
  if (!fs.existsSync(resolvedFile)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const rawMarkdown = fs.readFileSync(resolvedFile, 'utf8');
  const cliTargets = parseTargetsOption(parsed.values.targets);
  const bundle = compileCanonicalPost(rawMarkdown, cliTargets, config.guardrails);

  const outDir = parsed.values.out;
  if (outDir) {
    const resolvedOutDir = path.resolve(outDir);
    fs.mkdirSync(resolvedOutDir, { recursive: true });
    const writtenFiles: string[] = [];

    const bundlePath = path.join(resolvedOutDir, 'bundle.json');
    fs.writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
    writtenFiles.push('bundle.json');

    for (const artifact of bundle.artifacts) {
      const jsonName = `${artifact.platform}.json`;
      fs.writeFileSync(
        path.join(resolvedOutDir, jsonName),
        `${JSON.stringify(artifact, null, 2)}\n`,
        'utf8'
      );
      writtenFiles.push(jsonName);

      const txtParts: string[] = [artifact.posts.join('\n\n---\n\n')];
      if (artifact.firstComment) {
        txtParts.push(`\n\n[First Comment]\n${artifact.firstComment}`);
      }
      if (artifact.utmUrl) {
        txtParts.push(`\n\n[UTM URL]\n${artifact.utmUrl}`);
      }
      if (artifact.dmFunnelNote) {
        txtParts.push(`\n\n[DM Funnel Note]\n${artifact.dmFunnelNote}`);
      }
      const txtName = `${artifact.platform}.txt`;
      fs.writeFileSync(
        path.join(resolvedOutDir, txtName),
        `${txtParts.join('')}\n`,
        'utf8'
      );
      writtenFiles.push(txtName);

      if (artifact.facets && artifact.facets.length > 0) {
        const facetsName = `${artifact.platform}-facets.json`;
        fs.writeFileSync(
          path.join(resolvedOutDir, facetsName),
          `${JSON.stringify(
            {
              platform: artifact.platform,
              sourceId: bundle.sourceId,
              posts: artifact.posts.map((text, idx) => ({
                index: idx,
                text,
                facets: artifact.facets?.[idx] ?? [],
              })),
            },
            null,
            2
          )}\n`,
          'utf8'
        );
        writtenFiles.push(facetsName);
      }
    }

    if (format === 'json') {
      writeOut(
        JSON.stringify(
          {
            outDir: resolvedOutDir,
            files: writtenFiles,
            bundle,
          },
          null,
          2
        )
      );
    } else {
      writeOut(formatCompilationPretty(bundle));
      writeOut(
        `Compiled ${bundle.artifacts.length} target(s) into ${resolvedOutDir} (${writtenFiles.join(', ')})`
      );
    }
    return 0;
  }

  if (format === 'json') {
    writeOut(JSON.stringify(bundle, null, 2));
  } else {
    writeOut(formatCompilationPretty(bundle));
  }
  return 0;
}

function parseBoxSpec(raw: string, index: number): BoundingBox {
  const parts = raw.split(',');
  if (parts.length < 4) {
    throw new Error(
      `Invalid --box "${raw}". Expected format: x,y,w,h or x,y,w,h:label`
    );
  }

  const x = Number(parts[0]);
  const y = Number(parts[1]);
  const width = Number(parts[2]);
  const fourthJoined = parts.slice(3).join(',');
  const colonIdx = fourthJoined.indexOf(':');
  const heightRaw = colonIdx >= 0 ? fourthJoined.slice(0, colonIdx) : fourthJoined;
  const labelRaw = colonIdx >= 0 ? fourthJoined.slice(colonIdx + 1).trim() : '';
  const height = Number(heightRaw);

  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error(
      `Invalid numeric coordinates in --box "${raw}". Width and height must be positive numbers.`
    );
  }

  return {
    id: `box-${index + 1}`,
    label: labelRaw.length > 0 ? labelRaw : `Overlay ${index + 1}`,
    x,
    y,
    width,
    height,
  };
}

function handleSafeZoneCommand(args: string[]): number {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      preset: { type: 'string', short: 'p' },
      box: { type: 'string', short: 'b', multiple: true },
      list: { type: 'boolean', short: 'l', default: false },
      format: { type: 'string', short: 'f', default: 'pretty' },
    },
  });

  const format = (parsed.values.format ?? 'pretty').toLowerCase();
  if (format !== 'pretty' && format !== 'json') {
    throw new Error(`Invalid --format "${format}". Expected "pretty" or "json".`);
  }

  if (parsed.values.list) {
    const presets = listSafeZonePresets();
    if (format === 'json') {
      writeOut(JSON.stringify(presets, null, 2));
    } else {
      const c = createAnsi();
      writeOut(c.bold(c.cyan(`POSTFLIGHT SAFE-ZONE PRESETS (${presets.length})`)));
      for (const p of presets) {
        const notch = p.lowerRight
          ? ` +notch(y>=${p.lowerRight.startY},r=${p.lowerRight.right})`
          : '';
        writeOut(
          `  ${c.bold(p.id.padEnd(26))} ${String(`${p.canvas.width}x${p.canvas.height}`).padEnd(10)} ` +
            `T:${p.top} B:${p.bottom} L:${p.left} R:${p.right}${notch}`
        );
        writeOut(`    ${c.dim(p.description)}`);
      }
    }
    return 0;
  }

  const presetId = parsed.values.preset ?? parsed.positionals[0];
  if (!presetId || !isSafeZonePresetId(presetId)) {
    throw new Error(
      `Missing or invalid --preset "${presetId ?? ''}". Run "postflight safezone --list" to see valid presets: ${Object.keys(SAFE_ZONE_PRESETS).join(', ')}`
    );
  }

  const boxArgs = parsed.values.box ?? [];
  const boxes = boxArgs.map((raw, idx) => parseBoxSpec(raw, idx));
  const analysis = analyzeSafeZone(presetId, boxes);

  if (format === 'json') {
    writeOut(JSON.stringify(analysis, null, 2));
  } else {
    writeOut(formatSafeZonePretty(analysis));
  }

  return analysis.allClear ? 0 : 1;
}

function handleUtmCommand(args: string[]): number {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      url: { type: 'string', short: 'u' },
      platform: { type: 'string', short: 'p' },
      campaign: { type: 'string', short: 'c' },
      medium: { type: 'string', short: 'm' },
      format: { type: 'string', short: 'f', default: 'pretty' },
    },
  });

  const url = parsed.values.url ?? parsed.positionals[0];
  if (!url) {
    throw new Error(
      'Usage: postflight utm --url <url> [--platform <id>] [--campaign <name>] [--medium <name>] [--format pretty|json]'
    );
  }

  const format = (parsed.values.format ?? 'pretty').toLowerCase();
  if (format !== 'pretty' && format !== 'json') {
    throw new Error(`Invalid --format "${format}". Expected "pretty" or "json".`);
  }

  let platform: PlatformId | undefined;
  if (parsed.values.platform) {
    if (!isPlatformId(parsed.values.platform)) {
      throw new Error(
        `Unknown --platform "${parsed.values.platform}". Valid: ${PLATFORM_IDS.join(', ')}`
      );
    }
    platform = parsed.values.platform;
  }

  const campaign = parsed.values.campaign;
  const medium = parsed.values.medium;

  const audit = auditUtmUrl(url, {
    ...(platform ? { platform } : {}),
    ...(campaign ? { expectedCampaign: campaign } : {}),
    ...(medium ? { expectedMedium: medium } : {}),
  });

  let canonicalUrl: string | undefined;
  if (platform && campaign && audit.validUrl) {
    canonicalUrl = buildCanonicalUtmUrl(url, {
      platform,
      campaign,
      ...(medium ? { medium } : {}),
    });
  }

  if (format === 'json') {
    writeOut(
      JSON.stringify(
        {
          ...audit,
          ...(canonicalUrl ? { canonicalUrl } : {}),
        },
        null,
        2
      )
    );
  } else {
    writeOut(formatUtmPretty(audit));
    if (canonicalUrl) {
      const c = createAnsi();
      writeOut(`  ${c.bold('Canonical UTM URL:')} ${c.green(canonicalUrl)}`);
    }
  }

  const hasError = !audit.validUrl || audit.issues.some((i) => i.severity === 'error');
  return hasError ? 1 : 0;
}

function handleTriageCommand(args: string[]): number {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      format: { type: 'string', short: 'f', default: 'pretty' },
    },
  });

  const filePath = parsed.positionals[0];
  if (!filePath) {
    throw new Error('Usage: postflight triage <comments.json> [--format pretty|json]');
  }

  const format = (parsed.values.format ?? 'pretty').toLowerCase();
  if (format !== 'pretty' && format !== 'json') {
    throw new Error(`Invalid --format "${format}". Expected "pretty" or "json".`);
  }

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const raw: unknown = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const comments: CommentItem[] = Array.isArray(raw)
    ? (raw as CommentItem[])
    : isRecord(raw) && Array.isArray(raw.comments)
      ? (raw.comments as CommentItem[])
      : (() => {
          throw new Error(
            `Expected a JSON array of comments or { "comments": [...] } in ${filePath}`
          );
        })();

  const triaged = triageComments(comments);

  if (format === 'json') {
    writeOut(JSON.stringify(triaged, null, 2));
  } else {
    writeOut(formatTriagePretty(triaged));
  }
  return 0;
}

function handleFfmpegCommand(args: string[]): number {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      platform: { type: 'string', short: 'p' },
      input: { type: 'string', short: 'i' },
      output: { type: 'string', short: 'o' },
      hdr: { type: 'boolean', default: false },
      fps: { type: 'string' },
      format: { type: 'string', short: 'f', default: 'pretty' },
    },
  });

  const platformRaw = parsed.values.platform ?? parsed.positionals[0];
  if (!platformRaw || !isPlatformId(platformRaw)) {
    throw new Error(
      `Missing or invalid --platform "${platformRaw ?? ''}". Valid platforms: ${PLATFORM_IDS.join(', ')}`
    );
  }

  const format = (parsed.values.format ?? 'pretty').toLowerCase();
  if (format !== 'pretty' && format !== 'json') {
    throw new Error(`Invalid --format "${format}". Expected "pretty" or "json".`);
  }

  let targetFps: 24 | 30 | 60 | undefined;
  if (parsed.values.fps !== undefined) {
    const fpsNum = Number(parsed.values.fps);
    if (fpsNum === 24 || fpsNum === 30 || fpsNum === 60) {
      targetFps = fpsNum;
    } else {
      throw new Error(`Invalid --fps "${parsed.values.fps}". Expected 24, 30, or 60.`);
    }
  }

  const result = buildFfmpegNormalizeCommand(platformRaw, {
    ...(parsed.values.input ? { input: parsed.values.input } : {}),
    ...(parsed.values.output ? { output: parsed.values.output } : {}),
    ...(parsed.values.hdr ? { isHdr: true } : {}),
    ...(targetFps !== undefined ? { targetFps } : {}),
  });

  if (format === 'json') {
    writeOut(JSON.stringify(result, null, 2));
  } else {
    writeOut(formatFfmpegPretty(result));
  }
  return 0;
}

function handleTokensCommand(args: string[]): number {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      now: { type: 'string' },
      strict: { type: 'boolean', default: false },
      format: { type: 'string', short: 'f', default: 'pretty' },
    },
  });

  const filePath = parsed.positionals[0];
  if (!filePath) {
    throw new Error(
      'Usage: postflight tokens <connections.json> [--now <iso>] [--strict] [--format pretty|json]'
    );
  }

  const format = (parsed.values.format ?? 'pretty').toLowerCase();
  if (format !== 'pretty' && format !== 'json') {
    throw new Error(`Invalid --format "${format}". Expected "pretty" or "json".`);
  }

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const raw: unknown = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const connections: OAuthConnectionInput[] = Array.isArray(raw)
    ? (raw as OAuthConnectionInput[])
    : isRecord(raw) && Array.isArray(raw.connections)
      ? (raw.connections as OAuthConnectionInput[])
      : (() => {
          throw new Error(
            `Expected a JSON array of connections or { "connections": [...] } in ${filePath}`
          );
        })();

  const results = auditOAuthTokens(connections, parsed.values.now);

  if (format === 'json') {
    writeOut(JSON.stringify(results, null, 2));
  } else {
    writeOut(formatTokensPretty(results));
  }

  const hasSevere = results.some((r) => r.status === 'expired' || r.status === 'critical');
  return parsed.values.strict && hasSevere ? 1 : 0;
}

function handleContrastCommand(args: string[]): number {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      fg: { type: 'string' },
      bg: { type: 'string' },
      strict: { type: 'boolean', default: false },
      format: { type: 'string', short: 'f', default: 'pretty' },
    },
  });

  const fg = parsed.values.fg ?? parsed.positionals[0];
  const bg = parsed.values.bg ?? parsed.positionals[1];
  if (!fg || !bg) {
    throw new Error(
      'Usage: postflight contrast --fg <#hex> --bg <#hex> [--strict] [--format pretty|json]'
    );
  }

  const format = (parsed.values.format ?? 'pretty').toLowerCase();
  if (format !== 'pretty' && format !== 'json') {
    throw new Error(`Invalid --format "${format}". Expected "pretty" or "json".`);
  }

  const result = calculateContrastRatio(fg, bg);

  if (format === 'json') {
    writeOut(JSON.stringify(result, null, 2));
  } else {
    writeOut(formatContrastPretty(result));
  }

  return parsed.values.strict && !result.aaNormal ? 1 : 0;
}

function resolveKillSwitchStateDir(dirOption?: string): string {
  if (!dirOption) {
    return path.join(process.cwd(), '.postflight');
  }
  const resolved = path.resolve(dirOption);
  return path.basename(resolved) === '.postflight'
    ? resolved
    : path.join(resolved, '.postflight');
}

function handleKillSwitchCommand(args: string[]): number {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      actor: { type: 'string', short: 'a', default: 'cli-operator' },
      reason: { type: 'string', short: 'r' },
      dir: { type: 'string', short: 'd' },
      format: { type: 'string', short: 'f', default: 'pretty' },
    },
  });

  const action = (parsed.positionals[0] ?? 'status').toLowerCase();
  if (!['status', 'freeze', 'resume', 'verify'].includes(action)) {
    throw new Error(
      `Invalid killswitch action "${action}". Expected: status | freeze | resume | verify`
    );
  }

  const format = (parsed.values.format ?? 'pretty').toLowerCase();
  if (format !== 'pretty' && format !== 'json') {
    throw new Error(`Invalid --format "${format}". Expected "pretty" or "json".`);
  }

  const stateDir = resolveKillSwitchStateDir(parsed.values.dir);
  let state = loadKillSwitchState(stateDir);
  const actor = parsed.values.actor ?? 'cli-operator';

  if (action === 'freeze') {
    const reason = parsed.values.reason ?? 'Emergency publishing freeze activated via CLI';
    state = activateKillSwitch(state, actor, reason);
    saveKillSwitchState(stateDir, state);
  } else if (action === 'resume') {
    const reason = parsed.values.reason ?? 'Publishing freeze released via CLI';
    state = releaseKillSwitch(state, actor, reason);
    saveKillSwitchState(stateDir, state);
  }

  const chain = verifyAuditChain(state.auditLog);
  const publish = canPublish(state);

  if (format === 'json') {
    writeOut(
      JSON.stringify(
        {
          ledgerPath: path.join(stateDir, 'killswitch.json'),
          state,
          chain,
          publish,
        },
        null,
        2
      )
    );
  } else {
    writeOut(formatKillSwitchPretty(state, chain));
  }

  if (action === 'verify') {
    return chain.valid ? 0 : 1;
  }
  return 0;
}

function handleSpecsCommand(args: string[]): number {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      format: { type: 'string', short: 'f', default: 'pretty' },
    },
  });

  const format = (parsed.values.format ?? 'pretty').toLowerCase();
  if (format !== 'pretty' && format !== 'json') {
    throw new Error(`Invalid --format "${format}". Expected "pretty" or "json".`);
  }

  const platformId = parsed.positionals[0];
  if (platformId) {
    if (!isPlatformId(platformId)) {
      throw new Error(
        `Unknown platform "${platformId}". Valid platforms: ${PLATFORM_IDS.join(', ')}`
      );
    }
    const spec = getPlatformSpec(platformId);
    if (format === 'json') {
      writeOut(JSON.stringify(spec, null, 2));
    } else {
      writeOut(formatSpecPretty(spec));
    }
    return 0;
  }

  const specs = listPlatformSpecs();
  if (format === 'json') {
    writeOut(JSON.stringify(specs, null, 2));
  } else {
    const c = createAnsi();
    writeOut(c.bold(c.cyan(`POSTFLIGHT PLATFORM SPECS REGISTRY (${specs.length} platforms)`)));
    writeOut('');
    for (const s of specs) {
      const apiCap =
        s.counting.apiHardLimit !== null && s.counting.apiHardLimit !== s.counting.hardLimit
          ? ` (API ${s.counting.apiHardLimit})`
          : '';
      const hashCap =
        s.hashtags.hardCap !== null ? `max ${s.hashtags.hardCap}` : `rec <=${s.hashtags.recommendedMax}`;
      const fold = s.folds.mobileChars !== null ? `${s.folds.mobileChars}ch` : 'none';
      writeOut(
        `  ${c.bold(s.id.padEnd(18))} ${s.name.padEnd(28)} ` +
          `Limit: ${String(s.counting.hardLimit + apiCap).padEnd(14)} ` +
          `Fold: ${fold.padEnd(7)} Tags: ${hashCap}`
      );
    }
    writeOut('');
    writeOut(c.dim('Run "postflight specs <platformId>" for full specification details.'));
  }
  return 0;
}

function handleRulesCommand(args: string[]): number {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      category: { type: 'string', short: 'c' },
      format: { type: 'string', short: 'f', default: 'pretty' },
    },
  });

  const format = (parsed.values.format ?? 'pretty').toLowerCase();
  if (format !== 'pretty' && format !== 'json') {
    throw new Error(`Invalid --format "${format}". Expected "pretty" or "json".`);
  }

  const categoryFilter = parsed.values.category?.toLowerCase();
  const rules = categoryFilter
    ? RULE_CATALOG.filter((r) => r.category === categoryFilter)
    : RULE_CATALOG;

  if (format === 'json') {
    writeOut(JSON.stringify(rules, null, 2));
  } else {
    const c = createAnsi();
    writeOut(c.bold(c.cyan(`POSTFLIGHT DETERMINISTIC RULE CATALOG (${rules.length} rules)`)));
    writeOut('');
    for (const r of rules) {
      const sev =
        r.defaultSeverity === 'error'
          ? c.red('ERROR')
          : r.defaultSeverity === 'warning'
            ? c.yellow('WARN ')
            : c.cyan('INFO ');
      writeOut(`  ${sev} ${c.bold(r.id.padEnd(38))} ${c.dim(`[${r.category}]`)}`);
      writeOut(`        ${r.title} — ${c.dim(r.summary)}`);
    }
  }
  return 0;
}

async function handleStudioCommand(args: string[]): Promise<number> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p', default: '4173' },
      host: { type: 'string', short: 'h', default: '127.0.0.1' },
      dir: { type: 'string', short: 'd' },
    },
  });

  const port = Number(parsed.values.port ?? '4173');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port "${parsed.values.port}". Expected integer 0-65535.`);
  }

  const host = parsed.values.host ?? '127.0.0.1';
  const stateDir = resolveKillSwitchStateDir(parsed.values.dir);
  const handle = await startStudioServer({ port, host, stateDir });

  const c = createAnsi();
  writeOut(`${c.bold(c.cyan('PostFlight Studio'))} running locally at ${c.green(handle.url)}`);
  writeOut(c.dim('Zero API keys • Zero telemetry • Press Ctrl+C to stop'));

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      handle
        .close()
        .catch(() => {})
        .finally(resolve);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

  return 0;
}

function getHelpText(): string {
  return `PostFlight CLI v${CLI_VERSION} — Social Media Pre-Flight Compiler, Linter & Safe-Zone Engine

Usage:
  postflight <command> [options]

Commands:
  check <file-or-dir>       Lint a draft (.md/.txt/.json) or campaign directory (+ duplicate scan)
                              Flags: --targets <csv>, --format pretty|json|sarif|markdown,
                                     --fix, --strict, --api, --sponsored, --out <file>
  compile <file.md>         Compile 1 canonical Markdown post into platform-native threads & facets
                              Flags: --targets <csv>, --out <dir>, --format pretty|json
  safezone                  Check 2D pixel collisions against platform UI dead zones (16 presets)
                              Flags: --preset <id>, --box x,y,w,h[:label] (repeatable),
                                     --list, --format pretty|json
  utm                       Audit URL UTM hygiene, strip click-ID noise, generate canonical UTM URL
                              Flags: --url <url>, --platform <id>, --campaign <slug>,
                                     --medium <slug>, --format pretty|json
  triage <comments.json>    Prioritize P0 crisis & high-intent buyer comments from noise
                              Flags: --format pretty|json
  ffmpeg                    Build Rec.709 SDR / CFR / yuv420p / faststart / -14 LUFS FFmpeg commands
                              Flags: --platform <id>, --input <file>, --output <file>,
                                     --hdr, --fps 24|30|60, --format pretty|json
  tokens <connections.json> Audit OAuth token decay cliffs & refresh/rotation race hazards
                              Flags: --now <iso>, --strict, --format pretty|json
  contrast                  WCAG 2.2 AA/AAA contrast ratio checker for captions & graphics
                              Flags: --fg <#hex>, --bg <#hex>, --strict, --format pretty|json
  killswitch <action>       Manage SHA-256 hash-chained crisis kill-switch ledger
                              Actions: status | freeze | resume | verify
                              Flags: --actor <name>, --reason <text>, --dir <path>, --format pretty|json
  specs [platformId]        Inspect verified 2025-2026 specs from the open platform registry
  rules                     List all deterministic pre-flight lint rules
  studio                    Start the local-first PostFlight Web Studio server
                              Flags: --port 4173, --host 127.0.0.1

Global Flags:
  -h, --help                Show help
  -v, --version             Show CLI version`;
}

export async function runCli(argv: string[]): Promise<number> {
  const first = argv[0];

  if (!first || first === '-h' || first === '--help' || first === 'help') {
    writeOut(getHelpText());
    return 0;
  }

  if (first === '-v' || first === '--version' || first === 'version') {
    writeOut(`postflight v${CLI_VERSION}`);
    return 0;
  }

  const subArgs = argv.slice(1);
  if (subArgs.includes('--help') || subArgs.includes('-h')) {
    writeOut(getHelpText());
    return 0;
  }

  try {
    const config = loadProjectConfig();

    switch (first) {
      case 'check':
        return handleCheckCommand(subArgs, config);
      case 'compile':
        return handleCompileCommand(subArgs, config);
      case 'safezone':
        return handleSafeZoneCommand(subArgs);
      case 'utm':
        return handleUtmCommand(subArgs);
      case 'triage':
        return handleTriageCommand(subArgs);
      case 'ffmpeg':
        return handleFfmpegCommand(subArgs);
      case 'tokens':
        return handleTokensCommand(subArgs);
      case 'contrast':
        return handleContrastCommand(subArgs);
      case 'killswitch':
        return handleKillSwitchCommand(subArgs);
      case 'specs':
        return handleSpecsCommand(subArgs);
      case 'rules':
        return handleRulesCommand(subArgs);
      case 'studio':
        return await handleStudioCommand(subArgs);
      default:
        writeErr(`Unknown command "${first}". Run "postflight --help" for usage.`);
        return 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeErr(`Error: ${message}`);
    return 1;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const selfPath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(selfPath) === fs.realpathSync(path.resolve(entry));
  } catch {
    const a = path.resolve(selfPath);
    const b = path.resolve(entry);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
}

if (isMainModule()) {
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      process.exit(0);
    }
  });
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      writeErr(`Fatal error: ${message}`);
      process.exitCode = 1;
    });
}
