Fonts a film can use, the same on every machine (a font the film names that is not here comes from the system, and
looks different, or falls back, where that font is missing). Each is under the SIL Open Font License 1.1
(LICENSES.txt), as packaged by Fontsource 5.3.0 (latin and latin-ext, woff2):

| Family | What it is | Weights | Italic |
|---|---|---|---|
| Inter | grotesque sans | 100–900 | yes |
| EB Garamond | old-style serif (Garamond) | 400–800 | yes |
| Playfair Display | high-contrast serif (Didone) | 400–900 | yes |
| Oswald | condensed sans | 200–700 | no |
| JetBrains Mono | monospace | 100–800 | yes |
| Courier Prime | typewriter | 400, 700 | yes |

`fonts.css` declares them all (a family's files load only when the film uses it):

```js
import '../../assets/fonts/fonts.css';   // in film.js; or <link rel="stylesheet" href="../../assets/fonts/fonts.css"> in index.html
```

Then `font-family: 'Playfair Display'` in the film's HTML, or `ctx.font = "italic 600 96px 'EB Garamond'"` on a canvas
(after `await document.fonts.load(…)`: a canvas does not wait for a font). Add others the same way: the film's own in its
project, or here for every film.
