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
 *   3. Re-applies the theme's "semanticTokenColors" on top of the TextMate tokens,
 *      mimicking what the TypeScript language service contributes at runtime
 *      (Shiki alone has no language service, so this pass is hand-mapped for the sample).
 *   4. Wraps the highlighted code in a mock VS Code workbench built from the theme's
 *      own "colors" contributions (with stock Dark+ defaults as the fallback).
 *   5. Screenshots the result with headless Chromium via Playwright.
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseJsonc } from 'jsonc-parser';
import { createHighlighter, FontStyle } from 'shiki';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

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

//---------------------------------------------------------------------------
// ++ Semantic token overlay
//---------------------------------------------------------------------------

/* The TypeScript language service classifies these identifiers in sample.ts at
 * runtime; VS Code then styles them via the theme's semanticTokenColors. Shiki
 * has no language service, so the classifications for the sample are declared
 * here and re-applied over the TextMate tokens. */
const PARAMETERS = new Set(['value', 'min', 'max', 'title', 'target', 'options', 'aliases', 'next', 'directive']);
const READONLY_FUNCTIONS = new Set(['clamp']);
const ASYNC_MEMBERS = new Set(['analyze']);
const DEFAULT_LIBRARY_VARIABLES = new Set(['JSON', 'Reflect']);

function normalizeSemanticRule(rule) {
    if (typeof rule === 'string') { return { foreground: rule }; }
    const out = { foreground: rule.foreground };
    if (typeof rule.fontStyle === 'string') {
        out.fontStyle = 0;
        if (rule.fontStyle.includes('italic')) { out.fontStyle |= FontStyle.Italic; }
        if (rule.fontStyle.includes('bold')) { out.fontStyle |= FontStyle.Bold; }
        if (rule.fontStyle.includes('underline')) { out.fontStyle |= FontStyle.Underline; }
    }
    if (rule.underline === true) { out.addUnderline = true; }
    return out;
}

/** Applies the flattened theme's semanticTokenColors to the token stream,
 *  matching VS Code's rule precedence (most-specific selector wins; a string
 *  fontStyle replaces the token's style, boolean flags add to it). */
function applySemanticOverlay(lines, semanticTokenColors) {
    const rule = (sel) => semanticTokenColors[sel] !== undefined
        ? normalizeSemanticRule(semanticTokenColors[sel]) : undefined;
    const seen = new Map();

    for (const line of lines) {
        // Comments never receive semantic tokens from the language service
        const first = line.map((t) => t.content.trim()).find((s) => s !== '') ?? '';
        if (first.startsWith('//') || first.startsWith('/*') || first.startsWith('*')) { continue; }
        let prev = '';
        for (const token of line) {
            const word = token.content.trim();
            if (!/^[A-Za-z_$][\w$]*$/.test(word)) {
                if (word !== '') { prev = word; }
                continue;
            }
            const count = seen.get(word) ?? 0;
            seen.set(word, count + 1);
            const isDeclaration = count === 0;
            const afterDot = prev === '.';
            prev = word;

            let semantic;
            if (PARAMETERS.has(word) && !(afterDot && word === 'options')) {
                // "options" is a parameter property; "this.options" resolves as a
                // property access, which this theme leaves to the TextMate colors.
                semantic = (isDeclaration ? rule('parameter.declaration') : undefined) ?? rule('parameter');
            } else if (READONLY_FUNCTIONS.has(word)) {
                semantic = (isDeclaration ? rule('function.declaration.readonly') : undefined) ?? rule('function.readonly');
            } else if (ASYNC_MEMBERS.has(word)) {
                semantic = (isDeclaration ? rule('member.declaration.async') : undefined) ?? rule('member.async');
            } else if (DEFAULT_LIBRARY_VARIABLES.has(word)) {
                semantic = rule('variable.defaultLibrary');
            }
            if (!semantic) { continue; }

            if (semantic.foreground) { token.color = semantic.foreground; }
            if (semantic.fontStyle !== undefined) { token.fontStyle = semantic.fontStyle; }
            if (semantic.addUnderline) { token.fontStyle = (token.fontStyle > 0 ? token.fontStyle : 0) | FontStyle.Underline; }
        }
    }
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
Host 'Dolores' analyzed directive 'name': true</div>
            </div>
        </div>
    </div>
    <div class="statusbar">
        <div class="group"><span>&#8916; master</span><span>&#8855; 0 &#9888; 0</span></div>
        <div class="group"><span>Ln 38, Col 42</span><span>Spaces: 4</span><span>UTF-8</span><span>LF</span><span>TypeScript</span></div>
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

const flats = THEMES.map((t) => ({ ...t, flat: flattenTheme(resolve(ROOT, t.file)) }));

const highlighter = await createHighlighter({
    langs: ['typescript'],
    themes: flats.map((t) => ({ name: t.id, type: t.flat.type, colors: t.flat.colors, tokenColors: t.flat.tokenColors }))
});

const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
const page = await browser.newPage({ viewport: { width: 1240, height: 800 }, deviceScaleFactor: 2 });

for (const t of flats) {
    const lines = highlighter.codeToTokensBase(code, { lang: 'typescript', theme: t.id });
    applySemanticOverlay(lines, t.flat.semanticTokenColors);

    const editorFg = t.flat.colors['editor.foreground'] ?? '#D4D4D4';
    const html = renderWindow(t.flat, renderCode(lines, editorFg), t.tabLabel);

    await page.setContent(html, { waitUntil: 'networkidle' });
    const el = page.locator('#window');
    await el.screenshot({ path: resolve(ROOT, t.out) });
    console.log(`rendered ${t.out} (${t.flat.name})`);
}

await browser.close();
