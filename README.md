# Ts-Everyday-Theme

[![VS Marketplace version][marketplace-version-image]][marketplace-url] [![VS Marketplace installs][marketplace-installs-image]][marketplace-url] [![MIT License][license-image]][license-url]

*A pair of dark themes for VS Code, designed specifically for everyday use with TypeScript*

![The TS Everyday theme](assets/ts-everyday.png)

## Installing

Installing the TS Everyday themes is really simple. Simply launch VS Code Quick Open (`Ctrl+P`) and paste in the following command:

```batchfile
ext install Slither.ts-everyday-theme
```

Or, install it straight from the [Visual Studio Marketplace][marketplace-url]. Then, open the Color Theme picker (`Ctrl+K Ctrl+T`) and choose either **TS Everyday** or **TS Everyday Lite**.

## What does this extension do?

I write TypeScript every day, and over time I kept tweaking the stock **Dark+** theme with small bits of syntax highlighting that made the language's *structure* easier to see at a glance- which operators are type-level vs. runtime, where the control flow changes, which identifiers are parameters, and so on. Eventually those tweaks grew into a proper theme, and, thus, this extension was born.

The extension ships with **2** themes, and both of them share the exact same TypeScript syntax highlighting:

* **TS Everyday** - A dark-purple theme that re-skins the entire VS Code workbench (title bar, activity bar, side bar, tabs, panel, terminal, & status bar) with a near-black editor, to compliment the custom TypeScript highlighting
* **TS Everyday Lite** - A classic Dark+ based theme that leaves the workbench alone, with the same syntax highlighting as TS Everyday

Both themes are built directly on top of VS Code's own `dark_plus.json`, so anything not explicitly overridden looks exactly like the Dark+ you already know. If you are a minimalist, the Lite flavor is for you.

Let's take a look at what the Lite flavor looks like with the same sample file:

![The TS Everyday Lite theme](assets/ts-everyday-lite.png)

As you can see, the *code* is identical between the two- only the workbench around it changes.

## So, what exactly gets highlighted?

The custom highlighting comes in two layers: classic **TextMate rules** (scoped to TypeScript), and **semantic tokens** contributed by the TypeScript language service at runtime. You can follow along with any of the rules below in [`samples/sample.ts`](samples/sample.ts), which is the file rendered in the previews above.

### The TextMate rules

**Type-level syntax** gets pulled away from runtime code:

* Generic type parameter brackets (`<` / `>`) are *pink italics* (`#d162c8`), and the `as` cast keyword matches them
* Union & intersection operators in type positions (`|` / `&`) are **bright red** (`#ff1515`)- and so are the runtime logical operators (`&&` / `||`), since they play the same role at runtime that unions play in types
* The `:` type annotation operator is teal (`#4EC9B0`), the same color as the types it introduces
* `keyof`, and the `get` / `set` accessor keywords, are their own shade of blue (`#55b0fa`)

**Control flow** is made hard to miss:

* Flow keywords like `return`, `await`, & `yield` are ***bold italics***
* `try` / `catch` are **bold**, loop keywords are *italic*, and the ternary `?` / `:` is ***bold italic***
* The arrow of an arrow function (`=>`) is hot-pink ***bold italic*** (`#ff15b9`), so callbacks jump out of any expression
* `new` is *pink, italicized, and underlined*

**Everything else** that I found myself squinting at:

* Decorators are underlined, with a **bright red** `@` (`#ff1515`)- you will never miss one again
* Statement terminators (`;`) are cyan (`#58fcee`), which makes the *end* of each statement easy to track in dense code
* Import aliases (`import { EventEmitter as Emitter }`) are *green italics* (`#71c89c`) wherever they're used
* `this`, `typeof`, & `instanceof` are *blue italics* (`#569CD6`)
* Object variables (the `dolores` in `dolores.analyze()`) are teal (`#4EC9B0`), tying an instance visually to its type
* Constants and numeric literals are **bold**
* Rest & spread (`...`) is yellow (`#f1cd29`)
* JSDoc gets its own treatment: block tags like `@param` are light blue (`#85c8ff`), types are *teal italics*, and documented variables are *light-blue italics*
* Plain `//` comments are dimmed way down (`#505050`), so documentation stands out but noise doesn't

### The semantic tokens

Both themes also enable VS Code's [semantic highlighting](https://code.visualstudio.com/api/language-extensions/semantic-highlight-guide), which means the TypeScript **language service** (not just the grammar) classifies identifiers, and the theme styles those classifications:

* **Parameters** are *italicized* at their declaration, and <ins>underlined</ins> everywhere they're used- so inside a long function body you always know which values came in from the outside
* **Async members** are salmon (`#f77a7a`) at their *call sites*, but stay the normal function gold (`#dcdcaa`) at their declaration. In other words: the color tells you, at the call site, that you're looking at something you probably need to `await`
* **Readonly functions** (i.e. `const` arrow functions) are **bold** periwinkle (`#7c94fd`), to distinguish them from regular `function` declarations
* **Default library variables** like `JSON` & `Reflect` are teal (`#4EC9B0`), matching the built-in types they belong to

Let's take a look at lines 42 & 58 of the sample above. As you can see, `analyze` is gold where the `async` method is *declared*, but salmon where it is *called* from- that's the `member.async` / `member.declaration.async` pair doing its job. That one rule alone has saved me from more than a few forgotten `await`s.

## How were these previews rendered?

Here's the fun part: those screenshots above are **not** screenshots of VS Code. Since VS Code's tokenizer & themes are all open-source JavaScript, the previews are rendered *from the theme files themselves* by a small harness in the [`preview/`](preview/) folder:

1. Each theme's `include` chain (`dark_plus.json` → `dark_vs.json` → `dark_defaults.json`) is flattened, exactly the way VS Code resolves it
2. [`samples/sample.ts`](samples/sample.ts) is tokenized with [Shiki](https://shiki.style/), which uses the very same TextMate grammar engine (and the same TypeScript grammar) that VS Code uses
3. The theme's `semanticTokenColors` are re-applied on top of the TextMate tokens, mimicking what the TypeScript language service contributes at runtime
4. A mock VS Code workbench is built around the code using the theme's own `colors` contributions (falling back to stock Dark+ values, just like VS Code does), and headless Chromium screenshots the result

That means the previews are generated straight from `themes/*.json`- if a color changes in the theme, re-running the harness changes the screenshots. To rebuild them yourself:

```batchfile
cd preview
npm install
npm run build
```

> _Note_: Shiki has no language service, so the semantic classifications for the sample file are hand-mapped inside `preview/build-previews.js`. They match what VS Code's TypeScript service produces for that file, but if you change the sample you may need to update the mapping too.

## Suggestions?

If there's a piece of TypeScript syntax you'd like to see styled- or if one of these colors offends you deeply- open a new issue for me to review!

**Enjoy!** :smile:

[marketplace-version-image]: https://img.shields.io/visual-studio-marketplace/v/Slither.ts-everyday-theme
[marketplace-installs-image]: https://img.shields.io/visual-studio-marketplace/i/Slither.ts-everyday-theme
[marketplace-url]: https://marketplace.visualstudio.com/items?itemName=Slither.ts-everyday-theme
[license-image]: https://img.shields.io/github/license/xSlither/Ts-Everyday-Theme
[license-url]: LICENSE
