/*
 * build-previews.js
 *
 * Renders the README screenshots for TS Everyday Theme without ever opening VS Code.
 *
 * How it works:
 *   1. Flattens each theme JSON (resolving the "include" chain down through
 *      dark_plus.json -> dark_vs.json -> dark_defaults.json), exactly like VS Code does.
 *   2. Tokenizes samples/sample.ts with Shiki - the same TextMate grammar engine
 *      VS Code itself uses - against the flattened theme.
 *   3. Runs the real TypeScript language service over the sample and asks it for the
 *      same semantic classifications VS Code's TypeScript extension consumes
 *      (getEncodedSemanticClassifications, 2020 format), then resolves each one to a
 *      style the way VS Code does: the theme's "semanticTokenColors" win by specificity,
 *      and anything the theme doesn't style falls back to the standard token-type ->
 *      scope map, resolved against the flattened TextMate colors.
 *   4. Wraps the highlighted code in a mock VS Code workbench built from the theme's
 *      own "colors" contributions (with stock Dark+ defaults as the fallback).
 *   5. Screenshots the result with headless Chromium via Playwright.
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parse as parseJsonc } from 'jsonc-parser';
import { createHighlighter, FontStyle } from 'shiki';
import { chromium } from 'playwright-core';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

//---------------------------------------------------------------------------
// ++ Theme flattening
//---------------------------------------------------------------------------

function loadThemeFile(path) {
    return parseJsonc(readFileSync(path, 'utf8'));
}

/** Resolves a theme's "include" chain the same way VS Code does:
 *  included (base) rules come first, the including theme's rules are appended
 *  after them so they win, and colors/semanticTokenColors are shallow-merged. */
function flattenTheme(path) {
    const theme = loadThemeFile(path);
    if (!theme.include) {
        return {
            tokenColors: theme.tokenColors ?? [],
            colors: theme.colors ?? {},
            semanticTokenColors: theme.semanticTokenColors ?? {},
            name: theme.name,
            type: theme.type ?? 'dark'
        };
    }
    const base = flattenTheme(resolve(dirname(path), theme.include));
    return {
        tokenColors: [...base.tokenColors, ...(theme.tokenColors ?? [])],
        colors: { ...base.colors, ...(theme.colors ?? {}) },
        semanticTokenColors: { ...base.semanticTokenColors, ...(theme.semanticTokenColors ?? {}) },
        name: theme.name ?? base.name,
        type: theme.type ?? base.type
    };
}

/** Resolves a TextMate scope to its theme color, the way VS Code matches scopes:
 *  a rule selector matches a scope when it is a dot-segment prefix of it, and the
 *  longest (most specific) matching selector wins. */
function makeScopeResolver(tokenColors) {
    const rules = [];
    for (const rule of tokenColors) {
        if (!rule.settings) { continue; }
        const scopes = Array.isArray(rule.scope) ? rule.scope
            : typeof rule.scope === 'string' ? rule.scope.split(',').map((s) => s.trim())
            : [];
        for (const selector of scopes) {
            if (selector) { rules.push({ selector, settings: rule.settings }); }
        }
    }
    return (scope) => {
        let best = null, bestLen = -1;
        for (const { selector, settings } of rules) {
            if ((scope === selector || scope.startsWith(selector + '.')) && selector.length > bestLen) {
                best = settings; bestLen = selector.length;
            }
        }
        return best;
    };
}

//---------------------------------------------------------------------------
// ++ Real TypeScript semantic classifications
//---------------------------------------------------------------------------

// TypeScript's 2020 classification legend (services/classifier2020.ts)
const TS_TOKEN_TYPES = ['class', 'enum', 'interface', 'namespace', 'typeParameter', 'type',
    'parameter', 'variable', 'enumMember', 'property', 'function', 'member'];
const TS_TOKEN_MODIFIERS = ['declaration', 'static', 'async', 'readonly', 'defaultLibrary', 'local'];

/** Drives the actual TypeScript language service (the same API VS Code's TS extension
 *  uses) and returns one entry per classified identifier: { start, length, type, mods }. */
function classifySemantics(code, fileName = '/sample.ts') {
    const tsLibDir = dirname(require.resolve('typescript'));
    const files = { [fileName]: code };
    const host = {
        getScriptFileNames: () => [fileName],
        getScriptVersion: () => '1',
        getScriptSnapshot: (f) => {
            if (files[f] !== undefined) { return ts.ScriptSnapshot.fromString(files[f]); }
            try { return ts.ScriptSnapshot.fromString(readFileSync(f, 'utf8')); } catch { return undefined; }
        },
        getCurrentDirectory: () => '/',
        getCompilationSettings: () => ({
            target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, experimentalDecorators: true
        }),
        getDefaultLibFileName: (o) => join(tsLibDir, ts.getDefaultLibFileName(o)),
        fileExists: (f) => files[f] !== undefined || ts.sys.fileExists(f),
        readFile: (f) => files[f] ?? ts.sys.readFile(f),
        readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists,
        getDirectories: ts.sys.getDirectories
    };
    const svc = ts.createLanguageService(host, ts.createDocumentRegistry());
    const { spans } = svc.getEncodedSemanticClassifications(
        fileName, { start: 0, length: code.length }, ts.SemanticClassificationFormat.TwentyTwenty);

    const out = new Map();
    for (let i = 0; i < spans.length; i += 3) {
        const start = spans[i], length = spans[i + 1], cls = spans[i + 2];
        const type = TS_TOKEN_TYPES[(cls >> 8) - 1];
        const modBits = cls & 0xff;
        const mods = new Set(TS_TOKEN_MODIFIERS.filter((_, b) => modBits & (1 << b)));
        if (type) { out.set(start, { start, length, type, mods }); }
    }
    return out;
}

//---------------------------------------------------------------------------
// ++ Semantic style resolution (mirrors VS Code's precedence)
//---------------------------------------------------------------------------

// VS Code's default token-type -> TextMate scope map (tokenClassificationRegistry.ts)
const DEFAULT_TYPE_SCOPES = {
    namespace: ['entity.name.namespace'],
    type: ['entity.name.type', 'support.type'],
    class: ['entity.name.type.class', 'support.class'],
    interface: ['entity.name.type.interface'],
    enum: ['entity.name.type.enum'],
    typeParameter: ['entity.name.type.parameter'],
    function: ['entity.name.function', 'support.function'],
    member: ['entity.name.function.member', 'support.function'], // TS "member" == VS Code "method"
    variable: ['variable.other.readwrite', 'entity.name.variable'],
    parameter: ['variable.parameter'],
    property: ['variable.other.property'],
    enumMember: ['variable.other.enummember']
};
// Modifier-keyed default rules
const DEFAULT_READONLY_SCOPES = {
    variable: ['variable.other.constant'],
    property: ['variable.other.constant.property']
};

function parseFontStyle(str) {
    return {
        italic: /italic/.test(str),
        bold: /bold/.test(str),
        underline: /underline/.test(str)
    };
}

/** Parses a "type.mod1.mod2" semanticTokenColors selector. */
function parseSelector(key) {
    const [type, ...mods] = key.split('.');
    return { type, mods };
}

function normalizeSemanticSettings(value) {
    if (typeof value === 'string') { return { foreground: value }; }
    return value;
}

/** Builds a resolver that, given a TS classification, returns the final
 *  { color, style } VS Code would paint - theme semantic rules first (by
 *  specificity), then the standard scope fallback for anything unstyled. */
function makeSemanticResolver(flat) {
    const scopeColor = makeScopeResolver(flat.tokenColors);

    const themeRules = Object.entries(flat.semanticTokenColors).map(([key, value]) => ({
        ...parseSelector(key),
        settings: normalizeSemanticSettings(value)
    }));

    const fallbackForeground = (cls) => {
        const scopeLists = [];
        if (cls.mods.has('readonly') && DEFAULT_READONLY_SCOPES[cls.type]) {
            scopeLists.push(DEFAULT_READONLY_SCOPES[cls.type]);
        }
        if (DEFAULT_TYPE_SCOPES[cls.type]) { scopeLists.push(DEFAULT_TYPE_SCOPES[cls.type]); }
        for (const scopes of scopeLists) {
            for (const scope of scopes) {
                const s = scopeColor(scope);
                if (s && s.foreground) { return s.foreground; }
            }
        }
        return undefined;
    };

    return (cls) => {
        // Most-specific matching theme rule (all its modifiers must be present)
        let rule = null, ruleSpecificity = -1;
        for (const r of themeRules) {
            if (r.type !== cls.type) { continue; }
            if (!r.mods.every((m) => cls.mods.has(m))) { continue; }
            if (r.mods.length > ruleSpecificity) { rule = r; ruleSpecificity = r.mods.length; }
        }

        const color = (rule && rule.settings.foreground) ? rule.settings.foreground : fallbackForeground(cls);

        // fontStyle: only overridden when the theme rule explicitly sets one; a
        // string replaces the style outright, booleans add to it.
        let style;
        if (rule) {
            const s = rule.settings;
            if (typeof s.fontStyle === 'string') { style = parseFontStyle(s.fontStyle); }
            if (s.underline === true || s.bold === true || s.italic === true) {
                style = style ?? { italic: false, bold: false, underline: false, additive: true };
                if (s.underline === true) { style.underline = true; }
                if (s.bold === true) { style.bold = true; }
                if (s.italic === true) { style.italic = true; }
            }
        }
        return { color, style };
    };
}

//---------------------------------------------------------------------------
// ++ Applying semantics onto the TextMate token stream
//---------------------------------------------------------------------------

function styleToBits(style, existing) {
    // "additive" styles (boolean modifiers) layer on top of the TextMate style;
    // a fontStyle string starts from scratch.
    let bits = style.additive ? (existing > 0 ? existing : 0) : 0;
    if (style.italic) { bits |= FontStyle.Italic; }
    if (style.bold) { bits |= FontStyle.Bold; }
    if (style.underline) { bits |= FontStyle.Underline; }
    return bits;
}

/** Overlays the resolved semantic styles onto Shiki's TextMate tokens by matching
 *  each classified identifier to the token that starts at the same source offset. */
function applySemantics(code, lines, classifications, resolve) {
    const lineStarts = [];
    let acc = 0;
    for (const text of code.split('\n')) { lineStarts.push(acc); acc += text.length + 1; }

    lines.forEach((line, li) => {
        let col = 0;
        for (const token of line) {
            const lead = token.content.length - token.content.trimStart().length;
            const start = lineStarts[li] + col + lead;
            col += token.content.length;

            const cls = classifications.get(start);
            if (!cls || cls.length !== token.content.trim().length) { continue; }

            const { color, style } = resolve(cls);
            if (color) { token.color = color; }
            if (style) { token.fontStyle = styleToBits(style, token.fontStyle); }
        }
    });
}

//---------------------------------------------------------------------------
// ++ HTML rendering
//---------------------------------------------------------------------------

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function tokenToSpan(token) {
    const styles = [];
    if (token.color) { styles.push(`color:${token.color}`); }
    const fs = token.fontStyle > 0 ? token.fontStyle : 0;
    if (fs & FontStyle.Italic) { styles.push('font-style:italic'); }
    if (fs & FontStyle.Bold) { styles.push('font-weight:bold'); }
    if (fs & FontStyle.Underline) { styles.push('text-decoration:underline'); }

    // Keep leading whitespace outside the span so underlines never cover indentation
    const match = token.content.match(/^(\s*)(.*)$/s);
    const [, ws, text] = match;
    return `${ws}<span style="${styles.join(';')}">${escapeHtml(text)}</span>`;
}

function renderCode(lines, editorForeground) {
    return lines.map((line, i) => {
        const spans = line.map(tokenToSpan).join('') || '&nbsp;';
        return `<div class="line"><span class="ln">${i + 1}</span><span class="code" style="color:${editorForeground}">${spans}</span></div>`;
    }).join('\n');
}

// Stock Dark+ workbench values, used wherever a theme doesn't contribute a color
const DARK_PLUS_WORKBENCH = {
    'titleBar.activeBackground': '#3C3C3C',
    'titleBar.activeForeground': '#CCCCCC',
    'activityBar.background': '#333333',
    'activityBar.foreground': '#FFFFFF',
    'activityBar.activeBorder': '#FFFFFF',
    'sideBar.background': '#252526',
    'sideBar.foreground': '#CCCCCC',
    'editorGroupHeader.tabsBackground': '#252526',
    'tab.activeBackground': '#1E1E1E',
    'tab.inactiveBackground': '#2D2D2D',
    'tab.activeForeground': '#FFFFFF',
    'editor.background': '#1E1E1E',
    'editor.foreground': '#D4D4D4',
    'editorLineNumber.foreground': '#858585',
    'panel.background': '#1E1E1E',
    'panel.border': '#80808059',
    'terminal.foreground': '#CCCCCC',
    'statusBar.background': '#007ACC',
    'statusBar.foreground': '#FFFFFF',
    'list.activeSelectionBackground': '#094771',
    'list.activeSelectionForeground': '#FFFFFF'
};

const ICONS = {
    files: '<svg viewBox="0 0 24 24"><path d="M13 3H6v18h13V9l-6-6z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13 3v6h6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15 15l6 6" stroke="currentColor" stroke-width="1.8"/></svg>',
    git: '<svg viewBox="0 0 24 24"><circle cx="7" cy="6" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="7" cy="18" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="17" cy="10" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 8.5v7M14.7 11.5C12 13 9 12.5 7.4 11" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    debug: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7-11-7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="8" cy="12" r="0.1" stroke="currentColor"/></svg>',
    ext: '<svg viewBox="0 0 24 24"><rect x="4" y="12" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="13" y="12" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="13" y="3" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>'
};

function renderWindow(flat, codeHtml, label) {
    const c = (key) => flat.colors[key] ?? DARK_PLUS_WORKBENCH[key] ?? '#1E1E1E';

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #000; font-family: "Segoe UI", "Liberation Sans", "DejaVu Sans", sans-serif; }
    #window { width: 1180px; display: flex; flex-direction: column; overflow: hidden; }

    .titlebar { height: 30px; background: ${c('titleBar.activeBackground')}; color: ${c('titleBar.activeForeground')};
        display: flex; align-items: center; font-size: 12px; position: relative; }
    .menus { display: flex; gap: 2px; padding-left: 8px; z-index: 1; }
    .menus span { padding: 3px 8px; opacity: .9; }
    .titlebar .title { position: absolute; left: 0; right: 0; text-align: center; opacity: .85; }

    .main { display: flex; flex: 1; min-height: 0; }
    .activitybar { width: 48px; background: ${c('activityBar.background')}; color: ${c('activityBar.foreground')};
        display: flex; flex-direction: column; align-items: center; padding-top: 4px; }
    .activitybar .icon { width: 48px; height: 46px; display: flex; align-items: center; justify-content: center; opacity: .45; }
    .activitybar .icon svg { width: 23px; height: 23px; }
    .activitybar .icon.active { opacity: 1; border-left: 2px solid ${c('activityBar.activeBorder')}; }

    .sidebar { width: 220px; background: ${c('sideBar.background')}; color: ${c('sideBar.foreground')};
        font-size: 12px; overflow: hidden; }
    .sidebar .heading { padding: 8px 16px 6px; font-size: 11px; letter-spacing: .4px; opacity: .8; }
    .sidebar .project { padding: 4px 8px; font-weight: bold; font-size: 11px; letter-spacing: .3px; }
    .sidebar .item { padding: 3px 8px; white-space: nowrap; }
    .sidebar .item.active { background: ${c('list.activeSelectionBackground')}; color: ${c('list.activeSelectionForeground')}; }
    .sidebar .twist { display: inline-block; width: 14px; opacity: .8; }

    .editorcol { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .tabs { height: 35px; background: ${c('editorGroupHeader.tabsBackground')}; display: flex; font-size: 12.5px; }
    .tab { padding: 0 12px; display: flex; align-items: center; gap: 6px; background: ${c('tab.inactiveBackground')};
        color: ${c('tab.activeForeground')}; opacity: .55; border-right: 1px solid rgba(0,0,0,.35); }
    .tab.active { background: ${c('tab.activeBackground')}; opacity: 1; }
    .tab .lang { font-size: 10px; opacity: .75; }

    .editor { flex: 1; background: ${c('editor.background')}; padding: 8px 0 12px;
        font-family: "Liberation Mono", "DejaVu Sans Mono", monospace; font-size: 12.5px; line-height: 17px; overflow: hidden; }
    .line { display: flex; white-space: pre; }
    .ln { width: 44px; padding-right: 16px; text-align: right; flex-shrink: 0;
        color: ${c('editorLineNumber.foreground')}; user-select: none; }

    .panel { height: 110px; background: ${c('panel.background')}; border-top: 1px solid ${c('panel.border')};
        font-size: 11px; color: ${c('sideBar.foreground')}; }
    .panel .paneltabs { display: flex; gap: 18px; padding: 8px 16px 6px; letter-spacing: .4px; }
    .panel .paneltabs span { opacity: .5; }
    .panel .paneltabs span.active { opacity: 1; border-bottom: 1px solid currentColor; padding-bottom: 3px; }
    .panel .term { padding: 6px 16px; font-family: "Liberation Mono", "DejaVu Sans Mono", monospace;
        font-size: 12px; line-height: 17px; color: ${c('terminal.foreground')}; white-space: pre; }

    .statusbar { height: 22px; background: ${c('statusBar.background')}; color: ${c('statusBar.foreground')};
        display: flex; align-items: center; justify-content: space-between; font-size: 11.5px; padding: 0 10px; }
    .statusbar .group { display: flex; gap: 14px; }
</style></head>
<body>
<div id="window">
    <div class="titlebar">
        <div class="menus"><span>File</span><span>Edit</span><span>Selection</span><span>View</span><span>Go</span><span>Run</span><span>Terminal</span><span>Help</span></div>
        <div class="title">sample.ts — Ts-Everyday-Theme — Visual Studio Code</div>
    </div>
    <div class="main">
        <div class="activitybar">
            <div class="icon active">${ICONS.files}</div>
            <div class="icon">${ICONS.search}</div>
            <div class="icon">${ICONS.git}</div>
            <div class="icon">${ICONS.debug}</div>
            <div class="icon">${ICONS.ext}</div>
        </div>
        <div class="sidebar">
            <div class="heading">EXPLORER</div>
            <div class="project"><span class="twist">&#9662;</span>TS-EVERYDAY-THEME</div>
            <div class="item" style="padding-left:16px"><span class="twist">&#9656;</span>.vscode</div>
            <div class="item" style="padding-left:16px"><span class="twist">&#9662;</span>samples</div>
            <div class="item active" style="padding-left:40px">sample.ts</div>
            <div class="item" style="padding-left:16px"><span class="twist">&#9662;</span>themes</div>
            <div class="item" style="padding-left:32px"><span class="twist">&#9656;</span>defaults</div>
            <div class="item" style="padding-left:44px">ts-everyday-color-theme.json</div>
            <div class="item" style="padding-left:44px">ts-everyday-lite-color-theme.json</div>
            <div class="item" style="padding-left:28px">CHANGELOG.md</div>
            <div class="item" style="padding-left:28px">package.json</div>
            <div class="item" style="padding-left:28px">README.md</div>
        </div>
        <div class="editorcol">
            <div class="tabs">
                <div class="tab active"><span class="lang">TS</span> sample.ts</div>
                <div class="tab"><span class="lang">{}</span> ${label}</div>
            </div>
            <div class="editor">
${codeHtml}
            </div>
            <div class="panel">
                <div class="paneltabs"><span>PROBLEMS</span><span>OUTPUT</span><span>DEBUG CONSOLE</span><span class="active">TERMINAL</span></div>
                <div class="term">$ tsc && node ./dist/sample.js
WOPR simulated scenario 'name': true</div>
            </div>
        </div>
    </div>
    <div class="statusbar">
        <div class="group"><span>&#8916; master</span><span>&#8855; 0 &#9888; 0</span></div>
        <div class="group"><span>Ln 43, Col 42</span><span>Spaces: 4</span><span>UTF-8</span><span>LF</span><span>TypeScript</span></div>
    </div>
</div>
</body></html>`;
}

//---------------------------------------------------------------------------
// ++ Main
//---------------------------------------------------------------------------

const THEMES = [
    { file: 'themes/ts-everyday-color-theme.json', id: 'ts-everyday', out: 'assets/ts-everyday.png', tabLabel: 'ts-everyday-color-theme.json' },
    { file: 'themes/ts-everyday-lite-color-theme.json', id: 'ts-everyday-lite', out: 'assets/ts-everyday-lite.png', tabLabel: 'ts-everyday-lite-color-theme.json' }
];

const code = readFileSync(resolve(ROOT, 'samples/sample.ts'), 'utf8').trimEnd();
mkdirSync(resolve(ROOT, 'assets'), { recursive: true });

const classifications = classifySemantics(code);
const flats = THEMES.map((t) => ({ ...t, flat: flattenTheme(resolve(ROOT, t.file)) }));

const highlighter = await createHighlighter({
    langs: ['typescript'],
    themes: flats.map((t) => ({ name: t.id, type: t.flat.type, colors: t.flat.colors, tokenColors: t.flat.tokenColors }))
});

const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
const page = await browser.newPage({ viewport: { width: 1240, height: 800 }, deviceScaleFactor: 2 });

for (const t of flats) {
    const lines = highlighter.codeToTokensBase(code, { lang: 'typescript', theme: t.id });
    applySemantics(code, lines, classifications, makeSemanticResolver(t.flat));

    const editorFg = t.flat.colors['editor.foreground'] ?? '#D4D4D4';
    const html = renderWindow(t.flat, renderCode(lines, editorFg), t.tabLabel);

    await page.setContent(html, { waitUntil: 'networkidle' });
    const el = page.locator('#window');
    await el.screenshot({ path: resolve(ROOT, t.out) });
    console.log(`rendered ${t.out} (${t.flat.name})`);
}

await browser.close();
